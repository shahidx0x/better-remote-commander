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

## Cleaner console, no extra polling

Interactive CMD/Windows Terminal shows a static startup panel containing the device/relay/runtime, a simple live connection indicator and compact live activity. The display does not start a polling loop, write transcripts, render a high-frequency dashboard, or persist tool history.

Single-key controls in a TTY (or a command followed by Enter in non-raw interactive mode):

| Key | Action |
| --- | --- |
| **M** | Connection settings (only opens when tool execution is idle) |
| **S** | Show live connection and in-flight tool status (local O(1) snapshot) |
| **L** | Show last ten sanitized activity events held in RAM |
| **V** | Toggle concise/verbose live output |
| **?** or **H** | Show shortcut hints |
| **Ctrl+C** | Stop the agent gracefully |

TTY sessions default to compact mode: completion and failure are shown, rather than separate START and completion lines. Important warnings and connection state remain visible. **All** phase events are still available in the bounded in-memory activity buffer. Piped/non-TTY logging remains verbose by default to preserve existing workflows.

`--verbose` or `BRC_CONSOLE_MODE=verbose` shows the original START/OK/ERROR events; `--compact` selects compact even with redirected stdout. Set `NO_COLOR=1` or `BRC_COLOR=0` for plain, non-ANSI output. If `BRC_LOG_LEVEL=silent` is set, it still silences console activity as before. The display does not add execution latency beyond its optional, short text output.

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
