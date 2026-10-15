"use strict";
process.env.LOGLEVEL = process.env.LOGLEVEL || "none"; // не спамим логами skema
/*
 * Сквозной тест: наш сервер + клиент, который говорит на родном TL (как Telegram).
 * Регистрация/вход по @username + паролю -> диалоги -> сообщения -> медиа ->
 * кружочки -> голосовые -> группы и каналы -> скачивание файла.
 */

const path = require("path");
process.env.DATA_DIR = path.join(__dirname, "..", "test-data-e2e");
process.env.PORT = process.env.PORT || "3999";
const fs = require("fs");
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });

const http = require("http");
const { Raw: TL, TLObject } = require("@tgsnake/skema");
const { BytesIO } = require("@tgsnake/bytesio");

require("../server.js"); // поднимает сервер на PORT

const PORT = Number(process.env.PORT);
const HOST = "127.0.0.1";

function request(method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body ? (Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))) : null;
    const req = http.request({
      host: HOST, port: PORT, path: urlPath, method: method,
      headers: Object.assign(
        { "Content-Length": payload ? payload.length : 0 },
        payload && !Buffer.isBuffer(body) ? { "Content-Type": "application/json" } : {},
        token ? { Authorization: "Bearer " + token } : {}
      )
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ code: res.statusCode, buffer: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function rest(method, p, body, token) {
  const r = await request(method, p, body, token);
  try { return JSON.parse(r.buffer.toString()); } catch (e) { return { raw: r.buffer.toString() }; }
}

async function tlCall(token, obj, label) {
  const r = await request("POST", "/api/tl", obj.write(), token);
  if (r.code !== 200) return { __error: "HTTP " + r.code };
  try {
    const out = await TLObject.read(BytesIO.from(r.buffer));
    if (out.className === "RpcError") {
      return { __error: out.errorCode + " " + out.errorMessage };
    }
    return out;
  } catch (e) {
    return { __error: "parse: " + e.message };
  }
}

let failures = 0;
function expect(name, cond, extra) {
  if (cond) {
    console.log("  ✅ " + name + (extra ? " — " + extra : ""));
  } else {
    failures++;
    console.log("  ❌ " + name + (extra ? " — " + extra : ""));
  }
}

(async () => {
  await new Promise((r) => setTimeout(r, 300));

  console.log("1️⃣  Регистрация и вход по @username + паролю");
  const regA = await rest("POST", "/api/register", { username: "alice", password: "qwerty123", name: "Алиса" });
  expect("register @alice", regA.ok === true, JSON.stringify(regA.error || regA.user));
  const regB = await rest("POST", "/api/register", { username: "bob", password: "qwerty123", name: "Боб" });
  expect("register @bob", regB.ok === true, JSON.stringify(regB.error || regB.user));
  const dup = await rest("POST", "/api/register", { username: "alice", password: "qwerty123" });
  expect("повторный @alice отклонён", dup.ok === false);
  const badLogin = await rest("POST", "/api/login", { username: "alice", password: "wrong" });
  expect("неверный пароль отклонён", badLogin.ok === false);
  const loginA = await rest("POST", "/api/login", { username: "@alice", password: "qwerty123" });
  expect("вход @alice", loginA.ok === true && !!loginA.token);
  const tokenA = loginA.token, uidA = String(loginA.user.uid);
  const loginB = await rest("POST", "/api/login", { username: "bob", password: "qwerty123" });
  const tokenB = loginB.token;
  const uidB = String(loginB.user.uid);
  const me = await rest("GET", "/api/me", null, tokenA);
  expect("GET /api/me", me.ok === true && me.user.username === "@alice");

  console.log("\n2️⃣  TL: конфиг, пользователи, поиск людей");
  const cfg = await tlCall(tokenA, new TL.help.GetConfig({}), "config");
  expect("help.getConfig", cfg.className === "Config", cfg.__error || ("thisDc=" + cfg.thisDc));
  const users = await tlCall(tokenA, new TL.users.GetUsers({ id: [new TL.InputUser({ userId: BigInt(uidB), accessHash: BigInt(uidB) })] }));
  expect("users.getUsers", Array.isArray(users) && users[0] && users[0].username === "bob", users.__error);
  const found = await tlCall(tokenA, new TL.contacts.Search({ q: "bob", limit: 10 }));
  expect("contacts.search нашёл @bob", found.className === "contacts.Found" && found.results.length === 1, found.__error);
  const resolved = await tlCall(tokenA, new TL.contacts.ResolveUsername({ username: "bob" }));
  expect("contacts.resolveUsername", resolved.className === "contacts.ResolvedPeer", resolved.__error);

  console.log("\n3️⃣  TL: личный чат — текст");
  const peerB = new TL.InputPeerUser({ userId: BigInt(uidB), accessHash: BigInt(uidB) });
  const sent = await tlCall(tokenA, new TL.messages.SendMessage({
    noWebpage: true, silent: false, background: false, clearDraft: false, noforwards: false,
    updateStickersetsOrder: false, invertMedia: false,
    peer: peerB, replyTo: undefined, message: "Привет, Боб! Это наш сервер.",
    randomId: 12345, replyMarkup: undefined, entities: [], scheduleDate: undefined, sendAs: undefined
  }));
  expect("messages.sendMessage", sent.className === "UpdateShortSentMessage", sent.__error);
  const msgId = sent.id;

  const hist = await tlCall(tokenB, new TL.messages.GetHistory({
    peer: new TL.InputPeerUser({ userId: BigInt(uidA), accessHash: BigInt(uidA) }),
    offsetId: 0, offsetDate: 0, addOffset: 0, limit: 50, maxId: 0, minId: 0, hash: 0
  }));
  expect("messages.getHistory (Боб видит сообщение)",
    (hist.className === "messages.Messages" || hist.className === "messages.MessagesSlice") && hist.messages.length === 1,
    hist.__error || (hist.messages ? hist.messages.length + " сообщений" : ""));
  expect("текст сообщения совпадает", hist.messages && hist.messages[0] && hist.messages[0].message.indexOf("наш сервер") >= 0);
  expect("отправитель — Алиса", hist.messages && hist.messages[0] && String(hist.messages[0].fromId.userId) === uidA);

  const dialogs = await tlCall(tokenB, new TL.messages.GetDialogs({
    excludePinned: false, offsetDate: 0, offsetId: 0,
    offsetPeer: new TL.InputPeerEmpty({}), limit: 50, hash: 0, folderId: undefined
  }));
  expect("messages.getDialogs", dialogs.className === "messages.Dialogs" && dialogs.dialogs.length === 1, dialogs.__error);
  expect("в диалоге 1 непрочитанное", dialogs.dialogs && dialogs.dialogs[0] && dialogs.dialogs[0].unreadCount === 1,
    dialogs.dialogs ? "unread=" + dialogs.dialogs[0].unreadCount : "");

  const read = await tlCall(tokenB, new TL.messages.ReadHistory({ peer: new TL.InputPeerUser({ userId: BigInt(uidA), accessHash: BigInt(uidA) }), maxId: msgId }));
  expect("messages.readHistory", read.className === "messages.AffectedMessages", read.__error);
  const dialogs2 = await tlCall(tokenB, new TL.messages.GetDialogs({ excludePinned: false, offsetDate: 0, offsetId: 0, offsetPeer: new TL.InputPeerEmpty({}), limit: 50, hash: 0 }));
  expect("после прочтения unread=0", dialogs2.dialogs[0].unreadCount === 0);

  const typing = await tlCall(tokenB, new TL.messages.SetTyping({
    peer: new TL.InputPeerUser({ userId: BigInt(uidA), accessHash: BigInt(uidA) }), topMsgId: undefined,
    action: new TL.SendMessageTypingAction({})
  }));
  expect("messages.setTyping", typing.className === "BoolTrue" || typing === true, JSON.stringify(typing));

  console.log("\n4️⃣  TL: медиа — фото, голосовое, кружочек, видео, файл");
  async function uploadAndSend(token, bytes, inputMedia, message) {
    const fileId = 900000 + Math.floor(Math.random() * 99999);
    const partSize = Math.max(1, bytes.length);
    const save = await tlCall(token, new TL.upload.SaveFilePart({ fileId: BigInt(fileId), filePart: 0, bytes: bytes }));
    if (save.__error) return { error: save.__error };
    inputMedia.file = new TL.InputFile({ id: BigInt(fileId), parts: 1, name: inputMedia.__name || "file", md5Checksum: "" });
    return tlCall(token, new TL.messages.SendMedia({
      silent: false, background: false, clearDraft: false, noforwards: false, updateStickersetsOrder: false, invertMedia: false,
      peer: peerB, replyTo: undefined, media: inputMedia, message: message || "", randomId: Math.floor(Math.random() * 1e9),
      replyMarkup: undefined, entities: [], scheduleDate: undefined, sendAs: undefined
    }));
  }

  const photo = await uploadAndSend(tokenA, Buffer.from("fake-jpeg-bytes-0123456789"),
    new TL.InputMediaUploadedPhoto({ spoiler: false, file: undefined, stickers: [], ttlSeconds: undefined }), "фото");
  expect("отправка фото", photo.className === "UpdateShortSentMessage" && photo.media && photo.media.className === "MessageMediaPhoto", photo.__error);

  const voice = await uploadAndSend(tokenA, Buffer.from("fake-opus-bytes"),
    new TL.InputMediaUploadedDocument({
      nosoundVideo: false, forceFile: false, spoiler: false, file: undefined, thumb: undefined,
      mimeType: "audio/ogg", attributes: [new TL.DocumentAttributeAudio({ voice: true, duration: 7, title: "", performer: "", waveform: Buffer.alloc(0) })],
      stickers: [], ttlSeconds: undefined
    }), "");
  expect("отправка голосового", voice.className === "UpdateShortSentMessage" && voice.media && voice.media.document.attributes[0].voice === true, voice.__error);

  const round = await uploadAndSend(tokenA, Buffer.from("fake-round-mp4"),
    new TL.InputMediaUploadedDocument({
      nosoundVideo: false, forceFile: false, spoiler: false, file: undefined, thumb: undefined,
      mimeType: "video/mp4", attributes: [new TL.DocumentAttributeVideo({ roundMessage: true, supportsStreaming: true, nosound: false, duration: 5, w: 360, h: 360, preloadPrefixSize: 0 })],
      stickers: [], ttlSeconds: undefined
    }), "");
  expect("отправка кружочка", round.className === "UpdateShortSentMessage" && round.media && round.media.document.attributes[0].roundMessage === true, round.__error);

  const video = await uploadAndSend(tokenA, Buffer.from("fake-video-mp4"),
    new TL.InputMediaUploadedDocument({
      nosoundVideo: false, forceFile: false, spoiler: false, file: undefined, thumb: undefined,
      mimeType: "video/mp4", attributes: [new TL.DocumentAttributeVideo({ roundMessage: false, supportsStreaming: true, nosound: false, duration: 12, w: 1280, h: 720, preloadPrefixSize: 0 })],
      stickers: [], ttlSeconds: undefined
    }), "видео");
  expect("отправка видео", video.className === "UpdateShortSentMessage" && video.media && video.media.video === true, video.__error);

  const doc = await uploadAndSend(tokenA, Buffer.from("fake-pdf"),
    new TL.InputMediaUploadedDocument({
      nosoundVideo: false, forceFile: false, spoiler: false, file: undefined, thumb: undefined,
      mimeType: "application/pdf", attributes: [new TL.DocumentAttributeFilename({ fileName: "doc.pdf" })],
      stickers: [], ttlSeconds: undefined
    }), "");
  expect("отправка файла", doc.className === "UpdateShortSentMessage" && doc.media && doc.media.document.attributes[0].fileName === "doc.pdf", doc.__error || ("cls=" + doc.className + " fn=" + (doc.media && doc.media.document && doc.media.document.attributes[0] ? JSON.stringify(doc.media.document.attributes[0].fileName) : "-") + " media=" + (doc.media && doc.media.className) + " attrs=" + (doc.media && doc.media.document ? doc.media.document.attributes.map(a=>a.className).join("/") : "-") + " mime=" + (doc.media && doc.media.document ? doc.media.document.mimeType : "-")));

  // скачивание файла (как это делает клиент)
  const historyA = await tlCall(tokenA, new TL.messages.GetHistory({ peer: peerB, offsetId: 0, offsetDate: 0, addOffset: 0, limit: 50, maxId: 0, minId: 0, hash: 0 }));
  const photoMsg = historyA.messages.find((m) => m.media && m.media.className === "MessageMediaPhoto");
  const getFile = await tlCall(tokenA, new TL.upload.GetFile({
    precise: false, cdnSupported: false,
    location: new TL.InputPhotoFileLocation({
      id: photoMsg.media.photo.id, accessHash: photoMsg.media.photo.accessHash,
      fileReference: photoMsg.media.photo.fileReference, thumbSize: "x"
    }),
    offset: 0, limit: 1024 * 1024
  }));
  expect("upload.getFile (скачивание фото)", getFile.className === "upload.File" && getFile.bytes.toString() === "fake-jpeg-bytes-0123456789", getFile.__error || String(getFile.bytes));

  console.log("\n5️⃣  TL: группы и каналы");
  const created = await tlCall(tokenA, new TL.messages.CreateChat({
    users: [new TL.InputUser({ userId: BigInt(uidB), accessHash: BigInt(uidB) })],
    title: "Наша группа", ttlPeriod: undefined
  }));
  expect("messages.createChat", created.className === "Updates" && created.chats.length === 1, created.__error);
  const groupId = created.chats[0].id;

  const grpMsg = await tlCall(tokenA, new TL.messages.SendMessage({
    noWebpage: true, silent: false, background: false, clearDraft: false, noforwards: false, updateStickersetsOrder: false, invertMedia: false,
    peer: new TL.InputPeerChat({ chatId: groupId }), replyTo: undefined, message: "Всем привет!", randomId: 777,
    replyMarkup: undefined, entities: [], scheduleDate: undefined, sendAs: undefined
  }));
  expect("сообщение в группу", grpMsg.className === "UpdateShortSentMessage", grpMsg.__error);

  const grpHist = await tlCall(tokenB, new TL.messages.GetHistory({ peer: new TL.InputPeerChat({ chatId: groupId }), offsetId: 0, offsetDate: 0, addOffset: 0, limit: 50, maxId: 0, minId: 0, hash: 0 }));
  expect("история группы у Боба", grpHist.messages && grpHist.messages.length >= 1, grpHist.__error);

  const chan = await tlCall(tokenA, new TL.channels.CreateChannel({
    broadcast: true, megagroup: false, forImport: false, forum: false,
    title: "Наш канал", about: "Канал на нашем сервере", geoPoint: undefined, address: undefined
  }));
  expect("channels.createChannel", chan.className === "Updates" && chan.chats.length === 1, chan.__error);
  const chanId = chan.chats[0].id;
  expect("это канал (broadcast)", chan.chats[0].broadcast === true);

  const post = await tlCall(tokenA, new TL.messages.SendMessage({
    noWebpage: true, silent: false, background: false, clearDraft: false, noforwards: false, updateStickersetsOrder: false, invertMedia: false,
    peer: new TL.InputPeerChannel({ channelId: chanId, accessHash: chanId }), replyTo: undefined, message: "Первый пост!", randomId: 888,
    replyMarkup: undefined, entities: [], scheduleDate: undefined, sendAs: undefined
  }));
  expect("пост в канал", post.className === "UpdateShortSentMessage", post.__error);

  const chanHist = await tlCall(tokenB, new TL.messages.GetHistory({ peer: new TL.InputPeerChannel({ channelId: chanId, accessHash: chanId }), offsetId: 0, offsetDate: 0, addOffset: 0, limit: 50, maxId: 0, minId: 0, hash: 0 }));
  expect("история канала", chanHist.messages && chanHist.messages.length >= 1, chanHist.__error);

  const participants = await tlCall(tokenA, new TL.channels.GetParticipants({ channel: new TL.InputChannel({ channelId: chanId, accessHash: chanId }), filter: new TL.ChannelParticipantsRecent({}), offset: 0, limit: 100, hash: 0 }));
  expect("channels.getParticipants", participants.className === "channels.ChannelParticipants", participants.__error);

  const supergroup = await tlCall(tokenA, new TL.channels.CreateChannel({
    broadcast: false, megagroup: true, forImport: false, forum: false, title: "Супергруппа", about: "", geoPoint: undefined, address: undefined
  }));
  expect("создание супергруппы", supergroup.chats && supergroup.chats[0].megagroup === true, supergroup.__error);

  console.log("\n6️⃣  TL: редактирование, удаление, ответы, пересылка, реакции");
  const edited = await tlCall(tokenA, new TL.messages.EditMessage({
    noWebpage: true, invertMedia: false, peer: peerB, id: msgId, message: "Привет, Боб! (исправлено)",
    replyMarkup: undefined, entities: [], scheduleDate: undefined
  }));
  expect("messages.editMessage", edited.className === "Updates", edited.__error);
  const hist2 = await tlCall(tokenA, new TL.messages.GetHistory({ peer: peerB, offsetId: 0, offsetDate: 0, addOffset: 0, limit: 50, maxId: 0, minId: 0, hash: 0 }));
  const editedMsg = hist2.messages.find((m) => m.id === msgId);
  expect("текст изменился", !!editedMsg && editedMsg.message.indexOf("исправлено") >= 0);

  const reply = await tlCall(tokenB, new TL.messages.SendMessage({
    noWebpage: true, silent: false, background: false, clearDraft: false, noforwards: false, updateStickersetsOrder: false, invertMedia: false,
    peer: new TL.InputPeerUser({ userId: BigInt(uidA), accessHash: BigInt(uidA) }),
    replyTo: new TL.InputMessageReplyTo({ id: msgId }),
    message: "Вижу, спасибо!", randomId: 999, replyMarkup: undefined, entities: [], scheduleDate: undefined, sendAs: undefined
  }));
  expect("ответ на сообщение", reply.className === "UpdateShortSentMessage", reply.__error);

  const reaction = await tlCall(tokenB, new TL.messages.SendReaction({
    big: false, addToRecent: true, peer: new TL.InputPeerUser({ userId: BigInt(uidA), accessHash: BigInt(uidA) }),
    msgId: msgId, reaction: [new TL.ReactionEmoji({ emoticon: "👍" })]
  }));
  expect("messages.sendReaction", reaction.className === "Updates", reaction.__error);

  const search = await tlCall(tokenA, new TL.messages.Search({
    peer: peerB, q: "исправлено", filter: new TL.InputMessagesFilterEmpty({}), minDate: 0, maxDate: 0,
    offsetId: 0, addOffset: 0, limit: 20, maxId: 0, minId: 0, hash: 0, fromId: undefined, savedPeerId: undefined, savedReaction: []
  }));
  expect("messages.search", search.messages && search.messages.length >= 1, search.__error);

  const deleted = await tlCall(tokenA, new TL.messages.DeleteMessages({ revoke: true, id: [msgId] }));
  expect("messages.deleteMessages", deleted.className === "messages.AffectedMessages", deleted.__error);

  console.log("\n7️⃣  Прочее: стейты, обновления, контакты");
  const st = await tlCall(tokenA, new TL.updates.GetState({}));
  expect("updates.getState", st.className === "updates.State", st.__error);
  const diff = await tlCall(tokenA, new TL.updates.GetDifference({ pts: 0, ptsTotalLimit: undefined, date: 1, qts: 0 }));
  expect("updates.getDifference", diff.className === "updates.DifferenceEmpty", diff.__error);
  const contacts = await tlCall(tokenA, new TL.contacts.GetContacts({ hash: 0 }));
  expect("contacts.getContacts", contacts.className === "contacts.Contacts" && contacts.contacts.length === 1, contacts.__error);
  const status = await tlCall(tokenA, new TL.account.UpdateStatus({ offline: false }));
  expect("account.updateStatus", status === true || status.className === "BoolTrue", JSON.stringify(status));
  const profile = await tlCall(tokenA, new TL.account.UpdateProfile({ firstName: "Алиса", lastName: "", about: "Я на нашем сервере" }));
  expect("account.updateProfile", profile.className === "User" && profile.firstName === "Алиса", profile.__error);
  const full = await tlCall(tokenA, new TL.users.GetFullUser({ id: new TL.InputUser({ userId: BigInt(uidB), accessHash: BigInt(uidB) }) }));
  expect("users.getFullUser", full.className === "users.UserFull", full.__error);

  const health = await rest("GET", "/health");
  expect("health", health.status === "ok",
    "users=" + health.users + " chats=" + health.chats + " messages=" + health.messages + " files=" + health.files);

  console.log(failures === 0 ? "\n🎉 ВСЕ ТЕСТЫ ПРОЙДЕНЫ" : "\n💥 ПРОВАЛЕНО ТЕСТОВ: " + failures);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("💥 тест упал:", e && e.stack ? e.stack : e);
  process.exit(1);
});
