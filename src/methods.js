"use strict";
/*
 * Реализация TL-методов Telegram на нашем сервере (LAYER 231).
 * Клиент (DrKLO/Telegram) шлёт обычные TL-запросы — мы отвечаем ему родными TL-объектами.
 * Ни одного обращения к серверам Telegram здесь нет и быть не может.
 */

const store = require("./store");
const tl = require("./tl");
const ws = require("./ws");
const TL = tl.TL;

const SERVICE_UID = "1"; // системный пользователь (support)

function ensureServiceUser() {
  let u = store.getUser(SERVICE_UID);
  if (!u) {
    u = store.db.users[SERVICE_UID] = {
      uid: SERVICE_UID,
      username: "@support",
      name: "Поддержка",
      lastName: "",
      about: "Служба поддержки",
      salt: "0",
      hash: "x",
      accessHash: "1",
      photoId: 0,
      createdAt: Date.now(),
      lastSeen: Date.now()
    };
    store.db.usernames["@support"] = SERVICE_UID;
    store.save();
  }
  return u;
}

function fail(code, text) {
  return { error: { code: code, text: text } };
}

// ---------------- разбор peer ----------------
function peerUid(peer, selfUid) {
  if (!peer) return null;
  const c = peer.className || "";
  if (c === "InputPeerSelf" || c === "InputUserSelf" || c === "PeerUserSelf") {
    return selfUid ? String(selfUid) : null;
  }
  if (c === "InputPeerUser" || c === "PeerUser" || c === "InputUser" || c === "InputUserFromMessage") {
    return String(peer.userId);
  }
  return null;
}

function peerChatId(peer) {
  if (!peer) return null;
  const c = peer.className || "";
  if (c === "InputPeerChat" || c === "PeerChat") return String(peer.chatId);
  if (c === "InputPeerChannel" || c === "PeerChannel" || c === "InputChannel" || c === "InputChannelFromMessage") {
    return String(peer.channelId != null ? peer.channelId : peer.channelId);
  }
  if (c === "InputPeerUserFromMessage" || c === "InputPeerChannelFromMessage") {
    return peer.peer ? peerChatId(peer.peer) : null;
  }
  return null;
}

function resolvePeer(ctx, peer) {
  if (!peer) return null;
  const c = peer.className || "";
  const uid = peerUid(peer);
  if (uid) {
    const other = store.getUser(uid);
    if (!other) return null;
    return store.getOrCreatePrivateChat(ctx.uid, uid);
  }
  if (c === "InputPeerSelf" || c === "InputUserSelf") {
    return store.getOrCreatePrivateChat(ctx.uid, ctx.uid);
  }
  const cid = peerChatId(peer);
  if (cid) return store.getChat(cid);
  return null;
}

function isMember(chat, uid) {
  return !!chat && (chat.members || []).map(String).includes(String(uid));
}

// собрать пользователей, упомянутых в сообщениях (для TL-ответов)
function collectUsers(uids, viewerUid) {
  const out = [];
  const seen = new Set();
  for (const uid of uids) {
    const key = String(uid);
    if (seen.has(key)) continue;
    seen.add(key);
    const u = store.getUser(key);
    if (u) out.push(tl.user(u, { self: String(u.uid) === String(viewerUid) }));
  }
  return out;
}

function chatUsers(chat, viewerUid) {
  const ids = (chat.members || []).slice();
  return collectUsers(ids, viewerUid);
}

function chatPeers(chat, viewerUid) {
  if (!chat) return [];
  if (chat.type === "private") return chatUsers(chat, viewerUid);
  const users = chatUsers(chat, viewerUid);
  return users;
}

function chatsForPeers(chats) {
  const out = [];
  for (const c of chats) {
    if (!c || c.type === "private") continue;
    const obj = tl.chat(c);
    if (obj) out.push(obj);
  }
  return out;
}

function findChatByInvite(hash) {
  for (const id of Object.keys(store.db.chats)) {
    const c = store.db.chats[id];
    if (c.inviteHash && c.inviteHash === hash) return c;
  }
  return null;
}

// ---------------- отправка обновлений участникам ----------------
function pushToChat(chat, build, exceptUid) {
  for (const uid of (chat.members || [])) {
    if (String(uid) === String(exceptUid)) continue;
    const obj = build(String(uid));
    if (obj) ws.sendToUser(String(uid), obj);
  }
}

// ---------------- обработчики ----------------
const handlers = {};

// ==== help ====
handlers["help.GetConfig"] = () => tl.config();
handlers["help.GetNearestDc"] = () => new TL.NearestDc({ country: "NL", thisDc: tl.DC_ID, nearestDc: tl.DC_ID });
handlers["help.GetCdnConfig"] = () => new TL.CdnConfig({ publicKeys: [] });
handlers["help.GetAppConfig"] = () => new TL.help.AppConfig({ hash: 0, config: new TL.JsonObject({ value: [] }) });
handlers["help.GetInviteText"] = () => new TL.help.InviteText({ message: "Присоединяйся ко мне: https://mwmmw-production.up.railway.app/" });
handlers["help.GetTermsOfServiceUpdate"] = () => new TL.help.TermsOfServiceUpdateEmpty({ expires: Math.floor(Date.now() / 1000) + 86400 });
handlers["help.GetPromoData"] = () => new TL.help.PromoDataEmpty({ expires: Math.floor(Date.now() / 1000) + 86400 });
handlers["help.GetCountriesList"] = () => new TL.help.CountriesListNotModified({ hash: 0 });
handlers["help.GetSupport"] = (ctx) => new TL.help.Support({ phoneNumber: "", user: tl.user(ensureServiceUser(), {}) });
handlers["help.SaveAppLog"] = () => tl.boolTrue();
handlers["help.DismissSuggestion"] = () => tl.boolTrue();
handlers["help.SetBotUpdatesStatus"] = () => tl.boolTrue();
handlers["help.GetAppUpdate"] = () => new TL.help.NoAppUpdate({});
handlers["help.GetTimezonesList"] = () => new TL.help.TimezonesListNotModified({ hash: 0 });
handlers["help.GetDeepLinkInfo"] = () => new TL.help.DeepLinkInfoEmpty({});
handlers["help.GetPeerColors"] = () => new TL.help.PeerColorsNotModified({ hash: 0 });
handlers["help.GetPassportConfig"] = () => new TL.help.PassportConfigNotModified({ hash: 0 });

// ==== auth ====
handlers["auth.LogOut"] = (ctx) => {
  if (ctx.token) delete store.db.tokens[ctx.token];
  store.setOnline(ctx.uid, false);
  store.save();
  return tl.boolTrue();
};
handlers["auth.ResetAuthorizations"] = () => tl.boolTrue();
handlers["auth.BindTempAuthKey"] = () => tl.boolTrue();
handlers["auth.CancelCode"] = () => tl.boolTrue();

// ==== account ====
handlers["account.UpdateStatus"] = (ctx, req) => {
  store.setOnline(ctx.uid, !req.offline);
  ws.broadcastStatus(ctx.uid);
  return tl.boolTrue();
};
handlers["account.UpdateProfile"] = (ctx, req) => {
  const u = ctx.user;
  if (req.firstName !== undefined) u.name = String(req.firstName || "").slice(0, 64);
  if (req.lastName !== undefined) u.lastName = String(req.lastName || "").slice(0, 64);
  if (req.about !== undefined) u.about = String(req.about || "").slice(0, 255);
  store.save();
  const user = tl.user(u, { self: true });
  ws.sendToUser(String(u.uid), tl.updates([new TL.UpdateUser({ userId: tl.big(u.uid) })], [user], []));
  return user;
};
handlers["account.UpdateUsername"] = (ctx, req) => {
  const u = ctx.user;
  const uname = store.normUsername(req.username);
  if (!store.validUsername(uname)) return fail(400, "USERNAME_INVALID");
  if (store.getUserByName(uname) && store.getUserByName(uname).uid !== u.uid) return fail(400, "USERNAME_OCCUPIED");
  delete store.db.usernames[store.normUsername(u.username)];
  u.username = uname;
  store.db.usernames[uname] = u.uid;
  store.save();
  return tl.user(u, { self: true });
};
handlers["account.CheckUsername"] = (ctx, req) => {
  const uname = store.normUsername(req.username);
  return !store.getUserByName(uname);
};
handlers["account.GetNotifySettings"] = (ctx, req) => tl.notifySettings();
handlers["account.ResetNotifySettings"] = () => tl.boolTrue();
handlers["account.RegisterDevice"] = () => tl.boolTrue();
handlers["account.UnregisterDevice"] = () => tl.boolTrue();
handlers["account.GetAutoDownloadSettings"] = () => new TL.account.AutoDownloadSettings({
  low: new TL.AutoDownloadSettings({ disabled: false, videoPreloadLarge: false, audioPreloadNext: false, phonecallsLessData: false, photoSizeMax: 1048576, videoSizeMax: 10485760, fileSizeMax: 10485760, videoUploadMaxbitrate: 2000, storiesPreload: false, premium: false }),
  medium: new TL.AutoDownloadSettings({ disabled: false, videoPreloadLarge: false, audioPreloadNext: false, phonecallsLessData: false, photoSizeMax: 1048576, videoSizeMax: 15728640, fileSizeMax: 15728640, videoUploadMaxbitrate: 2000, storiesPreload: false, premium: false }),
  high: new TL.AutoDownloadSettings({ disabled: false, videoPreloadLarge: false, audioPreloadNext: false, phonecallsLessData: false, photoSizeMax: 1048576, videoSizeMax: 31457280, fileSizeMax: 31457280, videoUploadMaxbitrate: 2000, storiesPreload: false, premium: false })
});
handlers["account.SaveAutoDownloadSettings"] = () => tl.boolTrue();
handlers["account.GetPrivacy"] = (ctx, req) => new TL.account.PrivacyRules({ rules: [new TL.PrivacyValueAllowAll({})], chats: [], users: [] });
handlers["account.SetPrivacy"] = (ctx, req) => new TL.account.PrivacyRules({ rules: (req.rules && req.rules.length) ? req.rules : [new TL.PrivacyValueAllowAll({})], chats: [], users: [] });
handlers["account.GetGlobalPrivacySettings"] = () => new TL.GlobalPrivacySettings({ archiveAndMuteNewNoncontactPeers: undefined, keepArchivedUnmuted: undefined, keepArchivedFolders: undefined, hideReadMarks: undefined, newNoncontactPeersRequirePremium: undefined });
handlers["account.SetGlobalPrivacySettings"] = () => new TL.GlobalPrivacySettings({ archiveAndMuteNewNoncontactPeers: undefined, keepArchivedUnmuted: undefined, keepArchivedFolders: undefined, hideReadMarks: undefined, newNoncontactPeersRequirePremium: undefined });
handlers["account.GetAccountTTL"] = () => new TL.AccountDaysTTL({ days: 0 });
handlers["account.SetAccountTTL"] = () => tl.boolTrue();
handlers["account.GetContactSignUpNotification"] = () => tl.boolTrue();
handlers["account.SetContactSignUpNotification"] = () => tl.boolTrue();
handlers["account.DeleteAccount"] = () => tl.boolTrue();
handlers["account.GetNotifyExceptions"] = () => tl.updates([], [], []);
handlers["account.GetWallPapers"] = () => new TL.account.WallPapers({ hash: 0, wallpapers: [] });
handlers["account.GetThemes"] = () => new TL.account.Themes({ hash: 0, themes: [] });
handlers["account.GetChatThemes"] = () => new TL.account.ChatThemes({ hash: 0, themes: [] });
handlers["messages.GetRecentReactions"] = () => new TL.messages.Reactions({ hash: 0, reactions: [] });
handlers["messages.GetPinnedSavedDialogs"] = () => tl.messagesResult([], [], []);
handlers["chatlists.GetLeaveChatlistSuggestions"] = () => tl.updates([], [], []);
handlers["bots.GetPopularAppBots"] = () => [];
handlers["stickers.GetAllStickers"] = () => new TL.messages.AllStickers({ hash: 0, stickers: [] });
handlers["stickers.GetRecentStickers"] = () => new TL.messages.RecentStickers({ hash: 0, packs: [], stickers: [], dates: [] });
handlers["stickers.GetFeaturedStickers"] = () => new TL.messages.FeaturedStickers({ hash: 0, count: 0, sets: [], unread: [] });
handlers["premium.GetPromo"] = () => fail(400, "PREMIUM_NOT_AVAILABLE");
handlers["stories.GetAllStories"] = () => new TL.stories.AllStories({ hasMore: false, state: "", peerStories: [] });
handlers["stories.GetPeerStories"] = () => new TL.stories.PeerStories({ peer: undefined, stories: [] });
handlers["phone.GetGroupCall"] = () => fail(400, "CALL_NOT_SUPPORTED");
handlers["payments.GetPaymentForm"] = () => fail(400, "PAYMENTS_NOT_SUPPORTED");
handlers["account.GetContentSettings"] = () => new TL.account.ContentSettings({ sensitiveEnabled: false, sensitiveCanChange: true });

// ==== users ====
handlers["users.GetUsers"] = (ctx, req) => {
  const ids = (req.id || []).map((p) => peerUid(p, ctx.uid)).filter(Boolean);
  return collectUsers(ids, ctx.uid);
};
handlers["users.GetFullUser"] = (ctx, req) => {
  const uid = peerUid(req.id, ctx.uid);
  const u = store.getUser(uid);
  if (!u) return fail(400, "USER_ID_INVALID");
  return new TL.users.UserFull({ fullUser: tl.userFull(u, ctx.uid), chats: [], users: [tl.user(u, { self: String(u.uid) === String(ctx.uid) })] });
};
handlers["users.SetSecureValueErrors"] = () => tl.boolTrue();

// ==== contacts ====
handlers["contacts.GetContacts"] = (ctx) => {
  const contacts = [];
  const users = [];
  const seen = new Set();
  for (const chat of store.chatsOf(ctx.uid)) {
    if (chat.type !== "private") continue;
    const other = chat.members.find((m) => String(m) !== String(ctx.uid));
    if (!other || seen.has(other)) continue;
    seen.add(other);
    contacts.push(new TL.Contact({ userId: tl.big(other), mutual: true }));
    users.push(tl.user(store.getUser(other), { contact: true }));
  }
  return new TL.contacts.Contacts({ contacts: contacts, savedCount: contacts.length, users: users });
};
handlers["contacts.GetStatuses"] = () => [];
handlers["contacts.Search"] = (ctx, req) => {
  const q = String(req.q || "");
  const users = store.searchUsers(q, numOr(req.limit, 50));
  const results = [];
  for (const u of users) {
    if (String(u.uid) === String(ctx.uid)) continue;
    results.push(new TL.PeerUser({ userId: tl.big(u.uid) }));
  }
  return new TL.contacts.Found({
    myResults: [],
    results: results,
    chats: [],
    users: collectUsers(users.map((u) => u.uid), ctx.uid)
  });
};
handlers["contacts.ResolveUsername"] = (ctx, req) => {
  const uname = store.normUsername(req.username);
  const u = store.getUserByName(uname);
  if (u) {
    return new TL.contacts.ResolvedPeer({
      peer: new TL.PeerUser({ userId: tl.big(u.uid) }),
      chats: [],
      users: [tl.user(u, { self: String(u.uid) === String(ctx.uid) })]
    });
  }
  for (const id of Object.keys(store.db.chats)) {
    const c = store.db.chats[id];
    if (c.type !== "private" && store.normUsername(c.username) === uname) {
      return new TL.contacts.ResolvedPeer({
        peer: c.type === "channel" ? new TL.PeerChannel({ channelId: tl.big(c.id) }) : new TL.PeerChat({ chatId: tl.big(c.id) }),
        chats: [tl.chat(c)],
        users: []
      });
    }
  }
  return fail(400, "USERNAME_NOT_OCCUPIED");
};
handlers["contacts.ImportContacts"] = (ctx, req) => {
  const imported = [];
  const users = [];
  for (const c of (req.contacts || [])) {
    let u = store.getUserByName(c.phone || "");
    if (!u) u = store.getUserByName(String(c.clientId || ""));
    if (u) {
      imported.push(new TL.ImportedContact({ userId: tl.big(u.uid), clientId: numOr(c.clientId, 0) }));
      users.push(tl.user(u, {}));
    } else {
      users.push(undefined);
    }
  }
  return new TL.contacts.ImportedContacts({
    imported: imported,
    popularInvites: [],
    retryContacts: [],
    users: users.filter(Boolean)
  });
};
handlers["contacts.DeleteContacts"] = () => tl.updates([], [], []);
handlers["contacts.GetContactIDs"] = () => [];
handlers["contacts.ToggleTopPeers"] = () => tl.boolTrue();
handlers["contacts.ResetTopPeerRating"] = () => tl.boolTrue();
handlers["contacts.GetTopPeers"] = () => new TL.contacts.TopPeersNotModified({});
handlers["contacts.Block"] = () => tl.boolTrue();
handlers["contacts.Unblock"] = () => tl.boolTrue();
handlers["contacts.GetBlocked"] = () => new TL.contacts.Blocked({ blocked: [], chats: [], users: [] });

// ==== messages: диалоги ====
handlers["messages.GetDialogs"] = (ctx, req) => {
  const limit = numOr(req.limit, 100);
  let chats = store.chatsOf(ctx.uid);
  chats = chats.filter((c) => {
    const last = store.lastMessageOf(c.id);
    return !!last;
  });
  chats.sort((a, b) => {
    const la = store.lastMessageOf(a.id), lb = store.lastMessageOf(b.id);
    return (lb ? lb.id : 0) - (la ? la.id : 0);
  });
  const offsetPeerId = req.offsetPeer ? (peerUid(req.offsetPeer) || peerChatId(req.offsetPeer)) : null;
  if (offsetPeerId) {
    const idx = chats.findIndex((c) => String(c.id) === String(offsetPeerId));
    if (idx >= 0) chats = chats.slice(idx + 1);
  }
  const slice = chats.slice(0, limit);
  const dialogs = [];
  const messages = [];
  for (const c of slice) {
    dialogs.push(tl.dialog(c, ctx.uid));
    const last = store.lastMessageOf(c.id);
    if (last) messages.push(tl.message(last, ctx.uid));
  }
  const users = [];
  const seen = new Set();
  for (const c of slice) {
    for (const uid of (c.members || [])) {
      if (seen.has(String(uid))) continue;
      seen.add(String(uid));
      const u = store.getUser(uid);
      if (u) users.push(tl.user(u, { self: String(uid) === String(ctx.uid) }));
    }
  }
  if (chats.length > slice.length) {
    return tl.dialogsSlice(chats.length, dialogs, messages, chatsForPeers(slice), users);
  }
  return tl.dialogsResult(dialogs, messages, chatsForPeers(slice), users);
};
handlers["messages.GetPinnedDialogs"] = (ctx, req) => new TL.messages.PeerDialogs({
  dialogs: [], messages: [], chats: [], users: [], state: tl.state()
});
handlers["messages.GetPeerDialogs"] = (ctx, req) => {
  const dialogs = [];
  const messages = [];
  const chatsList = [];
  const users = [];
  const seen = new Set();
  for (const p of (req.peers || [])) {
    const chat = resolvePeer(ctx, p);
    if (!chat) continue;
    dialogs.push(tl.dialog(chat, ctx.uid));
    const last = store.lastMessageOf(chat.id);
    if (last) messages.push(tl.message(last, ctx.uid));
    if (chat.type !== "private") {
      const obj = tl.chat(chat);
      if (obj) chatsList.push(obj);
    }
    for (const uid of (chat.members || [])) {
      if (seen.has(String(uid))) continue;
      seen.add(String(uid));
      const u = store.getUser(uid);
      if (u) users.push(tl.user(u, { self: String(uid) === String(ctx.uid) }));
    }
  }
  return new TL.messages.PeerDialogs({ dialogs: dialogs, messages: messages, chats: chatsList, users: users, state: tl.state() });
};

// ==== messages: история ====
handlers["messages.GetHistory"] = (ctx, req) => {
  const chat = resolvePeer(ctx, req.peer);
  if (!chat) return tl.messagesResult([], [], []);
  const limit = numOr(req.limit, 50);
  const msgs = store.getMessages(chat.id, { limit: limit, beforeId: req.offsetId || 0 });
  const messages = msgs.map((m) => tl.message(m, ctx.uid));
  const users = chatUsers(chat, ctx.uid);
  if (chat.type === "channel") return tl.channelMessages(messages, [tl.channel(chat)], users, store.getMessages(chat.id, {}).length);
  return tl.messagesResult(messages, chat.type === "private" ? [] : [tl.chat(chat)], users);
};
handlers["channels.GetMessages"] = (ctx, req) => {
  const chat = store.getChat(peerChatId(req.channel) || req.channel && req.channel.channelId);
  if (!chat) return tl.messagesResult([], [], []);
  const ids = (req.id || []).map((i) => numOr(i.id, 0));
  const msgs = store.getMessages(chat.id, { ids: ids });
  return tl.channelMessages(msgs.map((m) => tl.message(m, ctx.uid)), [tl.channel(chat)], chatUsers(chat, ctx.uid), msgs.length);
};
handlers["messages.GetMessages"] = (ctx, req) => {
  const ids = (req.id || []).map((i) => numOr(i.id, 0));
  const found = [];
  const chats = [];
  const users = [];
  for (const chat of store.chatsOf(ctx.uid)) {
    const msgs = store.getMessages(chat.id, { ids: ids });
    for (const m of msgs) found.push(tl.message(m, ctx.uid));
    if (msgs.length && chat.type !== "private") {
      const obj = tl.chat(chat);
      if (obj) chats.push(obj);
    }
  }
  return tl.messagesResult(found, chats, users);
};
handlers["messages.GetChats"] = (ctx, req) => {
  const out = [];
  for (const id of (req.id || [])) {
    const c = store.getChat(id);
    if (!c || c.type === "private") continue;
    const obj = tl.chat(c);
    if (obj) out.push(obj);
  }
  return tl.chatsResult(out);
};
handlers["messages.GetFullChat"] = (ctx, req) => {
  const chat = store.getChat(req.chatId);
  if (!chat) return fail(400, "CHAT_ID_INVALID");
  return new TL.messages.ChatFull({
    fullChat: tl.chatFull(chat, ctx.uid),
    chats: chat.type === "private" ? [] : [tl.chat(chat)],
    users: chatUsers(chat, ctx.uid)
  });
};
handlers["channels.GetFullChannel"] = (ctx, req) => {
  const chat = store.getChat(peerChatId(req.channel));
  if (!chat) return fail(400, "CHANNEL_INVALID");
  return new TL.messages.ChatFull({
    fullChat: tl.chatFull(chat, ctx.uid),
    chats: [tl.channel(chat)],
    users: chatUsers(chat, ctx.uid)
  });
};
handlers["messages.GetPeerSettings"] = () => new TL.PeerSettings({
  reportSpam: false, addContact: false, blockContact: false, shareContact: false,
  needContactsException: false, reportGeo: false, autoarchived: false, inviteMembers: false,
  requestChatBroadcast: false, businessBotPaused: false, businessBotCanReply: false,
  geoDistance: undefined, requestChatTitle: undefined, requestChatDate: undefined,
  businessBotId: undefined, businessBotManageUrl: undefined, chargePaidMessageStars: undefined,
  registrationMonth: undefined, phoneCountry: undefined, nameChangeDate: undefined, photoChangeDate: undefined
});

// ==== messages: отправка ====
function mediaFromInput(ctx, inputMedia) {
  if (!inputMedia) return null;
  const c = inputMedia.className || "";
  if (c === "InputMediaUploadedPhoto") {
    const file = takeUpload(inputMedia.file);
    if (!file) return null;
    return store.saveFile(file.buffer, {
      name: file.meta.name || "photo.jpg", mime: file.meta.mime || "image/jpeg",
      kind: "photo", width: file.meta.width || 1280, height: file.meta.height || 960, owner: ctx.uid
    });
  }
  if (c === "InputMediaUploadedDocument") {
    const file = takeUpload(inputMedia.file);
    if (!file) return null;
    const attrs = inputMedia.attributes || [];
    let kind = "document";
    let duration = 0, w = 0, h = 0;
    for (const a of attrs) {
      const ac = a.className || "";
      if (ac === "DocumentAttributeVideo") {
        kind = a.roundMessage ? "video_note" : "video";
        duration = numOr(a.duration, 1);
        w = numOr(a.w, 0);
        h = numOr(a.h, 0);
      } else if (ac === "DocumentAttributeAudio") {
        kind = a.voice ? "voice" : "audio";
        duration = numOr(a.duration, 1);
      } else if (ac === "DocumentAttributeAnimated") {
        kind = "gif";
      } else if (ac === "DocumentAttributeSticker") {
        kind = "sticker";
      } else if (ac === "DocumentAttributeImageSize") {
        w = numOr(a.w, 0);
        h = numOr(a.h, 0);
      }
    }
    let fileName = file.meta.name || "";
    for (const a of attrs) {
      if ((a.className || "") === "DocumentAttributeFilename" && a.fileName) fileName = String(a.fileName);
    }
    const mime = String(inputMedia.mimeType || file.meta.mime || "application/octet-stream");
    if (kind === "document") {
      if (mime.startsWith("image/")) kind = "photo";
      else if (mime.startsWith("video/")) kind = "video";
      else if (mime.startsWith("audio/")) kind = "audio";
    }
    return store.saveFile(file.buffer, {
      name: fileName || "file", mime: mime, kind: kind,
      duration: duration, width: w, height: h, owner: ctx.uid
    });
  }
  if (c === "InputMediaPhoto" || c === "InputMediaDocument") {
    const fileId = tl.refToFileId(inputMedia.id && inputMedia.id.fileReference);
    return fileId ? store.getFile(fileId) : null;
  }
  return null;
}

function takeUpload(inputFile) {
  if (!inputFile) return null;
  const id = String(inputFile.id);
  const inputName = String(inputFile.name || "");
  const pending = store.peekPending(id);
  if (pending && inputName && !pending.meta.name) pending.meta.name = inputName;
  if (!pending) {
    // возможно файл загружен одним куском и уже собран
    return null;
  }
  const res = store.takePending(id);
  if (!res) return null;
  return { buffer: res.buffer, meta: pending.meta || {} };
}

function sendMessageInternal(ctx, chat, text, mediaFile, extra) {
  extra = extra || {};
  const media = mediaFile ? { type: mediaFile.kind, fileId: mediaFile.id, size: mediaFile.size } : null;
  const msg = store.addMessage(chat.id, ctx.uid, Object.assign({
    text: String(text || ""),
    media: media,
    entities: extra.entities || [],
    replyTo: extra.replyTo || 0,
    replyToTop: extra.replyToTop || 0,
    silent: !!extra.silent,
    randomId: extra.randomId || 0
  }, {}));
  if (chat.type === "channel" && chat.broadcast) msg.views = 1;
  // прочитанность: автор читает всё своё
  store.markRead(chat.id, ctx.uid, msg.id);
  pushToChat(chat, (uid) => tl.shortMessage(msg, uid));
  return msg;
}

handlers["messages.SendMessage"] = (ctx, req) => {
  const chat = resolvePeer(ctx, req.peer);
  if (!chat) return fail(400, "PEER_ID_INVALID");
  const msg = sendMessageInternal(ctx, chat, String(req.message || ""), null, {
    entities: req.entities || [],
    replyTo: req.replyTo ? numOr(req.replyTo.replyToMsgId, 0) : 0,
    silent: !!req.silent,
    randomId: numOr(req.randomId, 0)
  });
  return new TL.UpdateShortSentMessage({
    out: true,
    id: msg.id,
    pts: tl.PTS,
    ptsCount: tl.PTS_COUNT,
    date: msg.date,
    media: undefined,
    entities: [],
    ttlPeriod: undefined
  });
};

handlers["messages.SendMedia"] = (ctx, req) => {
  const chat = resolvePeer(ctx, req.peer);
  if (!chat) return fail(400, "PEER_ID_INVALID");
  const file = mediaFromInput(ctx, req.media);
  if (!file) return fail(400, "MEDIA_INVALID");
  const msg = sendMessageInternal(ctx, chat, String(req.message || ""), file, {
    entities: req.entities || [],
    replyTo: req.replyTo ? numOr(req.replyTo.replyToMsgId, 0) : 0,
    silent: !!req.silent,
    randomId: numOr(req.randomId, 0)
  });
  return new TL.UpdateShortSentMessage({
    out: true,
    id: msg.id,
    pts: tl.PTS,
    ptsCount: tl.PTS_COUNT,
    date: msg.date,
    media: tl.messageMedia(msg.media),
    entities: [],
    ttlPeriod: undefined
  });
};

handlers["messages.SendMultiMedia"] = (ctx, req) => {
  const chat = resolvePeer(ctx, req.peer);
  if (!chat) return fail(400, "PEER_ID_INVALID");
  const updatesList = [];
  for (const one of (req.multiMedia || [])) {
    const file = mediaFromInput(ctx, one.media);
    if (!file) continue;
    const msg = sendMessageInternal(ctx, chat, String(one.message || ""), file, { randomId: numOr(one.randomId, 0) });
    updatesList.push(new TL.UpdateNewMessage({ message: tl.message(msg, ctx.uid), pts: tl.PTS, ptsCount: tl.PTS_COUNT }));
  }
  return tl.updates(updatesList, chatUsers(chat, ctx.uid), chat.type === "private" ? [] : [tl.chat(chat)]);
};

handlers["messages.ForwardMessages"] = (ctx, req) => {
  const fromChat = resolvePeer(ctx, req.fromPeer);
  if (!fromChat) return fail(400, "PEER_ID_INVALID");
  const toPeers = (req.toPeers || [req.toPeer]).filter(Boolean);
  const ids = (req.id || []).map((i) => numOr(i, 0));
  const updateList = [];
  const chats = [];
  const users = [];
  for (const p of toPeers) {
    const chat = resolvePeer(ctx, p);
    if (!chat) continue;
    for (const id of ids) {
      const src = store.getMessage(fromChat.id, id);
      if (!src) continue;
      const author = store.getUser(src.fromUid);
      const msg = store.addMessage(chat.id, ctx.uid, {
        text: src.text,
        media: src.media,
        entities: src.entities,
        forwardFrom: { uid: src.fromUid, name: author ? author.name : "", date: src.date }
      });
      const upd = chat.type === "channel"
        ? new TL.UpdateNewChannelMessage({ message: tl.message(msg, ctx.uid), pts: tl.PTS, ptsCount: tl.PTS_COUNT })
        : new TL.UpdateNewMessage({ message: tl.message(msg, ctx.uid), pts: tl.PTS, ptsCount: tl.PTS_COUNT });
      updateList.push(upd);
      pushToChat(chat, (uid) => tl.updates([upd], chatUsers(chat, uid), chat.type === "private" ? [] : [tl.chat(chat)]));
      for (const u of chatUsers(chat, ctx.uid)) if (!users.some((x) => String(x.id) === String(u.id))) users.push(u);
    }
    if (chat.type !== "private") {
      const obj = tl.chat(chat);
      if (obj && !chats.some((c) => String(c.id) === String(obj.id))) chats.push(obj);
    }
  }
  return tl.updates(updateList, users, chats);
};

handlers["messages.SendScheduledMessages"] = (ctx, req) => tl.updates([], [], []);
handlers["messages.GetScheduledHistory"] = () => tl.messagesResult([], [], []);
handlers["messages.DeleteScheduledHistory"] = () => tl.updates([], [], []);
handlers["messages.EditMessage"] = (ctx, req) => {
  const chat = resolvePeer(ctx, req.peer);
  if (!chat) return fail(400, "PEER_ID_INVALID");
  const msg = store.getMessage(chat.id, numOr(req.id, 0));
  if (!msg) return fail(400, "MESSAGE_ID_INVALID");
  if (String(msg.fromUid) !== String(ctx.uid)) return fail(400, "MESSAGE_EDIT_FORBIDDEN");
  msg.text = String(req.message || "");
  msg.entities = req.entities || [];
  msg.edited = true;
  msg.editDate = Math.floor(Date.now() / 1000);
  store.save();
  const upd = chat.type === "channel"
    ? new TL.UpdateEditChannelMessage({ message: tl.message(msg, ctx.uid), pts: tl.PTS, ptsCount: tl.PTS_COUNT })
    : new TL.UpdateEditMessage({ message: tl.message(msg, ctx.uid), pts: tl.PTS, ptsCount: tl.PTS_COUNT });
  pushToChat(chat, () => tl.updates([upd], chatUsers(chat, ctx.uid), chat.type === "private" ? [] : [tl.chat(chat)]));
  return tl.updates([upd], chatUsers(chat, ctx.uid), chat.type === "private" ? [] : [tl.chat(chat)]);
};
handlers["messages.DeleteMessages"] = (ctx, req) => {
  const ids = (req.id || []).map((i) => numOr(i, 0));
  for (const chat of store.chatsOf(ctx.uid)) {
    for (const id of ids) {
      const m = store.getMessage(chat.id, id);
      if (m && (String(m.fromUid) === String(ctx.uid) || req.revoke)) {
        m.deleted = true;
        pushToChat(chat, () => tl.updates([
          chat.type === "channel"
            ? new TL.UpdateDeleteChannelMessages({ channelId: tl.big(chat.id), messages: [id], pts: tl.PTS, ptsCount: tl.PTS_COUNT })
            : new TL.UpdateDeleteMessages({ messages: [id], pts: tl.PTS, ptsCount: tl.PTS_COUNT })
        ], [], []));
      }
    }
  }
  store.save();
  return tl.affectedMessages();
};
handlers["channels.DeleteMessages"] = handlers["messages.DeleteMessages"];
handlers["messages.DeleteHistory"] = (ctx, req) => {
  const chat = resolvePeer(ctx, req.peer);
  if (!chat) return tl.affectedHistory(0);
  const list = store.db.messages[String(chat.id)] || [];
  for (const m of list) m.deleted = true;
  store.save();
  return tl.affectedHistory(0);
};
handlers["messages.ReadHistory"] = (ctx, req) => {
  const chat = resolvePeer(ctx, req.peer);
  if (!chat) return tl.affectedMessages();
  store.markRead(chat.id, ctx.uid, numOr(req.maxId, 0) || undefined);
  pushToChat(chat, (uid) => tl.updates([new TL.UpdateReadHistoryInbox({
    folderId: undefined,
    peer: tl.messagePeer({ chatId: chat.id, fromUid: uid }, uid),
    topMsgId: undefined,
    maxId: numOr(req.maxId, 0),
    stillUnreadCount: 0,
    pts: tl.PTS,
    ptsCount: tl.PTS_COUNT
  })], [], []), ctx.uid);
  return tl.affectedMessages();
};
handlers["channels.ReadHistory"] = (ctx, req) => {
  const chat = store.getChat(peerChatId(req.channel));
  if (!chat) return tl.boolTrue();
  store.markRead(chat.id, ctx.uid, numOr(req.maxId, 0) || undefined);
  return tl.boolTrue();
};
handlers["messages.ReadMessageContents"] = () => tl.affectedMessages();
handlers["channels.ReadMessageContents"] = () => tl.boolTrue();
handlers["messages.ReadMentions"] = () => tl.affectedHistory(0);
handlers["messages.ReadReactions"] = () => tl.affectedHistory(0);
handlers["messages.ReceivedMessages"] = () => [];
handlers["messages.SetTyping"] = (ctx, req) => {
  const chat = resolvePeer(ctx, req.peer);
  if (!chat) return tl.boolTrue();
  const action = req.action || null;
  pushToChat(chat, (uid) => {
    if (chat.type === "channel") {
      return tl.updates([new TL.UpdateChannelUserTyping({ channelId: tl.big(chat.id), topMsgId: undefined, fromId: new TL.PeerUser({ userId: tl.big(ctx.uid) }), action: action })], [], []);
    }
    if (chat.type === "private") {
      return tl.updates([new TL.UpdateUserTyping({ userId: tl.big(ctx.uid), topMsgId: undefined, action: action })], [], []);
    }
    return tl.updates([new TL.UpdateChatUserTyping({ chatId: tl.big(chat.id), topMsgId: undefined, fromId: new TL.PeerUser({ userId: tl.big(ctx.uid) }), action: action })], [], []);
  }, ctx.uid);
  return tl.boolTrue();
};
handlers["messages.Search"] = (ctx, req) => {
  const chat = resolvePeer(ctx, req.peer);
  if (!chat) return tl.messagesResult([], [], []);
  const q = String(req.q || "").toLowerCase();
  const all = store.getMessages(chat.id, { limit: 1000 });
  const found = all.filter((m) => String(m.text || "").toLowerCase().includes(q));
  const sliced = found.slice(Math.max(0, found.length - numOr(req.limit, 50)));
  return tl.messagesResult(sliced.map((m) => tl.message(m, ctx.uid)), [], chatUsers(chat, ctx.uid));
};
handlers["messages.SearchGlobal"] = (ctx, req) => {
  const q = String(req.q || "").toLowerCase();
  const found = [];
  const chats = [];
  const users = [];
  for (const chat of store.chatsOf(ctx.uid)) {
    const all = store.getMessages(chat.id, { limit: 500 });
    for (const m of all) {
      if (String(m.text || "").toLowerCase().includes(q)) {
        found.push(tl.message(m, ctx.uid));
        if (chat.type !== "private") {
          const obj = tl.chat(chat);
          if (obj && !chats.includes(obj)) chats.push(obj);
        }
        const u = store.getUser(m.fromUid);
        if (u) users.push(tl.user(u, { self: String(u.uid) === String(ctx.uid) }));
      }
    }
  }
  return tl.messagesResult(found.slice(0, numOr(req.limit, 50)), chats, users);
};
handlers["messages.GetUnreadMentions"] = () => tl.messagesResult([], [], []);
handlers["messages.GetRecentLocations"] = () => tl.messagesResult([], [], []);
handlers["messages.UpdatePinnedMessage"] = (ctx, req) => {
  const chat = resolvePeer(ctx, req.peer);
  if (!chat) return tl.updates([], [], []);
  if (!chat.pinned) chat.pinned = [];
  const id = numOr(req.id, 0);
  const idx = chat.pinned.indexOf(id);
  if (req.pinned && idx < 0) chat.pinned.push(id);
  if (!req.pinned && idx >= 0) chat.pinned.splice(idx, 1);
  const m = store.getMessage(chat.id, id);
  if (m) m.pinned = !!req.pinned;
  store.save();
  return tl.updates([], [], []);
};
handlers["messages.UnpinAllMessages"] = (ctx, req) => {
  const chat = resolvePeer(ctx, req.peer);
  if (chat) { chat.pinned = []; store.save(); }
  return tl.affectedHistory(0);
};
handlers["messages.SaveDraft"] = (ctx, req) => {
  const chat = resolvePeer(ctx, req.peer);
  if (!chat) return tl.boolTrue();
  const entities = (req.entities || []).map((e) => ({
    type: String((e.className || "").replace("MessageEntity", "").toLowerCase()),
    offset: numOr(e.offset, 0),
    length: numOr(e.length, 0),
    url: e.url || ""
  }));
  chat.draft = { text: String(req.message || ""), entities: entities, date: Math.floor(Date.now() / 1000), replyTo: req.replyTo ? numOr(req.replyTo.replyToMsgId, 0) : 0 };
  store.save();
  const draft = String(req.message || "").length || entities.length
    ? new TL.DraftMessage({ replyTo: undefined, message: String(req.message || ""), entities: req.entities || [], date: chat.draft.date, media: undefined, invoice: undefined })
    : new TL.DraftMessageEmpty({ date: chat.draft.date });
  ws.sendToUser(String(ctx.uid), tl.updates([new TL.UpdateDraftMessage({
    peer: chat.type === "private"
      ? new TL.PeerUser({ userId: tl.big(chat.members.find((m) => String(m) !== String(ctx.uid)) || ctx.uid) })
      : (chat.type === "channel" ? new TL.PeerChannel({ channelId: tl.big(chat.id) }) : new TL.PeerChat({ chatId: tl.big(chat.id) })),
    topMsgId: undefined,
    savedPeerId: undefined,
    draft: draft
  })], [], []));
  return tl.boolTrue();
};
handlers["messages.ClearAllDrafts"] = () => tl.boolTrue();
handlers["messages.GetAllDrafts"] = () => tl.updates([], [], []);
handlers["messages.ToggleDialogPin"] = () => tl.boolTrue();
handlers["messages.MarkDialogUnread"] = () => tl.boolTrue();
handlers["messages.HidePeerSettingsBar"] = () => tl.boolTrue();
handlers["messages.SetDefaultReaction"] = () => tl.boolTrue();
handlers["messages.SendReaction"] = (ctx, req) => {
  const chat = resolvePeer(ctx, req.peer);
  if (!chat) return tl.updates([], [], []);
  const msg = store.getMessage(chat.id, numOr(req.msgId, 0));
  if (!msg) return tl.updates([], [], []);
  msg.reactions = msg.reactions || {};
  const raw = req.reaction;
  let emoji = "";
  if (Array.isArray(raw)) {
    const first = raw[0];
    if (first) emoji = String(first.emoticon || "").trim();
  } else if (raw && typeof raw === "object") {
    emoji = String(raw.emoticon || "").trim();
  } else {
    emoji = String(raw || "").trim();
  }
  if (!emoji) {
    msg.reactions = {};
  } else {
    if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
    if (!msg.reactions[emoji].includes(String(ctx.uid))) msg.reactions[emoji].push(String(ctx.uid));
  }
  store.save();
  const upd = new TL.UpdateMessageReactions({
    peer: tl.messagePeer(msg, ctx.uid),
    msgId: msg.id,
    topMsgId: undefined,
    savedPeerId: undefined,
    reactions: tl.messageReactions(msg)
  });
  pushToChat(chat, () => tl.updates([upd], [], []));
  return tl.updates([upd], [], []);
};
handlers["messages.GetMessageReactionsList"] = () => tl.messagesResult([], [], []);
handlers["messages.GetAvailableReactions"] = () => new TL.messages.AvailableReactions({ hash: 0, reactions: [] });
handlers["messages.GetEmojiKeywords"] = (ctx, req) => new TL.EmojiKeywordsDifference({ langCode: String(req.langCode || "ru"), fromVersion: 0, version: 1, keywords: [] });
handlers["messages.GetEmojiKeywordsDifference"] = (ctx, req) => new TL.EmojiKeywordsDifference({ langCode: String(req.langCode || "ru"), fromVersion: 0, version: 1, keywords: [] });
handlers["messages.GetEmojiURL"] = () => new TL.EmojiURL({ url: "" });
handlers["messages.GetEmojiStatusGroups"] = () => new TL.messages.EmojiGroups({ hash: 0, groups: [] });
handlers["messages.GetEmojiStickers"] = () => new TL.messages.AllStickers({ hash: 0, stickers: [] });
handlers["messages.GetFeaturedEmojiStickers"] = () => new TL.messages.FeaturedStickers({ hash: 0, count: 0, sets: [], unread: [] });
handlers["messages.GetAllStickers"] = () => new TL.messages.AllStickers({ hash: 0, stickers: [] });
handlers["messages.GetStickers"] = () => new TL.messages.AllStickers({ hash: 0, stickers: [] });
handlers["messages.GetFeaturedStickers"] = () => new TL.messages.FeaturedStickers({ hash: 0, count: 0, sets: [], unread: [] });
handlers["messages.GetRecentStickers"] = () => new TL.messages.RecentStickers({ hash: 0, packs: [], stickers: [], dates: [] });
handlers["messages.GetFavedStickers"] = () => new TL.messages.FavedStickers({ hash: 0, packs: [], stickers: [] });
handlers["messages.GetArchivedStickers"] = () => new TL.messages.ArchivedStickers({ count: 0, sets: [] });
handlers["messages.GetSavedGifs"] = () => new TL.messages.SavedGifs({ hash: 0, gifs: [] });
handlers["messages.GetStickerSet"] = () => new TL.messages.StickerSet({ set: new TL.StickerSet({ archived: false, official: false, masks: false, animated: false, videos: false, emojis: false, textColor: false, installedDate: undefined, id: 0n, accessHash: 0n, title: "", shortName: "", thumbs: [], thumbDcId: undefined, thumbVersion: undefined, count: 0, hash: 0 }), packs: [], documents: [] });
handlers["messages.GetDocumentByHash"] = () => fail(400, "DOCUMENT_HASH_INVALID");
handlers["messages.GetWebPagePreview"] = () => new TL.MessageMediaWebPage({ webpage: new TL.WebPageEmpty({ id: 0n, url: "" }) });
handlers["messages.GetDialogFilters"] = () => [];
handlers["messages.GetSuggestedDialogFilters"] = () => [];
handlers["messages.UpdateDialogFilter"] = () => tl.boolTrue();
handlers["messages.UpdateDialogFiltersOrder"] = () => tl.boolTrue();
handlers["messages.GetDialogUnreadMarks"] = () => [];
handlers["messages.GetSearchCounters"] = () => [];
handlers["messages.GetSplitRanges"] = () => [];
handlers["messages.GetOnlines"] = () => new TL.ChatOnlines({ onlines: 1 });
handlers["messages.GetCommonChats"] = () => tl.chatsResult([]);
handlers["messages.GetReplies"] = () => tl.messagesResult([], [], []);
handlers["messages.GetDiscussionMessage"] = () => tl.messagesResult([], [], []);
handlers["messages.GetBotCallbackAnswer"] = () => new TL.messages.BotCallbackAnswer({ alert: false, hasUrl: false, nativeUi: false, message: undefined, url: undefined, cacheTime: 0 });
handlers["messages.GetInlineBotResults"] = () => new TL.messages.BotResults({ gallery: false, nextOffset: undefined, switchPm: undefined, results: [], cacheTime: 0, users: [], queryId: 0n });
handlers["messages.SetInlineBotResults"] = () => tl.boolTrue();
handlers["messages.GetAttachMenuBots"] = () => new TL.AttachMenuBots({ hash: 0, users: [] });
handlers["messages.GetExtendedMedia"] = () => tl.updates([], [], []);
handlers["messages.TranslateText"] = () => new TL.messages.TranslateResult({ result: [] });
handlers["messages.GetMessageReadParticipants"] = () => [];

// ==== создание чатов, групп и каналов ====
function serviceMessage(chat, fromUid, action) {
  return store.addMessage(chat.id, fromUid, { text: "", action: action });
}

handlers["messages.CreateChat"] = (ctx, req) => {
  const members = (req.users || []).map((u) => peerUid(u)).filter(Boolean);
  const chat = store.createChat("group", String(req.title || "Группа"), members, ctx.uid, "", "");
  const msg = serviceMessage(chat, ctx.uid, new TL.MessageActionChatCreate({ title: chat.title, users: members.map((m) => tl.big(m)) }));
  const upd = new TL.UpdateNewMessage({ message: tl.message(msg, ctx.uid), pts: tl.PTS, ptsCount: tl.PTS_COUNT });
  pushToChat(chat, () => tl.updates([upd], chatUsers(chat, ctx.uid), [tl.chat(chat)]));
  return tl.updates([upd], chatUsers(chat, ctx.uid), [tl.chat(chat)]);
};

handlers["messages.AddChatUser"] = (ctx, req) => {
  const chat = store.getChat(req.chatId);
  if (!chat) return fail(400, "CHAT_ID_INVALID");
  const uid = peerUid(req.userId);
  if (uid && !chat.members.includes(uid)) chat.members.push(uid);
  store.save();
  const msg = serviceMessage(chat, ctx.uid, new TL.MessageActionChatAddUser({ users: [tl.big(uid)] }));
  const upd = new TL.UpdateNewMessage({ message: tl.message(msg, ctx.uid), pts: tl.PTS, ptsCount: tl.PTS_COUNT });
  pushToChat(chat, () => tl.updates([upd], chatUsers(chat, ctx.uid), [tl.chat(chat)]));
  return tl.updates([upd], chatUsers(chat, ctx.uid), [tl.chat(chat)]);
};
handlers["messages.DeleteChatUser"] = (ctx, req) => {
  const chat = store.getChat(req.chatId);
  if (!chat) return fail(400, "CHAT_ID_INVALID");
  const uid = peerUid(req.userId);
  chat.members = chat.members.filter((m) => m !== uid);
  store.save();
  const msg = serviceMessage(chat, ctx.uid, new TL.MessageActionChatDeleteUser({ userId: tl.big(uid) }));
  const upd = new TL.UpdateNewMessage({ message: tl.message(msg, ctx.uid), pts: tl.PTS, ptsCount: tl.PTS_COUNT });
  pushToChat(chat, () => tl.updates([upd], chatUsers(chat, ctx.uid), [tl.chat(chat)]));
  return tl.updates([upd], chatUsers(chat, ctx.uid), [tl.chat(chat)]);
};
handlers["messages.EditChatTitle"] = (ctx, req) => {
  const chat = store.getChat(req.chatId);
  if (!chat) return fail(400, "CHAT_ID_INVALID");
  chat.title = String(req.title || chat.title);
  store.save();
  const msg = serviceMessage(chat, ctx.uid, new TL.MessageActionChatEditTitle({ title: chat.title }));
  const upd = new TL.UpdateNewMessage({ message: tl.message(msg, ctx.uid), pts: tl.PTS, ptsCount: tl.PTS_COUNT });
  pushToChat(chat, () => tl.updates([upd], chatUsers(chat, ctx.uid), [tl.chat(chat)]));
  return tl.updates([upd], chatUsers(chat, ctx.uid), [tl.chat(chat)]);
};
handlers["messages.EditChatAbout"] = (ctx, req) => {
  const chat = store.getChat(req.chatId);
  if (!chat) return fail(400, "CHAT_ID_INVALID");
  chat.about = String(req.about || "");
  store.save();
  return tl.boolTrue();
};
handlers["messages.EditChatPhoto"] = (ctx, req) => {
  const chat = store.getChat(req.chatId);
  if (!chat) return fail(400, "CHAT_ID_INVALID");
  const file = takeUpload(req.photo && req.photo.file);
  if (file) {
    const saved = store.saveFile(file.buffer, { name: "avatar.jpg", mime: "image/jpeg", kind: "photo", owner: ctx.uid });
    chat.photoId = saved.id;
    store.save();
  }
  const upd = new TL.UpdateNewMessage({ message: tl.message(serviceMessage(chat, ctx.uid, new TL.MessageActionChatEditPhoto({ photo: chat.photoId ? tl.photo(store.getFile(chat.photoId)) : new TL.PhotoEmpty({ id: 0n }) })), ctx.uid), pts: tl.PTS, ptsCount: tl.PTS_COUNT });
  pushToChat(chat, () => tl.updates([upd], chatUsers(chat, ctx.uid), [tl.chat(chat)]));
  return tl.updates([upd], chatUsers(chat, ctx.uid), [tl.chat(chat)]);
};
handlers["messages.EditChatDefaultBannedRights"] = (ctx, req) => {
  const chat = store.getChat(req.chatId);
  if (chat) store.save();
  return tl.updates([], [], []);
};
handlers["messages.MigrateChat"] = (ctx, req) => tl.updates([], [], []);
handlers["messages.CheckChatInvite"] = (ctx, req) => {
  const hash = String(req.hash || "");
  const chat = findChatByInvite(hash);
  if (!chat) return fail(400, "INVITE_HASH_INVALID");
  return new TL.ChatInviteAlready({ chat: tl.chat(chat) });
};
handlers["messages.ImportChatInvite"] = (ctx, req) => {
  const chat = findChatByInvite(String(req.hash || ""));
  if (!chat) return fail(400, "INVITE_HASH_INVALID");
  if (!chat.members.includes(String(ctx.uid))) chat.members.push(String(ctx.uid));
  store.save();
  return tl.updates([], chatUsers(chat, ctx.uid), [tl.chat(chat)]);
};
handlers["messages.ExportChatInvite"] = (ctx, req) => {
  const chat = store.getChat(req.peer ? peerChatId(req.peer) : null) || resolvePeer(ctx, req.peer);
  if (!chat) return fail(400, "CHAT_ID_INVALID");
  if (!chat.inviteHash) chat.inviteHash = require("crypto").randomBytes(8).toString("hex");
  store.save();
  return new TL.ChatInviteExported({
    revoked: false, permanent: true, requestNeeded: false,
    link: "https://t.me/+" + chat.inviteHash, adminId: tl.big(chat.creator),
    date: Math.floor(Date.now() / 1000), startDate: undefined, expireDate: undefined,
    usageLimit: undefined, usage: 0, requested: 0, subscriptionExpired: undefined,
    title: undefined, subscriptionPricing: undefined
  });
};
handlers["messages.GetChatInviteImporters"] = () => new TL.messages.ChatInviteImporters({ count: 0, importers: [], users: [] });

// ==== channels ====
handlers["channels.CreateChannel"] = (ctx, req) => {
  const isMega = !!req.megagroup || !!req.forum;
  const chat = store.createChat("channel", String(req.title || (isMega ? "Группа" : "Канал")), [], ctx.uid, String(req.about || ""), "");
  chat.megagroup = isMega;
  chat.broadcast = !isMega;
  store.save();
  const msg = serviceMessage(chat, ctx.uid, new TL.MessageActionChannelCreate({ title: chat.title }));
  const upd = new TL.UpdateNewChannelMessage({ message: tl.message(msg, ctx.uid), pts: tl.PTS, ptsCount: tl.PTS_COUNT });
  pushToChat(chat, () => tl.updates([upd], chatUsers(chat, ctx.uid), [tl.channel(chat)]));
  return tl.updates([upd], chatUsers(chat, ctx.uid), [tl.channel(chat)]);
};
handlers["channels.GetChannels"] = (ctx, req) => {
  const out = [];
  for (const p of (req.id || [])) {
    const c = store.getChat(peerChatId(p));
    if (c && c.type === "channel") out.push(tl.channel(c));
  }
  return tl.chatsResult(out);
};
handlers["channels.GetAdminedPublicChannels"] = (ctx) => {
  const out = [];
  for (const c of store.chatsOf(ctx.uid)) {
    if (c.type === "channel" && String(c.creator) === String(ctx.uid)) out.push(tl.channel(c));
  }
  return tl.chatsResult(out);
};
handlers["channels.EditTitle"] = (ctx, req) => {
  const chat = store.getChat(peerChatId(req.channel));
  if (!chat) return fail(400, "CHAT_ID_INVALID");
  chat.title = String(req.title || chat.title);
  store.save();
  const upd = new TL.UpdateNewChannelMessage({ message: tl.message(serviceMessage(chat, ctx.uid, new TL.MessageActionChatEditTitle({ title: chat.title })), ctx.uid), pts: tl.PTS, ptsCount: tl.PTS_COUNT });
  pushToChat(chat, () => tl.updates([upd], chatUsers(chat, ctx.uid), [tl.channel(chat)]));
  return tl.updates([upd], chatUsers(chat, ctx.uid), [tl.channel(chat)]);
};
handlers["channels.EditAbout"] = (ctx, req) => {
  const chat = store.getChat(peerChatId(req.channel));
  if (!chat) return fail(400, "CHAT_ID_INVALID");
  chat.about = String(req.about || "");
  store.save();
  return tl.boolTrue();
};
handlers["channels.EditPhoto"] = (ctx, req) => {
  const chat = store.getChat(peerChatId(req.channel));
  if (!chat) return fail(400, "CHAT_ID_INVALID");
  const file = takeUpload(req.photo && req.photo.file);
  if (file) {
    const saved = store.saveFile(file.buffer, { name: "avatar.jpg", mime: "image/jpeg", kind: "photo", owner: ctx.uid });
    chat.photoId = saved.id;
    store.save();
  }
  const upd = new TL.UpdateNewChannelMessage({ message: tl.message(serviceMessage(chat, ctx.uid, new TL.MessageActionChatEditPhoto({ photo: chat.photoId ? tl.photo(store.getFile(chat.photoId)) : new TL.PhotoEmpty({ id: 0n }) })), ctx.uid), pts: tl.PTS, ptsCount: tl.PTS_COUNT });
  pushToChat(chat, () => tl.updates([upd], chatUsers(chat, ctx.uid), [tl.channel(chat)]));
  return tl.updates([upd], chatUsers(chat, ctx.uid), [tl.channel(chat)]);
};
handlers["channels.UpdateUsername"] = (ctx, req) => {
  const chat = store.getChat(peerChatId(req.channel));
  if (!chat) return fail(400, "CHAT_ID_INVALID");
  chat.username = store.normUsername(req.username);
  store.save();
  return tl.boolTrue();
};
handlers["channels.CheckUsername"] = (ctx, req) => {
  const uname = store.normUsername(req.username);
  let taken = !!store.getUserByName(uname);
  for (const id of Object.keys(store.db.chats)) {
    if (store.normUsername(store.db.chats[id].username) === uname) taken = true;
  }
  return !taken;
};
handlers["channels.JoinChannel"] = (ctx, req) => {
  const chat = store.getChat(peerChatId(req.channel));
  if (!chat) return fail(400, "CHAT_ID_INVALID");
  if (!chat.members.includes(String(ctx.uid))) chat.members.push(String(ctx.uid));
  store.save();
  const upd = new TL.UpdateNewChannelMessage({ message: tl.message(serviceMessage(chat, ctx.uid, new TL.MessageActionChatAddUser({ users: [tl.big(ctx.uid)] })), ctx.uid), pts: tl.PTS, ptsCount: tl.PTS_COUNT });
  pushToChat(chat, () => tl.updates([upd], chatUsers(chat, ctx.uid), [tl.channel(chat)]));
  return tl.updates([upd], chatUsers(chat, ctx.uid), [tl.channel(chat)]);
};
handlers["channels.LeaveChannel"] = (ctx, req) => {
  const chat = store.getChat(peerChatId(req.channel));
  if (!chat) return fail(400, "CHAT_ID_INVALID");
  chat.members = chat.members.filter((m) => m !== String(ctx.uid));
  store.save();
  const upd = new TL.UpdateNewChannelMessage({ message: tl.message(serviceMessage(chat, ctx.uid, new TL.MessageActionChatDeleteUser({ userId: tl.big(ctx.uid) })), ctx.uid), pts: tl.PTS, ptsCount: tl.PTS_COUNT });
  pushToChat(chat, () => tl.updates([upd], chatUsers(chat, ctx.uid), [tl.channel(chat)]));
  return tl.updates([upd], chatUsers(chat, ctx.uid), [tl.channel(chat)]);
};
handlers["channels.InviteToChannel"] = (ctx, req) => {
  const chat = store.getChat(peerChatId(req.channel));
  if (!chat) return fail(400, "CHAT_ID_INVALID");
  const uids = (req.users || []).map((u) => peerUid(u)).filter(Boolean);
  for (const uid of uids) if (!chat.members.includes(uid)) chat.members.push(uid);
  store.save();
  const upd = new TL.UpdateNewChannelMessage({ message: tl.message(serviceMessage(chat, ctx.uid, new TL.MessageActionChatAddUser({ users: uids.map((u) => tl.big(u)) })), ctx.uid), pts: tl.PTS, ptsCount: tl.PTS_COUNT });
  pushToChat(chat, () => tl.updates([upd], chatUsers(chat, ctx.uid), [tl.channel(chat)]));
  return tl.updates([upd], chatUsers(chat, ctx.uid), [tl.channel(chat)]);
};
handlers["channels.DeleteChannel"] = (ctx, req) => {
  const chat = store.getChat(peerChatId(req.channel));
  if (chat) {
    delete store.db.chats[String(chat.id)];
    delete store.db.messages[String(chat.id)];
    store.save();
  }
  return tl.updates([], [], []);
};
handlers["channels.GetParticipants"] = (ctx, req) => {
  const chat = store.getChat(peerChatId(req.channel));
  if (!chat) return new TL.channels.ChannelParticipants({ count: 0, participants: [], chats: [], users: [] });
  const participants = (chat.members || []).map((uid) => String(uid) === String(chat.creator)
    ? new TL.ChannelParticipantCreator({ userId: tl.big(uid), adminRights: tl.adminRights(true), rank: undefined })
    : new TL.ChannelParticipant({ userId: tl.big(uid), date: Math.floor(numOr(chat.createdAt, Date.now()) / 1000), subscriptionUntilDate: undefined, rank: undefined }));
  return new TL.channels.ChannelParticipants({
    count: participants.length,
    participants: participants,
    chats: [tl.channel(chat)],
    users: chatUsers(chat, ctx.uid)
  });
};
handlers["channels.GetParticipant"] = (ctx, req) => {
  const chat = store.getChat(peerChatId(req.channel));
  const uid = peerUid(req.userId) || peerUid(req.participant);
  if (!chat || !uid) return fail(400, "USER_ID_INVALID");
  const p = String(uid) === String(chat.creator)
    ? new TL.ChannelParticipantCreator({ userId: tl.big(uid), adminRights: tl.adminRights(true), rank: undefined })
    : new TL.ChannelParticipant({ userId: tl.big(uid), date: Math.floor(numOr(chat.createdAt, Date.now()) / 1000), subscriptionUntilDate: undefined, rank: undefined });
  return new TL.channels.ChannelParticipant({ participant: p, chats: [tl.channel(chat)], users: chatUsers(chat, ctx.uid) });
};
handlers["channels.GetLeftChannels"] = () => tl.chatsResult([]);
handlers["channels.GetGroupsForDiscussion"] = () => tl.chatsResult([]);
handlers["channels.ToggleSignatures"] = () => tl.updates([], [], []);
handlers["channels.GetChannelRecommendations"] = () => tl.chatsResult([]);

// ==== photos ====
handlers["photos.UploadProfilePhoto"] = (ctx, req) => {
  const file = takeUpload(req.file);
  if (!file) return fail(400, "FILE_PART_MISSING");
  const saved = store.saveFile(file.buffer, { name: "avatar.jpg", mime: "image/jpeg", kind: "photo", owner: ctx.uid });
  ctx.user.photoId = saved.id;
  store.save();
  const upd = new TL.UpdateUser({ userId: tl.big(ctx.uid) });
  ws.sendToUser(String(ctx.uid), tl.updates([upd], [tl.user(ctx.user, { self: true })], []));
  return new TL.photos.Photo({ photo: tl.photo(saved), users: [tl.user(ctx.user, { self: true })] });
};
handlers["photos.UpdateProfilePhoto"] = (ctx, req) => {
  const fileId = tl.refToFileId(req.id && req.id.fileReference);
  const file = fileId ? store.getFile(fileId) : null;
  if (file) {
    ctx.user.photoId = file.id;
    store.save();
  }
  return new TL.photos.Photo({
    photo: file ? tl.photo(file) : new TL.PhotoEmpty({ id: 0n }),
    users: [tl.user(ctx.user, { self: true })]
  });
};
handlers["photos.GetUserPhotos"] = (ctx, req) => new TL.photos.Photos({ photos: [], users: [] });
handlers["photos.DeletePhotos"] = () => [];

// ==== upload ====
handlers["upload.SaveFilePart"] = (ctx, req) => {
  const bytes = req.bytes || Buffer.alloc(0);
  store.putPendingPart(String(req.fileId), numOr(req.filePart, 0), Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes), { name: queryName(req) });
  return tl.boolTrue();
};
handlers["upload.SaveBigFilePart"] = (ctx, req) => {
  const bytes = req.bytes || Buffer.alloc(0);
  store.putPendingPart(String(req.fileId), numOr(req.filePart, 0), Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
  return tl.boolTrue();
};
handlers["upload.GetFile"] = (ctx, req) => {
  const loc = req.location || {};
  let fileId = tl.refToFileId(loc.fileReference);
  if (fileId == null) {
    const c = loc.className || "";
    if (c === "InputPeerPhotoFileLocation") {
      const peerChat = resolvePeer(ctx, loc.peer);
      const uid = peerUid(loc.peer);
      if (uid) {
        const u = store.getUser(uid);
        if (u && u.photoId) fileId = u.photoId;
      } else if (peerChat && peerChat.photoId) {
        fileId = peerChat.photoId;
      }
    } else {
      fileId = String(loc.id != null ? loc.id : "");
    }
  }
  const res = store.fileBytes(fileId, numOr(req.offset, 0), numOr(req.limit, 0) || 0);
  if (!res) return fail(400, "FILE_ID_INVALID");
  return new TL.upload.File({
    type: res.complete ? new TL.storage.FileUnknown({}) : new TL.storage.FilePartial({}),
    mtime: Math.floor(Date.now() / 1000),
    bytes: res.buffer
  });
};
handlers["upload.GetWebFile"] = () => fail(400, "WEBFILE_NOT_SUPPORTED");
handlers["upload.ReuploadCdnFile"] = () => [];

// ==== updates ====
handlers["updates.GetState"] = () => tl.state();
handlers["updates.GetDifference"] = () => new TL.updates.DifferenceEmpty({ date: Math.floor(Date.now() / 1000), seq: 0 });

// ==== stickers / langpack / прочее — пустые ответы, чтобы UI не ломался ====
handlers["stickers.GetFeaturedStickers"] = () => new TL.messages.FeaturedStickers({ hash: 0, count: 0, sets: [], unread: [] });
handlers["langpack.GetLangPack"] = () => fail(400, "LANGPACK_NOT_SUPPORTED");
handlers["langpack.GetLanguages"] = () => [];
handlers["langpack.GetLanguage"] = () => fail(400, "LANGPACK_NOT_SUPPORTED");
handlers["help.GetSuggestions"] = () => fail(400, "SUGGESTIONS_EMPTY");
handlers["messages.GetQuickReplies"] = () => new TL.messages.QuickReplies({ hash: 0, quickReplies: [], messages: [] });
handlers["messages.GetDefaultEmojiStatuses"] = () => new TL.Account_EmojiStatuses({ hash: 0, statuses: [] });
handlers["messages.GetRecentEmojiStatuses"] = () => new TL.Account_EmojiStatuses({ hash: 0, statuses: [] });
handlers["account.GetDefaultEmojiStatuses"] = () => new TL.Account_EmojiStatuses({ hash: 0, statuses: [] });
handlers["account.GetRecentEmojiStatuses"] = () => new TL.Account_EmojiStatuses({ hash: 0, statuses: [] });
handlers["account.GetWebBrowserConfig"] = () => new TL.DataJSON({ data: "{}" });
handlers["messages.GetSponsoredMessages"] = () => new TL.messages.SponsoredMessages({ postsBetween: undefined, messages: [], chats: [], users: [] });
handlers["messages.ViewSponsoredMessage"] = () => tl.boolTrue();
handlers["messages.GetMessagesViews"] = () => new TL.messages.MessageViews({ views: [], chats: [], users: [] });
handlers["channels.GetSendAs"] = () => new TL.channels.SendAsPeers({ peers: [], chats: [], users: [] });
handlers["channels.GetAdminLog"] = () => new TL.channels.AdminLogResults({ events: [], chats: [], users: [] });
handlers["channels.GetForumTopics"] = () => new TL.messages.ForumTopics({ count: 0, topics: [], messages: [], chats: [], users: [], order: undefined, pts: 0 });
handlers["messages.GetSearchResultsPositions"] = () => [];
handlers["langpack.GetStrings"] = () => [];
handlers["langpack.GetDifference"] = () => new TL.LangPackDifference({ langCode: "ru", fromVersion: 0, version: 0, strings: [] });

function queryName(req) {
  const n = req && req.__fileName;
  return n ? String(n) : "";
}

function numOr(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

// ---------------- безопасные заглушки ----------------
// Если метод не реализован, но он из разряда «что-то меняем» (Set/Save/Toggle/...),
// отдаём boolTrue — клиент не упадёт и не зациклится.
const BOOL_PREFIXES = /^(Set|Save|Toggle|Update|Delete|Read|Mark|Add|Remove|Join|Leave|Import|Reset|Cancel|Clear|Hide|Install|Uninstall|Report|Reorder|Apply|Confirm|Accept|Decline|Disable|Enable|Register|Unregister|Bind|Stop|Start|Finish|Open|Close|Perform|Invoke|Upload|Dismiss|Rate|Send)/;

function fallbackFor(name) {
  const short = name.indexOf(".") >= 0 ? name.slice(name.indexOf(".") + 1) : name;
  if (!BOOL_PREFIXES.test(short)) return null;
  // методы, которые точно возвращают не Bool
  if (/^(Send|Upload)/.test(short)) return null;
  return tl.boolTrue();
}

// ---------------- диспетчер ----------------
async function dispatch(ctx, obj) {
  const name = obj && obj.className ? obj.className : "";
  let handler = handlers[name];
  if (!handler) {
    const fallback = fallbackFor(name);
    if (fallback !== null) {
      console.log("🔀 TL " + name + " — отвечаем безопасной заглушкой");
      return { result: fallback };
    }
    console.log("🔀 TL " + name + " — обработчика нет");
    return { error: { code: 400, text: name.toUpperCase().replace(/\./g, "_") + "_NOT_SUPPORTED" } };
  }
  try {
    const res = await handler(ctx, obj);
    if (res && res.error) return { error: res.error };
    if (res === undefined || res === null) {
      console.log("🔀 TL " + name + " — пустой ответ");
      return { error: { code: 500, text: "EMPTY_RESPONSE" } };
    }
    return { result: res };
  } catch (e) {
    console.error("💥 TL " + name + " error:", e && e.message ? e.message : e);
    return { error: { code: 500, text: "INTERNAL_ERROR" } };
  }
}

module.exports = {
  dispatch: dispatch,
  handlers: handlers,
  resolvePeer: resolvePeer,
  sendMessageInternal: sendMessageInternal,
  peerUid: peerUid,
  peerChatId: peerChatId
};
