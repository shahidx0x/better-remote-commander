#!/usr/bin/env node
/**
 * SES-RDP agent CLI.
 *   ses-rdp-agent --relay https://rdp.example.com [--name "My PC"] [--no-browser] [--debug]
 *   ses-rdp-agent --logout                 remove saved credentials
 *   ses-rdp-agent --relay <url> --token <t> --device-id <id>   (dev: skip pairing, pre-issued token)
 * Env: SES_RDP_RELAY, SES_RDP_NAME, SES_RDP_TOKEN, SES_RDP_DEVICE_ID, SES_RDP_HOME, SES_RDP_DEBUG
 */
import os from 'node:os';
import { WsClient } from './transport/ws-client.js';
import { pairDevice, loadCredentials, clearCredentials, saveCredentials, type DeviceCredentials } from './transport/pairing.js';
import { callTool, listTools } from './dispatcher.js';
import { VERSION as CORE_VERSION } from './core/version.js';
import { setCurrentClient } from './context.js';

const AGENT_VERSION = '0.2.0';

function arg(name: string, env?: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return (env && process.env[env]) || def;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const debug = flag('debug') || process.env.SES_RDP_DEBUG === '1';
const ts = () => new Date().toISOString();
const log = (level: 'info' | 'warn' | 'error' | 'debug', msg: string) => {
  if (level === 'debug' && !debug) return;
  (level === 'error' ? console.error : console.log)(`[${ts()}] [${level}] ${msg}`);
};

if (flag('logout')) {
  console.log(clearCredentials() ? 'Credentials removed.' : 'No saved credentials.');
  process.exit(0);
}

async function resolveCredentials(): Promise<DeviceCredentials> {
  const relayArg = arg('relay', 'SES_RDP_RELAY');
  const name = arg('name', 'SES_RDP_NAME', os.hostname())!;
  const token = arg('token', 'SES_RDP_TOKEN');
  const deviceId = arg('device-id', 'SES_RDP_DEVICE_ID');

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
    console.error('No saved credentials. Usage: ses-rdp-agent --relay <url> [--name <name>]');
    process.exit(2);
  }
  return pairDevice({ relayUrl: relayArg, name, deviceId, openBrowser: !flag('no-browser'), log: (m) => console.log(m) });
}

const creds = await resolveCredentials();
setCurrentClient({ name: 'ses-rdp-agent', version: AGENT_VERSION });
const tools = listTools();
console.log(`ses-rdp-agent ${AGENT_VERSION} (core ${CORE_VERSION}) - ${tools.length} tools - "${creds.name}" [${creds.deviceId}] -> ${creds.relayUrl}`);

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
