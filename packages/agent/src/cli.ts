#!/usr/bin/env node
/**
 * SES-RDP agent CLI (Phase 1: static token auth; Phase 2 adds device pairing).
 *   ses-rdp-agent --relay http://localhost:3000 --token dev-token [--name "My PC"] [--device-id id]
 * Env fallbacks: SES_RDP_RELAY, SES_RDP_TOKEN, SES_RDP_NAME, SES_RDP_DEVICE_ID
 */
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { WsClient } from './transport/ws-client.js';
import { callTool, listTools } from './dispatcher.js';
import { VERSION as CORE_VERSION } from './core/version.js';
import { setCurrentClient } from './context.js';

const AGENT_VERSION = '0.1.0';

function arg(name: string, env: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return process.env[env] ?? def;
}

const relayUrl = arg('relay', 'SES_RDP_RELAY');
const token = arg('token', 'SES_RDP_TOKEN');
const name = arg('name', 'SES_RDP_NAME', os.hostname())!;
const deviceId = arg('device-id', 'SES_RDP_DEVICE_ID', randomUUID())!;
const debug = process.argv.includes('--debug') || process.env.SES_RDP_DEBUG === '1';

if (!relayUrl || !token) {
  console.error('Usage: ses-rdp-agent --relay <url> --token <token> [--name <name>] [--device-id <id>] [--debug]');
  process.exit(2);
}

setCurrentClient({ name: 'ses-rdp-agent', version: AGENT_VERSION });
const tools = listTools();
console.log(`ses-rdp-agent ${AGENT_VERSION} (core ${CORE_VERSION}) - ${tools.length} tools - device "${name}" [${deviceId}]`);

const client = new WsClient({
  relayUrl, token, deviceId, name,
  agentVersion: AGENT_VERSION,
  coreVersion: CORE_VERSION,
  tools,
  callTool,
  log: (level, msg) => {
    if (level === 'debug' && !debug) return;
    const ts = new Date().toISOString();
    (level === 'error' ? console.error : console.log)(`[${ts}] [${level}] ${msg}`);
  },
});

client.start();

const shutdown = (sig: string) => {
  console.log(`\n${sig} received, stopping agent`);
  client.stop();
  setTimeout(() => process.exit(0), 200);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
