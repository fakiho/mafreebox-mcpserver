FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY src ./src/
COPY tsconfig.json ./
RUN npm run build

# Production image (default target — stdio transport)
FROM node:22-alpine AS prod

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=builder /app/dist ./dist/

# Set up persistent directory for tokens — owned by node before VOLUME is declared
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME ["/app/data"]
ENV FREEBOX_TOKEN_FILE=/app/data/freebox_token.json

USER node

ENTRYPOINT ["node", "dist/index.js"]

# Optional target with mcp-proxy bundled (HTTP / SSE transports)
# Build with: docker build --target with-mcp-proxy .
# Override entrypoint to: mcp-proxy --transport streamablehttp -- node /app/dist/index.js
FROM prod AS with-mcp-proxy
USER root
RUN apk add --no-cache python3 py3-pip \
 && pip3 install --break-system-packages mcp-proxy
USER node

# agh-sync sidecar — pushes Freebox device names into AdGuard Home persistent clients.
# Build with: docker build --target agh-sync -t mafreebox-agh-sync .
# Run: docker run -e AGH_URL=... -e AGH_USER=... -e AGH_PASS=... -v agh-sync-data:/app/data mafreebox-agh-sync
FROM node:22-alpine AS agh-sync

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=builder /app/dist ./dist/

RUN mkdir -p /app/data && chown node:node /app/data
VOLUME ["/app/data"]
ENV FREEBOX_TOKEN_FILE=/app/data/agh_sync_token.json
ENV SYNC_STATE_FILE=/app/data/sync_state.json

USER node

# CMD (not ENTRYPOINT) so `docker compose run agh-sync node dist/agh-sync/authorize.js`
# substitutes cleanly instead of appending to a fixed entrypoint.
CMD ["node", "dist/agh-sync/index.js"]
