# syntax=docker/dockerfile:1
# Build context: server/chat/ (its own lockfile). Node runs the TypeScript sources directly (type stripping), so there is
# no build step and no dist/. `import type` from shared/chat-protocol is erased and never needed at runtime.
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:24-alpine
ENV NODE_ENV=production CHAT_LISTEN_HOST=0.0.0.0 CHAT_PORT=8790 TZ=UTC
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
USER node
EXPOSE 8790
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8790/healthz >/dev/null || exit 1
CMD ["node", "src/main.ts"]
