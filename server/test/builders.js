"use strict";
process.env.LOGLEVEL = process.env.LOGLEVEL || "none"; // не спамим логами skema
/* Проверка: все TL-объекты, которые отдаёт наш сервер, должны сериализоваться и читаться обратно. */

const path = require("path");
process.env.DATA_DIR = path.join(__dirname, "..", "test-data");
const fs = require("fs");
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });

const store = require("../src/store");
const tl = require("../src/tl");
const { TLObject } = require("@tgsnake/skema");
const { BytesIO } = require("@tgsnake/bytesio");

store.load();

const a = store.createUser("@alice", "123456", "Алиса");
const b = store.createUser("@bob", "123456", "Боб");
const priv = store.getOrCreatePrivateChat(a.uid, b.uid);
const group = store.createChat("group", "Наша группа", [a.uid, b.uid], a.uid, "about", "");
const chan = store.createChat("channel", "Наш канал", [a.uid, b.uid], a.uid, "про канал", "@ourchannel");
chan.broadcast = true;
chan.megagroup = false;

const photoFile = store.saveFile(Buffer.from("jpegbytes"), { name: "a.jpg", mime: "image/jpeg", kind: "photo", width: 800, height: 600, owner: a.uid });
const voiceFile = store.saveFile(Buffer.from("opusbytes"), { name: "v.ogg", mime: "audio/ogg", kind: "voice", duration: 7, owner: a.uid });
const roundFile = store.saveFile(Buffer.from("mp4bytes"), { name: "r.mp4", mime: "video/mp4", kind: "video_note", duration: 5, width: 360, height: 360, owner: a.uid });
const videoFile = store.saveFile(Buffer.from("mp4bytes"), { name: "m.mp4", mime: "video/mp4", kind: "video", duration: 12, width: 1280, height: 720, owner: a.uid });
const docFile = store.saveFile(Buffer.from("pdfbytes"), { name: "d.pdf", mime: "application/pdf", kind: "document", owner: a.uid });

a.photoId = photoFile.id;
group.photoId = photoFile.id;

const m1 = store.addMessage(priv.id, a.uid, { text: "Привет, Боб!", entities: [{ type: "bold", offset: 0, length: 6 }] });
const m2 = store.addMessage(priv.id, b.uid, { text: "И тебе привет", replyTo: m1.id });
const m3 = store.addMessage(priv.id, a.uid, { text: "", media: { type: "photo", fileId: photoFile.id } });
const m4 = store.addMessage(priv.id, b.uid, { text: "", media: { type: "voice", fileId: voiceFile.id } });
const m5 = store.addMessage(priv.id, a.uid, { text: "", media: { type: "video_note", fileId: roundFile.id } });
const m6 = store.addMessage(priv.id, b.uid, { text: "", media: { type: "video", fileId: videoFile.id } });
const m7 = store.addMessage(priv.id, a.uid, { text: "", media: { type: "document", fileId: docFile.id } });
const m8 = store.addMessage(group.id, a.uid, { text: "Всем привет в группе" });
const m9 = store.addMessage(chan.id, a.uid, { text: "Первый пост канала", views: 3 });
store.addMessage(priv.id, a.uid, { text: "с реакцией", reactions: { "👍": [b.uid] } });

let failed = 0;
async function check(name, obj) {
  try {
    const buf = obj.write();
    const back = await TLObject.read(BytesIO.from(buf));
    console.log("  ✅ " + name + " (" + buf.length + " байт) -> " + back.className);
  } catch (e) {
    failed++;
    console.log("  ❌ " + name + ": " + e.message.split("\n")[0]);
  }
}

(async () => {
  console.log("— пользователи —");
  await check("user(self)", tl.user(a, { self: true }));
  await check("user(other, online)", tl.user(b, {}));
  await check("userFull", tl.userFull(a, a.uid));
  await check("userStatus online", tl.userStatus(a.uid));

  console.log("— чаты —");
  await check("chat(group)", tl.chat(group));
  await check("channel(group-megagroup)", tl.channel(group));
  await check("channel(broadcast)", tl.channel(chan));
  await check("chatFull", tl.chatFull(group, a.uid));

  console.log("— медиа —");
  await check("photo", tl.photo(photoFile));
  await check("document voice", tl.document(voiceFile));
  await check("document round", tl.document(roundFile));
  await check("document video", tl.document(videoFile));
  await check("document file", tl.document(docFile));

  console.log("— сообщения —");
  for (const [name, m] of [["text", m1], ["reply", m2], ["photo", m3], ["voice", m4], ["round", m5], ["video", m6], ["doc", m7]]) {
    await check("message " + name, tl.message(m, a.uid));
  }
  await check("message group", tl.message(m8, a.uid));
  await check("message channel", tl.message(m9, b.uid));

  console.log("— диалоги —");
  await check("dialog private", tl.dialog(priv, a.uid));
  await check("dialog group", tl.dialog(group, a.uid));
  await check("dialog channel", tl.dialog(chan, a.uid));
  await check("dialogs", tl.dialogsResult(
    [tl.dialog(priv, a.uid), tl.dialog(group, a.uid), tl.dialog(chan, a.uid)],
    [tl.message(m1, a.uid)],
    [tl.chat(group), tl.channel(chan)],
    [tl.user(a, { self: true }), tl.user(b)]));
  await check("dialogsSlice", tl.dialogsSlice(3, [tl.dialog(priv, a.uid)], [tl.message(m1, a.uid)], [], [tl.user(b)]));
  await check("messages.Messages", tl.messagesResult(
    [tl.message(m1, a.uid), tl.message(m3, a.uid)],
    [tl.chat(group)],
    [tl.user(a, { self: true }), tl.user(b)]));
  await check("messages.MessagesSlice", tl.messagesSlice(2, [tl.message(m4, a.uid)], [], [tl.user(b)]));
  await check("messages.ChannelMessages", tl.channelMessages([tl.message(m9, a.uid)], [tl.channel(chan)], [tl.user(a, { self: true })]));
  await check("messages.Chats", tl.chatsResult([tl.chat(group), tl.channel(chan)]));
  await check("messages.AffectedMessages", tl.affectedMessages());
  await check("messages.AffectedHistory", tl.affectedHistory(0));

  console.log("— обновления —");
  await check("updateShortMessage(private)", tl.shortMessage(m1, b.uid));
  await check("updateShort(newMessage group)", tl.shortMessage(m8, b.uid));
  await check("updateShort(channelMessage)", tl.shortMessage(m9, b.uid));
  await check("updates()", tl.updates([new tl.TL.UpdateNewMessage({ message: tl.message(m8, a.uid), pts: 0, ptsCount: 0 })], [tl.user(a, { self: true })], [tl.chat(group)]));
  await check("updates.State", tl.state());
  await check("help.Config", tl.config());
  await check("updateShortSentMessage", new tl.TL.UpdateShortSentMessage({
    out: true, id: m1.id, pts: 0, ptsCount: 0, date: m1.date,
    media: undefined, entities: [], ttlPeriod: undefined
  }));
  await check("upload.File", new tl.TL.upload.File({ type: new tl.TL.storage.FilePartial({}), mtime: 1, bytes: Buffer.from("abcd") }));
  await check("RpcError", new tl.TL.RpcError({ errorCode: 400, errorMessage: "TEST" }));

  console.log(failed === 0 ? "\n🎉 ВСЁ ОК — все объекты собираются и читаются" : "\n💥 ОШИБОК: " + failed);
  process.exit(failed === 0 ? 0 : 1);
})();
