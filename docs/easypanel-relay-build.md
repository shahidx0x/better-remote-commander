# Easypanel relay build fix — Alpine package-index TLS failure

## Error and root cause

The Docker build failed at:

```
RUN corepack enable && apk add --no-cache git ca-certificates
WARNING: fetching https://dl-cdn.alpinelinux.org/alpine/v3.24/main/x86_64/APKINDEX.tar.gz: TLS: unspecified error
ERROR: unable to select packages: git (no such package), ca-certificates (no such package)
```

This means **Alpine could not retrieve its package index** due to a TLS/network
failure from the build environment. The `no such package` message follows
from a missing index, not from the packages actually being unavailable.
It happens before any application code is built.

## Fix

The **build stage only** now uses `node:24-bookworm`, the official Debian
`buildpack-deps` Node image, which has Git and trusted CA certificates
already installed. It runs `corepack enable` and checks that both are present.
**No apt-get or apk call is required during the relay Docker build.**

The **runtime stage remains `node:24-alpine`** with the original `rdp`
user, `/data` volume, port 3000, `/health` healthcheck, and environment
variable behavior. This deliberately avoids a change to persisted volume
permissions. No MongoDB/SQLite, OAuth, pairing, token, public URL or
reverse-proxy configuration is modified.

## Deploy in Easypanel

1. Ensure the configured repository branch includes this fix. The same
   Dockerfile hotfix was pushed to both `main` and `harness-learn`.
   For the newest agent and relay features, choose `harness-learn`.
2. Prefer **Docker build context: repository root** with
   **Dockerfile path: `packages/relay/Dockerfile`**.
3. If Easypanel provides only a subfolder as context, the existing fallback
   downloads the repository. Configure a 40-character `GIT_SHA` build
   argument matching the **exact revision you are deploying** (when
   EasyPanel does not already supply it). This preserves the source
   revision pin and prevents silently building `main` while targeting
   `harness-learn`. The fallback's default without `GIT_SHA` remains
   `main` for backward compatibility.
4. Run **Redeploy / Rebuild**, preferably with a fresh build for the
   build-stage image. Do not wipe the MongoDB database or `/data` volume.
5. Verify `https://bettermcp.badal.agency/health` returns HTTP 200.
   Use Easypanel's build output to confirm the new image was built and
   successfully started, not just that an older relay remains healthy.

If a later step fails with TLS when accessing `github.com` or the npm
registry, that would be a separate **VPS network/DNS/proxy/clock/certificate**
issue, rather than the now-removed Alpine `apk` step. Verify outbound HTTPS
from the VPS in that case. **Do not disable TLS verification.**

## Validation

```sh
node --test packages/relay/test/dockerfile-deployment.test.mjs
docker buildx build --check -f packages/relay/Dockerfile .
pnpm --dir packages/relay build
```

The Dockerfile check validates syntax and base image metadata **without
downloading and executing all image layers**. It is not a production deployment.
