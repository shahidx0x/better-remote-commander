# brc-agent

Device agent for **Better Remote Commander** — self-hosted remote control of your computers from Claude and ChatGPT.
Runs on the machine you want to control and connects *outbound* to your own `brc-relay`. Exposes files, terminal and
processes (24 tools, same tool set as Desktop Commander) to any AI client authorized on the relay.

## Install

```bash
npm i -g brc-agent
```
Requires Node.js 22.13+ (Windows, macOS, Linux).

## Pair with your relay

```bash
brc-agent --relay https://brc.example.com --name "My PC"
```
The agent prints a pairing code and opens `https://brc.example.com/device/verify`. Sign in to the relay and approve.
Credentials are saved in `~/.brc/device.json`; later runs just need `brc-agent`.

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
| `--logout` | remove saved credentials |
| `--debug` / `BRC_DEBUG=1` | log every tool call |
| `BRC_HOME` | state directory (default `~/.brc`) |

## Docs

Full project, relay setup (Docker, Cloudflare Tunnel, VPS) and security notes:
https://github.com/shahidx0x/better-remote-commander

License MIT. Tool core derived from [Desktop Commander MCP](https://github.com/wonderwhy-er/DesktopCommanderMCP) (MIT).
