# Lyrics backend only (server/*.mjs is dependency-free). Build context = repo root.
#   docker build -t auralis-backend .
FROM node:24-alpine
WORKDIR /app
COPY server ./server
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/api/spicy/health || exit 1
CMD ["node", "server/index.mjs"]
