import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Easypanel may build with a subfolder context, so the relay build stage
// must have git + trust roots without relying on Alpine's APK mirror.
const dockerfile = readFileSync(fileURLToPath(new URL('../Dockerfile', import.meta.url)), 'utf8');
test('relay Docker build never needs Alpine APK indexes', () => {
  const [builder, runtime] = dockerfile.split(/\nFROM node:24-alpine\s*\n/);
  assert.ok(runtime, 'preserve original Alpine runtime and data volume UID');
  assert.match(builder, /^FROM node:24-bookworm AS build/m);
  assert.doesNotMatch(builder, /\bapk\s+(add|update)\b/);
  assert.match(builder, /RUN corepack enable && git --version/);
  assert.match(builder, /test -r \/etc\/ssl\/certs\/ca-certificates\.crt/);
  assert.match(builder, /ARG GIT_SHA/);
  assert.match(builder, /git -c protocol\.version=2 fetch -q --depth 1 origin/);
  assert.match(builder, /git rev-parse HEAD/);
});
test('relay runtime retains its production account, volume and healthcheck', () => {
  assert.match(dockerfile, /FROM node:24-alpine\nENV NODE_ENV=production/);
  assert.match(dockerfile, /RUN addgroup -S rdp && adduser -S rdp -G rdp/);
  assert.match(dockerfile, /COPY --from=build --chown=rdp:rdp \/out \./);
  assert.match(dockerfile, /USER rdp/);
  assert.match(dockerfile, /VOLUME \["\/data"\]/);
  assert.match(dockerfile, /CMD wget -qO- http:\/\/127\.0\.0\.1:3000\/health/);
  assert.doesNotMatch(dockerfile, /apt-get|apk add/);
});
