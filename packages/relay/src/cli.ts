#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { applyLegacyEnv } from 'brc-shared';
applyLegacyEnv();
import { buildRelay, loadConfig } from './app.js';

const cfg = loadConfig();
if (!cfg.adminPassword) { console.error('BRC_ADMIN_PASSWORD is required'); process.exit(2); }
if (!cfg.sessionSecret) {
  cfg.sessionSecret = randomBytes(32).toString('hex');
  console.warn('BRC_SESSION_SECRET not set: using a random secret (browser sessions reset on restart)');
}

const log = (level: string, msg: string) => {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
  (level === 'error' || level === 'warn' ? console.error : console.log)(line);
};

const relay = buildRelay(cfg, log);
relay.http.listen(cfg.port, cfg.host, () => {
  log('info', `brc-relay ${cfg.relayVersion} listening on ${cfg.host}:${cfg.port}`);
  log('info', `public URL ${cfg.publicUrl}  MCP: ${cfg.publicUrl}/mcp  pair: ${cfg.publicUrl}/device/verify`);
});

const stop = async () => { log('info', 'shutting down'); await relay.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
