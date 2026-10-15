"use strict";
/*
 * Realtime: WebSocket-канал для клиента Telegram.
 * По нему клиент получает родные TL-обновления: новые сообщения, «печатает»,
 * прочитанность, онлайн-статусы, удаления, реакции.
 */

const WebSocket = require("ws");
const store = require("./store");
const tl = require("./tl");

const sockets = new Map(); // ws -> { uid, token }
const byUser = new Map();  // uid -> Set(ws)

function add(uid, ws) {
  if (!byUser.has(String(uid))) byUser.set(String(uid), new Set());
  byUser.get(String(uid)).add(ws);
}

function drop(ws) {
  const info = sockets.get(ws);
  if (info) {
    const set = byUser.get(String(info.uid));
    if (set) {
      set.delete(ws);
      if (set.size === 0) {
        byUser.delete(String(info.uid));
        store.setOnline(info.uid, false);
        broadcastStatus(info.uid);
      }
    }
    sockets.delete(ws);
  }
}

function send(ws, obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    const buf = obj.write ? obj.write() : Buffer.from(obj);
    ws.send(buf, { binary: true });
    return true;
  } catch (e) {
    console.error("⚠️ ws send:", e.message);
    return false;
  }
}

function sendToUser(uid, obj) {
  const set = byUser.get(String(uid));
  if (!set || set.size === 0) return 0;
  let n = 0;
  for (const ws of set) if (send(ws, obj)) n++;
  return n;
}

function broadcast(obj, exceptUid) {
  for (const uid of byUser.keys()) {
    if (String(uid) === String(exceptUid)) continue;
    sendToUser(uid, obj);
  }
}

function broadcastStatus(uid) {
  const status = tl.userStatus(uid);
  const upd = tl.updates([new tl.TL.UpdateUserStatus({ userId: tl.big(uid), status: status })], [], []);
  // шлём тем, с кем есть общие чаты
  const targets = new Set();
  for (const chat of store.chatsOf(uid)) {
    for (const m of (chat.members || [])) targets.add(String(m));
  }
  for (const uid2 of targets) {
    if (String(uid2) === String(uid)) continue;
    sendToUser(uid2, upd);
  }
}

function attach(wss) {
  wss.on("connection", (ws, req) => {
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });

    // токен можно передать сразу в query: wss://…/ws?token=…
    let token = "";
    try {
      const url = new URL(req.url || "/", "http://localhost");
      token = url.searchParams.get("token") || "";
    } catch (e) { /* ignore */ }

    ws.on("message", (raw) => {
      let data;
      if (Buffer.isBuffer(raw) && raw.length >= 4) {
        // бинарный ping клиента — игнорируем
        return;
      }
      try {
        data = JSON.parse(raw.toString());
      } catch (e) {
        return;
      }
      if (data.type === "auth" || data.type === "hello") {
        const user = store.getUserByToken(String(data.token || token || ""));
        if (!user) {
          ws.send(JSON.stringify({ type: "error", message: "bad token" }));
          return;
        }
        sockets.set(ws, { uid: String(user.uid), token: String(data.token || token) });
        add(user.uid, ws);
        store.setOnline(user.uid, true);
        broadcastStatus(user.uid);
        ws.send(JSON.stringify({ type: "ok", uid: user.uid, username: user.username }));
        return;
      }
      if (data.type === "ping") {
        ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
        return;
      }
    });

    ws.on("close", () => drop(ws));
    ws.on("error", () => drop(ws));
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        drop(ws);
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch (e) { /* ignore */ }
    }
  }, 30000);
  wss.on("close", () => clearInterval(heartbeat));
}

module.exports = {
  attach: attach,
  send: send,
  sendToUser: sendToUser,
  broadcast: broadcast,
  broadcastStatus: broadcastStatus,
  onlineCount: () => byUser.size
};
