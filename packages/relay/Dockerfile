# BRC relay image (multi-stage, pnpm workspace, node 24 for node:sqlite)
FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json packages/shared/
COPY packages/relay/package.json packages/relay/tsconfig.json packages/relay/
RUN pnpm install --frozen-lockfile --filter brc-relay... --config.confirmModulesPurge=false
COPY packages/shared/src packages/shared/src
COPY packages/relay/src packages/relay/src
RUN pnpm --filter brc-shared build && pnpm --filter brc-relay build
RUN pnpm --filter brc-relay --prod deploy --legacy /out

FROM node:24-alpine
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0 BRC_DB=/data/relay.sqlite
RUN addgroup -S rdp && adduser -S rdp -G rdp && mkdir -p /data && chown rdp:rdp /data
WORKDIR /app
COPY --from=build --chown=rdp:rdp /out .
USER rdp
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/health >/dev/null 2>&1 || exit 1
CMD ["node", "dist/cli.js"]
