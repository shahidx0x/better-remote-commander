/**
 * Backward compatibility with the pre-rename (SES-RDP) environment.
 * Call once at process start: maps SES_RDP_* env vars to BRC_* when BRC_* is unset,
 * and falls back to ~/.ses-rdp as the home dir if ~/.brc does not exist yet.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function applyLegacyEnv(): void {
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('SES_RDP_') && v !== undefined) {
      const nk = 'BRC_' + k.slice('SES_RDP_'.length);
      if (process.env[nk] === undefined) process.env[nk] = v;
    }
  }
  if (!process.env.BRC_HOME) {
    const legacy = path.join(os.homedir(), '.ses-rdp');
    const current = path.join(os.homedir(), '.brc');
    if (!existsSync(path.join(current, 'device.json')) && existsSync(path.join(legacy, 'device.json'))) process.env.BRC_HOME = legacy;
  }
}
