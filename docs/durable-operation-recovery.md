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
   After the database commit, the relay sends an optional metadata-only
   `result_ack` to the device. Updated agents persist this confirmation in
   `agent_status({lookupCallId:operationId})`; older agents safely ignore it.
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
```

The MCP integration test uses an isolated SQLite file, disposable local
relay, fake local WebSocket device and new API keys. It does not touch
production deployments or credentials. For MongoDB parity, run the existing
`packages/relay/test/mongo.e2e.mjs` only with an explicitly approved
`BRC_TEST_MONGODB_URI` to an isolated test server.
