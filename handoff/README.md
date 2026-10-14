# 🛰️ Handoff — Telegram-FOSS (DrKLO) на нашем сервере

Это **исходный код официального Telegram for Android от DrKLO** (`DrKLO/Telegram`, GPL v2),
с нашими правками **существующих файлов** (никаких новых экранов/приложений):

- **Вход и регистрация по @username + паролю** вместо номера телефона — через наш сервер
  `https://mwmmw-production.up.railway.app/` (URL встроен в код), API: `POST /api/register`,
  `POST /api/login`, `GET /api/me`, `GET /api/search`, `GET /api/chats`, `POST /api/upload`, `GET /api/file/<id>`.
  Наш сервер — полноценный бэкенд мессенджера: @username-аккаунты, поиск по юзернейму,
  личные чаты, группы и каналы, текст и медиа (фото/видео/голосовые/кружочки).
- **MTProto отключён** (`TMessagesProj/.../tgnet/ConnectionsManager.java`):
  `init()` и `sendRequestInternal()` — no-op. Приложение **не делает ни одного API-вызова Telegram**,
  все обращения идут на наш сервер.
- **Пакет `com.ts.telegram`**, версия **13.1.0** (+0.1), **arm64-v8a only**.
- **Только Release-сборка** (без debug, без проверок, без эмуляторов).
- Из native-сборки вырезаны звонки (voip/tgcalls/wasm), кошелёк (wallet_engine 30 МБ) и absl —
  чтобы весить меньше (см. `TMessagesProj/jni/CMakeLists.txt`).

## 📁 Структура

```
handoff/
├── Telegram-FOSS/   — submodule: клон DrKLO/Telegram (только исходник+градле, глубина 1)
├── overrides/       — НАШИ ПРАВКИ существующих файлов Телеграма (те же пути):
│   ├── gradle.properties                     — версия 13.1.0, пакет com.ts.telegram
│   ├── settings.gradle                       — только нужные модули
│   ├── TMessagesProj_App/build.gradle        — arm64-v8a only
│   ├── TMessagesProj_App/google-services.json — package_name com.ts.telegram
│   ├── TMessagesProj/jni/CMakeLists.txt      — вырезаны voip/tgcalls/wallet/absl
│   └── TMessagesProj/src/main/java/org/telegram/
│       ├── ui/LoginActivity.java             — вход по почте+паролю (внутри существующего PhoneView)
│       └── tgnet/ConnectionsManager.java     — MTProto отключён (no-op)
└── apk/             — СЮДА всегда попадает собранный APK (в CI), скачать — по ссылке из Releases
```

Исходный код Telegram (454 МБ, ~13 000 файлов) не помещается внутрь этого репозитория
(лимит платформы 128 МБ / 10 000 файлов), поэтому он подключён как **submodule** —
это и есть «клон DrKLO в папку handoff»: при клоне нашего репозитория с submodules
полный исходник окажется в `handoff/Telegram-FOSS/`. CI скачивает его **sparse** —
только исходник+градле, без всей ветки и без тестовых модулей.

## 🏗️ Сборка (автоматически в GitHub Actions)

При каждом push, меняющем `handoff/`, `.gitmodules`, `server/` или workflows, запускается job
**«🛰️ Telegram-FOSS (DrKLO) → handoff/apk»**: клон submodule → применение `overrides/` →
`./gradlew :TMessagesProj_App:assembleAfatRelease` (Release, arm64) → APK копируется в `handoff/apk/` →
публикуется в Releases.

**Прямая ссылка на APK:**
👉 https://github.com/KamiSakyy/MehhhanzmmxlwqOzo/releases/latest/download/Telegram-FOSS-v13.1.0-arm64.apk

## 🖥️ Локальная сборка (если есть ПК)

```bash
git submodule update --init --depth 1 handoff/Telegram-FOSS
cd handoff/Telegram-FOSS
git sparse-checkout set --skip-checks TMessagesProj TMessagesProj_App TMessagesProj_Modules buildSrc gradle gradlew gradlew.bat settings.gradle build.gradle gradle.properties LICENSE
git submodule update --init --depth 1 TMessagesProj/jni/tlottie TMessagesProj/jni/third_party/libyuv TMessagesProj/jni/third_party/boringssl TMessagesProj/jni/third_party/xiph/ogg TMessagesProj/jni/third_party/xiph/opus TMessagesProj/jni/third_party/xiph/opusfile TMessagesProj/jni/third_party/boost-regex TMessagesProj/jni/third_party/libprisma TMessagesProj/jni/third_party/libvpx TMessagesProj/jni/third_party/dav1d TMessagesProj/jni/third_party/ffmpeg TMessagesProj/jni/td TMessagesProj/lib/jlatexmath TMessagesProj_Modules/media
cp -r ../overrides/. ./
./gradlew :TMessagesProj_App:assembleAfatRelease
cp TMessagesProj_App/build/outputs/apk/afat/release/app.apk ../apk/
```

Требуется: JDK 17, Android SDK (platforms;android-36, build-tools;36.0.0), NDK 27.2.12479018, CMake 3.22.1.
