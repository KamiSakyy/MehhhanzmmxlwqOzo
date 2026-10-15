# 📁 handoff/apk — сюда попадает собранный APK

Здесь появляется `Telegram-FOSS-v13.1.0-arm64.apk` при каждой сборке в GitHub Actions
(шаг «📁 APK → handoff/apk» копирует его сюда — не в /tmp).

Бинарный APK не коммитится в git (`*.apk` в .gitignore, ~32 МБ) — скачивай по прямой ссылке:

👉 https://github.com/KamiSakyy/MehhhanzmmxlwqOzo/releases/latest/download/Telegram-FOSS-v13.1.0-arm64.apk

или из артефакта `handoff-telegram-apk` во вкладке Actions.

## ✅ Первая успешная сборка Telegram-FOSS

- **Run:** https://github.com/KamiSakyy/MehhhanzmmxlwqOzo/actions/runs/38714410085
- **Коммит:** `0edf8f2`
- **Размер:** 32 756 058 байт (31,2 МБ), Release, только `arm64-v8a`
- **Пакет:** `com.ts.telegram`
- **Версия:** Telegram-FOSS 13.1.0 (DrKLO/Telegram)
- **Сервер:** `https://mwmmw-production.up.railway.app` (встроен в код, `HandoffBridge.DEFAULT_SERVER`)
- **Вход:** @username + пароль (экран входа переделан, телефон не нужен)
- **MTProto:** отключён (`HANDOFF_DISABLE_MTPROTO = true`), весь трафик = HTTPS `/api/tl` + WebSocket `/ws`
