#!/usr/bin/env node
/**
 * BRC agent CLI.
 *   brc-agent --relay https://rdp.example.com [--name "My PC"] [--no-browser] [--debug]
 *   brc-agent --logout                 remove saved credentials
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
import { pairDevice, loadCredentials, clearCredentials, saveCredentials, type DeviceCredentials } from './transport/pairing.js';
import { callTool, listTools } from './dispatcher.js';
import { VERSION as CORE_VERSION } from './core/version.js';
import { setCurrentClient } from './context.js';

const AGENT_VERSION = '2.0.6';

function arg(name: string, env?: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return (env && process.env[env]) || def;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const debug = flag('debug') || process.env.BRC_DEBUG === '1';
const ts = () => new Date().toISOString();
const log = (level: 'info' | 'warn' | 'error' | 'debug', msg: string) => {
  if (level === 'debug' && !debug) return;
  (level === 'error' ? console.error : console.log)(`[${ts()}] [${level}] ${msg}`);
};

if (flag('logout')) {
  console.log(clearCredentials() ? 'Credentials removed.' : 'No saved credentials.');
  process.exit(0);
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
    if (!loadCredentials()) { console.error('Pair first: run the agent once interactively with --relay <url>, then --install-service.'); process.exit(2); }
    // Service uses saved credentials; only pass through policy/debug flags.
    const keep = new Set(['--debug', '--allow-dir', '--no-plugins']);
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

async function resolveCredentials(): Promise<DeviceCredentials> {
  const relayArg = arg('relay', 'BRC_RELAY');
  const name = arg('name', 'BRC_NAME', os.hostname())!;
  const token = arg('token', 'BRC_TOKEN');
  const deviceId = arg('device-id', 'BRC_DEVICE_ID');

  if (token) {
    if (!relayArg || !deviceId) { console.error('--token requires --relay and --device-id'); process.exit(2); }
    return { relayUrl: relayArg.replace(/\/$/, ''), deviceId, deviceToken: token, name, pairedAt: 'manual' };
  }

  const saved = loadCredentials();
  if (saved && (!relayArg || saved.relayUrl === relayArg.replace(/\/$/, ''))) {
    log('info', `Using saved credentials for ${saved.relayUrl} as "${saved.name}" [${saved.deviceId}]`);
    return saved;
  }
  if (!relayArg) {
    console.error('No saved credentials. Usage: brc-agent --relay <url> [--name <name>]');
    process.exit(2);
  }
  return pairDevice({ relayUrl: relayArg, name, deviceId, openBrowser: !flag('no-browser'), log: (m) => console.log(m) });
}

const creds = await resolveCredentials();
const { registerInstaller } = await import('./plugins/installer.js');
registerInstaller();
const pluginsOff = flag('no-plugins') || (process.env.BRC_PLUGINS ?? '').toLowerCase() === 'none';
setCurrentClient({ name: 'brc-agent', version: AGENT_VERSION });
const tools = listTools();
console.log(`brc-agent ${AGENT_VERSION} (core ${CORE_VERSION}) - ${tools.length} tools - "${creds.name}" [${creds.deviceId}] -> ${creds.relayUrl}`);

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

let client: WsClient;
const start = (c: DeviceCredentials) => {
  client = new WsClient({
    relayUrl: c.relayUrl, token: c.deviceToken, deviceId: c.deviceId, name: c.name,
    agentVersion: AGENT_VERSION, coreVersion: CORE_VERSION, tools, callTool, log,
    onConnected: () => { if (!pluginSetupStarted) setImmediate(startPluginSetup); },
    onUnauthorized: async () => {
      if (c.pairedAt === 'manual') return false;
      log('warn', 'Relay rejected our device token; re-pairing');
      clearCredentials();
      const fresh = await pairDevice({ relayUrl: c.relayUrl, name: c.name, deviceId: c.deviceId, openBrowser: !flag('no-browser'), log: (m) => console.log(m) });
      saveCredentials(fresh);
      start(fresh);
      return true;
    },
  });
  client.start();
};
start(creds);

const shutdown = (sig: string) => {
  console.log(`\n${sig} received, stopping agent`);
  client.stop();
  // Persist debounced background config writes (usage stats) and stop plugin processes, bounded wait.
  const exit = () => process.exit(0);
  const timer = setTimeout(exit, 2500);
  Promise.allSettled([
    import('./core/config-manager.js').then(({ configManager }) => configManager.flush()),
    import('./plugins/host.js').then(({ stopAllPlugins }) => stopAllPlugins()),
  ]).finally(() => { clearTimeout(timer); setTimeout(exit, 50); });
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
