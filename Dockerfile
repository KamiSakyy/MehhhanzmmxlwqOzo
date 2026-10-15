# syntax=docker/dockerfile:1
FROM node:22-alpine

WORKDIR /app

# Install dependencies first (better Docker layer caching)
COPY server/package.json ./
RUN npm install --omit=dev

# Copy server source code
COPY server/ ./

ENV NODE_ENV=production
EXPOSE 3000

# Railway automatically provides the PORT environment variable.
# The server listens on 0.0.0.0:$PORT — no configuration needed.
CMD ["node", "server.js"]
