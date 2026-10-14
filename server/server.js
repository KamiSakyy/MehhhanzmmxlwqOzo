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
const files = new Map();    // fileId -> { id, name, type, size, path, owner }
const clients = new Map();  // WebSocket -> { username }

let chatSeq = 1;
let msgSeq = 1;
let fileSeq = 1;
let nextUid = 1001;

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
      owner: user.username
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
