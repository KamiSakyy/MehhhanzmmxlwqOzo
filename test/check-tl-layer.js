"use strict";
/*
 * Сверяем TL-слой сервера (skema) со слоем клиента (DrKLO/Telegram, TLRPC.java):
 * если constructor-id расходятся — клиент не сможет разобрать ответ сервера.
 *
 * Запуск: node test/check-tl-layer.js [путь к TLRPC.java]
 */
process.env.LOGLEVEL = process.env.LOGLEVEL || "none";
const fs = require("fs");
const { Raw: TL } = require("@tgsnake/skema");

const file = process.argv[2] || "/tmp/tg/TMessagesProj/src/main/java/org/telegram/tgnet/TLRPC.java";
if (!fs.existsSync(file)) { console.error("Нет файла " + file); process.exit(1); }
const java = fs.readFileSync(file, "utf8");

// TL_xxx_yyy -> constructor
const client = new Map();
const re = /public static class (TL_[A-Za-z0-9_]+)[^{]*\{\s*\n\s*public static final int constructor = (0x[0-9a-fA-F]+);/g;
let m;
while ((m = re.exec(java))) client.set(m[1].toLowerCase().replace(/_/g, ""), m[2].toLowerCase());

function walk(o, prefix, out) {
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (typeof v === "function") out.push(prefix + k);
    else if (v && typeof v === "object") walk(v, prefix + k + ".", out);
  }
  return out;
}
function norm(name) {
  // messages.AllStickers -> tlmessagesallstickers ; TL_messages_allStickers -> tlmessagesallstickers
  return ("tl_" + name.replace(/\./g, "_")).toLowerCase().replace(/_/g, "");
}

const names = walk(TL, "", []);

let matched = 0; const missing = []; const mismatched = [];
for (const n of names) {
  const key = norm(n);
  if (!client.has(key)) { missing.push(n); continue; }
  let inst = null;
  try {
    const Cls = n.split(".").reduce((a, p) => (a == null ? a : a[p]), TL);
    if (typeof Cls === "function") inst = new Cls({});
  } catch (e) { inst = null; }
  if (inst == null) continue;
  const id = inst.constructorId;
  if (id == null) continue;
  const hex = "0x" + BigInt.asUintN(32, BigInt(id)).toString(16).padStart(8, "0");
  const clientHex = client.get(key);
  const nz = (s) => "0x" + BigInt.asUintN(32, BigInt(s)).toString(16).padStart(8, "0");
  if (nz(clientHex) !== hex) {
    let slots = [];
    try { slots = (new (n.split(".").reduce((a, p) => a[p], TL))({}))._slots || []; } catch (e) { }
    mismatched.push(n + " — сервер " + hex + ", клиент " + nz(clientHex));
  } else matched++;
}
console.log("Классов в skema: " + names.length);
console.log("Совпало constructor-id с клиентом: " + matched);
console.log("Нет в клиенте (не страшно, если не используются): " + missing.length);
if (mismatched.length) {
  console.log("\n❌ РАСХОЖДЕНИЯ СЛОЁВ (" + mismatched.length + "):");
  mismatched.slice(0, 60).forEach((x) => console.log("  • " + x));
} else {
  console.log("\n✅ Расхождений constructor-id нет — слои совместимы");
}
