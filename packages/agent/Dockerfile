# SES-RDP agent image - for controlling a Linux server/container. On desktops prefer `npx`.
# docker run -d --name ses-rdp-agent -v ses-rdp-agent:/home/rdp/.ses-rdp -v /srv:/srv \
#   -e SES_RDP_RELAY=https://rdp.example.com -e SES_RDP_NAME=my-server ses-systems/rdp-agent
FROM node:24-bookworm-slim AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json packages/shared/
COPY packages/agent/package.json packages/agent/tsconfig.json packages/agent/
RUN pnpm install --frozen-lockfile --filter @ses-systems/rdp-agent... --config.confirmModulesPurge=false
COPY packages/shared/src packages/shared/src
COPY packages/agent/src packages/agent/src
RUN pnpm --filter @ses-systems/rdp-shared build && pnpm --filter @ses-systems/rdp-agent build
RUN pnpm --filter @ses-systems/rdp-agent --prod deploy --legacy /out

FROM node:24-bookworm-slim
ENV NODE_ENV=production SES_RDP_HOME=/home/rdp/.ses-rdp
RUN apt-get update && apt-get install -y --no-install-recommends bash git curl ca-certificates procps \
  && rm -rf /var/lib/apt/lists/* \
  && useradd -m -s /bin/bash rdp && mkdir -p /home/rdp/.ses-rdp && chown rdp:rdp /home/rdp/.ses-rdp
WORKDIR /app
COPY --from=build --chown=rdp:rdp /out .
USER rdp
VOLUME ["/home/rdp/.ses-rdp"]
ENTRYPOINT ["node", "dist/cli.js", "--no-browser"]
