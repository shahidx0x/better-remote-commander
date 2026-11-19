# BRC Harness Upgrade Plan — branch `harness-learn`

## Goal / constraints

Make the **local BRC agent** faster and more reliable, reduce unnecessary tool calls and RAM/CPU use, prevent unsafe retries, and allow verified progress to survive interruptions.

- Modify **only `packages/agent`**; preserve existing tool names, relay protocol, public MCP endpoint, and user authorization.
- Do **not** restart the currently connected local agent, relay, or ChatGPT MCP during development.
- Normal Node.js source edits only take effect on a future **local-agent restart**. New tool-registration metadata may require the MCP host to refresh it; do not promise instant hot activation.
- Never replay an ambiguous write, shell command, browser action, or third-party plugin call automatically.
- Keep generated caches and diagnostics bounded; avoid storing secrets, source code, or model transcripts without explicit user control.
- Run `pnpm --dir packages/agent build` and `node --test --test-concurrency=3 --test-reporter=dot packages/agent/test/*.test.mjs` before release.

## Implemented in this branch (first pass)

- [x] **Plugin environment isolation:** subprocesses inherit only required OS environment variables and explicitly configured plugin variables (`plugins/plugin-environment.ts`).
- [x] **Uncertain plugin results:** no automatic replay after a tool dispatch that may have side effects; `PLUGIN_CALL_OUTCOME_UNCERTAIN` returned with an inspection instruction.
- [x] **Plugin stderr cap:** per-plugin log capped to 512 KiB, with recent diagnostics retained (`plugins/capped-stderr.ts`).
- [x] **Filesystem fail-closed:** failed allowed-directory configuration read denies access rather than silently interpreting it as unrestricted.
- [x] **Safer background steps:** a background step gets its own deadline and cancellation signal, while retaining caller identity and remote-policy context.
- [x] **Cancellation uncertainty:** nested tools that do not settle after cancellation return an uncertain outcome, not falsely confirmed cancellation.
- [x] **Atomic persisted job history:** on-disk writes are ordered, temporary-rename atomic, retention uses recent write time and a 32 MiB disk quota. Stale running/queued jobs restore as `interrupted`, not `cancelled`.
- [x] **Durable coding-session checkpoints:** bounded metadata (goal, scope, source hashes and verification events), maximum eight saved sessions for seven days, 512 KiB each. Restored verification must be rerun. Opt out via `BRC_TASK_PERSIST=0`.
- [x] **Repeat-failure advice:** bounded hash-only record of identical failed tool calls; advisory prompts at 3/5/8 repeats without blocking calls or storing arguments.
- [x] **I/O and indexing hot paths:** remove redundant read-file `stat`/path validation; watcher-driven project-index refresh with integrity TTL; skip redundant clean code-graph passes while preserving cache metrics and invalidation.
- [x] **Tool routing descriptions:** correct concurrency guidance and shorten redundant model-facing descriptions without removing tools.
- [x] **Regression tests:** plugin crash-after-mutation, permission failure, capped stderr, job ownership/cancellation, checkpoint persistence and fresh-process restore, search/code-graph/MCP compatibility.

## Phase 2 — Bounded output spill and metadata-only mutation receipts (implemented)

- [x] Bounded, opt-in, redacted job-output storage (`runtime/job-output-spill.ts`): **2 MiB max per step**, **64 MiB global default**, 7-day retention, UTF-8 byte paging and SHA-256 verification on reads. Unavailable storage does not fail jobs.
- [x] `get_job` supports optional `output_step` (zero-based) and `output_byte_offset` with existing `output_chars`. The next offset is returned as structured metadata. Retrieving output is **read-only**; it never reruns any command.
- [x] `spawn_job` and `run_parallel` support `retain_output:true|false`; global opt-in via `BRC_JOB_OUTPUT_SPILL=1`, and optional `BRC_JOB_OUTPUT_QUOTA_BYTES` (2–64 MiB).
- [x] Redact common credentials in **new** persisted job previews and spill contents. Persist only sanitized step descriptors rather than commands or tool arguments. This is **not** a comprehensive secret detector; use only for trusted diagnostics.
- [x] Metadata-only mutation receipts (`runtime/operation-receipts.ts`): opt in via `BRC_OPERATION_RECEIPTS=1`. At most 128 receipts/1 MiB, 7-day retention; hash call IDs and target paths, and capture bounded before/after file hashes where available. `agent_status` shows recent sanitized outcomes.
- [x] Recover a receipt left at `started` as `uncertain` after restart. These are **observational receipts, not exactly-once execution or mutation replay**.
- [x] Tests cover Unicode pagination, redaction, integrity checks, disk quota eviction, disk write failure, corrupt storage, interrupted receipts, and fresh-process retrieval without command replay.
- [ ] Full raw output **already truncated inside an upstream command executor** cannot be recovered by spill storage. If deeper diagnostics are needed, configure the original command step's `maxOutputChars` appropriately; streaming capture is a separate future improvement.
- [ ] This agent-only change adds optional `get_job` schema fields. The live agent is **not** hot-reloaded; activate with a later local-agent-only restart and let the MCP host refresh advertised schemas if needed. No relay deployment is required.

## Phase 3 — Shared execution kernel, outcomes and safety (implemented first pass)

- [x] `runtime/execution-kernel.ts` centralizes preflight (including worker scope), cooperative cancellation checks, canonical file-lock acquisition, optional receipts and execution outcome classification. Existing dispatcher/tool/relay interfaces remain unchanged.
- [x] Each MCP tool result includes `_meta.executionOutcome.state`: **completed / failed / pending / uncertain**, plus `automaticRetry:false`. The kernel uses `_meta` so it does not inflate strict size-limited tool-owned `structuredContent` (for example `code_graph`). An ordinary failed command is NOT a rollback guarantee; a cancelled/timeout mutating operation can have uncertain effects.
- [x] Core filesystem mutations revalidate canonical paths inside the lock, rejecting retargeted symlinks/junctions with `PATH_CHANGED`. Caches invalidate even after an exception. This is **not** a complete OS-level solution to TOCTOU races (reparse points can still change after validation); Windows handle-level restrictions remain future work.
- [x] Background jobs stop subsequent steps after an uncertain mutation **even with continue_on_error=true**. Existing managed commands, plugin calls and tool results share the outcome classifier while retaining their normal lifecycle and cancellation policies.
- [x] Nested/batch calls now use unique internal receipt identities even when the host's parent MCP call ID is shared; no duplicated/overwritten mutation receipts.
- [x] `agent_status` exposes metadata-only kernel counts and aggregate lock admission time; no arguments, paths or full outputs are retained in the metrics.
- [x] Disposable local benchmark `node packages/agent/test/bench-phase3.mjs`: 20-file read, warm read, project-index cold/warm, ripgrep and 12 serial writes; measures wall time, CPU and RSS. Example Windows fixture results: cold 20-file read ~96 ms, warm ~12 ms, search ~34 ms, 12 serialized writes ~61 ms. **Not a representative large-project benchmark or a promised speedup**.
- [x] Regression coverage: 9 concurrent same-target writes, preflight cancellation, plugin uncertainty, crash-after-side-effect, Windows junction escape and retargeting, shared-parent receipt uniqueness, real MCP workflow.
- [ ] Audit every specialized mutating handler and external plugin/OS race under hostile concurrent filesystem changes, including symlink/junction replacement between final validation and actual file open; enforce stronger Windows handle-level guarantees where feasible.
- [ ] Collect subprocess-count and representative real-project P50/P95 benchmarks before changing worker counts. No global concurrency limits increased or relay/MCP protocol changes made.

## Phase 4 — Faster retrieval, graph output and context (implemented first pass)

- [x] Added `test/bench-phase4.mjs`, a read-only **disposable 150-file TypeScript project** benchmark covering 20-file cold/warm reads, repeated-file batches, ripgrep search, filename index, cold/warm graph, 48K/4K outlines and both context_pack modes. Real Next.js/NestJS benchmarks remain to be conducted before changing global worker limits.
- [x] `read_multiple_files` coalesces exact duplicate path/range reads **within a single batch only**, respecting its existing 3-worker limit and preserving response order. No cache is reused across requests; permissions and source remain fresh.
- [x] `project_index` streams match counting with a bounded result prefix (avoids allocating all matched filenames), aligns reported TTL with actual 5-minute watcher integrity/30-second fallback refresh, and invalidates only true descendants, not similarly named sibling directories.
- [x] `code_graph` focused traversal uses a frontier Set rather than scanning each frontier array for every graph edge.
- [x] `compactGraph` computes relevance scores once per file and tracks incremental serialized growth instead of serializing the whole graph for every file/symbol/edge; an exact final hard-budget guard remains, and file IDs/hash/line references remain validated.
- [x] `context_pack` now reads only the scoped instructions and package/framework metadata it actually uses, instead of invoking full project editor/toolchain discovery. `project_context` retains full discovery. Both modes preserve instruction scoping; balanced mode now states `mode:"balanced"`.
- [x] `context_pack` ranks nodes with precomputed scores, budgets added snippets incrementally and serializes the final compact response once, preserving source freshness and SHA-256 checks.
- [x] Tests added `test/phase4-retrieval.test.mjs`: batch freshness/coalescing and different ranges, exact index totals/sibling invalidation, compact outline byte-budget/reference correctness at 2K/4K/12K/48K, context instruction scope, fresh source hashes, and full project_context compatibility.
- [x] Measured example on the same Windows fixture (individual runs, approximate, **not guaranteed speedups**): 48K outline **54.5 → 2.3 ms**, repeated identical 20-file reads **14.3 → 2.1 ms**, context_pack outline **50.8 → 12.0 ms**, balanced **46.4 → 16.4 ms**. Warm graph and ordinary distinct-file reads were already fast and remained broadly similar.
- [ ] Benchmark on actual, representative Next.js/NestJS repositories and repeated samples (P50/P95), including CPU/RAM and subprocess counts, before tuning global concurrency or cache policy. No project sources are modified by the fixture benchmark.
- [ ] Provider-scoped/deferred tool discovery requires careful host-side tool-schema compatibility; avoid changing relay/MCP registration until explicitly planned.
- [ ] Do not add long-lived source caches or search-result caches without a verified invalidation model; index freshness and permissions must continue to be checked on every request.

## Phase 5 — Durable worker plans and optional semantic TypeScript (implemented first pass)

- [x] **Opt-in metadata-only worker-plan checkpoints:** `BRC_WORKER_PLAN_PERSIST=1`. `runtime/worker-plan-checkpoints.ts` caps each snapshot at 512 KiB, retains at most four plans for seven days, writes atomically with restricted permissions where the OS supports them, and ignores malformed/expired snapshots.
- [x] Save plan goals, task IDs/dependencies/scopes, check IDs and SHA-256 file evidence. **No raw coordinator keys, worker/claim keys, claim-key hashes, staged patch payloads, source bodies, tool outputs or model transcripts** are saved. Only a SHA-256 *verifier* for the original randomly generated coordinator key is stored to permit authorized resume/cancel. Users must retain that key themselves.
- [x] Restored active plans enter `needs_review`. They block ordinary file mutations and cannot dispatch new worker tasks until an authorized `worker_tasks({action:"resume",planId,coordinatorKey})` revalidates canonical scopes and the current source tree. Previous claimed/submitted work is reset to queued; previously applied tasks require source verification; old verification and claim keys are always invalid.
- [x] Persist plan metadata at creation, changes to check selections, releases/resets, submissions and integrations. A cancelled plan records a tombstone and is deleted. Plans evicted from RAM can reload from disk in review mode. A crash between file mutation and checkpoint can leave the plan unable to resume automatically: inspect actual files and replan, rather than replaying writes.
- [x] **Optional, lazy TS/JS semantic navigation:** `BRC_TS_SEMANTIC=1` activates `find_references` `mode="semantic"`, requiring a project root, exact TS/JS file, symbol, 1-based line and column. Uses TypeScript's compiler language service in a separate subprocess (`semantic-ts-worker.ts`) to distinguish true definitions/references from unrelated identifiers and comments; default `mode="lexical"` remains unchanged.
- [x] The semantic worker launches **only on demand**, one at a time, with a **160 MiB V8 heap cap** (NOT a total OS RSS cap), 10-second per-query deadline, 60-second idle shutdown, 400-project-file/16 MiB source coverage bounds, sanitized child environment, and no installs, writes, project script execution or model calls. Output is read-only and path/source freshness is revalidated by the parent. A simultaneous-request guard prevents one IPC request from replacing another.
- [x] Tests: `test/worker-plan-checkpoints.test.mjs` covers restart recovery, key/payload exclusion, stale source, cancellation, disk corruption and RAM eviction. `test/semantic-ts.test.mjs` covers default-disabled behavior, exact compiler references/definitions, lexical false positives, invalid positions/paths, warm worker reuse, idle shutdown and simultaneous calls.
- [ ] This is a **TypeScript compiler-language-service implementation**, not a complete, generic LSP protocol for C#, Rust, Python, etc. Results may be incomplete in large projects and are not proofs that a rename/refactor is safe; run project checks afterward.
- [ ] Stronger **Windows OS-level command confinement** remains unimplemented. The local Node worker heap limit and agent path checks are not Windows process isolation, a restricted token, or a total-memory quota. Do not claim OS sandbox guarantees.
- [ ] A standalone model-driven subagent loop remains a separate, explicitly opt-in architecture. Current BRC cannot control ChatGPT's model stream or autonomously launch new ChatGPT reasoning turns.

### Activation (no relay deployment)

No changes require a relay build or redeployment. The old running agent remains unchanged until a **future local-agent-only restart**. The existing MCP host may need to refresh its advertised tool schema to expose `worker_tasks.action=resume` and `find_references.mode=semantic`; a source edit cannot hot-reload an existing Node process. **Updated November 19, 2026:** bounded persistence and lazy semantic navigation are now enabled by default in agent code; set their flags to `0` to disable. Semantic mode still launches its worker only on demand.

## Verification and activation

- Current state: source changes and tests are on `harness-learn`, **not** committed/pushed/redeployed.
- Existing agent remains running; changing the local source does **not** hot-reload Node.js.
- Activation: restart **only the local BRC agent** at a user-chosen idle point. Avoid relay redevelopment/restart. A brief agent-device disconnection may occur during a restart; this is different from redeploying the relay.
- Never claim all planned phases are implemented until the relevant tests and acceptance criteria pass.

## Phases 6-11 - Hardening and architecture roadmap (2026-11-19)

The items below are agent-only work, derived from the second DeepSeek Harness review and an inspection of the BRC `harness-learn` branch. Never restart/reconnect the active MCP agent or deploy/modify the relay as part of these steps. Preserve existing tool names/schemas by default and use feature flags for changes to workflow behavior. Each item requires focused tests, full agent test suite and benchmark evidence before marking complete.

### P0 - Security, process ownership and shared resource admission

- [x] **Command environment policy (initial implementation):** add one command-env policy used by `run_command` and direct toolchain execution, with a secure allowlist profile and an explicit compatibility mode. Do not leak ambient relay/BRC auth, provider secrets, `NODE_OPTIONS` or `NODE_TEST_CONTEXT` in the secure profile. Preserve explicit user/project configuration and toolchain functionality; never silently break normal project commands. Test Windows PATH/PATHEXT, credential isolation, explicit opt-ins, offline restrictions.
- [ ] **Shared subprocess lifecycle:** centralize process-tree termination, process ownership, timeout/cancellation outcome, and bounded streams across command runners, terminal manager, search, plugins, parsers and optional TS worker. In Windows, `taskkill` invocation does not itself prove children stopped; distinguish requested termination from confirmed exit. Regression test orphan prevention and crash-on-spawn-error.
- [ ] **Unified resource coordinator:** consistent CPU-heavy slots, I/O/process permits, bounded queues, task cancellation and admission telemetry above MCP scheduler, background jobs, ripgrep, parser/TS workers. Do not unintentionally double-gate nested calls or increase current concurrency by default. Add tests for starvation, cancellations in queue, idle cleanup, multi-job fairness and memory pressure.
- [ ] **Windows command confinement:** optional restricted-token/job-object sandbox with independently verified enforcement. Do not claim that path validation or Node V8 heap limits are OS isolation, and never modify ACLs of unrelated projects.

### P1 - Response and tool-call efficiency

- [ ] **Canonical result presentation (optional shared result() helper implemented):** eliminate unnecessary duplication of large `structuredContent` in the human-readable text field where supported. Maintain backwards compatibility for existing MCP clients; test strict frame limits, error statuses, and reading the structured result. Measure actual wire bytes and full task calls, not just local JSON construction.
- [ ] **Tool visibility:** retain 80 native tool definitions until a host-compatible task-scoped/deferred schema registry is verified; no silent relay or protocol change. Measure schema/description overhead (baseline: 80 tools, ~102,884 metadata characters), tool selection accuracy and round trips before changing registration.
- [ ] **Shared project discovery:** deduplicate redundant enumeration and invalidate shared metadata by canonical root; use bounded manifests and watchers. Do not turn cached files into permission assertions; revalidate each requested path before use.
- [ ] **Safe source observations (initial implementation in write_file and edit_block):** add optional read-before-edit/expected-hash policy for coding sessions, allow intentional new file creation, and invalidate observations on out-of-band changes or uncertain mutations. Do not auto-rebase/overwrite ambiguous edits.
- [ ] **Efficient authoritative verification:** reuse enumerations/dirty-file information only if source hashes and permissions are freshly confirmed. Must preserve pre/post check integrity, including changes made during a build.
- [ ] **Recoverable completed results:** allow read-only lookup of small, durable result metadata after broken connections; do not rerun or automatically replay commands, plugins or filesystem writes.

### Additional smaller improvements and reliability QA

- [ ] Correct tool-description mismatches (`run_parallel` concurrency, shell selection, job/start vs complete), ideally derive limits from shared constants.
- [ ] Centralize resource-budget and process-status metrics, report P50/P95 latency, CPU time, peak/idle RSS and child-count from fixture and real-project runs.
- [ ] Optimize job spill integrity checks (avoid rehashing an immutable 2 MiB object for every small page while preserving tamper detection) and batch disk cleanup; never log raw credentials.
- [ ] Canonicalize repeat-failure fingerprints and recognize no-progress repeated reads without retaining raw tool parameters; advisory only, no autonomous retries.
- [ ] Coalesce only identical concurrent safe reads/searches with same canonical scope and permission checks, not writes or stale result reuse.
- [ ] Fault injection for ambiguous mutation after cancellation, symlink/junction retargeting, plugin disconnect, orphan processes and disk full; run complete regression suite.
- [ ] Verify interop for Windows PowerShell 5.1, CMD, pnpm, and common Next.js/NestJS/C# repositories without network/deploy changes.

### Delivery order and acceptance gates

1. **Phase 6 - Command safety and subprocess outcomes (P0).** Prove no unintended credential inheritance in secure mode; prevent false confirmed-stop status and keep existing commands working.
2. **Phase 7 - Resource scheduling (P0).** Prove no starvation and reliable queue cancellation; do not increase worker caps.
3. **Phase 8 - Tool responses and routing (P1 + smaller).** Benchmark bytes and calls; preserve compatibility with existing native MCP tools.
4. **Phase 9 - Project intelligence + guardrails (P1).** Demonstrate fewer scans and safe source/hash invalidation on real projects.
5. **Phase 10 - Recovery and storage (P1 + smaller).** Demonstrate read-only result recovery and bounded storage without replay.
6. **Phase 11 - Hardening and comparative benchmarks.** Stress/fault tests and P50/P95 CPU/RAM/latency on representative repos; no absolute speed claims without measurements.

**Status:** Planned. Individual checkboxes become checked only after corresponding implementation and tests. Phase 6 is the first coding target. No relay changes, MCP reconnect, live agent restart, git commit or push are authorized by this plan.

### First implementation batch (Phases 6-8, tested locally; agent-only)

- [x] `runtime/command-environment.ts`: `BRC_COMMAND_ENV_POLICY=isolated` inherits only essential OS/toolchain variables from the agent; `BRC_COMMAND_ENV_ALLOW=MONGODB_URI,NEXT_PUBLIC_...` explicitly grants named project values. Existing `compat` mode remains the default. Unneeded test-runner/Node options are excluded. Applied to `run_command`, direct `runProgram`, and interactive `start_process` shells. Environment policy and allowed-name count are visible through `agent_status`; values/secrets are not included in telemetry.
- [x] `runtime/process-termination.ts`: shared best-effort tree-stop request used by one-shot command and toolchain runners plus interactive terminal force-termination. Commands now report `root_exit_observed` versus `unconfirmed` instead of falsely treating grace-timeout as definite termination. An unconfirmed subprocess stop has `TOOL_OUTCOME_UNCERTAIN` and must be inspected before repeating. Neither state proves all descendants were terminated or that side effects rolled back.
- [x] `runtime/resource-admission.ts`: opt-in `BRC_SHARED_CPU_BUDGET=1` gates one-shot `run_command` and direct `runProgram` through one FIFO heavy-command permit. Bounded 24-waiter queue, default 10-second wait budget and cooperative queued-call cancellation. The later Phase 7 increment also gates TypeScript AST and Tree-sitter parsing. Default enabled as of November 19, 2026; broader background-job and OS process budgets are not unified.
- [x] `runtime/source-observations.ts`: opt-in `BRC_REQUIRE_SOURCE_HASH=1` requires `expected_sha256` before replacing/editing an **existing** code/config file through `write_file` or `edit_block`. New files remain creatable. The strict profile rejects stale hashes without dispatcher auto-rebase. This does **not** cover arbitrary shell, plugins or every specialized mutation handler.
- [x] `runtime/result-presentation.ts`: opt-in `BRC_RESULT_TEXT_MODE=compact` emits a short text summary when a shared `result()` helper receives a large object, retaining full `structuredContent`. Compact mode is now default, with full `structuredContent` preserved; set `BRC_RESULT_TEXT_MODE=legacy` for text-only clients. This does not remove duplicates from every custom response generator and requires clients consuming structured results.
- [x] Corrected `tool-routing.ts` documentation: `run_parallel` default/max concurrency is 3, not 4; Windows shell choice is configurable, not always PowerShell. Guardrail guidance mentions strict source hashes.
- [x] Regression tests: `test/command-environment.test.mjs`, `test/command-execution-guardrails.test.mjs`, `test/resource-admission.test.mjs`, `test/source-observations.test.mjs`, `test/result-presentation.test.mjs`; includes real Windows child-process checks, timeout outcome handling, FIFO/cancellation, fresh/stale edits, and bounded structured result compatibility.
- [x] Illustrative response-size measurement from a **synthetic large structured result**, with the same `structuredContent`: 129,956 bytes legacy versus 47,643 bytes compact (~63% less serialized frame data). This is a per-tool fixture result, **not** a measured overall chat/token or coding-task speedup.
- [ ] Complete unified process/resource ownership across all search, terminal, parser, plugin and background-job pathways. The current shared admission covers only two command runners.
- [ ] OS-enforced Windows process containment and true descendant-exit verification. `taskkill` requests, Node heap caps, filesystem path checks and V8 cancellation are **not** proof of OS isolation.
- [ ] Host-compatible deferred tool discovery, shared project manifest, complete canonical result format, read-only output recovery and full filesystem observation enforcement remain future phases.

**Activation:** Existing local agent continues unchanged until a later user-chosen local-agent-only restart. **Updated November 19, 2026:** tested bounded features are enabled by default in code. See Effective Defaults below. No `.env` file is required. Never redeploy/change relay or reconnect MCP as part of this source work. Do not commit/push without a separate request.

### Phase 7 - Expanded resource admission (agent-only increment, 2026-11-19)

- [x] Refactored bounded `CommandCpuAdmission` into a reusable configurable FIFO lane. `BRC_SHARED_CPU_BUDGET=1` now covers one-shot commands, direct toolchain calls, Tree-sitter parser worker jobs, and synchronous TypeScript saved-source AST parsing; each permit is released when its own work finishes. Background jobs that delegate to these tools do not hold extra global permits.
- [x] Added default-on `BRC_SHARED_IO_BUDGET` (set `=0` to disable): a 2-permit I/O lane for ripgrep. Search preserves its existing two-worker cap, and the extra I/O permit remains owned by a search session **until process close/error**, rather than leaking or being released when `start_search` first returns. Queued cancellation and startup failure release reservations safely.
- [x] Added default-on `BRC_SHARED_PROCESS_START_BUDGET` (set `=0` to disable): a 2-permit launch/startup lane shared by locally launched MCP plugins, interactive terminal `start_process`, and the optional on-demand TypeScript semantic worker. **Permits are short-lived startup leases, not lifetime process limits**; remotely connected plugins and existing worker/session caps are unchanged.
- [x] `agent_status` shows CPU/search-I/O/plugin-startup active and queued permits; bounded 64-sample P50/P95 admission wait times; and manager-level active terminal, ripgrep, parser thread, TS worker and plugin connection counts. These are **not** complete descendant OS process counts or an enforced RAM ceiling. Resource-lane metrics never retain command arguments, source content, credentials or project paths.
- [x] Regression tests in `test/resource-lanes-integration.test.mjs` cover shared CPU scheduling for Tree-sitter and TypeScript AST; no parser/search spawning before permit; cancellation while queued; I/O permit lifetime; local startup-queue fairness; delayed interactive terminal launches; optional TS semantic startup; and diagnostics. Existing plugin/search/semantic tests protect compatibility.
- [x] `context_pack` honors the existing opt-in `BRC_RESULT_TEXT_MODE=compact` for its custom response. The text shrinks while complete `structuredContent` (instructions, graph refs, hashes, snippets) remains identical. Fixture measurements: outline **6,962 -> 3,707 bytes (~47% less)**; balanced **7,969 -> 4,220 bytes (~47% less)**. These are per-response measurements, not end-to-end model speed gains. Legacy text remains available using `BRC_RESULT_TEXT_MODE=legacy`.
- [ ] Real OS process-tree ownership, machine-wide CPU/RSS quotas, cross-job priority and starvation policies, Windows Job Objects and representative real-project latency/CPU/RSS benchmarks remain future work. Do not claim these optional lanes enforce Windows process isolation.
- [ ] Shared project intelligence and safe file observation expansion remain Phase 9; durable read-only result recovery and storage cleanup remain Phase 10.

**Activation (updated):** All tested resource lanes are enabled by default in code; disable individually with `=0`. These changes do not hot-reload the running agent. No live agent restart, relay redeploy, MCP reconnection, commit or push was done during this increment.

### Phase 7 scheduling completion and Phase 9 shared project intelligence (2026-11-19)

- [x] Phase 7 *bounded resource scheduling* acceptance gates are implemented: FIFO permits, queued cancellation, CPU (commands + Tree-sitter/TypeScript AST), search-I/O permit lifecycle, local plugin/terminal/TS worker startup admission, bounded P50/P95 telemetry, and opt-in multi-tool stress tests. These bounded admission limits are enabled by default (each can be disabled with `=0`) and do not alter the relay.
- [ ] Windows Job Objects, confirmed full descendant termination, global OS CPU/RSS enforcement and cross-job priority policies remain a **separate Phase 11 security/performance hardening track**. Do not label those as completed or imply Node/V8 resource caps enforce OS containment.
- [x] Phase 9 initial implementation: opt-in `BRC_SHARED_PROJECT_MANIFEST=1` in `runtime/project-manifest.ts`. One bounded `rg --files --hidden` enumeration serves source/graph/context file navigation. The filename index retains its original `rg --files` semantics to preserve explicitly allowlisted hidden paths (for example `.env.example`) instead of using an unsafe approximation. At most four project roots, 20,000 filenames and 4 MiB raw scan data per project, a short 1.5-second reuse window, no additional filesystem watchers, source bodies, credentials or persistent index database. Per-request root/returned-file validation remains authoritative.
- [x] `listProjectFiles()` and `CodeGraph` use the shared source manifest; the separate `ProjectIndex` continues to cache its exact native ripgrep listing. A base-scan overflow falls back to the original source-specific enumeration. Cold graph builds and authoritative checks explicitly rescan for external changes. The manifest is enabled by default in the new agent code.
- [x] Every `sourceFingerprint()` verification bypasses cached listings, including pre/post command checks. If an in-progress listing is invalidated by an external write, perform at most one *read-only* rescan; if still changing, fail closed with `VERIFICATION_CHANGED` rather than pretending the snapshot was valid. No commands, edits or plugin actions are automatically replayed.
- [x] Explicit mutation invalidation and existing code-graph/index watcher events invalidate the shared manifest. One cancelled concurrent waiter never aborts remaining callers; when everyone cancels, the unnecessary scan is terminated. File-policy changes are checked on every call, even on cache hits.
- [x] Tests in `test/project-manifest.test.mjs` cover legacy-equivalent file views, hidden and generated-file exclusions, secret-name exclusion from source graph, cold index freshness, concurrent de-duplication/cancellation, out-of-band file additions, fresh verification, memory bounds and allowed-directory policy changes. The full real MCP transport workflow must pass with the new flag enabled.
- [x] Reproducible `test/bench-phase9.mjs`: on the same disposable 350-file Windows fixture, six-run median for four listings plus index setup decreased from 135.35 ms (legacy) to 69.49 ms (shared), **~49% less** after restoring native index parity. Twenty successive filename listings decreased from 443.97 ms to 30.80 ms, **~93% less**. This is local enumeration performance only, not a claimed overall agent/task speedup; warm vs cold filesystem cache effects may vary.
- [ ] Phase 9 remaining: evaluate exact sourced file-read observations across all specialized mutation paths, real-project watcher reliability, full source/metadata invalidation and project-scale P50/P95 CPU/RAM benchmarks. The manifest is a filename cache, not proof of current file contents.
- [ ] Phase 10 now includes durable metadata-only remote call-outcome lookup and verified spill pagination optimization (below); broader storage consolidation remains. Phase 11 still needs OS process containment/fault injection.

**Activation (updated):** The shared project manifest is enabled automatically on a future local-agent-only restart. `BRC_SHARED_PROJECT_MANIFEST=0` disables it. Do not restart live BRC, reconnect MCP, redeploy the relay or commit/push automatically.

## Effective agent defaults — no .env required (November 19, 2026)

**This section supersedes earlier opt-in activation language above.** Features below are enabled by agent source defaults, not by modifying a user's .env or Windows environment. The running agent stays unchanged until a user-chosen local-agent-only restart.

| Setting | Default when unset | Override | Notes |
| --- | --- | --- | --- |
| `BRC_SHARED_PROJECT_MANIFEST` | **On** | `=0` | 4-root bounded filename discovery; verification forces fresh enumeration |
| `BRC_SHARED_CPU_BUDGET` | **On** | `=0` | One CPU-heavy permit shared by commands and parsing; may trade throughput for lower contention |
| `BRC_SHARED_IO_BUDGET` | **On** | `=0` | Two ripgrep I/O permits; search also retains its existing caps |
| `BRC_SHARED_PROCESS_START_BUDGET` | **On** | `=0` | Two short-lived permits for plugin, terminal and semantic-worker startup |
| `BRC_RESULT_TEXT_MODE` | **compact** | `=legacy` or `=0` | Full structuredContent preserved; text-only clients should use legacy |
| `BRC_TS_SEMANTIC` | **On** | `=0` | Lazy compiler process starts only when semantic mode is requested |
| `BRC_WORKER_PLAN_PERSIST` | **On** | `=0` | Bounded metadata-only disk plans; no raw claim keys or patch payload |
| `BRC_OPERATION_RECEIPTS` | **On** | `=0` | Up to 128 bounded metadata-only mutation receipts |
| `BRC_CALL_OUTCOME_RECEIPTS` | **On** | `=0` | Up to 128 hashed-call-ID, metadata-only remote mutation outcomes; query with agent_status.lookupCallId |
| `BRC_SPILL_VERIFICATION_CACHE` | **On** | `=0` | In-memory verified file-identity cache, 32 entries/30 seconds; full SHA-256 again on identity change |
| `BRC_TASK_PERSIST` | **On (existing default)** | `=0` | Coding-session metadata checkpoint; unchanged |
| `BRC_COMMAND_ENV_POLICY` | **isolated** | `=compat` or `=0` | OS essentials retained; other inherited project vars may need approval |
| `BRC_COMMAND_ENV_ALLOW` | **MONGODB_URI** | Set comma-separated list, or empty | This *name* may be inherited from agent process if present, with its value accessible to spawned commands; no URI/password written into source |
| `BRC_REQUIRE_SOURCE_HASH` | **auto** | `=1` strict, `=0` off | Automatically computes fresh hash under a write lock for existing source/config files up to 8 MiB; strict requires caller hash. Auto does NOT prove prior human observation |
| `BRC_JOB_OUTPUT_SPILL` | **Off (intentional)** | `=1` or per-job `retain_output:true` | Redaction is imperfect; avoid automatically persisting potentially sensitive stdout |

Performance and reliability flags do NOT guarantee faster highly parallel builds, Windows OS process isolation, a total RSS cap, or exactly-once mutation execution. Turn off a resource lane with `=0` if it causes unnecessary queue waits.

**Verification:** `test/default-features.test.mjs` validates default values and overrides. Existing legacy behavior remains tested under explicit compatibility modes. Full default-profile test suite **passed on November 19, 2026 (exit code 0)** after fixing outdated compatibility-test assumptions. TypeScript build and `git diff --check` also passed. No live agent restart.

**Activation:** No `.env` entries required. The changes are source-only and activate on the user's later local-agent restart. No live restart, MCP reconnection, relay redeployment, commit or push.

## Re-audit and Phase 10 / 11 progress (2026-11-19)

### Precise phase accounting

| Phase | Verified implementation status | Still outstanding |
| --- | --- | --- |
| 1–5 | Five tested first-pass implementations | Further production/real-project stress testing |
| 6 | Environment isolation, safer termination reporting, source-write checks | OS-enforced process ownership/confinement and complete subprocess lifecycle |
| 7 | Bounded CPU/I/O/startup scheduling and cancellation are implemented | Truly unified OS-wide CPU/RSS quotas and cross-job fairness |
| 8 | Compact result views, tool guidance, canonicalized failure fingerprints | Host-compatible deferred tool discovery and complete canonical response coverage |
| 9 | Shared source-filename manifest, fresh authoritative verification; native index parity | More specialized mutation audit, long-running watcher stress |
| 10 | Durable metadata-only remote call outcomes and optimized spill paging | Consolidated storage cleanup, full-result delivery acknowledgement (needs relay protocol, not agent-only) |
| 11 | Read-only P50/P95 performance comparisons on three existing repositories | OS sandbox, descendant/interrupt fault injection and broader stress tests |

**Do not mark the entire 11-phase roadmap complete**. Phases 1–5 are completed first passes, Phase 7's bounded scheduler is complete, and Phases 6/8/9/10/11 have the scoped progress above.

### Phase 10: Remote call-outcome recovery

- [x] Agent-only `runtime/call-outcomes.ts` creates hashed call-ID, metadata-only records **before potentially side-effecting remote tools execute** and settles them before sending the tool result back to the relay. Record fields are limited to tool, received time, observed local status, bounded duration and safe error code. Raw call/client IDs, file paths, command arguments, credentials, source bodies, logs and actual tool results are not persisted.
- [x] The existing `agent_status` tool accepts an optional `lookupCallId`. If a record exists, this returns a read-only local outcome without rerunning anything; a record stranded at `started` after an interruption is shown as **uncertain**. A completed local tool result does NOT prove the relay or ChatGPT received it, and the full response is NOT saved. An absent record is NOT proof the call never ran.
- [x] Bounded local persistence: up to 128 records (prune with deletion headroom), 256 KiB disk budget, seven-day retention, atomic replacement and restricted file permissions when supported by the OS. Disabled with `BRC_CALL_OUTCOME_RECEIPTS=0`; default ON.
- [x] Duplicate remote call IDs with an existing durable potentially-mutating call receipt are not automatically re-executed after a local agent restart. The agent returns a refusal that directs the operator to the safe read-only lookup.
- [x] Unit tests include no-plaintext-secret persistence, fresh-process restart, failed/uncertain statuses, expiration, corrupt receipts, opt-out, and bounded rotation. `test/transport.test.mjs` demonstrates call -> result `_meta.callId` -> `agent_status({lookupCallId})` through actual local MCP transport without changing the relay.

### Phase 10: Spill-output retrieval optimization

- [x] `runtime/job-output-spill.ts` now maintains a **32-entry / 30-second** in-memory verified-file-identity cache. It hashes the entire 2 MiB-max spill when first read or whenever file identity, size or metadata timestamps change or cache expires; subsequent pages reuse that verified identity. File metadata is rechecked after each page read; corrupted content is rejected and never marked verified.
- [x] The verification cache is ON by default; `BRC_SPILL_VERIFICATION_CACHE=0` restores the original full-file SHA-256 on every paginated read. **Raw output spill storage remains opt-in** (`BRC_JOB_OUTPUT_SPILL=1` or per-job `retain_output:true`) because even redacted stdout may contain secrets.
- [x] `test/bench-phase10.mjs`, five rounds on a disposable 1,702,000-byte output: original median **228.49 ms** vs optimized median **73.74 ms**, **3.10× faster / ~67.7% less elapsed time**. Full-file SHA-256 work decreased from **132 times per complete page walk to once**. The test also verifies Unicode boundaries, stored output quotas, corruption detection, and retrieval after restart without tool re-execution.
- [ ] A privileged process able to mutate bytes and forge ALL file identity/timestamps may defeat an identity cache. It is a normal file-change guard, **not** OS-enforced immutability. Bounded output integrity remains cryptographically checked whenever observed identity changes. Verify threat model before using cached checks as proof against an adversarial local administrator.
- [ ] Consolidate retention/cleanup across operational state and reduce disk usage safely; do not store full secret-bearing tool outputs by default.

### Phase 8: Failure fingerprint consistency

- [x] `runtime/repeat-guard.ts` canonicalizes bounded JSON arguments by recursively sorting object keys, preserving array order. Equivalent failed calls with different key insertion order now share an advisory SHA-256 fingerprint. Raw arguments/results are not retained; no automatic retry, no blocking successful actions. Tests cover nested objects, ordered arrays, huge/cyclic inputs and unchanged retry guidance.
- [ ] Repeated successful no-progress reads are not automatically suppressed: identifying true semantic progress requires tool-specific freshness evidence and must not hide legitimate repeated reads.

### Phase 9/11: Actual read-only repository checks

- [x] The first real-project benchmark revealed a .env.example parity regression in the project filename index. Fix: keep the index's exact native ripgrep semantics, while sharing the bounded source/graph/context listing; tests confirm parity. No project files were modified.
- [x] `test/bench-real-projects.mjs` runs six paired rounds on existing repositories without writes or network operations. All three project/file-index result counts now match the legacy path: restaurants frontend **2.03× P50**, heaven-marriage **1.80× P50**, real-estate SaaS **1.62× P50** for four source listings plus filename-index setup. P95 speedups 2.91×, 1.81× and 1.63× respectively. Node CPU-only measurements and memory delta were captured; child ripgrep CPU is NOT included, so these are not total-machine CPU or end-to-end coding-task benchmarks.
- [x] The corrected 350-file disposable Phase 9 fixture: combined workflow six-run median **135.35 ms -> 69.49 ms** (~49% less), 20 repeated filenames **443.97 ms -> 30.80 ms** (~93% less). Repeatable scripts remain under agent/test.
- [ ] Windows job-object isolation, actual descendant termination proof, plugin fault injection, memory-pressure load and end-to-end task latency still require additional engineering and separate tests.

**Activation:** `BRC_CALL_OUTCOME_RECEIPTS` and `BRC_SPILL_VERIFICATION_CACHE` are ON by default in the new agent code; their `=0` values disable them. Existing running agent remains unchanged until a future local-agent restart. No relay/MCP changes or host restart, Git commit or push.

### Verification for this Phase 8/9/10/11 increment

- [x] TypeScript agent build (`pnpm --dir packages/agent build`) passed.
- [x] Full agent regression (`node --test --test-concurrency=3 --test-reporter=dot packages/agent/test/*.test.mjs`) passed **exit code 0**, including the real local MCP transport fixture, default-on policies, worker plans, source guards, spill tamper checks, duplicate remote-call refusal and persistence failure handling.
- [x] New Phase 10 unit tests and transport integration: call-outcome metadata persists across a new Node process, refuses duplicate post-restart mutation call IDs, and neither leaks arguments nor implies relay delivery. Disk failure is nonfatal.
- [x] All three read-only local project comparisons matched legacy source and filename-index totals after restoring exact native `.env.example` index handling; no project source files modified.
- [x] `git diff --check` passed. Branch remains `harness-learn`; **75 cumulative changed/new files**, exclusively under `packages/agent`. No commit/push, relay update, MCP reconnection or live agent restart.

**Still open after this pass:** fully unified operational storage/cleanup, host-side deferred tool schemas, additional specialized source guardrails, Windows Job Objects/true process-tree confinement and deeper fault/real workload testing. These are separate major engineering tasks and have NOT been marked completed.

## DeepSeek Harness subprocess comparison: agent-only continuation (2026-11-19)

Reference: https://github.com/deepseek-ai/deepseek-harness (packages/subprocess README, subprocess-local README). DeepSeek uses a shared subprocess service with platform-specific managed process ranges, bounded output, environment scrubbing and explicit weaker fallbacks. BRC currently has separate subprocess owners and best-effort Windows taskkill. Do not equate them with native Windows Job Objects.

- [x] Replace direct root-child `kill()` paths in BRC's shared project-manifest scan, legacy workspace source listing, project filename index and ripgrep search cancellation/early-stop/limits with the existing shared `requestProcessTreeStop` helper. This is a best-effort stop request, NOT proof of descendant exit or full managed-range ownership.
- [x] Preserve native project-index file enumeration semantics, existing search output/result limits, cancellation signals and search-session result retrieval. No relay or public tool-schema change.
- [x] Verified `pnpm --dir packages/agent build`; focused project-manifest/retrieval/resource-lanes/command-guardrails tests; full `node --test --test-concurrency=3 --test-reporter=dot packages/agent/test/*.test.mjs`; and `git diff --check` (all exit 0).
- [ ] DeepSeek parity still outstanding: a single managed spawn/observe/terminate service for ALL process consumers, native Windows Job Object process ownership, confirmed descendant quiescence, coordinated cleanup and end-to-end fault tests. Current change does not implement a Windows sandbox, and a taskkill request is not confirmation of full tree termination.

These changes remain uncommitted and take effect only on a later local-agent restart. The connected live agent and relay were not restarted, and no relay files were changed.

### Phase 6 additional lifecycle integration (2026-11-19)

**Target:** move the existing best-effort subprocess stop implementation toward DeepSeek's owned-child lifecycle, while preserving the BRC local-agent-only contract and not overstating OS sandbox guarantees.

- [x] `runtime/process-termination.ts` now tracks original child handles in a WeakMap and publishes aggregate metadata-only lifecycle counters (active, peak, closed, failed spawns, stop requests and duplicate requests). It coalesces duplicate stop requests per observed child and guards delayed Windows kill fallbacks against an already exited owner. It does not persist arguments, paths, transcripts or output.
- [x] Use observed owned-child stop requests for direct toolchain commands, run_command, terminal sessions, ripgrep searches, project filename index, project manifest scans, workspace listings, TypeScript semantic child and plugin-installer utility subprocesses. Tree-sitter parser workers use Node worker threads rather than OS child process spawns, and retain their own bounded termination.
- [x] Plugin-installer utility subprocess collection now clamps stdout/stderr capture independently and settles with `terminationState:unconfirmed` if the process root does not close within the timeout grace period; installation is never automatically replayed. Caller receives a timeout/error instead of being stalled indefinitely.
- [x] `agent_status.managedActivity.ownedChildLifecycle` reports bounded observability and explicitly says Job Object ownership and descendant exit have **not** been proven. The existing public tool name/schema and relay protocol are unchanged.
- [x] Added actual Windows child/grandchild stop test, duplicate-stop and failed-spawn tests in `test/managed-process-lifecycle.test.mjs`, plus plugin-installer timeout, bounded capture and spawn error tests in `test/plugin-utility-process.test.mjs`.
- [ ] **Phase 6 is NOT yet fully closed.** The MCP SDK's StdioClientTransport still owns its own spawn/close path; it is not brought under the owned-child helper. Job Objects / restricted tokens, kill-on-parent-exit and complete descendant quiescence are NOT implemented. The current Windows test proves one native fixture only, not OS-level enforcement for arbitrary tools. A reliable native helper/binding and integration audit are still required before Phase 6 can be marked fully complete.

The live agent was not restarted, and the changes are local-source-only until a future local-agent restart; no relay modifications, Git commit or push.

### Phase 6 MCP SDK local-plugin lifecycle hardening (2026-11-19)

- [x] `plugins/managed-stdio.ts` integrates the currently installed MCP SDK's local `StdioClientTransport` into BRC's owned-child tracking. It instruments `start()` *before* the SDK client connects, validates the returned child handle, and fails closed if that SDK implementation stops exposing an observable child. No plugin calls are replayed.
- [x] `plugins/host.ts` requests owned process-tree cleanup on explicit/idle stop and on failed or cancelled MCP handshake. Startup now uses a cooperative abort controller, including stop requests made before the handshake completes. `stopAllPlugins()` includes pending starts so a delayed connection cannot silently register a new running plugin after shutdown. No relay/server tool registration changes.
- [x] Sticky stop-before-start tracking ensures an SDK child which starts after cancellation is stopped when observed. Remote HTTP MCP plugins are not assigned local process-tree ownership.
- [x] Added `test/fixtures/managed-mcp.mjs` and `test/plugin-managed-lifecycle.test.mjs`. Windows end-to-end tests verify an SDK-started plugin's grandchild is gone after stop and after cancellation of an unfinished handshake. The SDK private-handle compatibility guard has a fail-closed test. Existing plugin crash-after-mutation/no-replay tests still pass.
- [x] Verification: TypeScript agent build, focused tests (8 passed including existing harness safety) and full agent regression suite with `--test-concurrency=3 --test-reporter=dot` passed. `git diff --check` passed.
- [ ] **Phase 6 native containment remains open.** This is best-effort Windows `taskkill /T /F` ownership, not the DeepSeek suspended-create + AssignProcessToJobObject + kill-on-close Job runner. There is still a spawn-to-observation race, a plugin can escape the process tree before being observed, and the MCP SDK's private `_process` field is a version-sensitive seam guarded by fail-closed validation. Native Job Objects/restricted tokens, OS-level descendant quiescence on arbitrary crashes, and non-Windows OS process containment need a separate tested native launcher/provider. Do not call this sandbox security complete.

All changes are source-only under `packages/agent`, uncommitted; the connected agent and relay were not restarted or modified.

### Phase 8 continuation — response shape and native-tool discovery footprint (2026-11-19)

- [x] `runtime/result-presentation.ts` and `dispatcher.ts`: safely compact any custom-handler text block proven to be a JSON duplicate of its full `structuredContent`. Never change independent file/search/job text, media blocks, error status, response metadata or full structured payloads; large and malformed non-duplicate text remains untouched. Existing `BRC_RESULT_TEXT_MODE=legacy` restores complete text for text-only clients.
- [x] `tool-routing.ts`: lower default tool-description budget from 1,350 to 1,050 characters and large-tool budget from 1,900 to 1,700, preserving ALL WHEN / INSTEAD / NEXT selection guidance and tool input schemas. `listTools()` still advertises 80 native tools, with unchanged tool names, annotations and handler mappings.
- [x] Read-only baseline/after test in `test/bench-phase8.mjs`: encoded 80-tool metadata **114,968 -> 110,217 bytes (4.1% less)**; description characters **64,901 -> 60,232 (7.2% less)**. This is catalog serialization size, NOT proven host prompt-token reduction or live-model tool-selection accuracy.
- [x] `transport/result-budget.ts`, `transport/ws-client.ts`, and existing `agent_status`: bounded 64-sample P50/P95/aggregate serialized response frame byte counters recorded only when a WebSocket result send is queued. No arguments, results, source text, file paths or credentials retained; WebSocket queue success is NOT proof the relay/ChatGPT received the result.
- [x] Synthetic duplicate JSON fixture: **67,086 -> 24,906 bytes (62.9% less)** with the exact same `structuredContent`. Individual custom tools only benefit if they actually contain duplicated JSON; independent human-readable output is not compressed.
- [x] Focused regression tests (including full MCP transport/coding workflow): **26/26 passed**; additional tests cover true JSON duplicates versus semantically different human text, image blocks, error guidance, legacy fallback and wire telemetry. Existing tool-routing guard was tightened to prevent future metadata growth.
- [ ] **Phase 8 is NOT yet fully closed**: host-compatible *deferred* per-task MCP tool-schema discovery and real model-based selection-accuracy/task-round-trip benchmarks require host/relay integration. Do not silently hide tools or change the public protocol. All remaining text-only results intentionally keep their original output; adding structured copies would increase wire cost, not reduce it.

All changes remain under `packages/agent` on `harness-learn` and require only a future local agent restart to activate. No relay edit, live agent restart, Git commit or push.

## Phase 6 + Phase 8 completion effort — native Windows runner and deferred-schema gateway (2026-11-19)

**Scope constraint:** source changes only under `packages/agent`. All previous uncommitted work is preserved. The running local agent and relay have NOT been restarted, redeployed, or modified, and there is no Git commit/push. This section supersedes earlier claims that Windows Job Objects were completely absent; it does **not** override the remaining exclusions below.

### Phase 6 — native Windows Job Object containment for eligible managed subprocesses

- [x] Added `native/winjob/Program.cs` and `BrcWinJob.csproj`: Windows CreateProcessW(CREATE_SUSPENDED), explicit validated .exe, Job Object with KILL_ON_JOB_CLOSE, AssignProcessToJobObject **before** ResumeThread, parent Node OS-handle watch, inherited stdio handles, Windows argument quoting and error-to-stderr without logging args/credentials. On normal completion the runner queries `JobObjectBasicAccountingInformation` until active job member count is **zero** before returning the target exit code. Handles close in finally.
- [x] Added `native/winjob/build.mjs` and package build hook: a machine with local .NET 10 SDK compiles the runner directly to `dist/native/winjob/BrcWinJob.dll`; the shipped agent package already includes `dist`. No network install/compilation occurs at agent runtime. Missing SDK is explicitly disclosed as weaker fallback, not misrepresented as native containment.
- [x] Added `runtime/managed-spawn.ts` with default-enabled native Windows wrapping of supported executable commands, and an explicit best-effort compatibility fallback for non-exe/IPC/verbatim/shell paths and unavailable native dependencies. A failed **native** start never silently re-executes the requested command. A PE-header preflight rejects fake .exe files so an unstarted optional rtk optimization can safely use its existing fallback-to-normal-command logic.
- [x] Used the shared wrapper in run_command, direct toolchain execution, interactive start_process, project/index/manifest/ripgrep search, ast-grep, plugin-installer/utility subprocesses and Node temp execution. Local MCP SDK stdio child launches use `managedLaunchSpec` and `attachManagedStdio` to observe the original owner; startup cancellation is preserved.
- [x] `stopManagedChild` uses original native wrapper ChildProcess handle rather than spawning `taskkill` when the child owns a native Job. Aggregate no-content native/legacy spawn counts and fallback causes appear in `agent_status.managedActivity.managedSpawn`.
- [x] Optional `BRC_WIN_JOB_MODE=strict` **fails closed** on unsupported managed-spawn/plugin launches and forces native containment for short read-only ripgrep scans. Default `BRC_WIN_JOB_OBJECT=1` is implied if unset, with `=0` disabling native wrapping; default `BRC_WIN_JOB_SHORT_READS=0` preserves fast read-only rg performance. Strict mode is off by default for compatibility, so do **not** claim every process is natively contained.
- [x] Native Windows tests cover Job assignment, stdout/stderr, quoted arguments/exit codes, detached grandchild death on Job owner termination, Node parent exiting unexpectedly, strict fail-closed, fake .exe rejection, no double execution, and command/plugin integration. See `test/winjob-native.test.mjs`, `test/native-managed-spawn.test.mjs`, `test/command-execution-guardrails.test.mjs`, `test/plugin-managed-lifecycle.test.mjs`, `test/ast-rtk.test.mjs`.
- [x] Startup overhead disclosed: read-only 10-round local Node fixture median **127.0 ms native vs 52.7 ms legacy (2.41x startup time)**. This is *not* a general agent performance benchmark; read-only scans use the old bounded stop mechanism unless `BRC_WIN_JOB_SHORT_READS=1` or strict mode is selected.
- [ ] **Phase 6 overall security remains partially open:** restricted-token/ACL filesystem sandbox is not implemented; no guarantee for `fork()`/IPC semantic-worker processes, external browser launches, non-exe/shell/verbatim subprocesses or read-only scans left on the legacy path. OS-managed Job containment is verified for eligible direct launch paths only. This is NOT a universal OS isolation/sandbox guarantee or cross-platform parity. A root process exiting alone still must not be described as proven descendant quiescence outside a native Job.

### Phase 8 — agent-native deferred tool registry and measured response efficiency

- [x] Added `runtime/deferred-tool-catalog.ts`: optional `BRC_TOOL_PROFILE=deferred` makes the **agent** advertise only `discover_tools` and `invoke_tool`. Discovery supports query/exact name, ranked short tool selection, pagination, and exact native JSON Schema only on explicit request. Invocation forwards to the unchanged native dispatcher with existing filesystem permission checks, source hash guards, mutation receipts, cancellation, audit and no uncertain-outcome replay. Recursion and unknown/retired tools are blocked.
- [x] Tests: direct gateway schema and file-operation compatibility in `test/deferred-tool-discovery.test.mjs`; disposable end-to-end HTTP MCP -> existing relay -> WebSocket -> agent integration in `test/deferred-mcp-transport.test.mjs`. Relay and live agent were NOT changed. The gateway works when the disposable relay uses its existing `BRC_MCP_TOOL_PROFILE=full` mode.
- [x] `test/bench-phase8.mjs`: normal 80 native tool metadata **110,217 bytes**, optional agent-sent deferred two-tool metadata **1,375 bytes**; synthetic duplicate JSON response **67,086 -> 24,906 bytes** (62.9% less) with unchanged structuredContent. None of these are measured chat token savings.
- [x] `test/bench-deferred-routing.mjs`: 14/14 chosen task-wording fixtures place expected native tool first after simple lexical guidance additions. This is **handpicked deterministic retrieval only**, NOT measured live model selection accuracy. Direct command uses one tool call; deferred discovery followed by invocation needs at least two. The gateway does not claim fewer model rounds.
- [ ] **Phase 8 host-level deferred loading remains blocked by the unchanged relay.** Its `packages/relay/src/mcp/server.ts` `liveTools()` intentionally merges a fixed relay tool catalog even when the connected agent advertises two schemas. Real end-to-end `tools/list` from a disposable relay using its existing full profile still returned **69 tools / 86,705 bytes**, not two. Default/focused relay profiles might not expose the two new gateway names at all. A true model-host two-tool discovery/prompt cost reduction needs a relay/host integration change, and user scope explicitly prohibits changing the relay. Do NOT mark that as fully completed or silently claim model token savings.
- [ ] External model-based tool-selection accuracy and real coding-task end-to-end walltime/CPU/RSS comparisons remain unmeasured; the lexical fixture and a synthetic serialization benchmark do not replace them.

**Configuration/activation:** All tested ordinary native Job functionality activates only after a future user-chosen **local-agent-only restart**. No changes to .env were required. `BRC_TOOL_PROFILE=deferred` is opt-in and needs host-compatible relay policy; the default full agent catalog remains intact to avoid breaking ChatGPT tools. `BRC_WIN_JOB_MODE=strict` is opt-in and can reject unsupported shell/IPC paths. No active connection, relay, or remote deployment was changed.

## Phase 9 continuation — safe AST rewrites and watcher freshness (2026-11-19)

Reference design: https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/filesystem.md — guarded provider writes and freshness-observation policy. BRC implements equivalent *local* safety intentions where compatible; this does not import the DeepSeek codebase or turn BRC into a filesystem sandbox.

### Implemented as source defaults (no .env required)

- [x] `runtime/ast-rewrite-guard.ts`, `tools/ast-grep.ts`: `ast_rewrite` no longer commits using unguarded `fsp.writeFile`. The scanner's offsets and matched UTF-8 text are revalidated against freshly read, bounded 8 MiB source snapshots while holding canonical per-file locks. All candidate file matches are preflighted before any file is written; stale/missing/overlapping/invalid spans fail before publication. The actual commit uses `atomicWrite(expectedSha256)` and revalidates paths. Failed later commits trigger conflict-aware best-effort rollback, with an explicit `AST_COMMIT_UNCERTAIN` error if prior writes or cleanup cannot be trusted.
- [x] `ast_rewrite` retains `dry_run=true` default; dry-run now includes original full-source SHA-256 hashes. Optional `expected_sha256_by_file` supports exact preview-to-commit version assertions, and `BRC_REQUIRE_SOURCE_HASH=1` requires these hashes on apply. Existing unset/default `BRC_REQUIRE_SOURCE_HASH=auto` still permits an automatically guarded rewrite when the scanner's matched bytes remain exactly current. **This is ON automatically**, not a new optional feature, and does not establish human read-before-write provenance.
- [x] `ProjectIndex` watcher events and watcher failure counts are bounded aggregate-only diagnostics. On external file changes during a scan, index building retries once (read-only); a still-changing tree fails closed as `INDEX_CHANGED` instead of returning a stale cache as authoritative. Changes/renames invalidate the shared project manifest, including a watch error. Windows ripgrep path values are normalized from `.\\src\\file` to `src/file` without changing native `rg --files` enumeration/hidden-file parity.
- [x] Tests `test/ast-rewrite-guard.test.mjs` cover normal preview/apply, stale scanner spans, strict/stale hash rejection, full multi-file preflight, overlapping/invalid byte offsets, and multibyte UTF-8. `test/project-index-watcher.test.mjs` verifies actual recursive Windows fs.watch invalidation from nested file creation/renames, single rescan after concurrent invalidation, continuous-change refusal and watcher closure. Existing project-manifest and source-observation tests remain active.
- [x] Three read-only existing-repository comparisons (six paired samples each): restaurants frontend **2.04× P50, 3.18× P95**, heaven-marriage **1.87× P50, 2.18× P95**, real-estate SaaS **1.67× P50, 1.80× P95**, with equivalent file/index counts on all three. Shared listing P50: 70.14 ms, 87.59 ms and 118.09 ms respectively. Node-only CPU and RSS deltas captured by `test/bench-real-projects.mjs`; ripgrep child CPU and LLM end-to-end latency are NOT measured.
- [ ] Remaining scope: a live ast-grep executable was not available in this test environment, so the real CLI rewrite end-to-end test is skipped; guard invariants were exercised directly with scanner-shaped fixtures. Multi-file commits are NOT one crash-atomic filesystem transaction. Shell/Git commands and arbitrary external tools cannot be forced into first-party source observation/locking without changing their execution contract. Watcher availability varies by OS/mount, so TTL/fresh scans remain required as fallback.
- [ ] Broader Phase 9 follow-up: test continuous external writes/junction-retargeting under production load and investigate any remaining specialized editors not already requiring explicit hashes. Do not conflate the 1.5-second filename hint cache with a safe source-content snapshot.

### Default/optional decision requested

- **On without configuration:** guarded ast_rewrite, automatic current-file SHA-256 for standard write_file/edit_block, shared project manifest, bounded resource lanes, compact text, native Windows Job containment for eligible direct .exe, and watcher freshness retry.
- **Not made universal:** `BRC_WIN_JOB_MODE=strict` rejects existing shell/IPC commands by design; enabling it for everyone would break compatible tooling. Short read-only scanners remain legacy by default because the measured native wrapper added roughly 2.41× startup overhead to a small process fixture.
- **Not made universal:** `BRC_TOOL_PROFILE=deferred` works in the local agent but the existing relay always merges its fixed MCP catalog; defaulting to two direct tool definitions would not shrink actual ChatGPT tool prompts and could break clients that expect direct tool registration. This requires an explicit host-compatible relay release outside the requested agent-only scope.

**Activation:** All modifications are under `packages/agent`, on the current `harness-learn` branch. No connected agent restart, relay change, reconnection, commit or push. The changes become active after a future local-agent-only restart.

## Phase 10 continuation — unified operational retention (2026-11-19)

**Status:** Local agent operational-state housekeeping is implemented and verified; relay-delivery acknowledgements and full-result recovery are NOT claimed and remain outside agent-only scope.

- [x] New `runtime/operational-retention.ts`: a single bounded, serial, idle-time scan over six **explicit** agent-owned storage directories. Enforces existing per-family TTL, file-count and disk-byte rules without migrating or replaying any records: call outcomes (128/256 KiB/7 d), mutation receipts (128/1 MiB/7 d), task checkpoints (8/4 MiB/7 d), worker plans (4/2 MiB/7 d), job-output spills (128/configured up to 64 MiB/7 d), and job history (100/32 MiB, existing no-TTL policy). Job history writes less than 6 hours old are protected from quota deletion; all recent record writes receive a 1-minute grace.
- [x] Explicit orphan-temp filename patterns for the six original atomic-writer formats; remove only exact owned matches older than **2 hours**. Skip unrelated names, non-files and symlinks, do not follow symlinked folders, and revalidate file identity before unlink. No recursive folder traversal. If a directory exceeds the 4096-entry bounded scan budget, skip quota deletion for that folder and report partial coverage instead of inferring completeness.
- [x] `resource-limits.ts` schedules unified retention automatically when idle, in the existing approximately five-minute cleanup cadence, coalesced with scratch maintenance. It does not run a directory sweep at startup or during an active MCP tool call. Housekeeping failures cannot fail commands or jobs; no network calls, user project writes, plugin/package deletions or new background worker processes.
- [x] `agent_status` exposes bounded, aggregate-only retention metrics: sweeps, deleted records/bytes, per-family counts, partial scans and errors. It contains no file paths, raw receipts, credentials, output, call arguments, command text or source content.
- [x] **Default ON without .env** (`BRC_OPERATIONAL_RETENTION=0` opt-out); raw job-output spill **remains off unless explicitly enabled** because command output may contain secrets. Status and maintenance do not prove relay delivery, exactly-once execution or full-result recoverability.
- [x] `test/operational-retention.test.mjs`: 7 tests cover exact ownership, TTL, disk/file quotas, orphan-temp grace, recent active writes, symlink/junction safety, opt-out and serialized concurrent cleanup. On Windows, creating a file symlink was refused with EPERM, so the specific file-symlink fixture was not exercised; the code rejects them via lstat. No unrelated files were deleted in the test.
- [x] `test/operational-retention-recovery.test.mjs`: a real fresh Node process after cleanup recovers a started remote call as **uncertain**, reads an existing task checkpoint, and pages a checksum-verified explicitly retained output spill. Local mutation receipts and settled outcomes are still available, with no replay.
- [x] TypeScript/native build, new focused tests, full agent regression suite and `git diff --check` passed (exit 0). The test suites use isolated temporary BRC_HOME directories; no live credentials or project files were touched.
- [ ] Remaining across Phase 10 beyond this agent-only milestone: confirmation that a result reached ChatGPT/relay, and a durable full-result delivery protocol, require a change to the relay/host and cannot be inferred from local WebSocket send success. Storing raw tool responses persistently by default is intentionally excluded for privacy and disk usage. High-adversary simultaneous directory retargeting or privileged timestamp spoofing is not an OS sandbox guarantee.

**Activation:** Future local-agent-only restart activates this feature automatically. No relay modification, ChatGPT reconnection, live agent restart, Git commit or push. All changes on `harness-learn` remain exclusively in `packages/agent`.

## Phase 11 continuation — fault injection, real-repository comparisons, and output memory hardening (2026-11-19)

**Implementation:** agent-only source changes; defaults preserve existing tool names and no `.env` changes required. This is a comparative/stress-testing milestone, **not** a claim of complete OS sandboxing, strict CPU/RAM quotas, or exactly-once execution.

- [x] Added `test/phase11-fault-stress.test.mjs` with eight disposable tests: 68 admission requests against a 24-waiter FIFO cap (44 bounded rejections, eight queued cancellations, remaining grants in FIFO order), 12 real toolchain calls cancelled while queued with no executable side effect, a 9 MiB chatty terminal fixture, eight native Windows Job grandchildren terminated through original owned handles (duplicate stop requests are safe), durable call receipt recovery after a deliberately abrupt subprocess exit (outcome stays uncertain and never replays), UTF-8 multibyte 500-KiB cap, UTF-16 astral-code-point boundary correctness, and bounded wait-phase text.
- [x] A real defect was reproduced: 290,000 CJK characters produced **870,077 UTF-8 bytes** in a supposed 500-KiB terminal log because only JavaScript character count was enforced. Fixed `core/terminal-manager.ts` and `core/types.ts` to maintain a precise incremental UTF-8 byte count as well as its original character/snapshot count, evict full old lines to obey both bounds, and trim the initial `start_process` output to the latest 500 KiB by valid UTF-8 boundaries. Long-line splitting now preserves UTF-16 surrogate pairs. New caps are **ON by default** and require no configuration.
- [x] The fault test also checks that native Job termination of repeated detached descendants leaves `managedChildStatus().active` unchanged; it does not claim a restricted-token sandbox or global OS CPU/RSS enforcement.
- [x] Extended `test/bench-real-projects.mjs` to report *managed BRC subprocess launch counts*, six paired-sample P50/P95 wall/Node-CPU, and sampled Node RSS (not continuous peak). For three existing repos, project enumeration and filename-index counts matched exactly in all baseline/shared paired samples. Read-only shared discovery measured:
  - Restaurants frontend: baseline P50 **132.01 ms**, shared P50 **65.02 ms**, **2.03x**; P95 207.49 -> 67.20 ms; files 282.
  - Heaven Marriage: baseline P50 **153.98 ms**, shared P50 **86.57 ms**, **1.78x**; P95 157.13 -> 88.54 ms; files 601.
  - Real-estate SaaS: baseline P50 **187.23 ms**, shared P50 **116.19 ms**, **1.61x**; P95 193.98 -> 119.55 ms; files 936.
  - Median managed subprocess selections reduced **5 -> 2** in all three compared workflows. Child process CPU is NOT included in Node CPU; sampled RSS is NOT an OS-enforced peak. One real-estate run had worse shared P95 Node CPU (234 vs 187 ms) and sampled RSS (9.49 vs 2.95 MiB), so no universal CPU/memory savings are claimed.
- [x] Tests are on disposable temporary `BRC_HOME` and projects, and the benchmark reads existing projects without writing sources. No credentials, raw tool output or source content enter these benchmark summaries.
- [ ] Still outside Phase 11 parity: adversarial kernel-level escape tests, restrictive Windows filesystem ACL/access-token sandboxing, machine-wide resource caps for shell/IPC and legacy processes, real relay/ChatGPT host-delivery acknowledgements and a multi-hour production workload profile. Existing tests establish bounded agent behavior for the tested fixtures only, not unrestricted process or memory safety.

**Verification:** focused Phase 11 stress suite, TypeScript and native builds, full agent suite and `git diff --check` need to pass on the final source. No live agent restart, relay modification, Git commit or push. Agent changes activate on a future local-agent-only restart.
