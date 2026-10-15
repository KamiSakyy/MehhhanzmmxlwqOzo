"use strict";
/*
 * Хранилище нашего сервера: пользователи (@username + пароль), личные чаты,
 * группы, каналы, сообщения (текст/фото/видео/голосовые/кружочки/файлы),
 * файлы, прочитанность, онлайн-статусы.
 * Всё persisted в data/db.json (снимок пишется с задержкой), медиа — в data/uploads.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/*
 * Где живут данные.
 * В Docker файловая система контейнера ephemeral: при каждом деплое Railway
 * создаёт НОВЫЙ контейнер, и всё, что записано внутрь, исчезает (аккаунты, чаты,
 * сообщения). Поэтому:
 *   1) если примонтирован Railway Volume (переменная RAILWAY_VOLUME_MOUNT_PATH) —
 *      пишем туда, данные переживают любые деплои;
 *   2) иначе — в DATA_DIR (по умолчанию /app/data в Docker, ./data локально).
 * Чтобы данные не пропадали, в Railway нужно добавить Volume с mount path = /app/data.
 */
const DATA_DIR = process.env.DATA_DIR
  || (process.env.RAILWAY_VOLUME_MOUNT_PATH ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, "data") : null)
  || path.join(__dirname, "..", "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const DB_FILE = path.join(DATA_DIR, "db.json");

try {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  console.log("💾 Данные: " + DB_FILE + (process.env.RAILWAY_VOLUME_MOUNT_PATH ? " (Railway Volume — сохраняется между деплоями)" : " (ВНИМАНИЕ: без Volume данные сотрутся при деплое!)"));
} catch (e) {
  console.error("⚠️ не смогли создать " + UPLOAD_DIR + ": " + e.message);
}

const db = {
  users: {},       // uid(string) -> user
  usernames: {},   // "@name" -> uid(string)
  chats: {},       // chatId(string) -> chat
  messages: {},    // chatId(string) -> [message]
  files: {},       // fileId(string) -> file meta
  read: {},        // chatId -> { uid: lastReadMessageId }
  typing: {},      // chatId -> { uid: ts }   (только в памяти)
  presence: {},    // uid -> { online, lastSeen } (lastSeen хранится)
  pending: {},     // uploadId -> { parts: {n: Buffer}, name, mime, size }
  counters: { user: 100, chat: 1000, channel: 1000000, message: 1, file: 1 },
  tokens: {}       // token -> uid(string)
};

// ---------------- загрузка / сохранение ----------------
function load() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
      Object.assign(db, raw);
      for (const key of ["users", "usernames", "chats", "messages", "files", "read", "presence", "counters", "tokens"]) {
        if (!db[key]) db[key] = {};
      }
      db.pending = {};
      db.typing = {};
      if (!db.counters.user) db.counters = { user: 100, chat: 1000, channel: 1000000, message: 1, file: 1 };
    }
  } catch (e) {
    console.error("⚠️ не смогли прочитать db.json:", e.message);
  }
  console.log("📂 Загружено из базы: пользователей " + Object.keys(db.users).length +
    ", чатов " + Object.keys(db.chats).length +
    ", сообщений " + Object.values(db.messages).reduce((a, m) => a + (m ? m.length : 0), 0) +
    ", файлов " + Object.keys(db.files).length +
    ", сессий " + Object.keys(db.tokens).length);
}

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const snapshot = {
        users: db.users,
        usernames: db.usernames,
        chats: db.chats,
        messages: db.messages,
        files: db.files,
        read: db.read,
        presence: db.presence,
        counters: db.counters,
        tokens: db.tokens
      };
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = DB_FILE + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(snapshot));
      fs.renameSync(tmp, DB_FILE);
    } catch (e) {
      console.error("⚠️ не смогли записать db.json:", e.message);
    }
  }, 400);
}

// ---------------- утилиты ----------------
function normUsername(raw) {
  let u = String(raw || "").trim().toLowerCase().replace(/^@+/, "");
  return u ? "@" + u : "";
}

function validUsername(u) {
  return /^@[a-z0-9_]{3,32}$/.test(u);
}

function hashPassword(password, salt) {
  return crypto.createHash("sha256").update(salt + ":" + String(password)).digest("hex");
}

function newToken() {
  return crypto.randomBytes(24).toString("hex");
}

function randomLong() {
  // знаковое int64 — как в TL
  return BigInt.asIntN(64, BigInt("0x" + crypto.randomBytes(8).toString("hex")));
}

// ---------------- пользователи ----------------
function getUser(uid) {
  return db.users[String(uid)] || null;
}

function getUserByName(username) {
  const uid = db.usernames[normUsername(username)];
  return uid == null ? null : getUser(uid);
}

function getUserByToken(token) {
  if (!token) return null;
  const uid = db.tokens[String(token)];
  return uid == null ? null : getUser(uid);
}

function createUser(username, password, name) {
  const uname = normUsername(username);
  const uid = String(++db.counters.user);
  const salt = crypto.randomBytes(8).toString("hex");
  const user = {
    uid: uid,
    username: uname,
    name: String(name || uname.replace(/^@/, "")).slice(0, 64),
    lastName: "",
    about: "",
    salt: salt,
    hash: hashPassword(password, salt),
    accessHash: randomLong().toString(),
    photoId: 0,
    createdAt: Date.now(),
    lastSeen: Date.now()
  };
  db.users[uid] = user;
  db.usernames[uname] = uid;
  save();
  return user;
}

function issueToken(user) {
  // один активный токен на пользователя
  for (const t of Object.keys(db.tokens)) {
    if (db.tokens[t] === user.uid) delete db.tokens[t];
  }
  const token = newToken();
  db.tokens[token] = user.uid;
  save();
  return token;
}

function checkPassword(user, password) {
  return !!user && user.hash === hashPassword(password, user.salt);
}

function searchUsers(query, limit) {
  const q = normUsername(query).replace(/^@/, "").toLowerCase();
  const out = [];
  for (const uid of Object.keys(db.users)) {
    const u = db.users[uid];
    if (!q || u.username.replace(/^@/, "").includes(q) || (u.name || "").toLowerCase().includes(q)) {
      out.push(u);
      if (out.length >= (limit || 50)) break;
    }
  }
  return out;
}

// ---------------- чаты (личные / группы / каналы) ----------------
function getChat(chatId) {
  return db.chats[String(chatId)] || null;
}

function privateKey(a, b) {
  const x = String(a), y = String(b);
  return x < y ? x + ":" + y : y + ":" + x;
}

function findPrivateChat(a, b) {
  const key = privateKey(a, b);
  for (const id of Object.keys(db.chats)) {
    const c = db.chats[id];
    if (c.type === "private" && c.pkey === key) return c;
  }
  return null;
}

function getOrCreatePrivateChat(a, b) {
  const existing = findPrivateChat(a, b);
  if (existing) return existing;
  const id = String(++db.counters.chat);
  const chat = {
    id: id,
    type: "private",
    pkey: privateKey(a, b),
    title: "",
    about: "",
    creator: String(a),
    members: [String(a), String(b)],
    admins: [],
    photoId: 0,
    createdAt: Date.now()
  };
  db.chats[id] = chat;
  db.messages[id] = [];
  save();
  return chat;
}

function createChat(type, title, members, creator, about, username) {
  const id = String(type === "channel" ? ++db.counters.channel : ++db.counters.chat);
  const uniq = [];
  for (const m of members) {
    const s = String(m);
    if (!uniq.includes(s)) uniq.push(s);
  }
  if (!uniq.includes(String(creator))) uniq.unshift(String(creator));
  const chat = {
    id: id,
    type: type, // "group" | "channel"
    title: String(title || "").slice(0, 128),
    about: String(about || ""),
    username: username ? normUsername(username) : "",
    creator: String(creator),
    members: uniq,
    admins: [String(creator)],
    megagroup: type === "channel" ? true : false,  // группы = супергруппы
    broadcast: type === "channel" ? false : true, // канал = broadcast
    photoId: 0,
    createdAt: Date.now(),
    pinned: []
  };
  db.chats[id] = chat;
  db.messages[id] = [];
  save();
  return chat;
}

function chatsOf(uid) {
  const out = [];
  for (const id of Object.keys(db.chats)) {
    const c = db.chats[id];
    if (c.members && c.members.includes(String(uid))) out.push(c);
  }
  return out;
}

function lastMessageOf(chatId) {
  const list = db.messages[String(chatId)] || [];
  for (let i = list.length - 1; i >= 0; i--) {
    if (!list[i].deleted) return list[i];
  }
  return null;
}

function unreadCount(chatId, uid) {
  const chat = getChat(chatId);
  if (!chat) return 0;
  const list = db.messages[String(chatId)] || [];
  const lastRead = (db.read[String(chatId)] || {})[String(uid)] || 0;
  let n = 0;
  for (const m of list) {
    if (m.deleted) continue;
    if (String(m.fromUid) === String(uid)) continue;
    if (m.id > lastRead) n++;
  }
  return n;
}

function markRead(chatId, uid, upToId) {
  const cid = String(chatId);
  if (!db.read[cid]) db.read[cid] = {};
  const prev = db.read[cid][String(uid)] || 0;
  const list = db.messages[cid] || [];
  let maxId = upToId;
  if (maxId == null) {
    maxId = 0;
    for (const m of list) if (m.id > maxId) maxId = m.id;
  }
  if (maxId > prev) {
    db.read[cid][String(uid)] = maxId;
    save();
  }
  return db.read[cid][String(uid)];
}

function readMaxId(chatId, uid, outgoing) {
  const cid = String(chatId);
  if (outgoing) {
    const list = db.messages[cid] || [];
    let last = 0;
    for (const m of list) if (String(m.fromUid) === String(uid) && m.id > last) last = m.id;
    return last;
  }
  return (db.read[cid] || {})[String(uid)] || 0;
}

// ---------------- сообщения ----------------
function addMessage(chatId, fromUid, fields) {
  const cid = String(chatId);
  if (!db.messages[cid]) db.messages[cid] = [];
  const msg = Object.assign({
    id: ++db.counters.message,
    chatId: cid,
    fromUid: String(fromUid),
    date: Math.floor(Date.now() / 1000),
    text: "",
    media: null,
    entities: [],
    replyTo: 0,
    replyToTop: 0,
    forwardFrom: null,
    reactions: {},
    views: 0,
    viewedBy: [],
    edited: false,
    editDate: 0,
    deleted: false,
    pinned: false,
    groupedId: 0,
    randomId: 0,
    silent: false
  }, fields || {});
  db.messages[cid].push(msg);
  save();
  return msg;
}

function getMessage(chatId, msgId) {
  const list = db.messages[String(chatId)] || [];
  for (const m of list) if (m.id === Number(msgId)) return m;
  return null;
}

function getMessages(chatId, opts) {
  opts = opts || {};
  const list = (db.messages[String(chatId)] || []).filter((m) => (opts.includeDeleted ? true : !m.deleted));
  let out = list;
  if (opts.beforeId) out = out.filter((m) => m.id < Number(opts.beforeId));
  if (opts.afterId) out = out.filter((m) => m.id > Number(opts.afterId));
  if (opts.ids) out = out.filter((m) => opts.ids.includes(m.id));
  out = out.slice().sort((a, b) => b.id - a.id);
  if (opts.limit) out = out.slice(0, Number(opts.limit));
  return out.reverse();
}

// ---------------- файлы и медиа ----------------
function saveFile(buffer, meta) {
  const id = String(++db.counters.file);
  const filePath = path.join(UPLOAD_DIR, id);
  fs.writeFileSync(filePath, buffer);
  const file = {
    id: id,
    name: String((meta && meta.name) || "file").slice(0, 180),
    mime: String((meta && meta.mime) || "application/octet-stream"),
    size: buffer.length,
    path: filePath,
    width: meta && meta.width ? Number(meta.width) : 0,
    height: meta && meta.height ? Number(meta.height) : 0,
    duration: meta && meta.duration ? Number(meta.duration) : 0,
    kind: (meta && meta.kind) || "document", // photo|video|voice|video_note|document|audio|sticker
    thumbId: (meta && meta.thumbId) || 0,
    owner: (meta && meta.owner) || "",
    createdAt: Date.now()
  };
  db.files[id] = file;
  save();
  return file;
}

function getFile(id) {
  return db.files[String(id)] || null;
}

function fileBytes(id, offset, limit) {
  const file = getFile(id);
  if (!file || !fs.existsSync(file.path)) return null;
  const size = fs.statSync(file.path).size;
  const start = Math.max(0, Math.min(offset || 0, size));
  const end = limit && limit > 0 ? Math.min(size, start + limit) : size;
  const buf = Buffer.alloc(Math.max(0, end - start));
  const fd = fs.openSync(file.path, "r");
  try {
    fs.readSync(fd, buf, 0, buf.length, start);
  } finally {
    fs.closeSync(fd);
  }
  return { buffer: buf, size: size, complete: end >= size };
}

// ---------------- загрузка по частям (MTProto upload.saveFilePart) ----------------
function putPendingPart(uploadId, part, buffer, meta) {
  if (!db.pending[uploadId]) {
    db.pending[uploadId] = { parts: {}, meta: meta || {} };
  }
  if (meta) db.pending[uploadId].meta = Object.assign(db.pending[uploadId].meta, meta);
  db.pending[uploadId].parts[String(part)] = buffer;
  return db.pending[uploadId];
}

function takePending(uploadId) {
  const p = db.pending[uploadId];
  if (!p) return null;
  const keys = Object.keys(p.parts).map(Number).sort((a, b) => a - b);
  const buffers = keys.map((k) => p.parts[String(k)]);
  if (buffers.length === 0) return null;
  const buffer = Buffer.concat(buffers);
  delete db.pending[uploadId];
  return { buffer: buffer, meta: p.meta, parts: keys.length };
}

function peekPending(uploadId) {
  return db.pending[uploadId] || null;
}

// ---------------- присутствие ----------------
function setOnline(uid, online) {
  const key = String(uid);
  if (!db.presence[key]) db.presence[key] = { online: false, lastSeen: Date.now() };
  db.presence[key].online = !!online;
  if (!online) db.presence[key].lastSeen = Date.now();
}

function isOnline(uid) {
  const p = db.presence[String(uid)];
  return !!(p && p.online);
}

function lastSeen(uid) {
  const p = db.presence[String(uid)];
  return p ? Math.floor((p.online ? Date.now() : p.lastSeen) / 1000) : 0;
}

module.exports = {
  db: db,
  DATA_DIR: DATA_DIR,
  UPLOAD_DIR: UPLOAD_DIR,
  load: load,
  save: save,
  normUsername: normUsername,
  validUsername: validUsername,
  hashPassword: hashPassword,
  randomLong: randomLong,
  getUser: getUser,
  getUserByName: getUserByName,
  getUserByToken: getUserByToken,
  createUser: createUser,
  issueToken: issueToken,
  checkPassword: checkPassword,
  searchUsers: searchUsers,
  getChat: getChat,
  findPrivateChat: findPrivateChat,
  getOrCreatePrivateChat: getOrCreatePrivateChat,
  createChat: createChat,
  chatsOf: chatsOf,
  lastMessageOf: lastMessageOf,
  unreadCount: unreadCount,
  markRead: markRead,
  readMaxId: readMaxId,
  addMessage: addMessage,
  getMessage: getMessage,
  getMessages: getMessages,
  saveFile: saveFile,
  getFile: getFile,
  fileBytes: fileBytes,
  putPendingPart: putPendingPart,
  takePending: takePending,
  peekPending: peekPending,
  setOnline: setOnline,
  isOnline: isOnline,
  lastSeen: lastSeen
};
