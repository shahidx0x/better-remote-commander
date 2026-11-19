# Durable relay operation recovery

The relay now records potentially side-effecting MCP calls **before** forwarding
them to a paired device. It uses the existing SQLite database or MongoDB
database; it never starts a second storage service or changes OAuth identities.
Safe read-only tools normally remain unjournaled to avoid extra I/O; supplying
an explicit operation ID requests recovery for a read too.

## How it works

1. Each journaled call gets an unpredictable UUID, or reuses the UUID supplied
   as optional `operationId` in an existing MCP tool invocation.
2. The relay atomically claims that ID **before** sending the request to the
   local agent, and reuses the ID as the WebSocket call ID. The agent's own
   metadata receipts therefore refer to the same operation.
3. The relay waits for the agent's result, stores a bounded encrypted result
   when permitted, and commits the settled receipt **before** returning the
   response to ChatGPT. The tool response includes
   `_meta.operationId`, `relayJournalSettled`, and `recoverableResult`.
   After the full encrypted result is durably retained, the relay sends a
   metadata-only `result_ack` to the device. Updated agents persist this
   confirmation and delete the local encrypted copy. A metadata-only receipt
   is **not** enough to delete the final surviving full-result copy.
4. Reusing an ID with exactly the same tool, owner, OAuth client, selected
   device and arguments **never dispatches again**. The relay returns the
   prior result if available or a no-replay recovery instruction. Reusing an
   ID for different arguments fails with `OPERATION_ID_CONFLICT`.
5. To recover, call `recover_operation({operationId:"<uuid>"})`, or call
   `recover_operation({})` to list recent operations for the **same** OAuth
   client. If the result is large, use `nextByteOffset` to page it. This
   works while the agent is offline, and after relay restarts if the relay
   database and encryption key were preserved.

Read-only `recover_operation` does not run anything on the PC. Its return is
owner- and OAuth-client-scoped. An account with a different client ID cannot
read the previous client's result merely because it knows an operation ID.

## Stronger agent-to-relay delivery (default on)

Newer local agents save a **bounded AES-256-GCM encrypted spool** of finished
results before sending them to the relay. The pairing token derives the local
spool key; no additional environment variable is required. The spool has a
500 KiB plaintext-result cap, at most 128 files and a 64 MiB encrypted disk
budget, with a seven-day retention limit in `BRC_HOME/result-spool`.
The spool does not contain raw tool arguments, and the agent never reexecutes
operations from it. If the agent restarts, it probes the relay with at most 32
stored operation IDs per probe (initially on reconnect, then every 20 seconds).
The relay acknowledges results already in its durable encrypted journal, and
requests only missing results. The agent resends the **saved result**, not the
command. This recovers from relay storage failure, an interrupted WebSocket,
missed acknowledgements, and agent/relay restarts. If the pairing token or
relay URL changes, old encrypted spool entries cannot be decrypted and expire
normally. `BRC_DURABLE_AGENT_SPOOL=0` is an explicit local-agent opt-out.

## MongoDB multi-relay routing (default on with a strong shared key)

Multiple relays can share one MongoDB database, the exact same issuer URL and
one **stable 32+ character encryption secret**. Each live device acquires a
20-second MongoDB-backed fenced ownership lease. A newer relay connection
supersedes an older lease; the old relay closes its stale device session.
If ChatGPT calls an MCP endpoint on a different relay instance, that instance
stores a bounded **encrypted** request in the same MongoDB operation journal.
Only the instance holding the device lease can atomically claim and send it.
A completed result is durably settled, recoverable by ID on any relay, and
acknowledged to the agent. Queued-but-not-running operations retarget to a new
lease owner; already-running/unknown operations are **not** automatically rerun.
A running operation stranded for more than about 190 seconds is marked
`uncertain`. This is a safety indicator, not evidence that nothing happened.

There are at most **128 queued/running routed operations per account** and
**1 MiB of plaintext arguments per routed call** (encrypted at rest). The
local relay shortcut avoids the cross-relay queue when the correct device
is connected to the current relay. The worker polls every 400 milliseconds,
with at most two cross-relay dispatches active per instance. Extra database
queries and encrypted routing add latency compared with direct local relay
calls; no overall speedup is claimed.

This coordination is available **only with MongoDB**, and it is disabled when
encrypted-result retention is explicitly disabled or there is no stable strong
key. SQLite remains fully supported for a **single relay instance**, but it
does not provide multi-instance device coordination. MongoDB must be shared
and persistent, with consistent `BRC_SESSION_SECRET` (or the same optional
`BRC_RECOVERY_ENCRYPTION_KEY`) across instances. No Redis, new public port or
additional authorization setup is needed.

## Recovery guarantees and limitations

- **No automatic mutation retries.** If the relay/agent stopped after a claim
  but before result settlement, the claim is `claimed` or `uncertain`. The
  command may have completed, failed or partially modified files. Inspect
  actual state before deciding what work remains.
- This is **at-most-one relay dispatch for the SAME operation ID while its
  receipt is retained**, not distributed exactly-once execution of external
  effects. Two different IDs can run the same command twice. Different hosts
  and expired receipts are not magically deduplicated.
- Settlement in the relay database confirms **relay persistence**, not
  delivery or rendering inside the ChatGPT conversation. ChatGPT UI delivery
  acknowledgements require host support and are not claimed here.
- SQLite uses WAL plus FULL synchronous writes. Its DB and WAL must reside on
  a persistent disk/volume. MongoDB remains the sole backend if configured.
- Claims and metadata expire after seven days. There is a maximum of 16,384
  unexpired operation records per owner, and encrypted payloads have a global
  64 MiB storage budget (MongoDB budget enforcement is best-effort under
  multi-process concurrency).
- The **plaintext result cap is 512 KiB** per operation; results larger than
  that retain outcome metadata only. Retrieval uses 16 KiB UTF-8-aware pages.
  File paths, raw arguments, commands, OAuth tokens and source text are not
  stored in unencrypted operation metadata.
- Result bodies are encrypted at rest using AES-256-GCM with operation/account/
  client/device data as authenticated context. The key is derived from the
  existing stable `BRC_SESSION_SECRET` (at least 32 characters) unless
  `BRC_RECOVERY_ENCRYPTION_KEY` is explicitly supplied. Do not rotate either
  key during redeploy unless losing **old encrypted results** is acceptable;
  account, OAuth and device data remain unaffected by encryption-key rotation.
- If no suitable stable key exists, metadata still persists but **result
  payloads are not saved**. `BRC_DURABLE_RESULT_PAYLOADS=0` disables encrypted
  payload retention explicitly. Neither setting disables durable claim
  protection.
- A tool may return `relayJournalSettled:false` after a storage failure.
  This is **not a reason to rerun an uncertain command**.
- A normal read-only MCP tool without `operationId` is not journaled.
  Read-only operations can safely be performed again as fresh reads.

## Upgrade without deleting pairing or OAuth

Deploy the same relay code at the existing `PUBLIC_URL` with the **same
persistent MongoDB database** or SQLite volume, admin identity and
`BRC_SESSION_SECRET`. The agent wire protocol version remains unchanged,
so existing agents can reconnect automatically. Do not create a fresh DB or
rotate device/OAuth credentials merely to activate recovery.

The new `recover_operation` MCP tool and optional `operationId` inputs must
be rediscovered by clients that snapshot tool schemas. ChatGPT may need an
MCP tool refresh to show the new tool. A fresh OAuth authorization should
not be necessary when the existing client ID, issuer URL and tokens are
preserved. Never claim a refresh/reconnect can be avoided for all hosts.

## Verification

From repository root after building:

```sh
pnpm --dir packages/relay build
node --test packages/relay/test/operation-recovery.test.mjs
node --test packages/relay/test/operation-mcp.test.mjs
node --test packages/relay/test/recovery-faults.test.mjs
node --test packages/relay/test/cross-relay.test.mjs
node --test packages/agent/test/result-spool.test.mjs
```

The cross-relay test uses a simulated MongoDB-like shared store; a live MongoDB
cluster or replica-set e2e still requires an explicitly authorized disposable
`BRC_TEST_MONGODB_URI`. None was available in the local environment. The
MCP integration test uses an isolated SQLite file, disposable local
relay, fake local WebSocket device and new API keys. It does not touch
production deployments or credentials. For MongoDB parity, run the existing
`packages/relay/test/mongo.e2e.mjs` only with an explicitly approved
`BRC_TEST_MONGODB_URI` to an isolated test server.
