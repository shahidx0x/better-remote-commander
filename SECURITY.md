# Security

## Model
- The agent runs with the permissions of the user who started it. Anything that user can do, an authenticated AI client can do on that machine (within `allowedDirectories` and outside `blockedCommands`).
- The relay never sees device tokens or user passwords in plaintext (SHA-256 / scrypt). OAuth access tokens live 1 h, refresh tokens 30 d and rotate on use.
- Agents only make outbound connections. The relay is the only thing that needs a public endpoint.
- Per-call audit log: tool name, args hash, device, client, result, latency. Arguments and outputs are never stored.

## Defaults you should keep
- `BRC_ADMIN_PASSWORD` strong; `BRC_SESSION_SECRET` random (32+ bytes)
- `PUBLIC_URL` must be `https://` in any real deployment (HSTS + secure cookies switch on automatically)
- Login: 5 failures per IP+user -> 5 min lock. Consent is required per OAuth client.
- Agent: `--allow-dir` to restrict file access; pause a device from `/admin` when you do not need it

## Threat notes
- A compromised AI client session = shell on paused-off devices only. Revoke: `/admin` -> Delete device (closes the socket, invalidates the token) or `/auth/clients` -> Delete client (revokes its tokens).
- The PKCE shim (`auth/pkce-compat.ts`) applies only to confidential clients that authenticate with a secret at `/token`; public clients must use S256 PKCE.
- Quick tunnels (`trycloudflare.com`, random ngrok URLs) are for testing: the hostname changes on restart and OAuth clients registered against it become invalid.

## Reporting
Open a private issue or email the maintainer. Please include relay version (`/health`) and steps to reproduce.
