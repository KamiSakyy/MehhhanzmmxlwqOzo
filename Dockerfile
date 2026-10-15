# syntax=docker/dockerfile:1
# Мессенджер 2026 — сервер (TL-мост вместо Telegram).
# Один Dockerfile на любой хостинг: Railway, Render, Fly.io, Koyeb, Amvera,
# любой Docker-раннер и обычный `docker build && docker run`.
# Всё нужное лежит в КОРНЕ репозитория: server.js, src/, package.json.

FROM node:22-alpine

WORKDIR /app

# Сначала только манифест — слой с зависимостями кэшируется
COPY package.json package-lock.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# Затем исходники
COPY server.js ./
COPY src/ ./src/

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Хостинг сам подставляет PORT; сервер слушает 0.0.0.0 — настраивать нечего.
CMD ["node", "server.js"]
