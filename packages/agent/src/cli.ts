#!/usr/bin/env node
/**
 * BRC agent CLI.
 *   brc-agent --relay https://rdp.example.com [--name "My PC"] [--no-browser] [--debug]
 *   brc-agent --logout                 remove saved credentials
 *   brc-agent --relay <url> --token <t> --device-id <id>   (dev: skip pairing, pre-issued token)
 * Env: BRC_RELAY, BRC_NAME, BRC_TOKEN, BRC_DEVICE_ID, BRC_HOME, BRC_DEBUG
 */
import os from 'node:os';
import { applyLegacyEnv } from 'brc-shared';
applyLegacyEnv();
import { WsClient } from './transport/ws-client.js';
import { pairDevice, loadCredentials, clearCredentials, saveCredentials, type DeviceCredentials } from './transport/pairing.js';
import { callTool, listTools } from './dispatcher.js';
import { VERSION as CORE_VERSION } from './core/version.js';
import { setCurrentClient } from './context.js';

const AGENT_VERSION = '2.0.1';

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
setCurrentClient({ name: 'brc-agent', version: AGENT_VERSION });
const tools = listTools();
console.log(`brc-agent ${AGENT_VERSION} (core ${CORE_VERSION}) - ${tools.length} tools - "${creds.name}" [${creds.deviceId}] -> ${creds.relayUrl}`);

let client: WsClient;
const start = (c: DeviceCredentials) => {
  client = new WsClient({
    relayUrl: c.relayUrl, token: c.deviceToken, deviceId: c.deviceId, name: c.name,
    agentVersion: AGENT_VERSION, coreVersion: CORE_VERSION, tools, callTool, log,
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

const shutdown = (sig: string) => { console.log(`\n${sig} received, stopping agent`); client.stop(); setTimeout(() => process.exit(0), 200); };
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
