"use strict";
/*
 * Проверка боевого сервера снаружи: health -> register -> login -> TL-вызовы.
 * Запускается в GitHub Actions (у раннера есть прямой интернет).
 *
 *   SERVER_URL=https://... node test/probe-production.js
 */
const BASE = (process.env.SERVER_URL || "https://mwmmw-production.up.railway.app").replace(/\/+$/, "");
const out = [];
function log(s) { console.log(s); out.push(String(s)); }

function req(path_, method, body, token) {
  return new Promise((resolve, reject) => {
    const https = require("https");
    const http = require("http");
    const mod = BASE.startsWith("https") ? https : http;
    const u = new URL(BASE + path_);
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const started = Date.now();
    const r = mod.request({
      hostname: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + (u.search || ""), method: method,
      headers: Object.assign(
        payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {},
        token ? { Authorization: "Bearer " + token } : {}
      ),
      timeout: 20000
    }, (res) => {
      const c = [];
      res.on("data", (d) => c.push(d));
      res.on("end", () => resolve({ code: res.statusCode, body: Buffer.concat(c).toString(), ms: Date.now() - started }));
    });
    r.on("timeout", () => { r.destroy(new Error("TIMEOUT 20s")); });
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function tlPost(token, bytes) {
  return new Promise((resolve, reject) => {
    const https = require("https");
    const u = new URL(BASE + "/api/tl");
    const started = Date.now();
    const r = https.request({
      hostname: u.hostname, port: u.port || 443, path: u.pathname, method: "POST",
      headers: {
        "Content-Type": "application/x-telegram-tl",
        "Content-Length": bytes.length,
        Authorization: "Bearer " + token
      },
      timeout: 20000
    }, (res) => {
      const c = [];
      res.on("data", (d) => c.push(d));
      res.on("end", () => resolve({ code: res.statusCode, buffer: Buffer.concat(c), ms: Date.now() - started }));
    });
    r.on("timeout", () => r.destroy(new Error("TIMEOUT 20s")));
    r.on("error", reject);
    r.write(bytes);
    r.end();
  });
}

(async () => {
  const { Raw: TL, Primitive } = require("@tgsnake/skema");
  const { BytesIO } = require("@tgsnake/bytesio");
  const { TLObject } = require("@tgsnake/skema");

  log("🎯 Сервер: " + BASE);

  // 1. health
  const h = await req("/health", "GET");
  log("1) GET /health → HTTP " + h.code + " (" + h.ms + " мс)\n   " + h.body.slice(0, 200));

  // 2. register
  const nick = "probe" + Math.floor(Math.random() * 1e6);
  const reg = await req("/api/register", "POST", { username: nick, password: "qwerty123", name: "Проба" });
  log("2) POST /api/register (@" + nick + ") → HTTP " + reg.code + " (" + reg.ms + " мс)\n   " + reg.body.slice(0, 200));
  let token = null;
  try { if (JSON.parse(reg.body).ok) token = JSON.parse(reg.body).token; } catch (e) { }

  // 3. login
  const log1 = await req("/api/login", "POST", { username: "@" + nick, password: "qwerty123" });
  log("3) POST /api/login → HTTP " + log1.code + " (" + log1.ms + " мс)\n   " + log1.body.slice(0, 200));
  if (!token) { try { if (JSON.parse(log1.body).ok) token = JSON.parse(log1.body).token; } catch (e) { } }

  if (!token) { log("❌ токен не получен — дальше проверять нечего"); require("fs").writeFileSync(process.env.PROBE_OUT || "/tmp/probe.txt", out.join("\n")); return; }
  log("   токен: " + token.slice(0, 12) + "…");

  // 4. TL-вызовы
  async function call(name, obj) {
    try {
      const r = await tlPost(token, obj.write());
      if (r.code !== 200) { log("   ❌ " + name + " → HTTP " + r.code); return; }
      const parsed = await TLObject.read(BytesIO.from(r.buffer));
      if (parsed.className === "RpcError") log("   ❌ " + name + " → " + parsed.errorCode + " " + parsed.errorMessage);
      else log("   ✅ " + name + " → " + parsed.className + " (" + r.buffer.length + " байт, " + r.ms + " мс)");
    } catch (e) {
      log("   ❌ " + name + " → " + e.message);
    }
  }
  log("4) TL-запросы (родной протокол Telegram):");
  await call("help.getConfig", new TL.help.GetConfig({}));
  await call("users.getFullUser", new TL.users.GetFullUser({ id: new TL.InputUserSelf({}) }));
  await call("messages.getDialogs", new TL.messages.GetDialogs({ excludePinned: false, offsetDate: 0, offsetId: 0, offsetPeer: new TL.InputPeerEmpty({}), limit: 50, hash: 0 }));
  await call("contacts.getContacts", new TL.contacts.GetContacts({ hash: 0 }));
  await call("updates.getState", new TL.updates.GetState({}));

  // 5. WebSocket
  try {
    const WebSocket = require("ws");
    const ws = new WebSocket(BASE.replace(/^http/, "ws") + "/ws?token=" + token);
    await new Promise((res) => {
      const t = setTimeout(() => { log("5) WebSocket → ❌ таймаут 10 с"); try { ws.close(); } catch (e) { } res(); }, 10000);
      ws.on("open", () => { clearTimeout(t); log("5) WebSocket → ✅ соединение установлено"); try { ws.close(); } catch (e) { } res(); });
      ws.on("error", (e) => { clearTimeout(t); log("5) WebSocket → ❌ " + e.message); res(); });
    });
  } catch (e) {
    log("5) WebSocket → ❌ " + e.message);
  }

  log("\n ГОТОВО");
  require("fs").writeFileSync(process.env.PROBE_OUT || "/tmp/probe.txt", out.join("\n"));
})().catch((e) => {
  log("💥 УПАЛ ПРОБНИК: " + (e && e.stack || e));
  require("fs").writeFileSync(process.env.PROBE_OUT || "/tmp/probe.txt", out.join("\n"));
});
