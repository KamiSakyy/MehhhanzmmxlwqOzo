"use strict";
process.env.LOGLEVEL = process.env.LOGLEVEL || "none";
process.env.DATA_DIR = require("path").join(__dirname, "..", "test-data-dbg");
process.env.PORT = process.env.PORT || "3997";
require("fs").rmSync(process.env.DATA_DIR, { recursive: true, force: true });

const http = require("http");
const { Raw: TL } = require("@tgsnake/skema");
require("../server.js");

const PORT = Number(process.env.PORT);

function req(path_, body, token) {
  return new Promise((res, rej) => {
    const r = http.request({ host: "127.0.0.1", port: PORT, path: path_, method: "POST",
      headers: { "Content-Length": body.length, Authorization: "Bearer " + token } }, (resp) => {
      const c = []; resp.on("data", (d) => c.push(d)); resp.on("end", () => res({ code: resp.statusCode, buf: Buffer.concat(c) }));
    });
    r.on("error", rej); r.write(body); r.end();
  });
}
function rest(p, body, token) {
  return new Promise((res, rej) => {
    const payload = JSON.stringify(body);
    const r = http.request({ host: "127.0.0.1", port: PORT, path: p, method: "POST",
      headers: { "Content-Length": payload.length, "Content-Type": "application/json" } }, (resp) => {
      const c = []; resp.on("data", (d) => c.push(d)); resp.on("end", () => res(JSON.parse(Buffer.concat(c).toString())));
    });
    r.on("error", rej); r.write(payload); r.end();
  });
}

(async () => {
  await new Promise((r) => setTimeout(r, 300));
  await rest("/api/register", { username: "dbg", password: "qwerty123" });
  const l = await rest("/api/login", { username: "dbg", password: "qwerty123" });
  const token = l.token;

  const calls = [
    ["messages.GetAllStickers", new TL.messages.GetAllStickers({ hash: 0 })],
    ["messages.GetStickers", new TL.messages.GetStickers({ emoticon: "x", hash: 0 })],
    ["messages.GetEmojiStickers", new TL.messages.GetEmojiStickers({ hash: 0 })],
    ["messages.GetAttachMenuBots", new TL.messages.GetAttachMenuBots({ hash: 0 })],
    ["messages.GetQuickReplies", new TL.messages.GetQuickReplies({ hash: 0 })],
    ["stories.GetAllStories", new TL.stories.GetAllStories({ next: false, hidden: false })],
    ["account.GetChatThemes", new TL.account.GetChatThemes({ hash: 0 })],
    ["account.GetAutoDownloadSettings", new TL.account.GetAutoDownloadSettings({})],
    ["messages.GetRecentReactions", new TL.messages.GetRecentReactions({ hash: 0 })]
  ];
  for (const [name, obj] of calls) {
    let bytes;
    try { bytes = obj.write(); } catch (e) { console.log(name, "SER-ERR", e.message); continue; }
    const r = await req("/api/tl", bytes, token);
    console.log(name.padEnd(32), "http=" + r.code, "len=" + r.buf.length, r.buf.toString("hex"));
  }
  process.exit(0);
})();
