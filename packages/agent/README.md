# brc-agent

Device agent for **Better Remote Commander** — self-hosted remote control of your computers from Claude and ChatGPT.
Runs on the machine you want to control and connects *outbound* to your own `brc-relay`. Exposes files, terminal and
processes and coding workflows (67 tools, including BRC-native tools) to any AI client authorized on the relay.

## Install

```bash
npm i -g brc-agent
```
Requires Node.js 22.13+ (Windows, macOS, Linux).

## Pair with your relay

```bash
brc-agent
# In a local source checkout on Windows: START_AGENT.cmd
```
On a foreground terminal, first launch asks for the relay URL and device name, then displays pairing instructions. Approve the code on your relay. Credentials are saved in `~/.brc/device.json`; later foreground launches automatically connect after four seconds. Enter connects immediately; M opens settings instead. M is also available while running and idle, without waiting for another log or restarting. Change keeps the old pairing until approval succeeds. Forget confirms before deleting only the local pairing; it does not revoke the old relay device.

Use `SETUP_AGENT.cmd` or `--setup` to open settings directly without the auto-connect timer. The live menu can return to the same connection; active tool calls are not interrupted. Scripted `--relay <base-url>` startup still works. Stop an existing foreground agent/service before opening another instance.

## Start at login

```bash
brc-agent --install-service      # Windows Task Scheduler / systemd --user / launchd
brc-agent --uninstall-service
```

## Options

| Flag / env | Meaning |
|---|---|
| `--relay <url>` / `BRC_RELAY` | relay base URL |
| `--name <name>` / `BRC_NAME` | device name shown in clients (default: hostname) |
| `--allow-dir <path>` (repeatable) | restrict file tools to these directories |
| `--no-browser` | print the pairing URL instead of opening it |
| `--auto-connect` | foreground launcher default: four-second saved reconnect, with M settings shortcut |
| `--setup` | open the URL/connect/change/forget menu; ignore connection overrides for this run |
| `--forget-relay` / `--logout` | forget only the locally saved URL/token and exit |
| `--non-interactive` | never prompt; use saved pairing or explicit connection arguments |
| `--debug` / `BRC_DEBUG=1` | extra live diagnostics; tool status is already visible by default |
| `BRC_TOOL_PROFILE=coding` | hide document/transfer/history tools from discovery |
| `BRC_HOME` | state directory (default `~/.brc`) |

## Docs

Full project, relay setup (Docker, Cloudflare Tunnel, VPS) and security notes:
https://github.com/shahidx0x/better-remote-commander

License MIT. Tool core derived from [Desktop Commander MCP](https://github.com/wonderwhy-er/DesktopCommanderMCP) (MIT).

## Local source build and diagnostics

From the repository root, run `pnpm install`, `pnpm build`, then `START_AGENT.cmd` on Windows or `node packages/agent/dist/cli.js`. No global install is needed. Tool status is visible by default and diagnostics are never persisted. See `docs/coding-agent.md` in the repository for the new coding tools, live-only logging, limits and service migration.

## Faster batches, infrastructure and images

See [the fast-agent guide](../../docs/fast-agent.md) for 64-call read waves/write barriers, combined workspace edits/readback/checks, Docker observation, actual image previews, optional restricted execution, automatic cache eviction and `pnpm bench:io`. Diagnostics remain live-only. These tools do not add another model or a graph database.
