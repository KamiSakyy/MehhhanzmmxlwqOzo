# 📱 Мессенджер 2026 — Android (Java + XML) + WebSocket-сервер + Docker/Railway

Полноценный мессенджер: Android-приложение на **Java + XML** (Material You / Material 3, API 28–36, дизайн 2026) и сервер на **Node.js (WebSocket)** с **Dockerfile** для мгновенного деплоя на **Railway** — без переменных, без консоли, без ПК.

## 🚀 Деплой на Railway (1 клик, всё автоматически)

1. Открой [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**.
2. Выбери этот репозиторий и ветку `arena/3ec8a4b2-mehhhanzmmxlwqozo`.
3. Railway **сам увидит** `Dockerfile` и `railway.json` в корне — нажми **Deploy**. Готово!
4. Никакие переменные окружения настраивать **не нужно**: Railway автоматически пробрасывает `PORT`, а сервер слушает `0.0.0.0:$PORT`.
5. После деплоя открой **Settings → Networking → Domains** — там появится адрес вида `https://xxx.up.railway.app`.

## 📲 Как скачать APK (автоматическая сборка в GitHub Actions)

1. В репозитории открой вкладку **Actions** → workflow **«🤖 Android CI — автосборка APK»**.
2. Каждый push в ветку собирает APK автоматически (Gradle + Android SDK уже установлены в CI).
3. Открой последний успешный run → внизу **Artifacts** → скачай `messenger-apk` (внутри `app-release.apk` — **подписанный**, готовый к установке, и `app-debug.apk`).

## 💬 Как подключить приложение к серверу

1. Установи APK на Android-телефон (Android 9–16, API 28–36).
2. При первом запуске в поле **«Адрес сервера»** введи адрес с Railway, например:
   `https://xxx.up.railway.app` — приложение само превратит его в `wss://…`.
3. Введи имя и нажми **«Войти в чат»**. Готово! 🎉

## 🗂 Структура репозитория

```
├── Dockerfile                  # образ сервера (Railway собирает его автоматически)
├── railway.json                # конфиг Railway (ничего настраивать не надо)
├── .dockerignore
├── server/                     # WebSocket-сервер (Node.js + ws)
│   ├── server.js
│   └── package.json
├── android/                    # Android-приложение (Java + XML, Material 3)
│   ├── settings.gradle
│   ├── build.gradle
│   ├── gradle.properties
│   └── app/
│       ├── build.gradle        # minSdk 28, target/compileSdk 36, AGP 8.13.0
│       └── src/main/
│           ├── AndroidManifest.xml
│           ├── java/com/messenger/chat/   # MainActivity, LoginActivity, ChatSocket, ChatAdapter, Message
│           └── res/                       # layout, values, drawable, mipmap (дизайн 2026)
└── .github/workflows/
    └── android-build.yml       # автосборка APK на каждом push
```

## ✨ Возможности

- 💬 Мгновенные сообщения через WebSocket (OkHttp)
- 👥 Список онлайн-пользователей (чипы)
- ⌨️ Индикатор «Печатает…», системные уведомления о входе/выходе
- 🔌 Автопереподключение с экспоненциальной задержкой
- 🎨 Material You (динамические цвета обоев на Android 12+), тёмная тема, edge-to-edge, сплэш-экран
- 🔐 Release-APK подписывается автоматически прямо в CI (keystore генерируется в workflow, секреты не нужны)

## 🧪 Локальный запуск сервера (опционально, не требуется для деплоя)

```bash
cd server
npm install
npm start
# сервер: http://localhost:3000 , health-check: http://localhost:3000/health
```

## 🐳 Локальный запуск сервера через Docker (опционально)

```bash
docker build -t messenger-server .
docker run -p 3000:3000 messenger-server
```
