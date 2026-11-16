# Native Android ARM64 / Termux BRC Agent

Native Termux is Android/Bionic, not ordinary GNU/Linux ARM64. This feature gates off known unsupported native/desktop tools. It has NOT yet been validated on a physical Android ARM64 device.

## Install on Android

1. Install up-to-date Termux and open a shell.
2. Run: `pkg update && pkg install nodejs-lts npm git ripgrep python clang make pkg-config`.
3. Bootstrap the repo-pinned JavaScript pnpm: `npm install -g pnpm@11.24.0` (one-time setup). Do not silently change the repository packageManager pin.
4. Clone/copy this BRC branch; run `pnpm install --no-optional --ignore-scripts` to avoid native desktop postinstall binaries. Then `pnpm build`.
5. Start with `sh scripts/START_AGENT_TERMUX.sh --relay https://YOUR-RELAY` and follow the browser pairing URL. The script requires system `rg`, disables automatic plugin downloads, and uses two concurrent requests by default.
6. Verify platform/architecture with `node -p "process.platform + ' ' + process.arch"` and inspect `agent_status` after connection. The tool catalog should reflect Termux capability limits.

## Supported and unsupported

- Core filesystem, terminal, code text/ranges, WebSocket pairing and worker coordination are intended to work within Termux app permissions, pending real on-device testing.
- No native `read_images` (sharp/libvips), Chromium `write_pdf`, Docker inspection/sandbox tools, or native `ast_search`/`ast_rewrite` in the Termux catalog. Invoking these on Termux returns `UNSUPPORTED_ON_TERMUX`.
- Code search needs system `rg`: `pkg install ripgrep`. Android/Bionic cannot necessarily run bundled linux-arm64 or linux-musl executables.
- Automatic plugin installation is skipped on Termux. Other optional plugins may need platform-specific binaries.
- Android cannot use BRC desktop systemd service registration; use a foreground Termux shell or opt into Termux:Boot after a successful foreground test. Android permissions/scoped storage still apply; do not assume root/system access.
- The Android-only relay tool list is filtered to online agent capabilities; the stable offline/desktop catalog remains available. Deploy the changed relay and restart the agent. Refresh MCP tool discovery in ChatGPT if its cache is stale.

## Chunking and worker recovery

- `read_file`: default 300 text lines, hard max 2000. Follow `structuredContent.read.next` while `hasMoreLines`; if a huge single line was truncated, use `read_code_file` with `charOffset`/`charLength` and follow `nextCharOffset`.
- PDFs default to 3 pages, maximum 5 per call; batches read up to 2 PDF pages. Follow the page continuation metadata.
- `write_file`: default 1000 lines, hard max 2000 and 1 MiB per call. `WRITE_LINE_LIMIT`/`WRITE_SIZE_LIMIT` indicate **nothing was written**. On success, `write.thisChunkComplete` covers only that chunk; append only the next intended chunk with `mode=append` and inspect the file before retrying after uncertain transport results.
- Worker coordinator does NOT spawn LLMs; actual native host subagents are necessary for model parallelism. Claims default to 15 minutes (max 60 minutes via renewal), and new directory scopes end with slash, e.g. `src/new-module/`. Workers only stage patches; the parent previews, applies and runs checks.

## Limits

This is best-effort compatibility, not a promise that every native dependency installs on Android. Device-side build, pairing, Android permissions, and an end-to-end smoke test are still required before declaring production support.
