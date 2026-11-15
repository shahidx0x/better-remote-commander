# Parallel coding: host workers, staged patches and bounded integration

BRC now exposes three optional coordination tools: `worker_tasks`, `worker_patch` and `worker_integrate`. They work through normal MCP calls and keep their state in agent RAM. The agent has **no language model** and never spawns a model, calls an inference API, starts Codex/Claude, or installs another agent framework.

## Choose the simplest path

- **Native subagents with BRC access:** the parent uses its host's actual delegation/spawn feature for independent tasks and gives those workers BRC read/context tools plus task claims and patch submission. Prefer 2-4 workers. One parent integrates the results.
- **Parallel tool calls without subagents:** the same model may issue independent reads concurrently or use `batch_tools`. This is not multiple reasoning agents.
- **Single-agent host:** keep using `batch_tools` and `workspace_batch`. A worker plan is optional and usually unnecessary for a small edit.

The relay's MCP initialization instructions, project context workflow and tool descriptions encourage the first path when actually supported. They do not force a host to spawn workers or bypass its permissions. `hostMode` is caller-declared, not auto-detection; responses report `spawnedModels: 0`. A standard MCP server cannot manufacture host capabilities.

All workers must use the **same target agent/deviceId and planId**. Coordination is not distributed across different agent processes. A new agent process loses plans, claim keys, submitted patches and verification evidence; already applied source remains on disk.

## Three tools

### `worker_tasks`

Actions: `create`, `status`, `claim`, `renew`, `release`, `reset`, `set_checks`, `cancel`.

`create` takes a project `path`, a `goal`, and up to 32 tasks. Each task has `id`, `goal`, literal relative `scope` paths, optional `dependsOn` IDs, and optional `readOnly`. Scope entries are existing directories or existing/planned files whose parent directories already exist. Create new directory scaffolding before opening the plan; the existing workspace-batch parent-directory rule is unchanged.

The coordinator receives an opaque `coordinatorKey`. Do not pass it to workers. Status does not expose coordinator/claim keys. These are cooperative role capabilities for already-authorized clients, not independent user authentication or a sandbox.

Concurrent editing tasks cannot own overlapping canonical paths. A directory includes its descendants. Shared files must have one owner or a dependency that serializes their tasks. Read-only tasks can overlap. Cycles, missing dependencies, path escapes and overlapping project plans are rejected.

`claim` requires a `workerId` label and optionally a `taskId`; otherwise it selects a ready task. Claims are atomic and capped at three active workers by default, configurable from one to ten. Dependencies become ready only after their prerequisites are **applied**, not merely submitted. Claim responses can include up to 16 requested file reads (`reads`) to save a separate round trip.

A claim returns a private `claimKey`, a generation, and an expiry (five minutes by default, configurable from 30 to 900 seconds). `renew` extends it. `release` relinquishes it. Expired or reset claim keys cannot submit late patches. Worker labels alone cannot recover keys. If a response is lost, the coordinator can reset that task or wait for expiry.

`reset` is coordinator-only and revokes the claim/submission. It does not revert source already applied. Active downstream work must be reset first. This permits correcting a failed integration using a fresh task claim and current file hashes.

`set_checks` is coordinator-only and accepts existing IDs from `discover_checks`. `cancel` discards staged work and invalidates keys without undoing applied source. It does not stop host-native model sessions; their host must stop them.

### `worker_patch`

A worker submits `planId`, `taskId`, `claimKey`, a unique `submissionId`, `summary`, and up to 16 `changes`. Changes have the same shape as `workspace_batch`: `path`, `expected_sha256`, and full `content` OR exact `edits`. A null expected hash means create only if absent. Paths and current hashes are validated, but **no source file is written**.

Editing tasks need an actual patch; read-only tasks submit a summary with no changes. A repeated submission ID with the same normalized payload returns the original acceptance instead of adding another patch. A changed retry is rejected; reset and re-claim before revising it.

Workers can concurrently explore and propose patches. They must not directly edit shared files or use unrestricted host shell tools for delegated changes. For active plans, the ordinary covered file-mutation tools reject writes into the coordinated root and direct callers to the patch/integration path. This helps prevent accidents; generic terminals, external editors, other processes and some specialized tools retain their existing authority. It is **not an OS security boundary**. Configure host subagents with a read-only tool subset when available; optional `sandbox_run` remains a separate explicit facility.

### `worker_integrate`

The parent supplies `coordinatorKey` and selects:

- `preview`: validate selected submitted tasks and return bounded proposals, file hashes and `review_sha256`. No source changes.
- `apply`: require that review digest, revalidate scopes/hashes, then apply the exact selected patches. Active claims must finish or be released first, so no worker is halfway through a shared-source read during a planned integration.
- `verify`: run the actual combined required checks, after all tasks have been applied.
- `finish`: recheck source/evidence and mark complete only when every task is applied, required checks passed, and current covered files match the accepted patches and verified snapshot.

The final `apply` may include `runChecks: true` to integrate and verify in one MCP round trip. Missing, failed or stale checks cannot finish a plan. A worker's summary saying "tests passed" is never verification evidence. A passing check establishes only that selected command's result, not complete program correctness or proof that a test runner discovered useful tests.

Applied proposals are released from RAM. Integration receipts make retries of recent successful applications non-mutating: they do not rerun writes or test commands. Receipts describe the earlier action, not newly verified source. Only the most recent 64 receipts are retained; older replays fail closed rather than overwriting current files.

If a write fails, integration waits for all in-flight writes, then attempts conflict-aware rollback. External edits are not overwritten during rollback. An unresolved rollback/unknown mutation outcome marks the plan `needs_review`; review the files and cancel/replan instead of blindly retrying. Failing tests leave applied edits intact; reset the relevant tasks and submit a correction.

## Example delegation contract

Parent creates:

```json
{
  "action": "create",
  "path": "D:\\projects\\my-app",
  "goal": "Implement agreed feature interfaces",
  "hostMode": "native_workers",
  "maxWorkers": 3,
  "requiredChecks": ["typecheck", "test"],
  "tasks": [
    { "id": "backend", "goal": "Implement the backend contract", "scope": ["backend/src"] },
    { "id": "frontend", "goal": "Implement the frontend against that contract", "scope": ["frontend/src"] },
    { "id": "review", "goal": "Review the combined source", "scope": ["."], "readOnly": true, "dependsOn": ["backend", "frontend"] }
  ]
}
```

Only use `native_workers` when the host really has that capability. `requiredChecks` must exist in the selected project. The parent passes planId, taskId, deviceId and instructions to actual host workers, not the coordinator key. Workers claim/read/propose; parent previews and applies a wave; the dependent review then becomes ready. The parent integrates the review result, runs checks and finishes.

For simple tasks, skip this whole protocol and issue one `workspace_batch` instead.

## Faster independent file publication

`workspace_batch` now accepts `writeConcurrency: 1..4` (default 1 preserves existing behavior). All changes are still validated first and all canonical target locks are held. With a value above one, distinct file publications run in bounded waves. Every promise in a wave settles before rollback, readback, or verification starts. Same-file duplicates are rejected and file contents are never assembled concurrently by different writers.

Worker integration uses four-wide publication for its already-separated proposals. Generic `batch_tools` still treats writes as ordered barriers; it does not accept arbitrary parallel mutations. Per-file atomicity, durable temporary writes, hash checks and rollback safeguards are retained. Multi-file operations are not crash-atomic, filesystem-wide compare-and-swap, or protection from every external-editor race.

`pnpm bench:io` compares individual writes, sequential workspace publication, and four-wide workspace publication through a real local MCP relay and separate agent. It checks contents and prints median results without saving logs. Results exclude Internet and model latency. Fewer round trips and overlapped I/O can help; more workers are not automatically faster.

## Resource and retention limits

Four retained plans; 32 tasks per plan; three simultaneous claims by default, maximum ten. Patches are limited to 2 MiB each, 8 MiB per plan and 16 MiB total. Plan metadata is capped at 512 KiB on input; a plan can cover at most 512 distinct applied paths and retain 64 recent receipts. Source verification retains bounded hashes, not source copies. Context accounting includes coordinator state.

Idle plans expire after two hours; finished/cancelled plans expire after five idle minutes and can be evicted to admit new work. In-flight integration/submission state is not discarded by idle cleanup. Payload limits are not a hard whole-process RSS guarantee.

No extra model workers, package downloads, persistent task database, worktree copies, task transcripts or disk logs are created. Existing login/device configuration and source files are not deleted by coordination cleanup. Live START/OK/ERROR activity remains unchanged.

## Verification and boundaries

Unit and real MCP integration tests cover racing claims, scope/dependency conflicts, stale claims/hashes, idempotent submission/application, read-only findings, quota/expiry cleanup, concurrent publication/rollback, and combined-check completion. Test clients simulate independent worker callers; tests do not claim that a real Claude or ChatGPT model was spawned.

This was developed and run on the connected Windows machine. The implementation uses the repository's existing Node/filesystem/MCP abstractions and language-neutral UTF-8 patches; host-specific delegation capabilities and other operating systems still need their own deployment validation.

## Primary references

- MCP tools: https://modelcontextprotocol.io/specification/2025-11-25/server/tools
- Claude Code subagents: https://code.claude.com/docs/en/sub-agents
- OpenAI subagent guidance: https://learn.chatgpt.com/docs/agent-configuration/subagents

These describe host/protocol behavior. They do not prove performance or correctness of this implementation. Run this repository's tests and benchmark for implementation evidence.
