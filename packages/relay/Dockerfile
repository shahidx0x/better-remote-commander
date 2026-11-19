# BRC relay image: works with the full monorepo context or Easypanel's subfolder context.
# The fallback fetches the exact GIT_SHA provided by Easypanel, never an unpinned branch when SHA is available.
FROM node:24-bookworm AS build
# Debian buildpack-deps already provides git and trusted CA certificates.
# Avoid Alpine apk altogether: its mirror's TLS failure prevented VPS deploys.
RUN corepack enable && git --version && test -r /etc/ssl/certs/ca-certificates.crt
WORKDIR /app
ARG GIT_SHA
COPY . /source-context/
RUN set -eu; \
    if [ -f /source-context/tsconfig.base.json ] \
       && [ -f /source-context/packages/shared/tsconfig.json ] \
       && [ -f /source-context/packages/relay/tsconfig.json ] \
       && [ -d /source-context/packages/shared/src ] \
       && [ -d /source-context/packages/relay/src ]; then \
      echo 'BRC: using complete local Docker build context'; \
      cp -a /source-context/. /app/; \
    else \
      echo 'BRC: incomplete Docker context; fetching source for the Git revision'; \
      if [ -n "${GIT_SHA:-}" ]; then \
        echo "$GIT_SHA" | grep -Eq '^[0-9a-fA-F]{40}$' || { echo 'BRC: GIT_SHA must be a 40-character commit hash' >&2; exit 1; }; \
      fi; \
      git init -q /app; \
      git remote add origin https://github.com/Rifatul-Islam-Munna/better-better-remote-commander.git; \
      git -c protocol.version=2 fetch -q --depth 1 origin "${GIT_SHA:-main}"; \
      git checkout -q --detach FETCH_HEAD; \
      if [ -n "${GIT_SHA:-}" ]; then \
        test "$(git rev-parse HEAD)" = "$GIT_SHA" || { echo 'BRC: fetched revision differs from requested Git SHA' >&2; exit 1; }; \
      fi; \
      rm -rf .git; \
    fi; \
    test -f package.json; \
    test -f pnpm-lock.yaml; \
    test -f pnpm-workspace.yaml; \
    test -f tsconfig.base.json; \
    test -f packages/shared/tsconfig.json; \
    test -f packages/relay/tsconfig.json
RUN pnpm install --frozen-lockfile --filter brc-relay... --config.confirmModulesPurge=false
RUN pnpm --filter brc-shared build && pnpm --filter brc-relay build
RUN pnpm --filter brc-relay --prod deploy --legacy /out

FROM node:24-alpine
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0 BRC_DB=/data/relay.sqlite
# Keep the original production UID/group and data-volume permissions unchanged.
RUN addgroup -S rdp && adduser -S rdp -G rdp && mkdir -p /data && chown rdp:rdp /data
WORKDIR /app
COPY --from=build --chown=rdp:rdp /out .
USER rdp
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/health >/dev/null 2>&1 || exit 1
CMD ["node", "dist/cli.js"]
