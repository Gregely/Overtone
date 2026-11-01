# syntax=docker/dockerfile:1
# Multi-arch (amd64, arm64 for Raspberry Pi 4/5). Build with:
#   docker compose build      or      docker buildx build --platform linux/arm64 .

FROM node:22-bookworm-slim AS build
WORKDIR /app
# Toolchain only used if better-sqlite3 has no prebuilt binary for this platform.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
RUN npm ci --workspace @overtone/shared --workspace @overtone/server --include-workspace-root
COPY packages/shared packages/shared
COPY apps/server apps/server
RUN npx tsc -b packages/shared apps/server \
 && npm prune --omit=dev --workspace @overtone/shared --workspace @overtone/server --include-workspace-root

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    OVERTONE_DATA_DIR=/data \
    OVERTONE_MUSIC_DIR=/music \
    OVERTONE_PORT=4800
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/server/package.json apps/server/
COPY --from=build /app/apps/server/dist apps/server/dist
RUN mkdir -p /data /music && chown node:node /data
USER node
EXPOSE 4800
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.OVERTONE_PORT||4800)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "apps/server/dist/index.js"]
