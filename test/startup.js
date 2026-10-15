"use strict";
process.env.LOGLEVEL = process.env.LOGLEVEL || "none";
/*
 * Тест «стартовой последовательности»: ровно те TL-вызовы, которые настоящий
 * клиент Telegram шлёт сразу после входа (пока открыт главный экран).
 * Если хоть один возвращает RpcError или 500 — в приложении что-то не работает
 * (UI показывает «ошибка сети», падает или пустой экран).
 *
 * Запуск: node test/startup.js
 */

const path = require("path");
process.env.DATA_DIR = path.join(__dirname, "..", "test-data-startup");
process.env.PORT = process.env.PORT || "3998";
const fs = require("fs");
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });

const http = require("http");
const { Raw: TL, TLObject } = require("@tgsnake/skema");
const { BytesIO } = require("@tgsnake/bytesio");

require("../server.js");

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

async function tlCall(token, obj) {
  let bytes;
  try {
    bytes = obj.write();
  } catch (e) {
    return { __error: "SERIALIZE: " + e.message };
  }
  const r = await request("POST", "/api/tl", bytes, token);
  if (r.code !== 200) return { __error: "HTTP " + r.code };
  try {
    const out = await TLObject.read(BytesIO.from(r.buffer));
    if (out.className === "RpcError") return { __error: out.errorCode + " " + out.errorMessage };
    return out;
  } catch (e) {
    return { __error: "PARSE: " + e.message };
  }
}

let failures = 0;
const bad = [];

async function check(name, factory) {
  let res;
  try {
    res = await tlCall(TOKEN, factory());
  } catch (e) {
    res = { __error: "THROW: " + e.message };
  }
  if (res && res.__error) {
    failures++;
    bad.push(name + " → " + res.__error);
    console.log("  ❌ " + name + " — " + res.__error);
  } else {
    const kind = res && res.className ? res.className : (Array.isArray(res) ? "Vector(" + res.length + ")" : typeof res);
    console.log("  ✅ " + name + " — " + kind);
  }
}

// объекты, которые нужны почти везде
let TOKEN = "";
const emptyPeer = () => new TL.InputPeerEmpty({});
const big = (v) => BigInt(v || 0);

(async () => {
  await new Promise((r) => setTimeout(r, 300));

  const reg = await rest("POST", "/api/register", { username: "startup", password: "qwerty123", name: "Старт" });
  if (!reg.ok) { console.log("❌ не удалось зарегистрироваться:", reg); process.exit(1); }
  const login = await rest("POST", "/api/login", { username: "startup", password: "qwerty123" });
  TOKEN = login.token;
  const uid = big(login.user.uid);

  console.log("Стартовая последовательность клиента Telegram (после входа):\n");

  // --- самые первые запросы ---
  await check("help.getConfig", () => new TL.help.GetConfig({}));
  await check("help.getNearestDc", () => new TL.help.GetNearestDc({}));
  await check("help.getCdnConfig", () => new TL.help.GetCdnConfig({}));
  await check("help.getAppConfig", () => new TL.help.GetAppConfig({ hash: 0 }));
  await check("help.getPromoData", () => new TL.help.GetPromoData({}));
  await check("help.getSupport", () => new TL.help.GetSupport({}));
  await check("help.getInviteText", () => new TL.help.GetInviteText({}));
  await check("help.getTermsOfServiceUpdate", () => new TL.help.GetTermsOfServiceUpdate({}));
  await check("help.getCountriesList", () => new TL.help.GetCountriesList({ hash: 0, langCode: "ru" }));
  await check("help.getTimezonesList", () => new TL.help.GetTimezonesList({ hash: 0 }));
  await check("help.getPeerColors", () => new TL.help.GetPeerColors({ hash: 0 }));
  await check("help.getPassportConfig", () => new TL.help.GetPassportConfig({ hash: 0 }));
  await check("help.getSuggestions", () => new TL.help.GetSuggestions({}));

  // --- состояние и обновления ---
  await check("updates.getState", () => new TL.updates.GetState({}));
  await check("account.updateStatus", () => new TL.account.UpdateStatus({ offline: false }));
  await check("account.registerDevice", () => new TL.account.RegisterDevice({ noMuted: false, tokenType: 10, token: "fake", appSandbox: false, secret: Buffer.alloc(0), otherUids: [] }));

  // --- диалоги ---
  await check("messages.getDialogs", () => new TL.messages.GetDialogs({ excludePinned: false, offsetDate: 0, offsetId: 0, offsetPeer: emptyPeer(), limit: 100, hash: 0 }));
  await check("messages.getPinnedDialogs", () => new TL.messages.GetPinnedDialogs({ folderId: 0 }));
  await check("messages.getAllDrafts", () => new TL.messages.GetAllDrafts({}));
  await check("messages.getDialogFilters", () => new TL.messages.GetDialogFilters({}));
  await check("messages.getSuggestedDialogFilters", () => new TL.messages.GetSuggestedDialogFilters({}));
  await check("messages.getDialogUnreadMarks", () => new TL.messages.GetDialogUnreadMarks({}));
  await check("messages.getSplitRanges", () => new TL.messages.GetSplitRanges({}));
  await check("messages.getScheduledHistory", () => new TL.messages.GetScheduledHistory({ peer: emptyPeer(), hash: 0 }));

  // --- контакты ---
  await check("contacts.getContacts", () => new TL.contacts.GetContacts({ hash: 0 }));
  await check("contacts.getContactIDs", () => new TL.contacts.GetContactIDs({ hash: 0 }));
  await check("contacts.getStatuses", () => new TL.contacts.GetStatuses({}));
  await check("contacts.getTopPeers", () => new TL.contacts.GetTopPeers({ correspondents: true, offset: 0, limit: 20, hash: 0 }));
  await check("contacts.getBlocked", () => new TL.contacts.GetBlocked({ offset: 0, limit: 20 }));
  await check("contacts.search", () => new TL.contacts.Search({ q: "a", limit: 20 }));
  await check("contacts.resolveUsername", () => new TL.contacts.ResolveUsername({ username: "startup" }));

  // --- настройки аккаунта ---
  await check("account.getNotifySettings", () => new TL.account.GetNotifySettings({ peer: new TL.InputNotifyUsers({}) }));
  await check("account.getNotifyExceptions", () => new TL.account.GetNotifyExceptions({ compareSound: false, peer: new TL.InputNotifyUsers({}) }));
  await check("account.getAutoDownloadSettings", () => new TL.account.GetAutoDownloadSettings({}));
  await check("account.getGlobalPrivacySettings", () => new TL.account.GetGlobalPrivacySettings({}));
  await check("account.getPrivacy", () => new TL.account.GetPrivacy({ key: new TL.PrivacyKeyStatusTimestamp({}) }));
  await check("account.getAccountTTL", () => new TL.account.GetAccountTTL({}));
  await check("account.getContentSettings", () => new TL.account.GetContentSettings({}));
  await check("account.getThemes", () => new TL.account.GetThemes({ format: "android", hash: 0 }));
  await check("account.getWallPapers", () => new TL.account.GetWallPapers({ hash: 0 }));
  await check("account.getChatThemes", () => new TL.account.GetChatThemes({ hash: 0 }));
  await check("account.getContactSignUpNotification", () => new TL.account.GetContactSignUpNotification({}));
  await check("account.getWebBrowserConfig", () => new TL.account.GetWebBrowserConfig({}));

  // --- локаль ---
  await check("langpack.getLanguages", () => new TL.langpack.GetLanguages({ langPack: "android" }));
  await check("langpack.getStrings", () => new TL.langpack.GetStrings({ langPack: "android", langCode: "ru", keys: ["Loading"] }));
  await check("langpack.getDifference", () => new TL.langpack.GetDifference({ langPack: "android", langCode: "ru", fromVersion: 0 }));

  // --- стикеры, реакции, эмодзи ---
  await check("messages.getAllStickers", () => new TL.messages.GetAllStickers({ hash: 0 }));
  await check("messages.getStickers", () => new TL.messages.GetStickers({ emoticon: "😀", hash: 0 }));
  await check("messages.getRecentStickers", () => new TL.messages.GetRecentStickers({ attached: false, hash: 0 }));
  await check("messages.getFavedStickers", () => new TL.messages.GetFavedStickers({ hash: 0 }));
  await check("messages.getFeaturedStickers", () => new TL.messages.GetFeaturedStickers({ hash: 0 }));
  await check("messages.getArchivedStickers", () => new TL.messages.GetArchivedStickers({ masks: false, offsetId: 0, limit: 20 }));
  await check("messages.getSavedGifs", () => new TL.messages.GetSavedGifs({ hash: 0 }));
  await check("messages.getAvailableReactions", () => new TL.messages.GetAvailableReactions({ hash: 0 }));
  await check("messages.getDefaultEmojiStatuses", () => new TL.messages.GetDefaultEmojiStatuses({ hash: 0 }));
  await check("messages.getRecentEmojiStatuses", () => new TL.messages.GetRecentEmojiStatuses({ hash: 0 }));
  await check("messages.getEmojiStatusGroups", () => new TL.messages.GetEmojiStatusGroups({ hash: 0 }));
  await check("messages.getEmojiStickers", () => new TL.messages.GetEmojiStickers({ hash: 0 }));
  await check("messages.getFeaturedEmojiStickers", () => new TL.messages.GetFeaturedEmojiStickers({ hash: 0 }));
  await check("messages.getRecentReactions", () => new TL.messages.GetRecentReactions({ hash: 0 }));
  await check("messages.getEmojiKeywords", () => new TL.messages.GetEmojiKeywords({ langCode: "ru" }));
  await check("messages.getAttachMenuBots", () => new TL.messages.GetAttachMenuBots({ hash: 0 }));
  await check("messages.getQuickReplies", () => new TL.messages.GetQuickReplies({ hash: 0 }));
  await check("messages.getSponsoredMessages", () => new TL.messages.GetSponsoredMessages({ peer: emptyPeer() }));
  await check("messages.getSearchResultsPositions", () => new TL.messages.GetSearchResultsPositions({ peer: emptyPeer(), filter: new TL.InputMessagesFilterEmpty({}), offsetId: 0, limit: 20 }));
  await check("messages.getSearchCounters", () => new TL.messages.GetSearchCounters({ peer: emptyPeer(), filters: [new TL.InputMessagesFilterEmpty({})] }));
  await check("messages.getUnreadMentions", () => new TL.messages.GetUnreadMentions({ peer: emptyPeer(), offsetId: 0, addOffset: 0, limit: 20, maxId: 0, minId: 0 }));

  // --- каналы / группы ---
  await check("channels.getLeftChannels", () => new TL.channels.GetLeftChannels({ offset: 0 }));
  await check("channels.getGroupsForDiscussion", () => new TL.channels.GetGroupsForDiscussion({}));
  await check("channels.getAdminedPublicChannels", () => new TL.channels.GetAdminedPublicChannels({ byLocation: false, checkLimit: false }));
  await check("channels.getChannelRecommendations", () => new TL.channels.GetChannelRecommendations({}));

  // --- прочее стартовое ---
  await check("users.getFullUser", () => new TL.users.GetFullUser({ id: new TL.InputUser({ userId: uid, accessHash: uid }) }));
  await check("users.getUsers", () => new TL.users.GetUsers({ id: [new TL.InputUser({ userId: uid, accessHash: uid })] }));
  await check("photos.getUserPhotos", () => new TL.photos.GetUserPhotos({ userId: new TL.InputUser({ userId: uid, accessHash: uid }), offset: 0, maxId: 0, limit: 20 }));
  await check("stickers.getAllStickers", () => new TL.stickers.GetAllStickers({ hash: 0 }));
  await check("stories.getAllStories", () => new TL.stories.GetAllStories({ next: false, hidden: false, state: undefined }));
  await check("premium.getPromo", () => new TL.premium.GetPromo({}));
  await check("bots.getPopularAppBots", () => new TL.bots.GetPopularAppBots({ offset: "", limit: 20 }));

  console.log("\n" + (failures === 0
    ? "🎉 ВСЕ СТАРТОВЫЕ ВЫЗОВЫ ОТВЕЧАЮТ БЕЗ ОШИБОК"
    : "⚠️  Проблемных вызовов: " + failures + "\n" + bad.map((b) => "   • " + b).join("\n")));
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("💥 Упал сам тест:", e);
  process.exit(1);
});
