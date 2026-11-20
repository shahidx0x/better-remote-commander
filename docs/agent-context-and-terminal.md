# Compact code graph context and portable Windows agent console

## What was already present

This project does **not** have a graph database or a built-in local model. It has a bounded **RAM-only multilingual file/import graph** with file hashes, declaration locations, candidate dependency edges, workspace freshness checks and incremental parser reuse. It does not persist source code, prompts, tool transcripts or model conversation state.

The repository [billion-context by ranxianglei](https://github.com/ranxianglei/billion-context) motivated the **tiered, on-demand expand** design. That separate project is an LLM API proxy that compresses conversation history, whereas BRC is an MCP **tool server/agent**. BRC has **not** bundled its model proxy or copied its code. No "billions of tokens" model-context claim is made here.

## Retrieval-first, smaller tool responses

Existing tools now accept opt-in compact modes:

### 1. Context orientation (lowest transmitted context)

Use the existing `context_pack` tool:

```json
{
  "path": "D:\\my-project",
  "focus": "src/api/handler.ts",
  "query": "createUser",
  "mode": "outline",
  "maxChars": 6000
}
```

Response includes a compressed file table and declaration/edge references, relevant project instructions, warnings and explicit partial/stale markers. It does **not** transmit source snippets, and does not make another LLM request.

The `graph.files` array contains rows `[relativePath,sha256,language]`. Index positions in `graph.files` are file IDs, referenced by `graph.declarations` rows `[fileID,qualifiedName,kind,startLine,endLine]` and `graph.relations` rows `[sourceFileID,targetFileID,importKind,confidence]`. Lines are 1-based. Candidate edges are not compiler guarantees.

For exact code, expand only the chosen file/ranges with existing `read_code_ranges` or `read_symbol`, then edit only after a **fresh SHA-256 check**. The outline hash can become stale after an edit; it is not edit authorization.

### 2. Pure graph reference projection

Use the existing `code_graph` tool:

```json
{
  "path": "D:\\my-project",
  "format": "compact",
  "limit": 80,
  "maxFiles": 150,
  "maxChars": 12000
}
```

The output is a dictionary-coded, byte-budgeted graph reference. Every emitted edge/declaration references an emitted file ID; dropped entries are reported in `coverage` and `partial`. You can request the same tool with `format: "full"` for the previous detailed graph, or `action: "refresh"` to re-index. The default remains **full** for compatibility.

### 3. Source-containing context (unchanged)

`context_pack` defaults to `mode: "balanced"` and still assembles fresh code snippets and hashes within the existing budget. Use this for precise work; do not rely on an old outline to authorize changes.

**Performance:** Graph parsing is unchanged. The compact projection is a small, synchronous in-process transform only when requested. No graph DB, embeddings, model calls, network proxy or persistent source cache is introduced. Existing watchers and per-file metadata invalidation remain in use.

Example on a synthetic 56-file TypeScript fixture (not a production promise):

```text
Graph full JSON:      20,823 bytes
Graph compact JSON:    9,320 bytes
Wire-byte reduction:      55%
Compact projection:     2.15 ms
Omissions:               none
```

Reproduce after building with `node scripts/benchmark-context-outline.mjs`. These are JSON bytes, **not provider tokenizer counts**, context-window length, or inferred model usage. Highly repetitive/minimal source structures can benefit less.

## Portable Windows launcher

After the repository is installed and `pnpm build` succeeds, run **`START_AGENT.bat`** once from the repository. The BAT registers the current project directory in:

`%LOCALAPPDATA%\BRC\agent-root.txt`

This file contains only the installation path, **never credentials**. It also supports an explicit one-time setup:

```bat
START_AGENT.bat --register-only
```

You can now copy or move **only `START_AGENT.bat`** anywhere on the **same machine** (Desktop, another drive/folder, etc.) and double-click it. It locates the registered installation, changes to the project directory, and runs the built Node agent using **saved pairing**. The older `START_AGENT.cmd` remains available and delegates to the new BAT.

Examples:

```bat
START_AGENT.bat
START_AGENT.bat --setup
START_AGENT.bat --help
START_AGENT.bat --verbose
```

Resolution order: compiled agent next to the BAT → explicit `BRC_AGENT_ROOT` environment variable → saved path → globally installed `brc-agent.cmd`.

Moving the **project itself** requires re-registering its new directory or updating `BRC_AGENT_ROOT`. On a **different computer**, you still need Node.js and a working built checkout or globally installed agent; a BAT cannot package and transport an entire application by itself. If the registered path is missing, a helpful error is shown instead of silently installing dependencies.

## Pairing verification, existing login and changing a relay URL

The desktop BRC Agent opens the verification page **on the exact relay base URL entered in the agent**, even when the relay server advertises a different `PUBLIC_URL`. This helps keep the verification browser on the same origin where the owner logged in.

- Opening `/device/verify?user_code=XXXX-XXXX` while logged in shows the **new, branded one-click review page** with the requesting device's name and code. Confirm the code and click Approve or Deny. There is **no automatic approval** and no need to enter the code again.
- Opening `/auth/login?returnTo=...` with a valid current session redirects to the intended destination instead of showing the login form again.
- Verification and approval POSTs both require the session's CSRF token; requests without it fail.
- A login session is a secure host-only cookie with a 12-hour lifetime. **Different hostnames cannot share that cookie** (for example, `relay.example.com` and `service.provider.com`). If the verification link uses a different hostname or the session expired, signing in there is expected. Use one canonical HTTPS hostname for the admin and the agent, and a stable production `BRC_SESSION_SECRET` across replicas.
- While the agent is running, press **M → 3 (Forget) → Yes**. This now disconnects the previous relay immediately, cancels its reconnect timer, deletes the old local pairing and asks for a new base URL. Device display name is preserved as the default. A completed new pairing reconnects only to the newly entered relay.
- **M → 2 (Change)** retains the old connection until the new pairing succeeds; this is intentional to avoid losing a working connection after a failed change.
- The interactive `START_AGENT.bat`/`--auto-connect` path prioritizes saved pairing over stale ambient `BRC_RELAY` or `BRC_TOKEN` variables. Explicit `--relay` flags and intentionally unattended/`--non-interactive` runs still use their supplied values.
- The old `SES_RDP_` legacy pairing is not silently resurrected after an intentional forget from the existing `~/.brc` directory.
- Running `--forget-relay` in **another** terminal clears the saved file but cannot stop a separate already-running agent process. Close that old agent window, or use **M → Forget** inside it, before starting a new instance.

Rebuild the agent after changing its source; redeploy the relay after changing its HTTP pages/routes. Building does not alter or restart an already-running service.

## MyMCP-style live console with bounded local heartbeat

Interactive CMD/Windows Terminal shows a static startup panel and **minimal MyMCP-inspired tool receipts**: one timestamped 🔧 start line with a short call ID, followed by a ✅ completion or ❌ failure entry. The completion displays elapsed time, a short human-readable result summary and a shortened target, when available. Raw JSON responses, file contents and escaped source code are not printed in the default console. The local status check still runs every 30 seconds, but unchanged heartbeats remain silent (a reassurance row appears at most every five idle minutes). It never polls the relay, writes activity transcripts, or redraws a full-screen dashboard.

Single-key controls in a TTY (or a command followed by Enter in non-raw interactive mode):

| Key | Action |
| --- | --- |
| **M** | Connection settings (only opens when tool execution is idle) |
| **S** | Show live connection and in-flight tool status (local O(1) snapshot) |
| **L** | Show last 50 sanitized activity events held in RAM |
| **V** | Cycle MyMCP-style, detailed, verbose and compact live output |
| **?** or **H** | Show shortcut hints |
| **Ctrl+C** | Stop the agent gracefully |

The agent CLI defaults to **mymcp** mode copied from MyMCP's `remote-device/device.ts` message layout. Its default on-screen previews contain only small outcome summaries and safe target hints, not raw JSON or source text. Args omit scripts and credentials; full results still reach the MCP caller. The default displays both start and outcome events, while keeping the start entry to one line. `--compact` uses the previous concise one-row layout, `BRC_CONSOLE_MODE=detailed` restores explicit START/OK rows and call IDs, and `--verbose` shows bounded redacted parameter/status previews. Live logging retains at most **428 KiB of event history + 40 KiB pending stdout + 32 KiB pending/in-flight history writes**. Native terminal scrollback is not duplicated in RAM. Separately, `~/.brc/logs/tool-history.jsonl` persists up to **1,000 sanitized tool records**, with a **4 KiB** maximum preview per record and **5 MiB** maximum file size. An asynchronous streaming writer trims older entries and loads history on demand; `BRC_TOOL_HISTORY=0` opts out.

Use `BRC_CONSOLE_MODE=mymcp|detailed|verbose|compact` or the CLI switches `--verbose` / `--compact`. Set `NO_COLOR=1` or `BRC_COLOR=0` for plain, non-ANSI output. If `BRC_LOG_LEVEL=silent` is set, it still silences console activity as before. The display does not add execution latency beyond its optional, short text output.

## Dependency layout note (Windows / pnpm)

This checkout sets `virtualStoreType: project` in `pnpm-workspace.yaml`. Testing the original global virtual-store setting on Windows showed pnpm reporting a successful installation but leaving the `typescript` compiler missing. A project-local virtual store rebuilt and passed tests. The pnpm content-addressable cache remains shared on E:, so downloads are reused. This is a reliability workaround, not a claimed runtime performance improvement. It may use more local disk space than a correctly functioning global virtual store.

## Verification

Run from the built repository root:

```powershell
pnpm build
pnpm typecheck
node --test packages/agent/test/graph-outline.test.mjs
node --test packages/agent/test/portable-launcher.test.mjs
node scripts/benchmark-context-outline.mjs
pnpm test:agent
pnpm test:e2e
```

Portable BAT tests use a disposable environment directory and never overwrite real pairing data or your actual launcher pointer.
