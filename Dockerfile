# syntax=docker/dockerfile:1

FROM node:22-alpine

WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8686 \
    AGENT_ROOT=/data/agent-sandbox \
    AGENT_ALLOW_EXEC=0

RUN mkdir -p /data/agent-sandbox && chown -R node:node /data /app

USER node

EXPOSE 8686

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8686)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.mjs"]
