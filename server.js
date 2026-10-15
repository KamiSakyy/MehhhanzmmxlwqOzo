"use strict";
process.env.LOGLEVEL = process.env.LOGLEVEL || "none"; // не спамим логами skema
/*
 * НАШ СЕРВЕР для Telegram (DrKLO, LAYER 231).
 *
 * Ни одного запроса к серверам Telegram. Клиент шлёт родные TL-запросы сюда,
 * мы отвечаем родными же TL-объектами, а реальное время (сообщения, «печатает»,
 * онлайн) прилетает по WebSocket.
 */

const http = require("http");
const { WebSocketServer } = require("ws");
const { Primitive } = require("@tgsnake/skema");

const store = require("./src/store");
const tl = require("./src/tl");
const api = require("./src/api");
const methods = require("./src/methods");
const ws = require("./src/ws");

const PORT = Number(process.env.PORT || 3000);
const HOST = "0.0.0.0";

store.load();
ensureDefaults();

function ensureDefaults() {
  // системный пользователь для help.getSupport
  if (!store.getUser("1")) {
    store.db.users["1"] = {
      uid: "1", username: "@support", name: "Поддержка", lastName: "", about: "Служба поддержки",
      salt: "0", hash: "x", accessHash: "1", photoId: 0, createdAt: Date.now(), lastSeen: Date.now()
    };
    store.db.usernames["@support"] = "1";
    store.save();
  }
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size > 200e6) { req.destroy(); reject(new Error("too large")); }
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

function binary(res, buffer) {
  res.writeHead(200, {
    "Content-Type": "application/x-telegram-tl",
    "Content-Length": buffer.length
  });
  res.end(buffer);
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || "/").split("?")[0];

  // ---------- MTProto-мост: родной TL клиента Telegram <-> наш сервер ----------
  if (url === "/api/tl" && req.method === "POST") {
    const started = Date.now();
    let body;
    try {
      body = await readRawBody(req);
    } catch (e) {
      return binary(res, tl.errorBuffer(413, "REQUEST_TOO_LARGE"));
    }
    const token = getToken(req);
    const user = store.getUserByToken(token);

    if (!user) {
      return binary(res, tl.errorBuffer(401, "AUTH_KEY_UNREGISTERED"));
    }
    const ctx = { user: user, uid: String(user.uid), token: token };

    let obj;
    try {
      obj = await tl.readObject(body);
    } catch (e) {
      console.log("🔀 TL: не смогли разобрать запрос:", e.message);
      return binary(res, tl.errorBuffer(400, "TL_DESERIALIZE_ERROR"));
    }
    if (!obj || !obj.className) {
      return binary(res, tl.errorBuffer(400, "TL_EMPTY_REQUEST"));
    }

    const out = await methods.dispatch(ctx, obj);
    let buffer;
    if (out.error) {
      buffer = tl.errorBuffer(out.error.code, out.error.text);
    } else {
      try {
        buffer = Array.isArray(out.result) ? Primitive.Vector.write(out.result) : tl.writeObject(out.result);
      } catch (e) {
        console.error("💥 TL " + obj.className + " не сериализуется:", e.message);
        buffer = tl.errorBuffer(500, "SERIALIZE_ERROR");
      }
    }
    if (process.env.TL_LOG === "1") {
      console.log("🔀 TL " + obj.className + " -> " + (out.error ? "error " + out.error.text : "ok") +
        " (" + buffer.length + " байт, " + (Date.now() - started) + " мс)");
    }
    return binary(res, buffer);
  }

  // ---------- WebSocket: реальное время ----------
  if (url === "/ws" || url === "/api/ws") {
    res.writeHead(426, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "upgrade required" }));
    return;
  }

  return api.handle(req, res);
});

const wss = new WebSocketServer({ server: server, path: "/ws" });
ws.attach(wss);

server.listen(PORT, HOST, () => {
  console.log("🚀 Наш сервер запущен: " + HOST + ":" + PORT);
  console.log("💚 Health:  http://localhost:" + PORT + "/health");
  console.log("🔌 TL-мост: POST http://localhost:" + PORT + "/api/tl (Authorization: Bearer <token>)");
  console.log("📡 Realtime: ws://localhost:" + PORT + "/ws?token=<token>");
  console.log("🔑 REST: /api/register /api/login /api/me /api/upload /api/file/<id> /api/search /api/chats");
});
