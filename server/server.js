"use strict";

/*
 * Наш сервер (Handoff backend) для Telegram-FOSS (DrKLO) + мессенджер.
 * Регистрация/вход по @username + пароль, поиск пользователей, личные чаты,
 * группы и каналы, отправка текста и медиа (фото/видео/голосовые/кружочки).
 * Всё поверх HTTP + WebSocket. Railway подхватывает PORT автоматически.
 */

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { WebSocketServer, WebSocket } = require("ws");

// TL-мост: наш сервер говорит с клиентом Telegram на родном TL-протоколе (через @tgsnake/skema)
let Skema = null;
let BytesIO = null;
try {
  Skema = require("@tgsnake/skema");
  BytesIO = require("@tgsnake/bytesio").BytesIO;
} catch (e) {
  console.log("⚠️ TL bridge отключён: @tgsnake/skema не установлен");
}
const TL = Skema ? Skema.Raw : null;
const TLObject = Skema ? Skema.TLObject : null;
const TLPrimitive = Skema ? Skema.Primitive : null;

const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";
const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// ---------- хранилища (в памяти; файлы — на диске) ----------
const users = new Map();    // "@username" -> { username, salt, hash, token, name, createdAt }
const chats = new Map();    // chatId -> { id, type, title, usernames[], createdAt, lastMessage }
const messages = new Map(); // chatId -> [ { id, from, text, time, ts, media } ]
const files = new Map();    // fileId -> { id, name, type, size, path, owner, nid }
const uploadParts = new Map(); // fileId -> Map(part -> Buffer) — части загружаемых файлов по TL
const clients = new Map();  // WebSocket -> { username }

let chatSeq = 1;
let msgSeq = 1;
let fileSeq = 1;
let nextUid = 1001;
let nextTid = 1000001;
let nextNid = 2000001;

// ---------- утилиты ----------
function pad(n) {
  return n < 10 ? "0" + n : "" + n;
}

function now() {
  const d = new Date();
  return pad(d.getHours()) + ":" + pad(d.getMinutes());
}

function normalizeUsername(raw) {
  let u = String(raw || "").trim().toLowerCase();
  if (u && !u.startsWith("@")) {
    u = "@" + u;
  }
  return u;
}

function validUsername(u) {
  return /^@[a-z0-9_]{4,31}$/.test(u);
}

function hashPassword(password, salt) {
  return crypto.createHash("sha256").update(salt + ":" + password).digest("hex");
}

function makeToken() {
  return crypto.randomBytes(24).toString("hex");
}

function makeId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function userList() {
  const list = [];
  for (const c of clients.values()) list.push(c.username);
  return list;
}

function findUserByToken(token) {
  if (!token) return null;
  for (const u of users.values()) {
    if (u.token === token) return u;
  }
  return null;
}

function getChat(chatId) {
  return chats.get(String(chatId)) || null;
}

function chatMembers(chat) {
  return chat.usernames.slice();
}

function publicUser(u) {
  return {
    username: u.username,
    name: u.name || u.username,
    online: userList().includes(u.username)
  };
}

function publicChat(chat) {
  const msgs = messages.get(chat.id) || [];
  const last = msgs.length ? msgs[msgs.length - 1] : null;
  return {
    id: chat.id,
    type: chat.type,
    title: chat.title,
    usernames: chat.usernames.slice(),
    lastMessage: last ? (last.text || (last.media ? "📎 " + (last.media.type || "media") : "")) : "",
    lastMessageTime: last ? last.time : "",
    unread: 0
  };
}

function publicMessage(m) {
  return {
    id: m.id,
    chatId: m.chatId,
    from: m.from,
    text: m.text,
    time: m.time,
    ts: m.ts,
    media: m.media || null
  };
}

function saveMessage(chatId, from, text, media) {
  const m = {
    id: msgSeq++,
    chatId: String(chatId),
    from: from,
    text: String(text || ""),
    time: now(),
    ts: Date.now(),
    media: media || null
  };
  if (!messages.has(m.chatId)) {
    messages.set(m.chatId, []);
  }
  messages.get(m.chatId).push(m);
  const chat = getChat(chatId);
  if (chat) {
    chat.lastMessage = m.text || (m.media ? "📎 media" : "");
  }
  return m;
}

function broadcast(payload, except) {
  const data = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client !== except && client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

function sendToUser(username, payload) {
  const data = JSON.stringify(payload);
  for (const [ws, c] of clients) {
    if (c.username === username && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

function broadcastToChat(chat, payload, except) {
  for (const username of chatMembers(chat)) {
    for (const [ws, c] of clients) {
      if (c.username === username && ws !== except && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
      }
    }
  }
}

// ---------- HTTP helpers ----------
function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 25e6) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size > 200e6) {
        req.destroy();
        reject(new Error("file too large"));
      }
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function getToken(req) {
  const auth = req.headers["authorization"] || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7);
  try {
    return new URL(req.url, "http://localhost").searchParams.get("token") || "";
  } catch (e) {
    return "";
  }
}

// ---------- TL bridge: клиент Telegram (исходник DrKLO) -> наш сервер, родной TL ----------
async function tlUnwrap(obj) {
  let guard = 0;
  while (obj && guard++ < 10) {
    if (obj.className === "InvokeWithLayer" || obj.className === "InitConnection") {
      obj = obj.query;
      continue;
    }
    if (obj.className === "GzipPacked") {
      if (obj.packedData && obj.packedData.className) {
        obj = obj.packedData;
      } else {
        const buf = Buffer.isBuffer(obj.packedData) ? obj.packedData : Buffer.from(obj.packedData || []);
        obj = await TLObject.read(BytesIO.from(buf));
      }
      continue;
    }
    break;
  }
  return obj;
}

function tlUserFromRecord(u, selfUsername) {
  return new TL.User({
    id: BigInt(u.uid),
    self: u.username === selfUsername,
    contact: false,
    mutualContact: false,
    deleted: false,
    bot: false,
    botChatHistory: false,
    botNochats: false,
    verified: false,
    restricted: false,
    min: false,
    botInlineGeo: false,
    support: false,
    scam: false,
    applyMinPhoto: false,
    firstName: u.name || u.username,
    lastName: "",
    username: u.username.replace(/^@/, ""),
    phone: "",
    accessHash: u.accessHash
  });
}

function tlFindUserByUid(uid) {
  for (const u of users.values()) {
    if (u.uid === Number(uid)) return u;
  }
  return null;
}

function tlFindChatByTid(tid) {
  for (const chat of chats.values()) {
    if (chat.tid === Number(tid)) return chat;
  }
  return null;
}

function tlChatPeer(chat, selfUsername) {
  if (chat.type === "private") {
    const otherName = chat.usernames.find(u => u !== selfUsername);
    const other = otherName ? users.get(otherName) : null;
    if (!other) return null;
    return new TL.PeerUser({ userId: BigInt(other.uid) });
  }
  if (chat.type === "group") {
    return new TL.PeerChat({ chatId: BigInt(chat.tid) });
  }
  return new TL.PeerChannel({ channelId: BigInt(chat.tid) });
}

function tlMessageToTL(m, selfUsername, mediaTL) {
  const chat = getChat(m.chatId);
  const fromUser = users.get(m.from);
  let peer = chat ? tlChatPeer(chat, selfUsername) : null;
  if (!peer && fromUser) {
    peer = new TL.PeerUser({ userId: BigInt(fromUser.uid) });
  }
  return new TL.Message({
    id: m.id,
    peerId: peer,
    date: Math.floor(m.ts / 1000),
    message: m.text || "",
    out: m.from === selfUsername,
    mentioned: false,
    mediaUnread: false,
    silent: false,
    post: false,
    fromScheduled: false,
    legacy: false,
    editHide: false,
    pinned: false,
    noforwards: false,
    invertMedia: false,
    offline: false,
    videoProcessingPending: false,
    fromId: fromUser ? new TL.PeerUser({ userId: BigInt(fromUser.uid) }) : undefined,
    media: mediaTL || undefined
  });
}

function tlPhotoForFile(file) {
  const bytes = fs.existsSync(file.path) ? fs.readFileSync(file.path) : Buffer.alloc(0);
  return new TL.Photo({
    hasStickers: false,
    id: BigInt(file.nid),
    accessHash: BigInt(file.nid),
    fileReference: Buffer.from(file.id),
    date: Math.floor(Date.now() / 1000),
    sizes: [
      new TL.PhotoStrippedSize({ type: "s", bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) }),
      new TL.PhotoCachedSize({ type: "x", w: 800, h: 600, bytes: bytes })
    ],
    videoSizes: [],
    dcId: 1
  });
}

function tlDocumentForFile(file, kind) {
  const attrs = [new TL.DocumentAttributeFilename({ fileName: file.name })];
  const durationSec = Math.max(1, Math.floor((file.duration || 0) / 1000));
  if (kind === "voice") {
    attrs.push(new TL.DocumentAttributeAudio({
      voice: true,
      duration: durationSec,
      title: "",
      performer: "",
      waveform: Buffer.alloc(0)
    }));
  } else if (kind === "video" || kind === "round") {
    attrs.push(new TL.DocumentAttributeVideo({
      roundMessage: kind === "round",
      supportsStreaming: true,
      nosound: false,
      duration: durationSec,
      w: 640,
      h: 640,
      preloadPrefixSize: 0,
      videoStartTs: 0,
      videoCodec: ""
    }));
  }
  return new TL.Document({
    id: BigInt(file.nid),
    accessHash: BigInt(file.nid),
    fileReference: Buffer.from(file.id),
    date: Math.floor(Date.now() / 1000),
    mimeType: file.type || "application/octet-stream",
    size: file.size,
    thumbs: [],
    videoThumbs: [],
    dcId: 1,
    attributes: attrs
  });
}

function tlMediaForMessage(m) {
  if (!m.media || !m.media.fileId) return undefined;
  const file = files.get(m.media.fileId);
  if (!file) return undefined;
  if (m.media.type === "photo") {
    return new TL.MessageMediaPhoto({
      spoiler: false,
      photo: tlPhotoForFile(file)
    });
  }
  return new TL.MessageMediaDocument({
    nopremium: false,
    spoiler: false,
    video: m.media.type === "video" || m.media.type === "round",
    round: m.media.type === "round",
    voice: m.media.type === "voice",
    document: tlDocumentForFile(file, m.media.type),
    altDocuments: [],
    videoCover: [],
    videoTimestamp: 0
  });
}

function tlChatToTL(chat) {
  const photo = new TL.PhotoEmpty({ id: 0n });
  const createdSec = Math.floor(chat.createdAt / 1000);
  if (chat.type === "group") {
    return new TL.Chat({
      id: BigInt(chat.tid),
      title: chat.title || "Group",
      photo: photo,
      participantsCount: chat.usernames.length,
      date: createdSec,
      version: 1,
      creator: false,
      left: false,
      deactivated: false,
      callActive: false,
      callNotEmpty: false,
      noforwards: false
    });
  }
  return new TL.Channel({
    id: BigInt(chat.tid),
    title: chat.title || "Channel",
    photo: photo,
    date: createdSec,
    accessHash: BigInt(chat.tid),
    username: "",
    creator: false,
    left: false,
    broadcast: chat.type === "channel",
    verified: false,
    megagroup: chat.type === "group",
    restricted: false,
    signatures: false,
    min: false,
    scam: false,
    hasLink: false,
    hasGeo: false,
    slowmodeEnabled: false,
    callActive: false,
    callNotEmpty: false,
    fake: false,
    gigagroup: false,
    noforwards: false,
    joinToSend: false,
    joinRequest: false,
    forum: false,
    storiesHidden: false,
    storiesHiddenMin: false,
    storiesUnavailable: false,
    signatureProfiles: false,
    autotranslation: false,
    broadcastMessagesAllowed: false,
    monoforum: false,
    forumTabs: false
  });
}

function tlResolveInputPeer(peer, selfUsername) {
  if (!peer || !peer.className) return null;
  if (peer.className === "InputPeerUser") {
    const other = tlFindUserByUid(peer.userId);
    if (!other) return null;
    for (const chat of chats.values()) {
      if (chat.type === "private" && chat.usernames.includes(selfUsername) && chat.usernames.includes(other.username)) {
        return chat;
      }
    }
    // чата ещё нет — создаём (как в Telegram: первое сообщение создаёт диалог)
    const chat = {
      id: "c" + chatSeq++,
      tid: nextTid++,
      type: "private",
      title: "",
      usernames: [selfUsername, other.username],
      createdAt: Date.now(),
      lastMessage: ""
    };
    chats.set(chat.id, chat);
    messages.set(chat.id, []);
    return chat;
  }
  if (peer.className === "InputPeerChat") {
    return tlFindChatByTid(peer.chatId);
  }
  if (peer.className === "InputPeerChannel") {
    return tlFindChatByTid(peer.channelId);
  }
  return null;
}

function tlAssembleFile(fileId) {
  const parts = uploadParts.get(String(fileId));
  if (!parts) return null;
  const ids = Array.from(parts.keys()).sort((a, b) => a - b);
  const chunks = [];
  for (const id of ids) {
    chunks.push(parts.get(id));
  }
  return Buffer.concat(chunks);
}

function tlUsersForChat(chat, selfUsername) {
  const list = [];
  const seen = new Set();
  for (const name of chat.usernames) {
    const u = users.get(name);
    if (u && !seen.has(u.username)) {
      seen.add(u.username);
      list.push(tlUserFromRecord(u, selfUsername));
    }
  }
  return list;
}

function tlUsersForMessages(msgs, selfUsername) {
  const list = [];
  const seen = new Set();
  for (const m of msgs) {
    const u = users.get(m.from);
    if (u && !seen.has(u.username)) {
      seen.add(u.username);
      list.push(tlUserFromRecord(u, selfUsername));
    }
  }
  return list;
}

const tlHandlers = {
  "help.GetConfig": async (req, ctx) => {
    const nowSec = Math.floor(Date.now() / 1000);
    return new TL.Config({
      defaultP2pContacts: false,
      preloadFeaturedStickers: false,
      revokePmInbox: false,
      blockedMode: false,
      forceTryIpv6: false,
      date: nowSec,
      expires: nowSec + 86400,
      testMode: false,
      thisDc: 1,
      dcOptions: [],
      dcTxtDomainName: "",
      chatSizeMax: 200,
      megagroupSizeMax: 200000,
      forwardedCountMax: 100,
      onlineUpdatePeriodMs: 10000,
      offlineBlurTimeoutMs: 5000,
      offlineIdleTimeoutMs: 10000,
      onlineCloudTimeoutMs: 30000,
      notifyCloudDelayMs: 1000,
      notifyDefaultDelayMs: 25000,
      pushChatPeriodMs: 60000,
      pushChatLimit: 10,
      editTimeLimit: 86400,
      revokeTimeLimit: 86400,
      revokePmTimeLimit: 86400,
      ratingEDecay: 1,
      stickersRecentLimit: 20,
      channelsReadMediaPeriod: 604800,
      callReceiveTimeoutMs: 20000,
      callRingTimeoutMs: 30000,
      callConnectTimeoutMs: 30000,
      callPacketTimeoutMs: 10000,
      meUrlPrefix: "https://mwmmw-production.up.railway.app/",
      captionLengthMax: 1024,
      messageLengthMax: 4096,
      webfileDcId: 1
    });
  },
  "updates.GetState": async (req, ctx) => {
    return new TL.updates.State({
      pts: 0,
      qts: 0,
      date: Math.floor(Date.now() / 1000),
      seq: 0,
      unreadCount: 0
    });
  },
  "users.GetUsers": async (req, ctx) => {
    const list = [];
    for (const u of users.values()) {
      list.push(tlUserFromRecord(u, ctx.user ? ctx.user.username : null));
    }
    return new TL.users.Users({ users: list });
  },
  "messages.GetDialogs": async (req, ctx) => {
    const selfName = ctx.user ? ctx.user.username : null;
    const dialogs = [];
    const msgs = [];
    const chatObjs = [];
    const userObjs = [];
    const seen = new Set();
    for (const chat of chats.values()) {
      if (!selfName || !chat.usernames.includes(selfName)) continue;
      const peer = tlChatPeer(chat, selfName);
      if (!peer) continue;
      const chatMsgs = messages.get(chat.id) || [];
      const last = chatMsgs.length ? chatMsgs[chatMsgs.length - 1] : null;
      dialogs.push(new TL.Dialog({
        pinned: false,
        unreadMark: false,
        viewForumAsMessages: false,
        peer: peer,
        topMessage: last ? last.id : 0,
        readInboxMaxId: last ? last.id : 0,
        readOutboxMaxId: last ? last.id : 0,
        unreadCount: 0,
        unreadMentionsCount: 0,
        unreadReactionsCount: 0,
        unreadPollVotesCount: 0,
        notifySettings: new TL.PeerNotifySettings({})
      }));
      if (last) {
        msgs.push(tlMessageToTL(last, selfName, tlMediaForMessage(last)));
      }
      if (chat.type !== "private") {
        chatObjs.push(tlChatToTL(chat));
      } else {
        for (const u of tlUsersForChat(chat, selfName)) {
          if (!seen.has(u.username)) {
            seen.add(u.username);
            userObjs.push(u);
          }
        }
      }
    }
    return new TL.messages.Dialogs({
      dialogs: dialogs,
      messages: msgs,
      chats: chatObjs,
      users: userObjs
    });
  },
  "messages.GetHistory": async (req, ctx) => {
    const selfName = ctx.user ? ctx.user.username : null;
    const chat = tlResolveInputPeer(req.peer, selfName);
    if (!chat || !selfName || !chat.usernames.includes(selfName)) {
      return new TL.RpcError({ errorCode: 400, errorMessage: "CHAT_NOT_FOUND" });
    }
    const limit = Math.min(Number(req.limit) || 50, 100);
    const all = messages.get(chat.id) || [];
    const slice = all.slice(-limit);
    const msgs = slice.map(m => tlMessageToTL(m, selfName, tlMediaForMessage(m)));
    const chatObjs = chat.type !== "private" ? [tlChatToTL(chat)] : [];
    const userObjs = tlUsersForChat(chat, selfName);
    for (const u of tlUsersForMessages(slice, selfName)) {
      if (!userObjs.find(x => x.username === u.username)) {
        userObjs.push(u);
      }
    }
    return new TL.messages.Messages({
      messages: msgs,
      topics: [],
      chats: chatObjs,
      users: userObjs
    });
  },
  "messages.SendMessage": async (req, ctx) => {
    const selfName = ctx.user ? ctx.user.username : null;
    if (!selfName) {
      return new TL.RpcError({ errorCode: 401, errorMessage: "AUTH_REQUIRED" });
    }
    const chat = tlResolveInputPeer(req.peer, selfName);
    if (!chat || !chat.usernames.includes(selfName)) {
      return new TL.RpcError({ errorCode: 400, errorMessage: "PEER_ID_INVALID" });
    }
    const text = String(req.message || "").slice(0, 4000);
    if (!text) {
      return new TL.RpcError({ errorCode: 400, errorMessage: "MESSAGE_EMPTY" });
    }
    const m = saveMessage(chat.id, selfName, text, null);
    const tlMsg = tlMessageToTL(m, selfName, null);
    return new TL.Updates({
      updates: [new TL.UpdateNewMessage({ message: tlMsg, pts: m.id, ptsCount: 1 })],
      users: tlUsersForChat(chat, selfName),
      chats: chat.type !== "private" ? [tlChatToTL(chat)] : [],
      date: Math.floor(Date.now() / 1000),
      seq: 0
    });
  },
  "messages.SendMedia": async (req, ctx) => {
    const selfName = ctx.user ? ctx.user.username : null;
    if (!selfName) {
      return new TL.RpcError({ errorCode: 401, errorMessage: "AUTH_REQUIRED" });
    }
    const chat = tlResolveInputPeer(req.peer, selfName);
    if (!chat || !chat.usernames.includes(selfName)) {
      return new TL.RpcError({ errorCode: 400, errorMessage: "PEER_ID_INVALID" });
    }
    const media = req.media;
    if (!media || !media.file) {
      return new TL.RpcError({ errorCode: 400, errorMessage: "MEDIA_EMPTY" });
    }
    const rawBytes = tlAssembleFile(media.file.id);
    if (!rawBytes || !rawBytes.length) {
      return new TL.RpcError({ errorCode: 400, errorMessage: "FILE_PARTS_MISSING" });
    }
    let kind = "document";
    const attrs = Array.isArray(media.attributes) ? media.attributes : [];
    for (const a of attrs) {
      if (!a || !a.className) continue;
      if (a.className === "DocumentAttributeAudio" && a.voice) kind = "voice";
      if (a.className === "DocumentAttributeVideo") {
        if (a.roundMessage) kind = "round";
        else if (kind !== "voice") kind = "video";
      }
    }
    if (media.className === "InputMediaUploadedPhoto") kind = "photo";
    const name = String(media.file.name || "file").slice(0, 100);
    const mime = String(media.mimeType || (kind === "photo" ? "image/jpeg" : "application/octet-stream")).slice(0, 100);
    const fileId = makeId("f");
    const filePath = path.join(UPLOAD_DIR, fileId);
    fs.writeFileSync(filePath, rawBytes);
    const file = {
      id: fileId,
      name: name,
      type: mime,
      size: rawBytes.length,
      path: filePath,
      owner: selfName,
      nid: nextNid++
    };
    files.set(fileId, file);
    const m = saveMessage(chat.id, selfName, String(req.message || ""), {
      type: kind,
      fileId: fileId,
      url: "/api/file/" + fileId,
      name: name,
      size: rawBytes.length
    });
    const tlMsg = tlMessageToTL(m, selfName, tlMediaForMessage(m));
    return new TL.Updates({
      updates: [new TL.UpdateNewMessage({ message: tlMsg, pts: m.id, ptsCount: 1 })],
      users: tlUsersForChat(chat, selfName),
      chats: chat.type !== "private" ? [tlChatToTL(chat)] : [],
      date: Math.floor(Date.now() / 1000),
      seq: 0
    });
  },
  "contacts.Search": async (req, ctx) => {
    const selfName = ctx.user ? ctx.user.username : null;
    const needle = String(req.q || "").toLowerCase().replace(/^@/, "");
    const results = [];
    const userObjs = [];
    for (const u of users.values()) {
      if (u.username === selfName) continue;
      const uName = u.username.replace(/^@/, "");
      if (!needle || uName.includes(needle) || (u.name || "").toLowerCase().includes(needle)) {
        results.push(new TL.PeerUser({ userId: BigInt(u.uid) }));
        userObjs.push(tlUserFromRecord(u, selfName));
      }
    }
    return new TL.contacts.Found({
      myResults: [],
      results: results.slice(0, 50),
      chats: [],
      users: userObjs.slice(0, 50)
    });
  },
  "channels.CreateChannel": async (req, ctx) => {
    const selfName = ctx.user ? ctx.user.username : null;
    if (!selfName) {
      return new TL.RpcError({ errorCode: 401, errorMessage: "AUTH_REQUIRED" });
    }
    const title = String(req.title || "").trim().slice(0, 100);
    if (!title) {
      return new TL.RpcError({ errorCode: 400, errorMessage: "TITLE_EMPTY" });
    }
    const chat = {
      id: "c" + chatSeq++,
      tid: nextTid++,
      type: req.broadcast ? "channel" : "group",
      title: title,
      usernames: [selfName],
      createdAt: Date.now(),
      lastMessage: ""
    };
    chats.set(chat.id, chat);
    messages.set(chat.id, []);
    const self = users.get(selfName);
    return new TL.Updates({
      updates: [],
      users: self ? [tlUserFromRecord(self, selfName)] : [],
      chats: [tlChatToTL(chat)],
      date: Math.floor(Date.now() / 1000),
      seq: 0
    });
  },
  "upload.SaveFilePart": async (req, ctx) => {
    const fileId = String(req.fileId);
    const part = Number(req.filePart);
    const bytes = Buffer.isBuffer(req.bytes) ? req.bytes : Buffer.from(req.bytes || []);
    if (!uploadParts.has(fileId)) {
      uploadParts.set(fileId, new Map());
    }
    uploadParts.get(fileId).set(part, bytes);
    return new TLPrimitive.BoolTrue({});
  },
  "upload.GetFile": async (req, ctx) => {
    const loc = req.location;
    if (!loc || !loc.fileReference) {
      return new TL.RpcError({ errorCode: 400, errorMessage: "FILE_REFERENCE_INVALID" });
    }
    const fileId = Buffer.from(loc.fileReference).toString("utf8");
    const file = files.get(fileId);
    if (!file || !fs.existsSync(file.path)) {
      return new TL.RpcError({ errorCode: 404, errorMessage: "FILE_NOT_FOUND" });
    }
    const offset = Number(req.offset) || 0;
    const limit = Math.min(Number(req.limit) || 1048576, 1048576);
    const all = fs.readFileSync(file.path);
    return new TL.upload.File({
      type: new TL.storage.FileUnknown({}),
      mtime: Math.floor(Date.now() / 1000),
      bytes: all.slice(offset, offset + limit)
    });
  },
  "updates.GetDifference": async (req, ctx) => {
    return new TL.updates.DifferenceEmpty({
      date: Math.floor(Date.now() / 1000),
      seq: 0
    });
  }
};

async function tlDispatch(bodyBuffer, ctx) {
  const stream = BytesIO.from(bodyBuffer);
  let obj = await TLObject.read(stream);
  obj = await tlUnwrap(obj);
  if (!obj || !obj.className) {
    return new TL.RpcError({ errorCode: 400, errorMessage: "TL: empty request" }).write();
  }
  const handler = tlHandlers[obj.className];
  if (!handler) {
    console.log("🔀 TL " + obj.className + " — нет обработчика, отвечаем RpcError");
    return new TL.RpcError({ errorCode: 400, errorMessage: "TL: method not implemented: " + obj.className }).write();
  }
  try {
    const result = await handler(obj, ctx);
    return result.write();
  } catch (e) {
    console.log("🔀 TL " + obj.className + " error: " + (e.message || e));
    return new TL.RpcError({ errorCode: 500, errorMessage: "TL: " + (e.message || e) }).write();
  }
}

// ---------- HTTP server ----------
const server = http.createServer(async (req, res) => {
  const url = (req.url || "/").split("?")[0];

  // Регистрация: @username + пароль
  if (url === "/api/register" && req.method === "POST") {
    const data = await readJsonBody(req);
    const username = normalizeUsername(data.username);
    const password = String(data.password || "");
    const name = String(data.name || "").trim().slice(0, 64);
    if (!validUsername(username)) {
      return sendJson(res, 400, { ok: false, error: "Юзернейм: @ + 5-32 символа (a-z, 0-9, _)" });
    }
    if (password.length < 6) {
      return sendJson(res, 400, { ok: false, error: "Пароль — минимум 6 символов" });
    }
    if (users.has(username)) {
      return sendJson(res, 409, { ok: false, error: "Такой @username уже занят" });
    }
    const salt = crypto.randomBytes(8).toString("hex");
    const user = {
      username: username,
      salt: salt,
      hash: hashPassword(password, salt),
      token: makeToken(),
      name: name || username,
      createdAt: Date.now(),
      uid: nextUid,
      accessHash: BigInt(100000000 + nextUid)
    };
    nextUid++;
    users.set(username, user);
    console.log("📝 зарегистрирован " + username);
    return sendJson(res, 200, { ok: true, token: user.token, username: user.username, name: user.name });
  }

  // Вход: @username + пароль
  if (url === "/api/login" && req.method === "POST") {
    const data = await readJsonBody(req);
    const username = normalizeUsername(data.username);
    const password = String(data.password || "");
    const user = users.get(username);
    if (!user || user.hash !== hashPassword(password, user.salt)) {
      return sendJson(res, 401, { ok: false, error: "Неверный @username или пароль" });
    }
    console.log("🔑 вход " + username);
    return sendJson(res, 200, { ok: true, token: user.token, username: user.username, name: user.name });
  }

  // Кто я
  if (url === "/api/me" && req.method === "GET") {
    const user = findUserByToken(getToken(req));
    if (!user) {
      return sendJson(res, 401, { ok: false, error: "Недействительный токен" });
    }
    return sendJson(res, 200, { ok: true, username: user.username, name: user.name });
  }

  // Поиск пользователей по @username / имени
  if (url === "/api/search" && req.method === "GET") {
    let q = "";
    try {
      q = new URL(req.url, "http://localhost").searchParams.get("q") || "";
    } catch (e) { /* ignore */ }
    const needle = normalizeUsername(q).replace(/^@/, "");
    const result = [];
    for (const u of users.values()) {
      const uName = u.username.replace(/^@/, "");
      const uDisplay = (u.name || "").toLowerCase();
      if (!needle || uName.includes(needle) || uDisplay.includes(needle.toLowerCase())) {
        result.push(publicUser(u));
      }
    }
    return sendJson(res, 200, { ok: true, users: result.slice(0, 50) });
  }

  // Список чатов пользователя
  if (url === "/api/chats" && req.method === "GET") {
    const user = findUserByToken(getToken(req));
    if (!user) {
      return sendJson(res, 401, { ok: false, error: "Недействительный токен" });
    }
    const list = [];
    for (const chat of chats.values()) {
      if (chat.usernames.includes(user.username)) {
        list.push(publicChat(chat));
      }
    }
    return sendJson(res, 200, { ok: true, chats: list });
  }

  // Загрузка медиа (фото/видео/голосовое/кружочек)
  if (url === "/api/upload" && req.method === "POST") {
    const user = findUserByToken(getToken(req));
    if (!user) {
      return sendJson(res, 401, { ok: false, error: "Недействительный токен" });
    }
    let buffer;
    try {
      buffer = await readRawBody(req);
    } catch (e) {
      return sendJson(res, 413, { ok: false, error: "Файл слишком большой" });
    }
    const fileId = makeId("f");
    const safeName = String(req.headers["x-file-name"] || "file").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
    const filePath = path.join(UPLOAD_DIR, fileId);
    fs.writeFileSync(filePath, buffer);
    files.set(fileId, {
      id: fileId,
      name: safeName,
      type: req.headers["x-file-type"] || "application/octet-stream",
      size: buffer.length,
      path: filePath,
      owner: user.username,
      nid: nextNid++
    });
    console.log("📎 загружен файл " + safeName + " (" + buffer.length + " байт) от " + user.username);
    return sendJson(res, 200, {
      ok: true,
      fileId: fileId,
      url: "/api/file/" + fileId,
      name: safeName,
      size: buffer.length,
      type: files.get(fileId).type
    });
  }

  // Отдача файла
  if (url.startsWith("/api/file/") && req.method === "GET") {
    const fileId = url.slice("/api/file/".length);
    const file = files.get(fileId);
    if (!file || !fs.existsSync(file.path)) {
      return sendJson(res, 404, { ok: false, error: "Файл не найден" });
    }
    res.writeHead(200, {
      "Content-Type": file.type,
      "Content-Length": file.size,
      "Content-Disposition": 'inline; filename="' + file.name + '"'
    });
    fs.createReadStream(file.path).pipe(res);
    return;
  }

  // TL bridge: бинарный TL-запрос клиента Telegram -> бинарный TL-ответ нашего сервера
  if (url === "/api/tl" && req.method === "POST") {
    if (!TL) {
      res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "TL bridge disabled" }));
      return;
    }
    const user = findUserByToken(getToken(req));
    let body;
    try {
      body = await readRawBody(req);
    } catch (e) {
      res.writeHead(413, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "too large" }));
      return;
    }
    try {
      const out = await tlDispatch(body, { user: user });
      res.writeHead(200, { "Content-Type": "application/x-telegram-tl" });
      res.end(out);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
    return;
  }

  // Health check
  if (url === "/health" || url === "/healthz" || url === "/") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      status: "ok",
      service: "handoff-server",
      uptime: Math.round(process.uptime()),
      online: clients.size,
      users: users.size,
      chats: chats.size
    }));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ status: "not found" }));
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch (e) {
      ws.send(JSON.stringify({ type: "error", message: "Неверный формат сообщения" }));
      return;
    }

    switch (data.type) {
      case "join": {
        // Вход по @username + токен нашего сервера
        const username = normalizeUsername(data.username);
        const user = findUserByToken(String(data.token || ""));
        if (!user || user.username !== username) {
          ws.send(JSON.stringify({ type: "error", message: "Недействительный токен. Сначала войдите." }));
          return;
        }
        let finalName = username;
        let counter = 2;
        const taken = new Set(userList());
        while (taken.has(finalName)) {
          finalName = username + "_" + counter;
          counter++;
        }
        clients.set(ws, { username: finalName });
        ws.send(JSON.stringify({
          type: "joined",
          username: finalName,
          users: userList(),
          time: now(),
          ts: Date.now()
        }));
        broadcast({ type: "system", text: "👋 " + finalName + " в сети", time: now(), ts: Date.now() });
        broadcast({ type: "users", users: userList() });
        break;
      }

      case "chats": {
        const client = clients.get(ws);
        if (!client) {
          ws.send(JSON.stringify({ type: "error", message: "Сначала войдите" }));
          return;
        }
        const list = [];
        for (const chat of chats.values()) {
          if (chat.usernames.includes(client.username)) {
            list.push(publicChat(chat));
          }
        }
        ws.send(JSON.stringify({ type: "chats", chats: list }));
        break;
      }

      case "history": {
        const client = clients.get(ws);
        if (!client) {
          ws.send(JSON.stringify({ type: "error", message: "Сначала войдите" }));
          return;
        }
        const chat = getChat(data.chatId);
        if (!chat || !chat.usernames.includes(client.username)) {
          ws.send(JSON.stringify({ type: "error", message: "Чат не найден" }));
          return;
        }
        const limit = Math.min(parseInt(data.limit, 10) || 100, 500);
        const all = messages.get(chat.id) || [];
        ws.send(JSON.stringify({
          type: "history",
          chatId: chat.id,
          messages: all.slice(-limit).map(publicMessage)
        }));
        break;
      }

      case "createChat": {
        const client = clients.get(ws);
        if (!client) {
          ws.send(JSON.stringify({ type: "error", message: "Сначала войдите" }));
          return;
        }
        const type = ["private", "group", "channel"].includes(data.chatType) ? data.chatType : "private";
        let title = String(data.title || "").trim().slice(0, 100);
        const members = Array.isArray(data.members) ? data.members.map(normalizeUsername).filter(validUsername) : [];
        if (type === "private") {
          if (members.length !== 1 || members[0] === client.username) {
            ws.send(JSON.stringify({ type: "error", message: "Для личного чата нужен один собеседник" }));
            return;
          }
          if (!users.has(members[0])) {
            ws.send(JSON.stringify({ type: "error", message: "Пользователь не найден" }));
            return;
          }
          // Личный чат между двумя юзерами — один на пару
          for (const chat of chats.values()) {
            if (chat.type === "private" &&
                chat.usernames.length === 2 &&
                chat.usernames.includes(client.username) &&
                chat.usernames.includes(members[0])) {
              ws.send(JSON.stringify({ type: "chatCreated", chat: publicChat(chat) }));
              return;
            }
          }
          title = "";
        } else {
          if (!title) {
            ws.send(JSON.stringify({ type: "error", message: "Укажите название" }));
            return;
          }
        }
        const chat = {
          id: "c" + chatSeq++,
          tid: nextTid++,
          type: type,
          title: title,
          usernames: type === "private" ? [client.username, members[0]] : [client.username, ...members],
          createdAt: Date.now(),
          lastMessage: ""
        };
        chats.set(chat.id, chat);
        messages.set(chat.id, []);
        const payload = { type: "chatCreated", chat: publicChat(chat) };
        ws.send(JSON.stringify(payload));
        for (const username of chat.usernames) {
          if (username !== client.username) {
            sendToUser(username, payload);
          }
        }
        break;
      }

      case "search": {
        const client = clients.get(ws);
        if (!client) {
          ws.send(JSON.stringify({ type: "error", message: "Сначала войдите" }));
          return;
        }
        const needle = String(data.q || "").toLowerCase().replace(/^@/, "");
        const result = [];
        for (const u of users.values()) {
          const uName = u.username.replace(/^@/, "");
          if (!needle || uName.includes(needle) || (u.name || "").toLowerCase().includes(needle)) {
            result.push(publicUser(u));
          }
        }
        ws.send(JSON.stringify({ type: "searchResults", users: result.slice(0, 50) }));
        break;
      }

      case "message": {
        const client = clients.get(ws);
        if (!client) {
          ws.send(JSON.stringify({ type: "error", message: "Сначала войдите" }));
          return;
        }
        const text = String(data.text || "").trim().slice(0, 4000);
        let media = null;
        if (data.media && data.media.fileId) {
          const file = files.get(String(data.media.fileId));
          if (file) {
            media = {
              type: data.media.type || "photo",
              fileId: file.id,
              url: "/api/file/" + file.id,
              name: file.name,
              size: file.size
            };
            if (data.media.duration) {
              media.duration = data.media.duration;
            }
          }
        }
        if (!text && !media) return;

        if (data.chatId) {
          // Сообщение в конкретный чат (личный/группа/канал)
          const chat = getChat(data.chatId);
          if (!chat || !chat.usernames.includes(client.username)) {
            ws.send(JSON.stringify({ type: "error", message: "Чат не найден" }));
            return;
          }
          if (chat.type === "channel" && !chat.usernames[0] === false) {
            // в канале пишет только владелец — упрощённо: все участники
          }
          const m = saveMessage(chat.id, client.username, text, media);
          broadcastToChat(chat, { type: "message", message: publicMessage(m) }, null);
        } else {
          // Глобальное сообщение (старый общий чат — обратная совместимость)
          const m = saveMessage("global", client.username, text, media);
          broadcast({ type: "message", message: Object.assign(publicMessage(m), { chatId: "global" }) });
        }
        break;
      }

      case "typing": {
        const client = clients.get(ws);
        if (!client) return;
        if (data.chatId) {
          const chat = getChat(data.chatId);
          if (chat) {
            broadcastToChat(chat, { type: "typing", chatId: chat.id, username: client.username, typing: !!data.typing }, ws);
          }
        } else {
          broadcast({ type: "typing", username: client.username, typing: !!data.typing }, ws);
        }
        break;
      }

      case "ping": {
        ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
        break;
      }

      default:
        break;
    }
  });

  ws.on("close", () => {
    const client = clients.get(ws);
    if (client) {
      clients.delete(ws);
      broadcast({ type: "system", text: "👋 " + client.username + " вышел", time: now(), ts: Date.now() });
      broadcast({ type: "users", users: userList() });
    }
  });

  ws.on("error", () => {
    // cleanup в close
  });
});

// Heartbeat: отключаем мёртвые соединения каждые 30 секунд
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      clients.delete(ws);
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch (e) {
      // ignore
    }
  }
}, 30000);

wss.on("close", () => clearInterval(heartbeat));

server.listen(PORT, HOST, () => {
  console.log("🚀 Handoff server запущен на " + HOST + ":" + PORT);
  console.log("💚 Health: http://localhost:" + PORT + "/health");
  console.log("📝 API: /api/register /api/login /api/me /api/search /api/chats /api/upload /api/file/<id>");
});
