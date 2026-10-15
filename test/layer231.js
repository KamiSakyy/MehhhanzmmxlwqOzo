"use strict";
/*
 * Клиент DrKLO/Telegram работает на LAYER 231 и шлёт НОВЫЕ TL-конструкторы.
 * Этот тест собирает такие запросы вручную (ровно как их собирает TLRPC.java)
 * и проверяет, что сервер понимает каждый — а не отвечает TL_DESERIALIZE_ERROR.
 *
 * Запуск: node test/layer231.js
 */
process.env.LOGLEVEL = process.env.LOGLEVEL || "none";
const path = require("path");
process.env.DATA_DIR = path.join(__dirname, "..", "test-data-231");
process.env.PORT = process.env.PORT || "3996";
require("fs").rmSync(process.env.DATA_DIR, { recursive: true, force: true });

const http = require("http");
const { Raw: TL, Primitive } = require("@tgsnake/skema");
const { BytesIO } = require("@tgsnake/bytesio");
require("../server.js");

const PORT = Number(process.env.PORT);

function postTl(token, buf) {
  return new Promise((resolve, reject) => {
    const r = http.request({
      host: "127.0.0.1", port: PORT, path: "/api/tl", method: "POST",
      headers: { "Content-Length": buf.length, "Content-Type": "application/x-telegram-tl", Authorization: "Bearer " + token }
    }, (res) => {
      const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => resolve({ code: res.statusCode, buf: Buffer.concat(c) }));
    });
    r.on("error", reject); r.write(buf); r.end();
  });
}
function rest(p, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const r = http.request({ host: "127.0.0.1", port: PORT, path: p, method: "POST",
      headers: { "Content-Length": Buffer.byteLength(payload), "Content-Type": "application/json" } }, (res) => {
      const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => resolve(JSON.parse(Buffer.concat(c).toString())));
    });
    r.on("error", reject); r.write(payload); r.end();
  });
}

// --- ручная сборка TL (как в TLRPC.java) ---
function w() { const parts = []; return {
  int(v) { const b = Buffer.alloc(4); b.writeInt32LE(v | 0); parts.push(b); return this; },
  uint(v) { const b = Buffer.alloc(4); b.writeUInt32LE(Number(v) >>> 0); parts.push(b); return this; },
  long(v) { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); parts.push(b); return this; },
  str(v) {
    const s = Buffer.from(String(v), "utf8");
    const head = [];
    if (s.length < 254) { head.push(Buffer.from([s.length])); }
    else { const b = Buffer.alloc(4); b.writeUInt32LE((s.length << 8) | 254, 0); head.push(b); }
    const pad = (4 - ((s.length + (s.length < 254 ? 1 : 4)) % 4)) % 4;
    parts.push(Buffer.concat(head), s, Buffer.alloc(pad)); return this;
  },
  obj(o) { parts.push(o.write()); return this; },
  vectorInt(arr) { this.int(arr.length); for (const v of arr) this.int(v); return this; },
  vectorObj(arr) { this.int(arr.length); for (const o of arr) this.obj(o); return this; },
  done() { return Buffer.concat(parts); }
}; }

let failures = 0;
async function expectParsed(name, ctor, body, token) {
  const buf = Buffer.concat([(b => { const x = Buffer.alloc(4); x.writeUInt32LE(ctor >>> 0, 0); return x; })(), body]);
  const r = await postTl(token, buf);
  const isDeserError = r.buf.length >= 4 && r.buf.readUInt32LE(0) === 0x19ca4421 &&
    r.buf.toString("utf8").indexOf("DESERIALIZE") >= 0;
  const isRpcError = r.buf.length >= 4 && r.buf.readUInt32LE(0) === 0x19ca4421;
  if (isDeserError) {
    failures++;
    console.log("  ❌ " + name + " — сервер не разобрал запрос (TL_DESERIALIZE_ERROR)");
    return null;
  }
  const text = isRpcError ? r.buf.toString("utf8").replace(/[^\x20-\x7eА-Яа-яЁё]/g, " ").trim() : "";
  console.log("  ✅ " + name + (isRpcError ? " — разобран, ответ-ошибка: " + text : " — разобран, ответ OK (" + r.buf.length + " байт)"));
  return r;
}

(async () => {
  await new Promise((r) => setTimeout(r, 300));
  await rest("/api/register", { username: "layer231", password: "qwerty123", name: "Тест" });
  const login = await rest("/api/login", { username: "@layer231", password: "qwerty123" });
  const token = login.token;
  console.log("LAYER 231: запросы в точности как их шлёт DrKLO/Telegram\n");

  const peerSelf = new TL.InputPeerSelf({});
  const peerChat = new TL.InputPeerChat({ chatId: 1n });
  const inputUserSelf = new TL.InputUserSelf({});

  await expectParsed("messages.getMessages  #4222fa74", 0x4222fa74, w().vectorInt([1, 2]).done(), token);
  await expectParsed("channels.getMessages  #93d7b347", 0x93d7b347, w().obj(new TL.InputChannel({ channelId: 1n, accessHash: 1n })).vectorInt([1]).done(), token);
  await expectParsed("messages.createChat   #34a818", 0x34a818, w().int(0).vectorObj([inputUserSelf]).str("Моя группа").done(), token);
  await expectParsed("messages.addChatUser  #f24753e3", 0xf24753e3, w().long(1).obj(inputUserSelf).int(100).done(), token);
  await expectParsed("channels.joinChannel  #24b524c5", 0x24b524c5, w().obj(new TL.InputChannel({ channelId: 1n, accessHash: 1n })).done(), token);
  await expectParsed("channels.inviteToChannel #199f3a6c", 0x199f3a6c, w().obj(new TL.InputChannel({ channelId: 1n, accessHash: 1n })).vectorObj([inputUserSelf]).done(), token);
  await expectParsed("updates.getDifference #25939651", 0x25939651, w().int(0).int(0).int(0).int(0).done(), token);
  await expectParsed("messages.uploadMedia  #519bc2b1", 0x519bc2b1, w().obj(peerSelf).obj(new TL.InputMediaEmpty({})).done(), token);
  await expectParsed("langpack.getLanguages #800fd57d", 0x800fd57d, Buffer.alloc(0), token);
  await expectParsed("langpack.getStrings   #2e1ee318", 0x2e1ee318, w().str("ru").int(1).str("Loading").done(), token);
  await expectParsed("langpack.getLangPack  #9ab5c58e", 0x9ab5c58e, w().str("ru").done(), token);
  await expectParsed("upload.getFileHashes  #c7025931", 0xc7025931, w().obj(new TL.InputDocumentFileLocation({ id: 1n, accessHash: 1n, fileReference: Buffer.from("f1"), thumbSize: "" })).int(0).done(), token);

  console.log("\n" + (failures === 0
    ? "🎉 ВСЕ ЗАПРОСЫ LAYER 231 РАЗОБРАНЫ"
    : "⚠️  не разобрано: " + failures));
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error("💥 тест упал:", e); process.exit(1); });
