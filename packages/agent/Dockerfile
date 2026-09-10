# BRC agent image - for controlling a Linux server/container. On desktops prefer `npx`.
# docker run -d --name brc-agent -v brc-agent:/home/rdp/.brc -v /srv:/srv \
#   -e BRC_RELAY=https://rdp.example.com -e BRC_NAME=my-server brc/agent
FROM node:24-bookworm-slim AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json packages/shared/
COPY packages/agent/package.json packages/agent/tsconfig.json packages/agent/
RUN pnpm install --frozen-lockfile --filter brc-agent... --config.confirmModulesPurge=false
COPY packages/shared/src packages/shared/src
COPY packages/agent/src packages/agent/src
RUN pnpm --filter brc-shared build && pnpm --filter brc-agent build
RUN pnpm --filter brc-agent --prod deploy --legacy /out

FROM node:24-bookworm-slim
ENV NODE_ENV=production BRC_HOME=/home/rdp/.brc
RUN apt-get update && apt-get install -y --no-install-recommends bash git curl ca-certificates procps \
  && rm -rf /var/lib/apt/lists/* \
  && useradd -m -s /bin/bash rdp && mkdir -p /home/rdp/.brc && chown rdp:rdp /home/rdp/.brc
WORKDIR /app
COPY --from=build --chown=rdp:rdp /out .
USER rdp
VOLUME ["/home/rdp/.brc"]
ENTRYPOINT ["node", "dist/cli.js", "--no-browser"]
