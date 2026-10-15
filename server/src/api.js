"use strict";
/*
 * REST-часть сервера: регистрация/вход по @username + паролю (экран входа Telegram),
 * загрузка/отдача файлов, поиск людей, список чатов. Всё это использует наш
 * переделанный экран входа и обычные HTTP-клиенты.
 */

const fs = require("fs");
const store = require("./store");

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 5e6) req.destroy();
    });
    req.on("end", () => {
      try { resolve(JSON.parse(body)); } catch (e) { resolve({}); }
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
      if (size > 400e6) { req.destroy(); reject(new Error("too large")); }
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function query(req, key) {
  try {
    return new URL(req.url, "http://localhost").searchParams.get(key);
  } catch (e) {
    return null;
  }
}

function getToken(req) {
  const auth = req.headers["authorization"] || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7);
  if (auth.startsWith("Bearer")) return auth.slice(6);
  return query(req, "token") || "";
}

function publicUser(u, self) {
  return {
    uid: Number(u.uid),
    id: Number(u.uid),
    username: u.username,
    name: u.name,
    lastName: u.lastName || "",
    about: u.about || "",
    accessHash: String(u.accessHash || u.uid),
    photoId: u.photoId || 0,
    online: store.isOnline(u.uid),
    self: !!self,
    lastSeen: store.lastSeen(u.uid)
  };
}

function publicChat(chat, uid) {
  const last = store.lastMessageOf(chat.id);
  return {
    id: String(chat.id),
    type: chat.type,
    title: chat.title || "",
    about: chat.about || "",
    username: chat.username || "",
    members: chat.members || [],
    unread: store.unreadCount(chat.id, uid),
    photoId: chat.photoId || 0,
    lastMessage: last ? { id: last.id, from: last.fromUid, text: last.text, media: last.media, ts: last.date } : null
  };
}

async function handle(req, res) {
  const url = (req.url || "/").split("?")[0];

  // ---------- регистрация: @username + пароль ----------
  if (url === "/api/register" && req.method === "POST") {
    const data = await readJsonBody(req);
    const username = store.normUsername(data.username);
    const password = String(data.password || "");
    const name = String(data.name || "").trim();
    if (!store.validUsername(username)) {
      return sendJson(res, 400, { ok: false, error: "@username: 5–32 символа (a–z, 0–9, _)" });
    }
    if (password.length < 6) {
      return sendJson(res, 400, { ok: false, error: "Пароль — минимум 6 символов" });
    }
    if (store.getUserByName(username)) {
      return sendJson(res, 409, { ok: false, error: "Такой @username уже занят" });
    }
    const user = store.createUser(username, password, name || username.replace(/^@/, ""));
    const token = store.issueToken(user);
    return sendJson(res, 200, { ok: true, token: token, user: publicUser(user, true) });
  }

  // ---------- вход: @username + пароль ----------
  if (url === "/api/login" && req.method === "POST") {
    const data = await readJsonBody(req);
    const username = store.normUsername(data.username);
    const user = store.getUserByName(username);
    if (!user || !store.checkPassword(user, String(data.password || ""))) {
      return sendJson(res, 401, { ok: false, error: "Неверный @username или пароль" });
    }
    const token = store.issueToken(user);
    store.setOnline(user.uid, false);
    return sendJson(res, 200, { ok: true, token: token, user: publicUser(user, true) });
  }

  // ---------- выход ----------
  if (url === "/api/logout" && req.method === "POST") {
    const user = store.getUserByToken(getToken(req));
    if (user) {
      delete store.db.tokens[getToken(req)];
      store.setOnline(user.uid, false);
      store.save();
    }
    return sendJson(res, 200, { ok: true });
  }

  // ---------- кто я ----------
  if (url === "/api/me" && req.method === "GET") {
    const user = store.getUserByToken(getToken(req));
    if (!user) return sendJson(res, 401, { ok: false, error: "Недействительный токен" });
    return sendJson(res, 200, { ok: true, user: publicUser(user, true) });
  }

  // ---------- обновить профиль ----------
  if (url === "/api/me" && (req.method === "PATCH" || req.method === "POST")) {
    const user = store.getUserByToken(getToken(req));
    if (!user) return sendJson(res, 401, { ok: false, error: "Недействительный токен" });
    const data = await readJsonBody(req);
    if (data.name !== undefined) user.name = String(data.name).slice(0, 64);
    if (data.lastName !== undefined) user.lastName = String(data.lastName).slice(0, 64);
    if (data.about !== undefined) user.about = String(data.about).slice(0, 255);
    if (data.photoId !== undefined) user.photoId = Number(data.photoId) || 0;
    store.save();
    return sendJson(res, 200, { ok: true, user: publicUser(user, true) });
  }

  // ---------- загрузка файла ----------
  if (url === "/api/upload" && req.method === "POST") {
    const user = store.getUserByToken(getToken(req));
    if (!user) return sendJson(res, 401, { ok: false, error: "Недействительный токен" });
    let buffer;
    try {
      buffer = await readRawBody(req);
    } catch (e) {
      return sendJson(res, 413, { ok: false, error: "Файл слишком большой" });
    }
    if (!buffer.length) return sendJson(res, 400, { ok: false, error: "Пустой файл" });
    const file = store.saveFile(buffer, {
      name: query(req, "name") || req.headers["x-file-name"] || "file",
      mime: query(req, "mime") || req.headers["x-file-type"] || req.headers["content-type"] || "application/octet-stream",
      kind: query(req, "kind") || "document",
      duration: Number(query(req, "duration") || 0),
      width: Number(query(req, "width") || 0),
      height: Number(query(req, "height") || 0),
      owner: user.uid
    });
    return sendJson(res, 200, {
      ok: true,
      file: { id: file.id, name: file.name, mime: file.mime, size: file.size, kind: file.kind, url: "/api/file/" + file.id }
    });
  }

  // ---------- отдача файла (с поддержкой Range — видео стримится) ----------
  if (url.startsWith("/api/file/") && (req.method === "GET" || req.method === "HEAD")) {
    const fileId = url.slice("/api/file/".length);
    const file = store.getFile(fileId);
    if (!file || !fs.existsSync(file.path)) {
      return sendJson(res, 404, { ok: false, error: "Файл не найден" });
    }
    const size = fs.statSync(file.path).size;
    const range = req.headers.range;
    const headers = {
      "Content-Type": file.mime || "application/octet-stream",
      "Accept-Ranges": "bytes",
      "Content-Disposition": "inline; filename=\"" + encodeURIComponent(file.name) + "\"",
      "Cache-Control": "public, max-age=31536000"
    };
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const start = m && m[1] ? parseInt(m[1], 10) : 0;
      const end = m && m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1;
      headers["Content-Range"] = "bytes " + start + "-" + end + "/" + size;
      headers["Content-Length"] = end - start + 1;
      res.writeHead(206, headers);
      if (req.method === "HEAD") return res.end();
      fs.createReadStream(file.path, { start: start, end: end }).pipe(res);
      return;
    }
    headers["Content-Length"] = size;
    res.writeHead(200, headers);
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file.path).pipe(res);
    return;
  }

  // ---------- поиск людей ----------
  if (url === "/api/search" && req.method === "GET") {
    const user = store.getUserByToken(getToken(req));
    if (!user) return sendJson(res, 401, { ok: false, error: "Недействительный токен" });
    const q = query(req, "q") || "";
    const users = store.searchUsers(q, 50).map((u) => publicUser(u, u.uid === user.uid));
    return sendJson(res, 200, { ok: true, users: users });
  }

  // ---------- список чатов ----------
  if (url === "/api/chats" && req.method === "GET") {
    const user = store.getUserByToken(getToken(req));
    if (!user) return sendJson(res, 401, { ok: false, error: "Недействительный токен" });
    const chats = store.chatsOf(user.uid)
      .sort((a, b) => {
        const la = store.lastMessageOf(a.id), lb = store.lastMessageOf(b.id);
        return (lb ? lb.id : 0) - (la ? la.id : 0);
      })
      .map((c) => publicChat(c, user.uid));
    return sendJson(res, 200, { ok: true, chats: chats });
  }

  // ---------- health ----------
  if (url === "/health" || url === "/healthz" || url === "/") {
    return sendJson(res, 200, {
      status: "ok",
      service: "handoff-server (Telegram на нашем сервере)",
      uptime: Math.round(process.uptime()),
      users: Object.keys(store.db.users).length,
      chats: Object.keys(store.db.chats).length,
      messages: Object.keys(store.db.messages).reduce((a, k) => a + store.db.messages[k].length, 0),
      files: Object.keys(store.db.files).length,
      online: require("./ws").onlineCount()
    });
  }

  return sendJson(res, 404, { status: "not found" });
}

module.exports = { handle: handle, publicUser: publicUser, publicChat: publicChat };
