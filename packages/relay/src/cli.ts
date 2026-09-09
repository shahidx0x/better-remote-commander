#!/usr/bin/env node
import { buildServer, loadConfig } from './server.js';

const cfg = loadConfig();
if (!cfg.deviceToken) { console.error('SES_RDP_DEVICE_TOKEN is required (Phase 1 static auth)'); process.exit(2); }
if (!cfg.adminToken) console.warn('SES_RDP_ADMIN_TOKEN not set: /debug/* disabled');

const { app } = await buildServer(cfg);
await app.listen({ port: cfg.port, host: cfg.host });
app.log.info(`ses-rdp-relay ${cfg.relayVersion} listening on ${cfg.host}:${cfg.port}, public ${cfg.publicUrl}`);

const stop = async () => { await app.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
