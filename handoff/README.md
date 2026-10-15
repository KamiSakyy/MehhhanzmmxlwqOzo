# 🛰️ Handoff — это Telegram (DrKLO) целиком, но на НАШЕМ сервере

**Код и дизайн — стоковый Telegram for Android от DrKLO** (`DrKLO/Telegram`, LAYER 231, GPL v2),
без переписанных экранов и без «своего мессенджера». Меняются ровно две вещи:

1. **Сервер.** MTProto-соединение с дата-центрами Telegram вырезано полностью.
   Все TL-запросы клиента уходят на **наш сервер** `https://mwmmw-production.up.railway.app`,
   который отвечает клиенту его родными TL-объектами (LAYER 231), а реальное время
   (сообщения, «печатает», онлайн) присылает по WebSocket.
2. **Экран входа.** Вместо номера телефона — **@username + пароль** (вход и регистрация).

Всё остальное — оригинальный Telegram: диалоги, личные чаты, группы, каналы,
фото/видео/голосовые/кружочки/файлы, ответы, пересылка, реакции, редактирование,
удаление, поиск, прочитанность, онлайн-статусы, профили, аватары, медиапросмотрщик.

## 🧩 Как это работает

```
Telegram (DrKLO)                    наш сервер (Node.js)
─────────────────────               ─────────────────────────────
ConnectionsManager               
  └─ sendRequestInternal()   ──HTTPS POST /api/tl──►  чтение TL-запроса
       (MTProto вырезан)                              ↓
                                                   методы: messages.*, channels.*,
                                                   upload.*, account.*, users.*,
                                                   contacts.*, photos.*, updates.*,
                                                   help.*
                                                      ↓
       deserializeResponse()  ◄───── TL-объект ─────  запись TL-ответа
  └─ HandoffBridge (WebSocket /ws) ◄── TL-обновления (новые сообщения, «печатает»,
                                       прочитанность, онлайн-статусы)
                                    └─► MessagesController.processUpdates()
```

* `HandoffBridge` (`org.telegram.messenger.HandoffBridge`) — весь транспорт: HTTP + WebSocket,
  авторизация по токену, автореконнект. Библиотека WebSocket уже есть в зависимостях Telegram
  (`com.neovisionaries:nv-websocket-client`).
* `ConnectionsManager` — все `native_*` вызовы tgnet отключены; единственный путь запроса — наш сервер.
  `getConnectionState()` всегда «подключено» (к нашему серверу), `getCurrentTime()` — системное время.
* Экран входа `LoginActivity` — поля «Адрес сервера / @username / Пароль» + переключатель
  «Войти / Зарегистрироваться». REST: `POST /api/register`, `POST /api/login`
  (ответ: `{ token, user: { uid, username, name, accessHash } }`).
  После успеха — обычная для Telegram авторизация аккаунта (`UserConfig.setCurrentUser`,
  сохранение конфига, `MessagesController.putUser`) и открытие главного экрана `MainTabsActivity`.

## ✅ Что уже реализовано на сервере

| Раздел | Методы |
|---|---|
| Аккаунты | регистрация/вход по @username + паролю, токены, `account.updateProfile`, `account.updateUsername`, `account.updateStatus` (онлайн/офлайн), `users.getUsers`, `users.getFullUser`, аватары (`photos.uploadProfilePhoto`) |
| Диалоги | `messages.getDialogs`, `getPeerDialogs`, `getPinnedDialogs`, счётчики непрочитанного, время последнего сообщения |
| История | `messages.getHistory`, `messages.getMessages`, `channels.getMessages`, `messages.search`, `messages.searchGlobal`, `messages.getUnreadMentions` |
| Отправка | `messages.sendMessage`, `sendMedia`, `sendMultiMedia`, `editMessage`, `deleteMessages`, `deleteHistory`, `forwardMessages`, `updatePinnedMessage`, `sendReaction` |
| Медиа | фото, видео, **голосовые**, **кружочки (video_note)**, GIF, стикеры, документы — загрузка частями (`upload.saveFilePart` / `saveBigFilePart`) и скачивание (`upload.getFile`, с Range) |
| Чаты | личные чаты, группы (`messages.createChat`, `addChatUser`, `editChatTitle`, `editChatAbout`, `editChatPhoto`), **каналы и супергруппы** (`channels.createChannel`, `editTitle`, `editAbout`, `editPhoto`, `updateUsername`, `joinChannel`, `leaveChannel`, `inviteToChannel`, `getParticipants`, `getFullChannel`) |
| Люди | `contacts.getContacts`, `contacts.search` (поиск по @username), `contacts.resolveUsername`, `contacts.importContacts` |
| Реалтайм | WebSocket: новые сообщения, «печатает», прочитанность, онлайн-статусы, удаление/редактирование, реакции |
| Прочее | `help.getConfig`, `updates.getState/getDifference`, `messages.setTyping`, `messages.readHistory`, `messages.saveDraft`, стикеры/эмодзи (пустые наборы, чтобы UI не ломался) |

Данные (пользователи, чаты, сообщения) хранятся в `data/db.json`, медиа — в `data/uploads/`.

## 📁 Структура

```
handoff/
├── Telegram-FOSS/   — submodule: клон DrKLO/Telegram (исходник + gradle)
├── overrides/       — НАШИ правки (те же пути, что в исходнике):
│   ├── gradle.properties                     — версия 13.1.0, пакет com.ts.telegram
│   ├── settings.gradle                       — только нужные модули
│   ├── TMessagesProj_App/build.gradle        — arm64-v8a only
│   ├── TMessagesProj_App/google-services.json — package_name com.ts.telegram
│   ├── TMessagesProj/jni/CMakeLists.txt      — вырезаны voip/tgcalls/wallet/absl
│   └── TMessagesProj/src/main/java/org/telegram/
│       ├── messenger/HandoffBridge.java      — НОВЫЙ: транспорт к нашему серверу (HTTP+WS)
│       ├── tgnet/ConnectionsManager.java     — MTProto выключен, запросы → наш сервер
│       └── ui/LoginActivity.java             — вход/регистрация по @username + паролю
└── apk/             — сюда CI кладёт собранный APK
```

Сервер: `server/` (`server.js` + `src/store.js`, `src/tl.js`, `src/methods.js`, `src/api.js`, `src/ws.js`).

## 🏗️ Сборка APK

GitHub Actions (job **«🛰️ Telegram-FOSS (DrKLO) → handoff/apk»**) при каждом push:
клонирует submodule → применяет `overrides/` → `./gradlew :TMessagesProj_App:assembleAfatRelease`
(Release, arm64) → APK в `handoff/apk/` → публикует в Releases.

**Прямая ссылка:**
👉 https://github.com/KamiSakyy/MehhhanzmmxlwqOzo/releases/latest/download/Telegram-FOSS-v13.1.0-arm64.apk

## 🧪 Тесты сервера

```bash
cd server
npm install
node test/builders.js   # все TL-объекты собираются и читаются
node test/e2e.js        # сквозной сценарий "как клиент Telegram": регистрация,
                        # диалоги, текст, фото, голосовое, кружочек, видео, файл,
                        # группа, канал, супергруппа, ответы, реакции, поиск
```

## 🚀 Деплой сервера на Railway

В корне репозитория лежат `Dockerfile` и `railway.json` — Railway собирает образ сам,
переменные настраивать не нужно (PORT подхватывается автоматически).
После деплоя адрес вида `https://xxx.up.railway.app` нужно вписать в поле «Адрес сервера»
на экране входа (по умолчанию уже стоит `https://mwmmw-production.up.railway.app`).
