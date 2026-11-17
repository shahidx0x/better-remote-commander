#!/usr/bin/env node
/**
 * BRC agent CLI.
 *   brc-agent --relay https://rdp.example.com [--name "My PC"] [--no-browser] [--debug]
 *   brc-agent                          interactive: first run asks for the relay URL; a saved connection auto-connects after 4 s (Enter = now, M = settings)
 *   brc-agent --setup                  open the connection settings menu
 *   brc-agent --forget-relay | --logout   forget the saved relay URL and local pairing, then exit
 *   brc-agent --non-interactive        never prompt or wait (used by the background service)
 *   brc-agent --compact | --verbose    console style (default: compact on a terminal)
 *   brc-agent --relay <url> --token <t> --device-id <id>   (dev: skip pairing, pre-issued token)
 *   brc-agent --install-service | --uninstall-service       run as a background service (saved credentials)
 *   brc-agent --no-plugins             run without plugin set-up (no default plugin installs this run)
 *
 * Plugins (each prints a result and exits):
 *   brc-agent --list-plugins
 *   brc-agent --add-plugin <id>        re-add a default plugin (playwright, computer-use, ast-grep, rtk, serena, markitdown)
 *   brc-agent --add-plugin <id> --npm <pkg>@<ver> | --pypi <pkg>==<ver> | --command "<cmd> <args...>" | --url <https url>
 *                                      [--env KEY=VALUE ...] [--name "<display name>"]
 *   brc-agent --remove-plugin <id>
 *   brc-agent --enable-plugin <id> | --disable-plugin <id>
 *   brc-agent --update-plugins         latest versions for the default plugins, then reinstall them
 * Env: BRC_RELAY, BRC_NAME, BRC_TOKEN, BRC_DEVICE_ID, BRC_HOME, BRC_DEBUG, BRC_PLUGINS=none (same as --no-plugins)
 */
import os from 'node:os';
import { applyLegacyEnv } from 'brc-shared';
applyLegacyEnv();
import { WsClient } from './transport/ws-client.js';
import { pairDevice, loadCredentials, clearCredentials, type DeviceCredentials } from './transport/pairing.js';
import { callTool, listTools } from './dispatcher.js';
import { VERSION as CORE_VERSION } from './core/version.js';
import { setCurrentClient } from './context.js';
import { activity } from './runtime/activity.js';
import { listenForTerminalShortcuts } from './terminal-shortcuts.js';
import { createTerminalPrompts, resolveStartupConnection, shouldPromptForConnection, type ConnectionOptions } from './terminal-setup.js';
import { consoleBanner, controlHint, connectionPanel, recentActivity, type AgentTerminal } from './terminal-ui.js';

const AGENT_VERSION = '2.0.13';

function arg(name: string, env?: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return (env && process.env[env]) || def;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const debug = flag('debug') || process.env.BRC_DEBUG === '1';
if (debug) process.env.BRC_DEBUG = '1';
if (flag('verbose') || debug) activity.setConsoleMode('verbose');
else if (flag('compact')) activity.setConsoleMode('compact');
const log = (level: 'info' | 'warn' | 'error' | 'debug', msg: string) => activity.log(level, msg);

if (flag('help')) {
  console.log([
    'brc-agent [options]',
    '  (no options)           first run asks for the relay URL; a saved connection auto-connects after 4 s (Enter = now, M = settings)',
    '  --relay <base-url>     scripted pairing (no menu); --name <name>, --no-browser',
    '  --token <t> --device-id <id>   skip pairing with a pre-issued token (needs --relay)',
    '  --setup                open the connection settings menu',
    '  --forget-relay|--logout   forget the saved relay URL and local pairing, then exit',
    '  --non-interactive      never prompt or wait; use saved credentials or --relay',
    '  --allow-dir <path>     restrict tools to a directory (repeatable)',
    '  --compact | --verbose | --debug   console detail',
    '  --install-service [--service-log] | --uninstall-service   run in the background (--service-log keeps an agent.log)',
    '  --list-plugins | --add-plugin <id> | --remove-plugin <id> | --enable-plugin <id> | --disable-plugin <id> | --update-plugins | --no-plugins',
    'While running in a terminal: M settings, S status, L recent activity, V compact/verbose, ? help, Ctrl+C stop.',
    'Diagnostics are live-only: no tool history or activity log is written to disk.',
  ].join('\n'));
  process.exit(0);
}

if (flag('logout') || flag('forget-relay')) {
  try {
    console.log(clearCredentials() ? 'Saved relay URL and local pairing forgotten. Projects and settings were not changed.' : 'No saved relay or pairing.');
    console.log('This does not revoke the device on the old relay; remove it there separately.');
    if (process.env.BRC_RELAY || process.env.BRC_TOKEN) console.log('BRC_RELAY/BRC_TOKEN environment values are unchanged.');
    process.exit(0);
  } catch {
    console.error('Could not forget the saved pairing. Check permissions on the agent state directory.');
    process.exit(1);
  }
}
if (process.argv.some((a) => /^--(list-plugins|add-plugin|remove-plugin|enable-plugin|disable-plugin|update-plugins)$/.test(a))) {
  const { runPluginCommand } = await import('./plugins/cli-commands.js');
  const code = await runPluginCommand(process.argv.slice(2), debug);
  if (code !== null) process.exit(code);
}
if (flag('install-service') || flag('uninstall-service')) {
  const { installService, uninstallService } = await import('./service.js');
  try {
    if (flag('uninstall-service')) { console.log(uninstallService()); process.exit(0); }
    if (!loadCredentials()) { console.error('Pair first: run the agent once interactively (or with --relay <url>), then --install-service.'); process.exit(2); }
    // Service uses saved credentials; only pass through policy/debug flags.
    const keep = new Set(['--debug', '--allow-dir', '--no-plugins']);
    const passthrough: string[] = [];
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
      if (!keep.has(argv[i])) continue;
      passthrough.push(argv[i]);
      if (argv[i] === '--allow-dir' && argv[i + 1]) passthrough.push(argv[++i]);
    }
    console.log(installService(passthrough, flag('service-log')));
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

const ambientEnv = (explicitFlag: string) => !(flag('auto-connect') && !flag('non-interactive') && !process.argv.includes(explicitFlag));
const connection: ConnectionOptions = {
  interactive: !!process.stdin.isTTY && !!process.stdout.isTTY,
  setup: flag('setup'), autoConnect: flag('auto-connect'), nonInteractive: flag('non-interactive'),
  // In the interactive --auto-connect flow the saved pairing is authoritative: a stale BRC_RELAY/BRC_TOKEN in the environment
  // must not silently restore a server the user changed or forgot. Explicit --relay/--token/--device-id flags still win.
  relay: arg('relay', ambientEnv('--relay') ? 'BRC_RELAY' : undefined), token: arg('token', ambientEnv('--token') ? 'BRC_TOKEN' : undefined), deviceId: arg('device-id', ambientEnv('--device-id') ? 'BRC_DEVICE_ID' : undefined),
  name: arg('name', 'BRC_NAME', os.hostname())!,
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
  // readline is opened only when a menu is actually needed, so it never competes with shortcuts.
  const getPrompts = () => (prompts ??= createTerminalPrompts(process.stdin, process.stdout, startupAbort.signal));
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

const { registerInstaller } = await import('./plugins/installer.js');
registerInstaller();
const pluginsOff = flag('no-plugins') || (process.env.BRC_PLUGINS ?? '').toLowerCase() === 'none';
setCurrentClient({ name: 'brc-agent', version: AGENT_VERSION });
const tools = listTools();
const terminalInfo: AgentTerminal = { name: creds.name, relay: creds.relayUrl, deviceId: creds.deviceId, version: AGENT_VERSION, coreVersion: CORE_VERSION, tools: tools.length };
const visualConsole = !!process.stdout.isTTY && !connection.nonInteractive;
console.log(visualConsole ? consoleBanner(terminalInfo) : `brc-agent ${AGENT_VERSION} (core ${CORE_VERSION}) - ${tools.length} tools - "${creds.name}" [${creds.deviceId}] -> ${creds.relayUrl}`);

// Default plugins: set up in the background once the relay connection is up (or after 10 s
// without one), so plugin installs never delay connecting. Later starts only check files on disk.
let pluginSetupStarted = false;
const startPluginSetup = () => {
  if (pluginSetupStarted || pluginsOff) return;
  pluginSetupStarted = true;
  import('./plugins/first-run.js')
    .then(({ ensureDefaultPlugins }) => ensureDefaultPlugins(log))
    .then((r) => { if (r.queued.length) void r.done.then(() => log('info', 'plugins: background set-up finished')); })
    .catch((e) => log('warn', `plugin set-up failed: ${e instanceof Error ? e.message : String(e)}`));
};
if (!pluginsOff) setTimeout(startPluginSetup, 10_000).unref();

const runningAbort = new AbortController();
const foregroundControls = !connection.nonInteractive && (connection.interactive || !!connection.autoConnect);
const settingsHint = controlHint(!!process.stdin.isTTY);
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
  shortcuts = listenForTerminalShortcuts(process.stdin, (choice) => {
    if (choice === 'settings') void openSettings();
    else if (choice === 'status') console.log(connectionPanel(client.status(), { ...terminalInfo, name: activeCredentials.name, relay: activeCredentials.relayUrl }));
    else if (choice === 'activity') console.log(recentActivity(activity.recent(), 10));
    else if (choice === 'verbose') {
      activity.setConsoleMode(activity.getConsoleMode() === 'compact' ? 'verbose' : 'compact');
      console.log('  Console mode: ' + activity.getConsoleMode());
    } else if (choice === 'help') console.log(settingsHint);
    else if (choice === 'exit') shutdown('Ctrl+C');
  }, { signal: runningAbort.signal, liveCommands: true });
}

function start(c: DeviceCredentials): void {
  activeCredentials = c;
  const next: WsClient = new WsClient({
    relayUrl: c.relayUrl, token: c.deviceToken, deviceId: c.deviceId, name: c.name,
    agentVersion: AGENT_VERSION, coreVersion: CORE_VERSION, tools, callTool, log,
    onConnected: () => { if (!pluginSetupStarted) setImmediate(startPluginSetup); },
    onUnauthorized: async () => {
      if (shuttingDown || client !== next) return true;
      if (c.pairedAt === 'manual') return false;
      log('warn', 'Relay rejected our device token; re-pairing');
      // The old pairing is replaced only when the new one is approved (pairDevice saves it).
      const fresh = await pairDevice({ relayUrl: c.relayUrl, name: c.name, deviceId: c.deviceId, openBrowser: !connection.noBrowser, log: (m) => console.log(m), signal: runningAbort.signal });
      if (shuttingDown || client !== next) return true;
      next.stop();
      start(fresh);
      return true;
    },
  });
  client = next;
  client.start();
}

async function openSettings(): Promise<void> {
  if (settingsOpen || shuttingDown) return;
  if (!client.pauseForSettings()) { log('info', 'Tools are still running. Press M again when idle; no work was interrupted.'); return; }
  const paused = client;
  settingsOpen = true;
  shortcuts?.close(); shortcuts = undefined;
  const resumeLogs = activity.pauseConsole();
  let forgotten = false;
  try {
    livePrompts = createTerminalPrompts(process.stdin, process.stdout, runningAbort.signal);
    livePrompts.write('Connection settings: new tool calls are paused; the relay connection stays alive.');
    const next = await resolveStartupConnection(
      { ...connection, setup: true, autoConnect: false, returnToAgent: true, relay: undefined, token: undefined, deviceId: undefined, signal: runningAbort.signal },
      livePrompts,
      {
        // Fall back to the live credentials only until the owner forgets them.
        load: () => loadCredentials() ?? (forgotten ? null : activeCredentials),
        clear: () => {
          const removed = clearCredentials();
          forgotten = true;
          paused.stop(); // stop the old socket and its reconnect timer right away
          livePrompts?.write('Old relay disconnected. Enter the new relay URL below.');
          return removed;
        },
        pair: pairDevice,
      },
    );
    if (shuttingDown) return;
    if (!next && forgotten) { shutdown('Saved connection forgotten'); return; }
    if (next && (forgotten || next.relayUrl !== activeCredentials.relayUrl || next.deviceId !== activeCredentials.deviceId || next.deviceToken !== activeCredentials.deviceToken)) {
      paused.stop();
      start(next);
    }
  } catch (error) {
    if (!shuttingDown) console.error(`Settings: ${error instanceof Error ? error.message : 'Connection setup failed.'}`);
    if (forgotten && !shuttingDown) shutdown('Saved connection forgotten');
  } finally {
    livePrompts?.close(); livePrompts = undefined;
    paused.resumeAfterSettings();
    settingsOpen = false;
    resumeLogs();
    if (!shuttingDown) { console.log(`Back to live logs. ${settingsHint}`); armShortcuts(); }
  }
}

function shutdown(reason: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  shortcuts?.close(); shortcuts = undefined;
  console.log(`\n${reason}; stopping agent`);
  runningAbort.abort();
  livePrompts?.close();
  client?.stop();
  // Persist debounced background config writes (usage stats) and stop plugin processes, bounded wait.
  const exit = () => process.exit(0);
  const timer = setTimeout(exit, 2500);
  Promise.allSettled([
    import('./core/config-manager.js').then(({ configManager }) => configManager.flush()),
    import('./plugins/host.js').then(({ stopAllPlugins }) => stopAllPlugins()),
    activity.close(),
  ]).finally(() => { clearTimeout(timer); setTimeout(exit, 50); });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start(creds);
if (foregroundControls) {
  console.log(settingsHint);
  armShortcuts();
}