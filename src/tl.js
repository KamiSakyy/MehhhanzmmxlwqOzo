"use strict";
/*
 * TL-слой: превращает наши данные (пользователи, чаты, сообщения, файлы)
 * в родные TL-объекты Telegram (LAYER 231 — тот же, что у клиента DrKLO)
 * и обратно. Сериализация — @tgsnake/skema (конструкторы совпадают с TLRPC.java).
 */

const { Raw: TL, TLObject, Primitive } = require("@tgsnake/skema");
const { BytesIO } = require("@tgsnake/bytesio");
const store = require("./store");

const DC_ID = 1;
const PTS = 0;       // pts/pts_count всегда 0 — клиент не уходит в getDifference
const PTS_COUNT = 0;

function big(v) {
  if (typeof v === "bigint") return v;
  if (v === null || v === undefined) return 0n;
  return BigInt(String(v));
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// наш file_reference: "f<id>" — по нему клиент качает файл через upload.getFile
function fileRef(fileId) {
  return Buffer.from("f" + fileId, "utf8");
}

function refToFileId(buf) {
  try {
    const s = Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf || "");
    if (s.startsWith("f")) return s.slice(1);
  } catch (e) { /* ignore */ }
  return null;
}

// ---------------- чтение / запись ----------------
/*
 * HANDOFF: клиент (DrKLO/Telegram, LAYER 231) шлёт НОВЫЕ TL-конструкторы, а схема
 * @tgsnake/skema знает старые — из-за этого часть запросов вообще не разбиралась
 * (сообщения не грузились, группы/каналы не создавались, обновления не приходили).
 *
 * Где поля совпадают один-в-один — просто подменяем 4 байта конструктора.
 * Где раскладка другая — разбираем запрос руками и отдаём объект старого вида.
 */
const CTOR_TRANSLATE = new Map([
  [0x4222fa74, 0x63c66506], // messages.getMessages   (id:Vector<int>)
  [0x93d7b347, 0xad8c9a23], // channels.getMessages   (channel, id)
  [0x6c50051c, 0xde91436e], // messages.importChatInvite (hash:string)
  [0x24b524c5, 0x7f6a1e22], // channels.joinChannel   (channel)
  [0x199f3a6c, 0xc9e33d54], // channels.inviteToChannel (channel, users)
  [0xc7025931, 0x9156982a], // upload.getFileHashes   (location, offset)
]);

async function readTlObjects(io, count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(await TLObject.read(io));
  return out;
}

async function readTlVector(io) {
  const n = io.readInt32LE();
  if (n === 0x1cb5c415) return readTlVector(io); // на всякий случай: «голый» Vector
  if (n < 0 || n > 100000) throw new Error("bad vector size " + n);
  return readTlObjects(io, n);
}

async function readTlString(io) {
  return Primitive.String.read(io);
}

// --- ручные разборщики запросов нового слоя ---
const MANUAL_PARSERS = {
  // messages.uploadMedia#519bc2b1 peer:InputPeer media:InputMedia
  0x519bc2b1: async (io) => ({
    className: "messages.UploadMedia",
    peer: await TLObject.read(io),
    media: await TLObject.read(io)
  }),
  // langpack.getLangPack#9ab5c58e lang_code:string
  0x9ab5c58e: async (io) => ({
    className: "langpack.GetLangPack",
    langPack: "android",
    langCode: await readTlString(io)
  }),
  // langpack.getStrings#2e1ee318 lang_code:string keys:Vector<string>
  0x2e1ee318: async (io) => {
    const obj = { className: "langpack.GetStrings", langPack: "android" };
    obj.langCode = await readTlString(io);
    const n = io.readInt32LE();
    const keys = [];
    for (let i = 0; i < n; i++) keys.push(await readTlString(io));
    obj.keys = keys;
    return obj;
  },
  // langpack.getLanguages#800fd57d — без полей
  0x800fd57d: async () => ({ className: "langpack.GetLanguages", langPack: "android" }),
  // messages.createChat#34a818 flags:# users:Vector<InputUser> title:string ttl_period:flags.0?int
  0x34a818: async (io) => {
    const flags = io.readInt32LE();
    const users = await readTlVector(io);
    const title = await readTlString(io);
    if (flags & 1) io.readInt32LE(); // ttl_period — нам не нужен
    return { className: "messages.CreateChat", users: users, title: title };
  },
  // messages.addChatUser#f24753e3 chat_id:long user_id:InputUser fwd_limit:int
  0xf24753e3: async (io) => ({
    className: "messages.AddChatUser",
    chatId: Number(io.readBigInt64LE()),
    userId: await TLObject.read(io),
    fwdLimit: io.readInt32LE()
  }),
  // updates.getDifference#25939651 flags:# pts:int pts_total_limit:flags.0?int date:int qts:int
  0x25939651: async (io) => {
    const flags = io.readInt32LE();
    const pts = io.readInt32LE();
    const ptsTotalLimit = (flags & 1) ? io.readInt32LE() : 0;
    const date = io.readInt32LE();
    const qts = io.readInt32LE();
    return { className: "updates.GetDifference", pts: pts, ptsTotalLimit: ptsTotalLimit, date: date, qts: qts };
  }
};

async function readObject(buffer) {
  let buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (buf.length >= 4) {
    const ctor = buf.readUInt32LE(0);
    const manual = MANUAL_PARSERS[ctor];
    if (manual) {
      const io = BytesIO.from(buf);
      io.read(4); // съедаем конструктор
      try {
        return await manual(io);
      } catch (e) {
        throw new Error("manual parse 0x" + ctor.toString(16) + ": " + e.message);
      }
    }
    const legacy = CTOR_TRANSLATE.get(ctor);
    if (legacy !== undefined) {
      buf = Buffer.from(buf);
      buf.writeUInt32LE(legacy, 0);
    }
  }
  let obj = await TLObject.read(BytesIO.from(buf));
  let guard = 0;
  while (obj && guard++ < 8) {
    const cls = obj.className || "";
    if (cls === "InvokeWithLayer" || cls === "InitConnection" || cls === "InvokeWithoutUpdates" ||
        cls === "InvokeWithTakeout" || cls === "InvokeWithMessagesRange" || cls === "InvokeWithReCaptcha") {
      obj = obj.query;
      continue;
    }
    if (cls === "GzipPacked") {
      const packed = obj.packedData;
      if (packed && packed.className) {
        obj = packed;
      } else {
        const zlib = require("zlib");
        const raw = Buffer.isBuffer(packed) ? packed : Buffer.from(packed || []);
        obj = await TLObject.read(BytesIO.from(zlib.gunzipSync(raw)));
      }
      continue;
    }
    break;
  }
  return obj;
}

function writeObject(obj) {
  return obj.write();
}

function errorBuffer(code, text) {
  return new TL.RpcError({ errorCode: num(code), errorMessage: String(text || "ERROR") }).write();
}

function boolTrue() {
  return new Primitive.BoolTrue({});
}

// ---------------- пользователи ----------------
function userStatus(uid) {
  if (store.isOnline(uid)) return new TL.UserStatusOnline({ expires: Math.floor(Date.now() / 1000) + 60 });
  const ls = store.lastSeen(uid);
  if (!ls) return new TL.UserStatusEmpty({});
  const diff = Math.floor(Date.now() / 1000) - ls;
  if (diff < 3 * 86400) return new TL.UserStatusOffline({ wasOnline: ls });
  return new TL.UserStatusRecently({ byMe: false });
}

function userPhoto(u) {
  if (!u.photoId) return new TL.UserProfilePhotoEmpty({});
  return new TL.UserProfilePhoto({
    hasVideo: false,
    personal: false,
    photoId: big(u.photoId),
    dcId: DC_ID,
    strippedThumb: undefined
  });
}

function user(u, opts) {
  opts = opts || {};
  const uid = num(u.uid);
  const self = !!opts.self;
  return new TL.User({
    id: big(uid),
    self: self,
    contact: opts.contact || false,
    mutualContact: false,
    deleted: false,
    bot: false,
    botChatHistory: false,
    botNochats: false,
    verified: false,
    restricted: false,
    min: false,
    botInlineGeo: false,
    support: false,
    scam: false,
    applyMinPhoto: false,
    fake: false,
    botAttachMenu: false,
    premium: false,
    attachMenuEnabled: false,
    botCanEdit: false,
    closeFriend: false,
    storiesHidden: false,
    storiesUnavailable: false,
    contactRequirePremium: false,
    botBusiness: false,
    botHasMainApp: false,
    botForumView: false,
    botForumCanManageTopics: false,
    botCanManageBots: false,
    botGuestchat: false,
    botGuard: false,
    accessHash: big(u.accessHash || uid),
    firstName: String(u.name || u.username || "").slice(0, 64) || "Пользователь",
    lastName: String(u.lastName || ""),
    username: String(u.username || "").replace(/^@/, ""),
    phone: "",
    photo: userPhoto(u),
    status: userStatus(uid),
    botInfoVersion: undefined,
    restrictionReason: [],
    botInlinePlaceholder: undefined,
    langCode: undefined,
    emojiStatus: undefined,
    usernames: undefined,
    storiesMaxId: undefined,
    color: undefined,
    profileColor: undefined,
    botActiveUsers: undefined,
    botVerificationIcon: undefined,
    sendPaidMessagesStars: undefined,
    linkedCommunityId: undefined
  });
}

function userFull(u, self) {
  return new TL.UserFull({
    blocked: false,
    phoneCallsAvailable: false,
    phoneCallsPrivate: false,
    canPinMessage: true,
    hasScheduled: false,
    videoCallsAvailable: false,
    voiceMessagesForbidden: false,
    translationsDisabled: false,
    storiesPinnedAvailable: false,
    blockedMyStoriesFrom: false,
    wallpaperOverridden: false,
    contactRequirePremium: false,
    readDatesPrivate: false,
    botCanManageEmojiStatus: false,
    newUniqueGiftNotifications: false,
    revenueBlockedUntilDate: undefined,
    id: big(u.uid),
    about: String(u.about || ""),
    settings: new TL.PeerSettings({
      reportSpam: false, addContact: false, blockContact: false, shareContact: false,
      needContactsException: false, reportGeo: false, autoarchived: false, inviteMembers: false,
      requestChatBroadcast: false, businessBotPaused: false, businessBotCanReply: false,
      geoDistance: undefined, requestChatTitle: undefined, requestChatDate: undefined,
      businessBotId: undefined, businessBotManageUrl: undefined, chargePaidMessageStars: undefined,
      registrationMonth: undefined, phoneCountry: undefined, nameChangeDate: undefined, photoChangeDate: undefined
    }),
    personalPhoto: undefined,
    profilePhoto: u.photoId ? userPhoto(u) : undefined,
    fallbackPhoto: undefined,
    notifySettings: notifySettings(),
    botInfo: undefined,
    pinnedMsgId: undefined,
    commonChatsCount: 0,
    folderId: undefined,
    themeEmoticon: undefined,
    privateForwardName: undefined,
    botGroupAdminRights: undefined,
    botBroadcastAdminRights: undefined,
    premiumGifts: undefined,
    wallpaper: undefined,
    stories: undefined,
    businessWorkHours: undefined,
    businessLocation: undefined,
    businessGreetingMessage: undefined,
    businessAwayMessage: undefined,
    businessIntro: undefined,
    birthday: undefined,
    personalChannelId: undefined,
    personalChannelMessage: undefined,
    stargiftsCount: undefined,
    starGiftsCount: undefined,
    soldOutGiftsCount: undefined,
    savedMusic: undefined
  });
}

function notifySettings() {
  return new TL.PeerNotifySettings({
    showPreviews: undefined,
    silent: undefined,
    muteUntil: 0,
    iosSound: undefined,
    androidSound: undefined,
    otherSound: undefined,
    storiesMuted: false,
    storiesHideSender: false,
    storiesIosSound: undefined,
    storiesAndroidSound: undefined,
    storiesOtherSound: undefined
  });
}

// ---------------- чаты: личные / группы / каналы ----------------
function chatPhoto(chat) {
  if (!chat.photoId) return new TL.ChatPhotoEmpty({});
  return new TL.ChatPhoto({
    hasVideo: false,
    photoId: big(chat.photoId),
    dcId: DC_ID,
    strippedThumb: undefined
  });
}

function adminRights(admin) {
  return new TL.ChatAdminRights({
    changeInfo: admin, postMessages: admin, editMessages: admin, deleteMessages: admin,
    banUsers: admin, inviteUsers: admin, pinMessages: admin, addAdmins: admin,
    anonymous: false, manageCall: admin, other: admin, manageTopics: admin,
    postStories: admin, editStories: admin, deleteStories: admin, manageDirectMessages: admin
  });
}

function bannedRights() {
  return new TL.ChatBannedRights({
    viewMessages: false, sendMessages: false, sendMedia: false, sendStickers: false,
    sendGifs: false, sendGames: false, sendInline: false, embedLinks: false,
    sendPolls: false, changeInfo: false, inviteUsers: false, pinMessages: false,
    manageTopics: false, sendPhotos: false, sendVideos: false, sendRoundvideos: false,
    sendAudios: false, sendVoices: false, sendDocs: false, sendPlain: false,
    untilDate: 0
  });
}

function chat(c) {
  if (c.type === "private") return null; // личные чаты — это пользователи
  if (c.type === "channel") return channel(c);
  return new TL.Chat({
    creator: false,
    left: false,
    deactivated: false,
    callActive: false,
    callNotEmpty: false,
    noforwards: false,
    id: big(c.id),
    title: String(c.title || ""),
    photo: chatPhoto(c),
    participantsCount: (c.members || []).length,
    date: Math.floor(num(c.createdAt) / 1000),
    version: 1,
    migratedTo: undefined,
    adminRights: undefined,
    defaultBannedRights: undefined
  });
}

function channel(c) {
  return new TL.Channel({
    creator: false,
    left: false,
    broadcast: !!c.broadcast,
    verified: false,
    megagroup: !!c.megagroup,
    restricted: false,
    signatures: false,
    min: false,
    scam: false,
    hasLink: !!c.username,
    hasGeo: false,
    slowmodeEnabled: false,
    callActive: false,
    callNotEmpty: false,
    fake: false,
    gigagroup: false,
    noforwards: false,
    joinToSend: false,
    joinRequest: false,
    forum: false,
    storiesHidden: false,
    storiesHiddenMin: false,
    storiesUnavailable: false,
    signatureProfiles: false,
    autotranslation: false,
    broadcastMessagesAllowed: false,
    monoforum: false,
    forumTabs: false,
    id: big(c.id),
    accessHash: big(c.id),
    title: String(c.title || ""),
    username: String(c.username || "").replace(/^@/, ""),
    photo: chatPhoto(c),
    date: Math.floor(num(c.createdAt) / 1000),
    restrictionReason: [],
    adminRights: undefined,
    bannedRights: undefined,
    defaultBannedRights: bannedRights(),
    participantsCount: (c.members || []).length,
    usernames: undefined,
    storiesMaxId: undefined,
    color: undefined,
    profileColor: undefined,
    emojiStatus: undefined,
    level: undefined,
    subscriptionUntilDate: undefined,
    botVerificationIcon: undefined,
    sendPaidMessagesStars: undefined,
    linkedMonoforumId: undefined,
    linkedCommunityId: undefined
  });
}

function chatFull(c, viewerUid) {
  const participants = [];
  for (const uid of (c.members || [])) {
    const isCreator = String(uid) === String(c.creator);
    participants.push(isCreator
      ? new TL.ChatParticipantCreator({ userId: big(uid), rank: undefined })
      : new TL.ChatParticipant({ userId: big(uid), inviterId: big(c.creator), date: Math.floor(num(c.createdAt) / 1000), rank: undefined }));
  }
  return new TL.ChatFull({
    canSetUsername: true,
    hasScheduled: false,
    translationsDisabled: false,
    hasWelcomeMessages: false,
    id: big(c.id),
    about: String(c.about || ""),
    participants: new TL.ChatParticipants({ chatId: big(c.id), participants: participants, version: 1 }),
    chatPhoto: c.photoId ? chatPhoto(c) : new TL.PhotoEmpty({ id: 0n }),
    notifySettings: notifySettings(),
    exportedInvite: new TL.ChatInviteExported({
      revoked: false, permanent: true, requestNeeded: false,
      link: "https://t.me/+" + c.id, adminId: big(c.creator),
      date: Math.floor(num(c.createdAt) / 1000), startDate: undefined, expireDate: undefined,
      usageLimit: undefined, usage: 0, requested: 0, subscriptionExpired: undefined,
      title: undefined, subscriptionPricing: undefined
    }),
    botInfo: [],
    pinnedMsgId: (c.pinned && c.pinned.length) ? num(c.pinned[c.pinned.length - 1]) : undefined,
    folderId: undefined,
    call: undefined,
    ttlPeriod: undefined,
    groupcallDefaultJoinAs: undefined,
    themeEmoticon: undefined,
    requestsPending: 0,
    recentRequesters: [],
    availableReactions: undefined,
    reactionsLimit: undefined
  });
}

// ---------------- медиа ----------------
function photo(file) {
  return new TL.Photo({
    hasStickers: false,
    id: big(file.id),
    accessHash: big(file.id),
    fileReference: fileRef(file.id),
    date: Math.floor(num(file.createdAt) / 1000),
    sizes: [
      new TL.PhotoSize({
        type: "x",
        w: num(file.width) || 640,
        h: num(file.height) || 640,
        size: num(file.size)
      })
    ],
    videoSizes: [],
    dcId: DC_ID
  });
}

function document(file) {
  const attrs = [];
  const kind = file.kind || "document";
  if (kind === "voice" || kind === "audio") {
    attrs.push(new TL.DocumentAttributeAudio({
      voice: kind === "voice",
      duration: num(file.duration) || 1,
      title: kind === "audio" ? String(file.name || "") : "",
      performer: "",
      waveform: Buffer.alloc(0)
    }));
  } else if (kind === "video" || kind === "video_note") {
    attrs.push(new TL.DocumentAttributeVideo({
      roundMessage: kind === "video_note",
      supportsStreaming: true,
      nosound: false,
      duration: num(file.duration) || 1,
      w: num(file.width) || (kind === "video_note" ? 360 : 640),
      h: num(file.height) || (kind === "video_note" ? 360 : 360),
      preloadPrefixSize: 0,
      videoStartTs: undefined,
      videoCodec: undefined
    }));
  } else if (kind === "photo") {
    attrs.push(new TL.DocumentAttributeImageSize({ w: num(file.width) || 640, h: num(file.height) || 640 }));
  } else if (kind === "sticker") {
    attrs.push(new TL.DocumentAttributeSticker({
      mask: false, alt: "", stickerset: new TL.InputStickerSetEmpty({}), maskCoords: undefined
    }));
    attrs.push(new TL.DocumentAttributeImageSize({ w: num(file.width) || 512, h: num(file.height) || 512 }));
  } else {
    attrs.push(new TL.DocumentAttributeFilename({ fileName: String(file.name || "file") }));
  }
  return new TL.Document({
    id: big(file.id),
    accessHash: big(file.id),
    fileReference: fileRef(file.id),
    date: Math.floor(num(file.createdAt) / 1000),
    mimeType: String(file.mime || "application/octet-stream"),
    size: num(file.size),
    thumbs: [],
    videoThumbs: [],
    dcId: DC_ID,
    attributes: attrs
  });
}

function messageMedia(m) {
  if (!m || !m.fileId) return undefined;
  const file = store.getFile(m.fileId);
  if (!file) return undefined;
  const kind = file.kind || "document";
  if (kind === "photo" && m.type !== "document") {
    return new TL.MessageMediaPhoto({
      spoiler: false,
      livePhoto: false,
      photo: photo(file),
      ttlSeconds: undefined,
      video: undefined
    });
  }
  return new TL.MessageMediaDocument({
    nopremium: true,
    spoiler: false,
    video: kind === "video",
    round: kind === "video_note",
    voice: kind === "voice",
    document: document(file),
    altDocuments: [],
    videoCover: undefined,
    videoTimestamp: undefined,
    ttlSeconds: undefined
  });
}

function messageReplies(msg) {
  if (!msg || !msg.replies) return undefined;
  return new TL.MessageReplies({
    comments: false,
    replies: num(msg.replies),
    repliesPts: 0,
    recentRepliers: undefined,
    channelId: undefined,
    maxId: undefined,
    readMaxId: undefined
  });
}

function messageReactions(msg) {
  if (!msg || !msg.reactions) return undefined;
  const entries = Object.keys(msg.reactions || {});
  if (!entries.length) return undefined;
  const results = [];
  let order = 0;
  for (const emoji of entries) {
    results.push(new TL.ReactionCount({
      chosenOrder: undefined,
      reaction: new TL.ReactionEmoji({ emoticon: emoji }),
      count: num((msg.reactions[emoji] || []).length)
    }));
    order++;
  }
  return new TL.MessageReactions({
    min: false,
    canSeeList: true,
    reactionsAsTags: false,
    results: results,
    recentReactions: undefined,
    topReactors: undefined
  });
}

// ---------------- сообщения ----------------
function messagePeer(msg, viewerUid) {
  const chat = store.getChat(msg.chatId);
  if (!chat) return new TL.PeerUser({ userId: big(msg.fromUid) });
  if (chat.type === "private") {
    const other = String(msg.fromUid) === String(viewerUid)
      ? (chat.members.find((m) => String(m) !== String(msg.fromUid)) || msg.fromUid)
      : msg.fromUid;
    return new TL.PeerUser({ userId: big(other) });
  }
  if (chat.type === "channel") return new TL.PeerChannel({ channelId: big(chat.id) });
  return new TL.PeerChat({ chatId: big(chat.id) });
}

function messageEntities(msg) {
  const out = [];
  for (const e of (msg.entities || [])) {
    if (e.type === "bold") out.push(new TL.MessageEntityBold({ offset: num(e.offset), length: num(e.length) }));
    else if (e.type === "italic") out.push(new TL.MessageEntityItalic({ offset: num(e.offset), length: num(e.length) }));
    else if (e.type === "code") out.push(new TL.MessageEntityCode({ offset: num(e.offset), length: num(e.length) }));
    else if (e.type === "pre") out.push(new TL.MessageEntityPre({ offset: num(e.offset), length: num(e.length), language: "" }));
    else if (e.type === "underline") out.push(new TL.MessageEntityUnderline({ offset: num(e.offset), length: num(e.length) }));
    else if (e.type === "strike") out.push(new TL.MessageEntityStrike({ offset: num(e.offset), length: num(e.length) }));
    else if (e.type === "textUrl") out.push(new TL.MessageEntityTextUrl({ offset: num(e.offset), length: num(e.length), url: String(e.url || "") }));
    else if (e.type === "url") out.push(new TL.MessageEntityUrl({ offset: num(e.offset), length: num(e.length) }));
    else if (e.type === "mention") out.push(new TL.MessageEntityMention({ offset: num(e.offset), length: num(e.length) }));
  }
  return out;
}

function message(msg, viewerUid, opts) {
  opts = opts || {};
  const chat = store.getChat(msg.chatId);
  const viewer = String(viewerUid);
  const out = String(msg.fromUid) === viewer;
  const isChannel = chat && chat.type === "channel";
  const media = messageMedia(msg.media);
  const peer = opts.peer || messagePeer(msg, viewer);
  return new TL.Message({
    out: out,
    mentioned: false,
    mediaUnread: false,
    silent: !!msg.silent,
    post: isChannel && !!chat.broadcast,
    fromScheduled: false,
    legacy: false,
    editHide: false,
    pinned: !!msg.pinned,
    noforwards: false,
    invertMedia: false,
    offline: false,
    videoProcessingPending: false,
    paidSuggestedPostStars: 0,
    paidSuggestedPostTon: 0,
    id: num(msg.id),
    fromId: isChannel && chat.broadcast ? undefined : new TL.PeerUser({ userId: big(msg.fromUid) }),
    fromBoostsApplied: undefined,
    fromRank: undefined,
    peerId: peer,
    savedPeerId: undefined,
    fwdFrom: msg.forwardFrom ? new TL.MessageFwdHeader({
      imported: false, savedOut: false,
      fromId: new TL.PeerUser({ userId: big(msg.forwardFrom.uid) }),
      fromName: String(msg.forwardFrom.name || ""),
      date: num(msg.forwardFrom.date),
      channelPost: undefined, postAuthor: undefined, savedFromPeer: undefined,
      savedFromMsgId: undefined, savedFromId: undefined, savedFromName: undefined,
      savedDate: undefined, psaType: undefined
    }) : undefined,
    viaBotId: undefined,
    viaBusinessBotId: undefined,
    guestchatViaFrom: undefined,
    replyTo: msg.replyTo ? new TL.MessageReplyHeader({
      replyToScheduled: false, forumTopic: false, quote: false, replyToEphemeral: false,
      replyToMsgId: num(msg.replyTo), replyToPeerId: undefined, replyFrom: undefined,
      replyMedia: undefined, replyToTopId: num(msg.replyToTop || 0) || undefined,
      quoteText: undefined, quoteEntities: undefined, quoteOffset: undefined,
      todoItemId: undefined, pollOption: undefined
    }) : undefined,
    date: num(msg.date),
    message: String(msg.text || ""),
    media: media,
    replyMarkup: undefined,
    entities: messageEntities(msg),
    views: isChannel ? num(msg.views) : undefined,
    forwards: isChannel ? num(msg.forwards || 0) : undefined,
    replies: messageReplies(msg),
    editDate: msg.edited ? num(msg.editDate) : undefined,
    postAuthor: undefined,
    groupedId: msg.groupedId ? big(msg.groupedId) : undefined,
    reactions: messageReactions(msg),
    restrictionReason: [],
    ttlPeriod: undefined,
    quickReplyShortcutId: undefined,
    effect: undefined,
    factcheck: undefined,
    reportDeliveryUntilDate: undefined,
    paidMessageStars: undefined,
    suggestedPost: undefined,
    scheduleRepeatPeriod: undefined,
    summaryFromLanguage: undefined,
    richMessage: undefined
  });
}

// ---------------- диалоги ----------------
function dialog(chat, viewerUid) {
  const last = store.lastMessageOf(chat.id);
  const peer = chat.type === "private"
    ? new TL.PeerUser({ userId: big(chat.members.find((m) => String(m) !== String(viewerUid)) || viewerUid) })
    : (chat.type === "channel" ? new TL.PeerChannel({ channelId: big(chat.id) }) : new TL.PeerChat({ chatId: big(chat.id) }));
  return new TL.Dialog({
    pinned: false,
    unreadMark: false,
    viewForumAsMessages: false,
    peer: peer,
    topMessage: last ? num(last.id) : 0,
    readInboxMaxId: num(store.readMaxId(chat.id, viewerUid, false)),
    readOutboxMaxId: num(store.readMaxId(chat.id, viewerUid, true)),
    unreadCount: num(store.unreadCount(chat.id, viewerUid)),
    unreadMentionsCount: 0,
    unreadReactionsCount: 0,
    unreadPollVotesCount: 0,
    notifySettings: new TL.PeerNotifySettings({
      showPreviews: undefined, silent: undefined, muteUntil: 0, iosSound: undefined,
      androidSound: undefined, otherSound: undefined, storiesMuted: false,
      storiesHideSender: false, storiesIosSound: undefined, storiesAndroidSound: undefined,
      storiesOtherSound: undefined
    }),
    pts: PTS,
    draft: undefined,
    folderId: undefined,
    ttlPeriod: undefined
  });
}

// ---------------- обновления (приходят по WebSocket) ----------------
function shortMessage(msg, viewerUid) {
  const chat = store.getChat(msg.chatId);
  const out = String(msg.fromUid) === String(viewerUid);
  if (chat && chat.type === "private") {
    return new TL.UpdateShortMessage({
      out: out,
      mentioned: false,
      mediaUnread: false,
      silent: !!msg.silent,
      id: num(msg.id),
      userId: big(chat.members.find((m) => String(m) !== String(viewerUid)) || msg.fromUid),
      message: String(msg.text || ""),
      pts: PTS,
      ptsCount: PTS_COUNT,
      date: num(msg.date),
      fwdFrom: undefined,
      viaBotId: undefined,
      replyTo: undefined,
      entities: messageEntities(msg),
      ttlPeriod: undefined
    });
  }
  const m = message(msg, viewerUid);
  if (chat && chat.type === "channel") {
    return new TL.UpdateShort({
      update: new TL.UpdateNewChannelMessage({ message: m, pts: PTS, ptsCount: PTS_COUNT }),
      date: num(msg.date)
    });
  }
  return new TL.UpdateShort({
    update: new TL.UpdateNewMessage({ message: m, pts: PTS, ptsCount: PTS_COUNT }),
    date: num(msg.date)
  });
}

function updates(updatesList, users, chats) {
  return new TL.Updates({
    updates: updatesList,
    users: users || [],
    chats: chats || [],
    date: Math.floor(Date.now() / 1000),
    seq: 0
  });
}

// ВАЖНО: skema пропускает undefined-поля при записи, а читатель ожидает все векторы.
// Поэтому все векторы (в т.ч. topics) передаём всегда явно.
function messagesResult(messages, chats, users) {
  return new TL.messages.Messages({
    messages: messages || [],
    topics: [],
    chats: chats || [],
    users: users || []
  });
}

function messagesSlice(count, messages, chats, users) {
  return new TL.messages.MessagesSlice({
    inexact: false,
    count: num(count),
    nextRate: undefined,
    offsetIdOffset: undefined,
    searchFlood: undefined,
    messages: messages || [],
    topics: [],
    chats: chats || [],
    users: users || []
  });
}

function channelMessages(messages, chats, users, count) {
  return new TL.messages.ChannelMessages({
    inexact: false,
    pts: PTS,
    count: num(count !== undefined ? count : (messages || []).length),
    offsetIdOffset: undefined,
    messages: messages || [],
    topics: [],
    chats: chats || [],
    users: users || []
  });
}

function dialogsResult(dialogs, messages, chats, users) {
  return new TL.messages.Dialogs({
    dialogs: dialogs || [],
    messages: messages || [],
    chats: chats || [],
    users: users || []
  });
}

function dialogsSlice(count, dialogs, messages, chats, users) {
  return new TL.messages.DialogsSlice({
    count: num(count),
    dialogs: dialogs || [],
    messages: messages || [],
    chats: chats || [],
    users: users || []
  });
}

function chatsResult(chats) {
  return new TL.messages.Chats({ chats: chats || [] });
}

function affectedMessages() {
  return new TL.messages.AffectedMessages({ pts: PTS, ptsCount: PTS_COUNT });
}

function affectedHistory(offset) {
  return new TL.messages.AffectedHistory({ pts: PTS, ptsCount: PTS_COUNT, offset: num(offset) });
}

function state() {
  return new TL.updates.State({
    pts: PTS,
    qts: 0,
    date: Math.floor(Date.now() / 1000),
    seq: 0,
    unreadCount: 0
  });
}

function config() {
  const now = Math.floor(Date.now() / 1000);
  return new TL.Config({
    defaultP2pContacts: false,
    preloadFeaturedStickers: false,
    revokePmInbox: false,
    blockedMode: false,
    forceTryIpv6: false,
    date: now,
    expires: now + 86400,
    testMode: false,
    thisDc: DC_ID,
    dcOptions: [],
    dcTxtDomainName: "",
    chatSizeMax: 200,
    megagroupSizeMax: 200000,
    forwardedCountMax: 100,
    onlineUpdatePeriodMs: 60000,
    offlineBlurTimeoutMs: 5000,
    offlineIdleTimeoutMs: 30000,
    onlineCloudTimeoutMs: 300000,
    notifyCloudDelayMs: 30000,
    notifyDefaultDelayMs: 1500,
    pushChatPeriodMs: 60000,
    pushChatLimit: 2,
    editTimeLimit: 172800,
    revokeTimeLimit: 172800,
    revokePmTimeLimit: 172800,
    ratingEDecay: 2419200,
    stickersRecentLimit: 200,
    channelsReadMediaPeriod: 604800,
    tmpSessions: undefined,
    callReceiveTimeoutMs: 20000,
    callRingTimeoutMs: 30000,
    callConnectTimeoutMs: 30000,
    callPacketTimeoutMs: 10000,
    meUrlPrefix: "https://mwmmw-production.up.railway.app/",
    autoupdateUrlPrefix: "",
    gifSearchUsername: "gif",
    venueSearchUsername: "foursquare",
    imgSearchUsername: "bing",
    staticMapsProvider: "",
    captionLengthMax: 2048,
    messageLengthMax: 4096,
    webfileDcId: DC_ID,
    suggestedLangCode: "ru",
    langPackVersion: 0,
    baseLangPackVersion: 0,
    reactionsDefault: undefined,
    autologinToken: undefined
  });
}

module.exports = {
  TL: TL,
  TLObject: TLObject,
  BytesIO: BytesIO,
  DC_ID: DC_ID,
  PTS: PTS,
  PTS_COUNT: PTS_COUNT,
  big: big,
  num: num,
  fileRef: fileRef,
  refToFileId: refToFileId,
  readObject: readObject,
  writeObject: writeObject,
  errorBuffer: errorBuffer,
  boolTrue: boolTrue,
  user: user,
  userFull: userFull,
  userStatus: userStatus,
  notifySettings: notifySettings,
  chat: chat,
  channel: channel,
  chatFull: chatFull,
  adminRights: adminRights,
  photo: photo,
  document: document,
  messageMedia: messageMedia,
  messageReactions: messageReactions,
  message: message,
  messagePeer: messagePeer,
  dialog: dialog,
  shortMessage: shortMessage,
  updates: updates,
  messagesResult: messagesResult,
  messagesSlice: messagesSlice,
  channelMessages: channelMessages,
  dialogsResult: dialogsResult,
  dialogsSlice: dialogsSlice,
  chatsResult: chatsResult,
  affectedMessages: affectedMessages,
  affectedHistory: affectedHistory,
  state: state,
  config: config
};
