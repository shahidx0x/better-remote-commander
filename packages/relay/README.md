# brc-relay

Relay server for **Better Remote Commander** — the self-hosted bridge between AI clients (Claude, ChatGPT) and your
machines running [`brc-agent`](https://www.npmjs.com/package/brc-agent). One process, SQLite **or MongoDB**, your domain.

Doors it exposes:
- `/mcp` — remote MCP (Streamable HTTP) with OAuth 2.0 (PKCE, dynamic client registration) or API-key bearer auth
- `/admin`, `/device/verify`, `/auth/clients`, `/auth/apikeys` — browser dashboard: pair / pause / remove devices, OAuth clients, API keys, audit log
- `/ws` — agent WebSocket (agents connect outbound; nothing to open on their side)
- `recover_operation` — read-only MCP recovery of durably journaled operation outcomes and encrypted bounded results (same OAuth client, no replay). See [durable recovery](../../docs/durable-operation-recovery.md).

## Install & run

```bash
npm i -g brc-relay
PUBLIC_URL=https://brc.example.com BRC_ADMIN_PASSWORD=change-me BRC_SESSION_SECRET=random-string TRUST_PROXY=true brc-relay
```
Put it behind any HTTPS reverse proxy or tunnel that forwards WebSockets (Caddy, nginx, Cloudflare Tunnel, ngrok).
Docker Compose profiles for VPS / Cloudflare Tunnel / ngrok are in the repository.

### Easypanel Docker builds

The relay Dockerfile supports two build contexts. With the repository root as context, it builds the checked-out source directly. If Easypanel supplies only `packages/relay` instead, it fetches the public repository at the exact `GIT_SHA` build argument (which Easypanel supplies), then builds that revision. It checks the resulting commit hash and refuses a mismatch; no source files are taken from a misleading partial context. The image build therefore needs outbound HTTPS access to GitHub in the fallback case. `GIT_SHA` is optional for standalone builds without a GitHub source and defaults to `main` only when omitted.

Recommended Easypanel settings are **Build Path `/`** with **Dockerfile `packages/relay/Dockerfile`**. The alternative **Build Path `/packages/relay`** with **Dockerfile `Dockerfile`** also works using the fallback. Neither layout requires modifying the project source tree in Easypanel.

## Configuration

| Env | Meaning |
|---|---|
| `PUBLIC_URL` | exact public origin; drives OAuth issuer and pairing links |
| `PORT`, `HOST` | listen address (default 3000 / 0.0.0.0) |
| `TRUST_PROXY` | `true` behind a proxy/tunnel |
| `BRC_ADMIN_USER`, `BRC_ADMIN_PASSWORD` | dashboard login (single-user) |
| `BRC_SESSION_SECRET` | Stable random 32+ character secret for signed cookies and default durable-result encryption; preserve across redeploys |
| `BRC_DURABLE_RESULT_PAYLOADS` | Optional `0` disables encrypted result bodies while keeping pre-dispatch metadata receipts. Enabled by default when the stable secret is strong. |
| `BRC_RECOVERY_ENCRYPTION_KEY` | Optional separate stable 32+ character encryption secret; not required with an existing strong `BRC_SESSION_SECRET`. |
| `BRC_DB` | SQLite file (default `data/relay.sqlite`); used only when `MONGODB_URI` is absent |
| `MONGODB_URI` | **Optional** MongoDB connection string; when supplied, MongoDB is the sole persistent backend, no SQLite fallback |
| `MONGODB_DB` | Optional dedicated database name override (otherwise uses the database from the URI, or `brc_relay` if no database is specified) |

## Optional MongoDB persistence (Easypanel or self-hosted)

Use **either** SQLite **or** MongoDB. No second SQLite database or MongoDB cache is created
when MongoDB is selected. All persistent BRC accounts, OAuth clients/codes, access
and refresh tokens, device pairings, API keys, and private connection links are
stored natively in MongoDB. Recent tool activity and CMD logs remain RAM-only. A separate bounded durable
operation journal records pre-dispatch claims and, when a strong stable encryption
secret is configured, encrypted recovery payloads. This is not a full plaintext
command transcript or automatic command replay.

In **Easypanel -> better-remote -> Environment**, keep your existing
PUBLIC_URL, PORT, BRC_ADMIN_USER, BRC_ADMIN_PASSWORD, BRC_SESSION_SECRET and
add just:

```dotenv
MONGODB_URI=mongodb://<username>:<password>@<mongodb-internal-host>:27017/brc_relay?authSource=admin
# Optional override, only if the URI does not select the desired database:
MONGODB_DB=brc_relay
```

Use the actual MongoDB service host, database and credentials from your
deployment. Keep its data directory on its **own persistent volume**, and use
TLS for off-host connections. Percent-encode special characters in the URI.
With `MONGODB_URI` set, `BRC_DB` is ignored; omit `MONGODB_URI` to continue
using SQLite and the existing `BRC_DB=/data/relay.sqlite` volume.

**Startup safety:** If the MongoDB URI is configured but the server, permissions,
or indexes are unavailable, BRC fails startup rather than starting an empty
SQLite database. The `/health` endpoint reports `"storage":"mongodb"` and
checks MongoDB connectivity; a connection failure returns HTTP 503.
Database credentials are never included in BRC logs.

### Preserve existing SQLite registrations when switching

Changing the environment variable does **not** automatically copy existing
SQLite state. To keep **existing devices, OAuth clients, login IDs, API tokens
and private links**, migrate the old SQLite DB **before** pointing the live
relay at a fresh MongoDB database:

1. Back up your current persistent SQLite database and its WAL safely (stop the
   old relay or take a consistent SQLite backup). If the old ephemeral volume
   has already been deleted, BRC cannot reconstruct the missing credentials.
2. Make the backup accessible to a computer/container that can reach MongoDB.
   Use an **empty dedicated MongoDB database**.
3. From the repository root, after `pnpm build`, run:

```sh
BRC_DB=/path/to/backup/relay.sqlite MONGODB_URI='mongodb://USER:PASSWORD@HOST:27017/brc_relay?authSource=admin' pnpm --filter brc-relay migrate:sqlite-to-mongo --dry-run
BRC_DB=/path/to/backup/relay.sqlite MONGODB_URI='mongodb://USER:PASSWORD@HOST:27017/brc_relay?authSource=admin' pnpm --filter brc-relay migrate:sqlite-to-mongo
```

For PowerShell, set `$env:BRC_DB` and `$env:MONGODB_URI` separately,
then run `pnpm.cmd --filter brc-relay migrate:sqlite-to-mongo`.

The import is insert-only (does not overwrite MongoDB records), ignores
expired temporary credentials, and **never migrates activity/audit logs**.
If interrupted, inspect the destination before using `--resume`. Keep the
original backup for rollback. Use a dedicated BRC MongoDB database to avoid
mixing different products' records.

4. Keep your original **BRC_SESSION_SECRET** unchanged if you want existing
   signed admin sessions to remain valid. Set `MONGODB_URI` in Easypanel,
   redeploy, then verify `/health` includes `"storage":"mongodb"` and your
   paired devices still appear.

Your agent and MCP URLs do not change. A MongoDB database also needs persistent
storage and backups; selecting MongoDB alone cannot prevent data loss if the
MongoDB service is itself ephemeral.

## Connect clients

### One-click private URL (no OAuth callback)
1. Sign in to `https://your-relay.example/auth/links` (or click **Connect without OAuth** in the admin dashboard).
2. Name the connection, choose **read only** or **full access**, choose a 1/7/30/90-day, 1-year (365-day), or 2-year (730-day) expiry, and click **Generate private MCP URL**.
3. Copy the generated `https://your-relay.example/c/brc_link_<random-secret>/mcp` into any client that supports a custom **Streamable HTTP MCP** server with **No authentication**.
4. Revoke it from the same page when no longer needed. Expired links stop working automatically.

This skips the OAuth login/redirect flow **but is not public anonymous access**. The URL itself is a 256-bit bearer credential: anyone holding it can use the permitted tools. The raw secret is shown once, only its SHA-256 hash is stored in the selected relay database (SQLite or MongoDB), and no per-call activity records are saved. Treat the URL like a password, never place it in issues/screenshots/logs, and do not expose the relay's port 3000 over unencrypted HTTP. Reverse proxies and hosting providers can independently log URL paths; configure their access-log redaction or disable access logging. New connections require the user's authenticated admin session and CSRF token.

### Repair OAuth for any wrapper you trust

BRC accepts dynamic OAuth client registrations from clients that implement DCR. Other
wrappers may save a `client_id` that becomes unknown after a relay redeployment,
or they may supply an HTTPS callback that has never been registered. Instead of
a raw `invalid_client` error, such valid PKCE requests now show a
**Review and approve callback** page.

1. Open the wrapper's original `https://your-relay.example/authorize?...` link.
2. Click **Review and approve callback**. Sign in to BRC.
3. Confirm the exact callback domain and tick the trust checkbox.
4. Click **Approve callback and continue**. BRC preserves the original client ID,
   registers the exact callback, and continues the original OAuth request.

Alternatively, open `/auth/clients` yourself and use **Option A** to paste the
full `/authorize` URL or **Option B** to enter a client ID plus a callback URL.
Any HTTPS callback you explicitly trust is allowed; localhost HTTP is also
supported for native apps. OAuth still requires PKCE S256 and the normal
authorization consent. A new callback for an existing ID needs separate approval.

**Important:** If using SQLite, persist `/data` as an Easypanel volume. The file
`/data/relay.sqlite` contains OAuth clients, accounts, tokens and device pairings;
without a persistent volume, Docker recreation can erase them. Alternatively,
configure MongoDB as described below, with **persistent storage on the MongoDB service**.
Do not disable Cloudflare HTTPS proxy or remove OAuth redirect validation to fix a stale client ID.

**Existing OAuth remains available** and is appropriate for clients requiring it:
- **Claude**: Settings → Connectors → add `https://your-relay.example/mcp` → sign in → Allow
- **ChatGPT (MCP)**: same normal OAuth endpoint.

Not every MCP host supports a no-auth remote HTTP URL or suppresses OAuth. This option works in clients that support it; it cannot force unrelated AI products to bypass their own connection policies.

### Fewer MCP calls: preferred tool choices

The relay's MCP initialization instructions and the tool descriptions both
recommend the cheapest safe operation for the task. The source of truth is
`packages/agent/src/tool-routing.ts`: every agent tool has a concise,
explicit `USE WHEN` and `USE INSTEAD` rule plus any critical evidence caveat.
The relay uses these reviewed rules for all 70 tools even if an older local
agent reconnects with misleading descriptions. JSON input schemas, permissions,
and execution remain unchanged. Tests fail if any advertised tool lacks a
routing rule.
 For 2+ known file paths,
`read_multiple_files` reads them in one MCP call (internal concurrency: 8).
Use `read_file` for one file, `read_code_ranges` for multi-file code snippets
with hashes, and `start_search(wait=true)` when filenames are not yet known.
Use `batch_tools` for mixed independent read/context operations and
`workspace_batch` for coordinated edits, readback and real checks. Avoid
starting a shell/REPL solely to inspect files.

Existing full-access MCP clients retain every tool. Read-only capability URLs
can now also invoke `batch_tools`, but the relay checks **every nested tool**
against its read-only allowlist before dispatch. Writes, terminal commands and
nested batches are rejected. The model/host still makes the final tool
selection; BRC cannot force an unsupported LLM to batch.

The bundled descriptions take priority over stale hints from an older local
agent, while live device schemas and permissions are still enforced. Refresh
the MCP connector after deployment if your AI host has cached old tools.

### OAuth says the PC is offline after the agent restarts

Closing the agent does **not** revoke an OAuth authorization. Reopening the
agent with its saved `device.json` reconnects the **same paired device ID**
and the same owner; the MCP client's existing access/refresh tokens continue
working. Do **not** re-pair the device or create another OAuth client on each
restart. The MongoDB integration test exercises the full sequence: OAuth
authorization, `list_devices`, a file call, agent disconnect, reconnect, and
the same OAuth access token performing another file call.

If `list_devices` reports `no_devices_for_oauth_account`, the OAuth
authorization belongs to a BRC account without that paired PC. Reauthorize
the OAuth connector **once**, signed into the same BRC account you used to
approve the device pairing. Never bypass ownership checks or automatically
assign an online computer to an arbitrary OAuth token. If it reports
`paired_device_offline`, that account does have paired devices but they
haven't connected (or were disconnected). If `paused`, resume the device
in the admin dashboard.

If the relay homepage shows the PC online but the OAuth tool sees none,
compare `relayInstance` in `/health` and the MCP `list_devices` result.
They must match. **The live WebSocket hub is held in each relay process's
RAM; MongoDB only persists authentication and pairing.** Two load-balanced
Easypanel replicas can route the PC's WebSocket to one process and MCP
requests to another, causing exactly this symptom. Run **one relay replica**
for this lightweight deployment (or implement an explicit shared call router
before scaling out). Never disable OAuth or route across users to mask
the problem. The instance IDs are temporary diagnostic identifiers, not
credentials or persisted logs.

Older BRC installs may intentionally keep their pairing under
`~/.ses-rdp/device.json` until moved; deleting that file forces a
new pairing. Don't clear a valid saved token just to restart the agent.

### Fix for clients seeing only `list_devices`

Earlier relay versions populated `tools/list` only with tools from devices that
were online **at the moment the AI host connected**. Some clients cache that
initial result, even if the agent reconnects later. The relay now includes a
generated **stable catalog of the 70 agent tools**, and overrides schemas from
the running agent when available. Authentication, owner/device routing and
pause/online checks are always performed at invocation time. Advertising an
offline tool does not make it executable while the agent is offline.

After deploying the fix, check `https://your-relay.example/health` for
`"mcpTools":71` (70 agent tools plus `list_devices`).
**An AI client with an old cached one-tool list must refresh its MCP connector
or remove/re-add that connection once.** Restarting the Windows agent alone
cannot change a tool list that the AI host has already cached.

Maintainers: after changing agent tool definitions, run `pnpm build` followed
by `pnpm catalog:update`, and commit
`packages/relay/src/mcp/agent-tools.catalog.ts`. CI runs
`pnpm catalog:check` to detect stale snapshots. This catalog is a static
schema (about 125 KiB), not a project index, user database, or activity log.

Full docs: https://github.com/shahidx0x/better-remote-commander · License MIT.
