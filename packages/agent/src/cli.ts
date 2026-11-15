#!/usr/bin/env node
/**
 * BRC agent CLI.
 *   brc-agent --relay https://rdp.example.com [--name "My PC"] [--no-browser] [--debug]
 *   brc-agent --logout                 remove saved credentials
 *   brc-agent --relay <url> --token <t> --device-id <id>   (dev: skip pairing, pre-issued token)
 * Env: BRC_RELAY, BRC_NAME, BRC_TOKEN, BRC_DEVICE_ID, BRC_HOME, BRC_DEBUG
 */
import os from 'node:os';
import { listenForTerminalShortcuts } from './terminal-shortcuts.js';
import { createTerminalPrompts, resolveStartupConnection, shouldPromptForConnection, type ConnectionOptions } from './terminal-setup.js';
import { startResourceMaintenance, stopResourceMaintenance } from './runtime/resource-limits.js';
import { applyLegacyEnv } from 'brc-shared';
applyLegacyEnv();
import { WsClient } from './transport/ws-client.js';
import { pairDevice, loadCredentials, clearCredentials, type DeviceCredentials } from './transport/pairing.js';
import { callTool, listTools } from './dispatcher.js';
import { VERSION as CORE_VERSION } from './core/version.js';
import { setCurrentClient } from './context.js';
import { activity } from './runtime/activity.js';
import { projectIndex } from './runtime/project-index.js';
import { codeGraph } from './runtime/code-graph.js';
import { clearCodeCache } from './runtime/code-structure.js';

const AGENT_VERSION = '2.0.5';

function arg(name: string, env?: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return (env && process.env[env]) || def;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const debug = flag('debug') || process.env.BRC_DEBUG === '1';
if (debug) process.env.BRC_DEBUG = '1';
const log = (level: 'info' | 'warn' | 'error' | 'debug', msg: string) => activity.log(level, msg);
if (flag('help')) {
  console.log('Local agent: START_AGENT.cmd or node packages/agent/dist/cli.js\nFirst terminal launch asks for the relay URL and device name. Saved connections start automatically after 4 seconds; Enter connects now, M opens settings.\n--setup opens settings explicitly. M also opens settings while the foreground agent is idle; active tool calls are never interrupted.\n--forget-relay / --logout forget only the local saved URL and pairing, then exit.\n--relay <base-url> keeps scripted pairing available; --non-interactive skips the menu and delay. --auto-connect is the foreground default.\nOther flags: --name <name>, --no-browser, --allow-dir <path> (repeatable), --debug, --install-service, --uninstall-service.\nTool START/OK/ERROR status is visible by default. Live-only logging: no log files or persisted tool history.');
  process.exit(0);
}

if (flag('logout') || flag('forget-relay')) {
  try {
    console.log(clearCredentials() ? 'Saved relay URL and local pairing forgotten. Projects and settings were not changed.' : 'No saved relay or pairing.');
    console.log('This does not revoke the device on the old relay. Remove it there separately when needed.');
    if (process.env.BRC_RELAY || process.env.BRC_TOKEN) console.log('BRC_RELAY/BRC_TOKEN environment values are unchanged. Use --setup for a new interactive connection, or update those values.');
    process.exit(0);
  } catch {
    console.error('Could not forget the saved pairing. Check permissions on the agent state directory.');
    process.exit(1);
  }
}
if (flag('install-service') || flag('uninstall-service')) {
  const { installService, uninstallService } = await import('./service.js');
  try {
    if (flag('uninstall-service')) { console.log(uninstallService()); process.exit(0); }
    if (!loadCredentials()) { console.error('Pair first: run the agent once interactively with --relay <url>, then --install-service.'); process.exit(2); }
    // Service uses saved credentials; only pass through policy/debug flags.
    const keep = new Set(['--debug', '--allow-dir']);
    const passthrough: string[] = [];
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
      if (!keep.has(argv[i])) continue;
      passthrough.push(argv[i]);
      if (argv[i] === '--allow-dir' && argv[i + 1]) passthrough.push(argv[++i]);
    }
    console.log(installService(passthrough));
  } catch (e) { console.error(`Service setup failed: ${e instanceof Error ? e.message : String(e)}`); process.exit(1); }
  process.exit(0);
}

// --allow-dir <path> (repeatable): restrict tools to these directories (agent-side policy, persisted in config)
const allowDirs = process.argv.flatMap((a, i, all) => (a === '--allow-dir' && all[i + 1] ? [all[i + 1]] : []));
if (allowDirs.length) {
  const { configManager } = await import('./core/config-manager.js');
  await configManager.setValue('allowedDirectories', allowDirs);
  console.log(`allowedDirectories set to: ${allowDirs.join(', ')}`);
}

const connection: ConnectionOptions = {
  interactive: !!process.stdin.isTTY && !!process.stdout.isTTY,
  setup: flag('setup'), autoConnect: flag('auto-connect'), nonInteractive: flag('non-interactive'),
  relay: arg('relay', 'BRC_RELAY'), token: arg('token', 'BRC_TOKEN'),
  deviceId: arg('device-id', 'BRC_DEVICE_ID'), name: arg('name', 'BRC_NAME', os.hostname())!,
  noBrowser: flag('no-browser'),
};
const startupAbort = new AbortController();
connection.signal = startupAbort.signal;
const stopStartup = () => startupAbort.abort(new DOMException('Startup cancelled.', 'AbortError'));
process.once('SIGINT', stopStartup);
process.once('SIGTERM', stopStartup);
let prompts: ReturnType<typeof createTerminalPrompts> | undefined;
let creds: DeviceCredentials | null = null;
let startupExitCode = 0;
try {
  await activity.start().catch(() => console.error('Could not remove an old diagnostic file; live logging remains enabled.'));
  // Delay opening readline until a real menu is requested; it must not compete with startup shortcuts.
  const getPrompts = () => prompts ??= createTerminalPrompts(process.stdin, process.stdout, startupAbort.signal);
  const lazyPrompts = shouldPromptForConnection(connection) ? {
    ask: (message: string) => getPrompts().ask(message),
    write: (message: string) => getPrompts().write(message),
    get signal() { return prompts?.signal ?? startupAbort.signal; },
  } : undefined;
  creds = await resolveStartupConnection(connection, lazyPrompts);
} catch (error) {
  if (!startupAbort.signal.aborted && !prompts?.signal?.aborted) {
    console.error(`Startup: ${error instanceof Error ? error.message : 'Connection setup failed.'}`);
    startupExitCode = 2;
  }
} finally {
  prompts?.close();
  process.removeListener('SIGINT', stopStartup);
  process.removeListener('SIGTERM', stopStartup);
}
if (!creds) {
  await activity.close();
  process.exit(startupExitCode);
}
await startResourceMaintenance();
setCurrentClient({ name: 'brc-agent', version: AGENT_VERSION });
const tools = listTools();
console.log(`brc-agent ${AGENT_VERSION} (core ${CORE_VERSION}) - ${tools.length} tools - "${creds.name}" [${creds.deviceId}] -> ${creds.relayUrl}`);

const runningAbort = new AbortController();
const foregroundControls = !connection.nonInteractive && (connection.interactive || connection.autoConnect);
const settingsHint = process.stdin.isTTY ? 'M = settings | Ctrl+C = stop' : 'M + Enter = settings | Ctrl+C = stop';
let activeCredentials: DeviceCredentials = creds;
let client: WsClient;
let shortcuts: ReturnType<typeof listenForTerminalShortcuts> | undefined;
let livePrompts: ReturnType<typeof createTerminalPrompts> | undefined;
let settingsOpen = false;
let shuttingDown = false;

function armShortcuts(): void {
  shortcuts?.close();
  shortcuts = undefined;
  if (!foregroundControls || shuttingDown || settingsOpen || process.stdin.destroyed || process.stdin.readableEnded) return;
  shortcuts = listenForTerminalShortcuts(process.stdin, choice => {
    if (choice === 'settings') void openSettings();
    else if (choice === 'exit') shutdown('Ctrl+C');
  }, { signal: runningAbort.signal });
}

function start(c: DeviceCredentials): void {
  activeCredentials = c;
  const nextClient: WsClient = new WsClient({
    relayUrl: c.relayUrl, token: c.deviceToken, deviceId: c.deviceId, name: c.name,
    agentVersion: AGENT_VERSION, coreVersion: CORE_VERSION, tools, callTool, log,
    onUnauthorized: async () => {
      if (shuttingDown || client !== nextClient) return true;
      if (c.pairedAt === 'manual' || !foregroundControls || settingsOpen) return false;
      settingsOpen = true;
      shortcuts?.close(); shortcuts = undefined;
      try {
        log('warn', 'Relay rejected the device token; re-pairing');
        const fresh = await pairDevice({ relayUrl: c.relayUrl, name: c.name, deviceId: c.deviceId, openBrowser: !connection.noBrowser, log: message => console.log(message), signal: runningAbort.signal });
        if (shuttingDown || client !== nextClient) return true;
        nextClient.stop();
        start(fresh);
        return true;
      } finally {
        settingsOpen = false;
        armShortcuts();
      }
    },
  });
  client = nextClient;
  client.start();
}

async function openSettings(): Promise<void> {
  if (settingsOpen || shuttingDown) return;
  if (!client.pauseForSettings()) {
    log('info', 'Tools are still running. Press M again when idle; no work was interrupted.');
    return;
  }
  const pausedClient = client;
  settingsOpen = true;
  shortcuts?.close(); shortcuts = undefined;
  const resumeLogs = activity.pauseConsole();
  let forgotten = false;
  try {
    livePrompts = createTerminalPrompts(process.stdin, process.stdout, runningAbort.signal);
    livePrompts.write('Connection settings: new tool calls are paused; the relay connection stays alive.');
    const next = await resolveStartupConnection({
      ...connection, setup: true, autoConnect: false, returnToAgent: true,
      relay: undefined, token: undefined, deviceId: undefined, signal: runningAbort.signal,
    }, livePrompts, {
      load: () => loadCredentials() ?? activeCredentials,
      clear: () => { const removed = clearCredentials(); forgotten = true; return removed; },
      pair: pairDevice,
    });
    if (shuttingDown) return;
    if (!next && forgotten) {
      shutdown('Saved connection forgotten');
      return;
    }
    if (next && (next.relayUrl !== activeCredentials.relayUrl || next.deviceId !== activeCredentials.deviceId || next.deviceToken !== activeCredentials.deviceToken)) {
      pausedClient.stop();
      start(next);
    }
  } catch (error) {
    if (!shuttingDown) console.error(`Settings: ${error instanceof Error ? error.message : 'Connection setup failed.'}`);
    if (forgotten && !shuttingDown) shutdown('Saved connection forgotten');
  } finally {
    livePrompts?.close(); livePrompts = undefined;
    pausedClient.resumeAfterSettings();
    settingsOpen = false;
    resumeLogs();
    if (!shuttingDown) {
      console.log(`Back to live logs. ${settingsHint}`);
      armShortcuts();
    }
  }
}

function shutdown(reason: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  shortcuts?.close(); shortcuts = undefined;
  console.log(`\n${reason}; stopping agent`);
  runningAbort.abort();
  livePrompts?.close();
  stopResourceMaintenance();
  client?.stop();
  projectIndex.close();
  codeGraph.clear();
  clearCodeCache();
  const exit = () => process.exit(0);
  const timer = setTimeout(exit, 1500);
  import('./core/config-manager.js')
    .then(({ configManager }) => Promise.all([configManager.close(), activity.close()]))
    .catch(() => {})
    .finally(() => { clearTimeout(timer); setTimeout(exit, 50); });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
start(creds);
if (foregroundControls) {
  console.log(settingsHint);
  armShortcuts();
}
