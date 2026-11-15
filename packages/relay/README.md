# brc-relay

Relay server for **Better Remote Commander** — the self-hosted bridge between AI clients (Claude, ChatGPT) and your
machines running [`brc-agent`](https://www.npmjs.com/package/brc-agent). One process, SQLite, your domain.

Doors it exposes:
- `/mcp` — remote MCP (Streamable HTTP) with OAuth 2.0 (PKCE, dynamic client registration) or API-key bearer auth
- `/admin`, `/device/verify`, `/auth/clients`, `/auth/apikeys` — browser dashboard: pair / pause / remove devices, OAuth clients, API keys, audit log
- `/ws` — agent WebSocket (agents connect outbound; nothing to open on their side)

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
| `BRC_SESSION_SECRET` | cookie signing secret |
| `BRC_DB` | SQLite file (default `data/relay.sqlite`) |

## Connect clients

### One-click private URL (no OAuth callback)
1. Sign in to `https://your-relay.example/auth/links` (or click **Connect without OAuth** in the admin dashboard).
2. Name the connection, choose **read only** or **full access**, choose 1/7/30/90-day expiry, and click **Generate private MCP URL**.
3. Copy the generated `https://your-relay.example/c/brc_link_<random-secret>/mcp` into any client that supports a custom **Streamable HTTP MCP** server with **No authentication**.
4. Revoke it from the same page when no longer needed. Expired links stop working automatically.

This skips the OAuth login/redirect flow **but is not public anonymous access**. The URL itself is a 256-bit bearer credential: anyone holding it can use the permitted tools. The raw secret is shown once, only its SHA-256 hash is stored in the relay's operational SQLite database, and no per-call activity records are saved. Treat the URL like a password, never place it in issues/screenshots/logs, and do not expose the relay's port 3000 over unencrypted HTTP. Reverse proxies and hosting providers can independently log URL paths; configure their access-log redaction or disable access logging. New connections require the user's authenticated admin session and CSRF token.

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

**Important:** Persist `/data` as an Easypanel volume. The SQLite file
`/data/relay.sqlite` contains the registered OAuth clients, accounts,
tokens and device pairing. Without persistent storage, Docker image recreation
can erase those registrations. Do not disable Cloudflare HTTPS proxy or remove
OAuth redirect validation to fix a stale client ID.

**Existing OAuth remains available** and is appropriate for clients requiring it:
- **Claude**: Settings → Connectors → add `https://your-relay.example/mcp` → sign in → Allow
- **ChatGPT (MCP)**: same normal OAuth endpoint.

Not every MCP host supports a no-auth remote HTTP URL or suppresses OAuth. This option works in clients that support it; it cannot force unrelated AI products to bypass their own connection policies.

Full docs: https://github.com/shahidx0x/better-remote-commander · License MIT.
