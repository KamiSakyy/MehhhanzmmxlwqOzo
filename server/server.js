"use strict";

const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");

const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

/** @type {Map<WebSocket, {username: string}>} */
const clients = new Map();

function pad(n) {
  return n < 10 ? "0" + n : "" + n;
}

function now() {
  const d = new Date();
  return pad(d.getHours()) + ":" + pad(d.getMinutes());
}

function userList() {
  const list = [];
  for (const c of clients.values()) list.push(c.username);
  return list;
}

function broadcast(payload, except) {
  const data = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client !== except && client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

function systemMessage(text) {
  broadcast({ type: "system", text: text, time: now(), ts: Date.now() });
}

const server = http.createServer((req, res) => {
  const url = (req.url || "/").split("?")[0];
  if (url === "/health" || url === "/healthz" || url === "/") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      status: "ok",
      service: "messenger-server",
      uptime: Math.round(process.uptime()),
      online: clients.size
    }));
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ status: "not found" }));
});

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
        const username = String(data.username || "").trim().slice(0, 24);
        if (username.length < 2) {
          ws.send(JSON.stringify({ type: "error", message: "Имя должно быть минимум 2 символа" }));
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
        systemMessage("👋 " + finalName + " присоединился к чату");
        broadcast({ type: "users", users: userList() });
        break;
      }
      case "message": {
        const client = clients.get(ws);
        if (!client) {
          ws.send(JSON.stringify({ type: "error", message: "Сначала войдите в чат" }));
          return;
        }
        const text = String(data.text || "").trim().slice(0, 2000);
        if (!text) return;
        broadcast({
          type: "message",
          username: client.username,
          text: text,
          time: now(),
          ts: Date.now()
        });
        break;
      }
      case "typing": {
        const client = clients.get(ws);
        if (!client) return;
        broadcast({ type: "typing", username: client.username, typing: !!data.typing }, ws);
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
      systemMessage("👋 " + client.username + " покинул чат");
      broadcast({ type: "users", users: userList() });
    }
  });

  ws.on("error", () => {
    // ignore socket errors, close event will handle cleanup
  });
});

// Heartbeat: drop dead connections every 30 seconds
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
  console.log("🚀 Messenger server запущен на " + HOST + ":" + PORT);
  console.log("💚 Health check: http://localhost:" + PORT + "/health");
});
