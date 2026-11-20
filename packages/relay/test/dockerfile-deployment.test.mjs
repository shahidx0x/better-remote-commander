import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Easypanel may build with a subfolder context, so the relay build stage
// must have git + trust roots without relying on Alpine's APK mirror.
const dockerfile = readFileSync(fileURLToPath(new URL('../Dockerfile', import.meta.url)), 'utf8');
const agentDockerfile = readFileSync(fileURLToPath(new URL('../../agent/Dockerfile', import.meta.url)), 'utf8');
const compose = readFileSync(fileURLToPath(new URL('../../../docker-compose.yml', import.meta.url)), 'utf8');
test('relay Docker build never needs Alpine APK indexes', () => {
  const [builder, runtime] = dockerfile.split(/\nFROM node:24-alpine\s*\n/);
  assert.ok(runtime, 'preserve original Alpine runtime and data volume UID');
  assert.match(builder, /^FROM node:24-bookworm AS build/m);
  assert.doesNotMatch(builder, /\bapk\s+(add|update)\b/);
  assert.match(builder, /RUN corepack enable && git --version/);
  assert.match(builder, /test -r \/etc\/ssl\/certs\/ca-certificates\.crt/);
  assert.match(builder, /ARG GIT_SHA/);
  assert.match(builder, /git -c protocol\.version=2 fetch -q --depth 1 origin/);
  assert.match(builder, /test -n "\$\{GIT_SHA:-\}"/,'partial contexts must be pinned');
  assert.match(builder, /git rev-parse HEAD/);
  assert.doesNotMatch(builder, /\$\{GIT_SHA:-main\}/,'never silently ship code from moving main');
  assert.match(builder, /mcpToolProfile\(\) !== 'codemode'/,'Docker build verifies default profile');
  assert.match(builder, /grep -Fq '"name": "code_mode"'/,'Code Mode must be in bundled schema');
});
test('relay runtime retains its production account, volume and healthcheck', () => {
  assert.match(dockerfile, /FROM node:24-alpine\nENV NODE_ENV=production/);
  assert.match(dockerfile, /RUN addgroup -S rdp && adduser -S rdp -G rdp/);
  assert.match(dockerfile, /COPY --from=build --chown=rdp:rdp \/out \./);
  assert.match(dockerfile, /BRC_MCP_TOOL_PROFILE=codemode/);
  assert.match(dockerfile, /USER rdp/);
  assert.match(dockerfile, /VOLUME \["\/data"\]/);
  assert.match(dockerfile, /CMD wget -qO- http:\/\/127\.0\.0\.1:3000\/health/);
  assert.doesNotMatch(dockerfile, /apt-get|apk add/);
});
test('agent Docker image includes QuickJS/WASM worker and native build-script sources', () => {
  assert.match(agentDockerfile, /COPY packages\/agent\/native packages\/agent\/native/);
  assert.match(agentDockerfile, /test -f \/out\/dist\/runtime\/code-mode-worker.js/);
  assert.match(agentDockerfile, /import\('quickjs-emscripten'\)/);
  assert.match(agentDockerfile, /pnpm --filter brc-agent --prod deploy --legacy \/out/);
});
test('docker-compose defaults to Code Mode-first, without removing the explicit profile override', () => {
  assert.match(compose, /BRC_MCP_TOOL_PROFILE: \$\{BRC_MCP_TOOL_PROFILE:-codemode\}/);
});
