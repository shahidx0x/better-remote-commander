/** Device pairing and operational credentials. No activity logs are persisted. */
import { mkdirSync, readFileSync, writeFileSync, chmodSync, unlinkSync, renameSync, lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { normalizeRelayUrl } from './relay-url.js';

export interface DeviceCredentials { relayUrl: string; deviceId: string; deviceToken: string; name: string; pairedAt: string }
const longPath = (p: string): string => { try { return realpathSync.native(p); } catch { const parent = path.dirname(p); return parent === p ? p : path.join(longPath(parent), path.basename(p)); } };
/** Windows long paths avoid the libuv watcher issue with 8.3 short names. */
export const homeDir = () => longPath(process.env.BRC_HOME ?? path.join(os.homedir(), '.brc'));
const credFile = () => path.join(homeDir(), 'device.json');

function validatedCredentials(value: unknown): DeviceCredentials {
  if (!value || typeof value !== 'object') throw new Error('Saved pairing is invalid.');
  const c = value as Record<string, unknown>;
  for (const [key, max] of [['relayUrl', 2048], ['deviceId', 256], ['deviceToken', 8192], ['name', 160], ['pairedAt', 80]] as const) {
    if (typeof c[key] !== 'string' || !c[key].length || c[key].length > max || /[\x00-\x1f\x7f-\x9f]/.test(c[key])) throw new Error('Saved pairing is invalid.');
  }
  return { relayUrl: normalizeRelayUrl(c.relayUrl as string), deviceId: c.deviceId as string, deviceToken: c.deviceToken as string, name: c.name as string, pairedAt: c.pairedAt as string };
}
export function loadCredentials(): DeviceCredentials | null {
  try { return validatedCredentials(JSON.parse(readFileSync(credFile(), 'utf8'))); }
  catch { return null; }
}
export function saveCredentials(value: DeviceCredentials): void {
  const c = validatedCredentials(value), file = credFile();
  mkdirSync(homeDir(), { recursive: true });
  try { const s = lstatSync(file); if (!s.isFile() || s.isSymbolicLink()) throw new Error('Saved pairing must be a regular file.'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temp = path.join(homeDir(), `.device-${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, JSON.stringify(c, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    // Commit only the successful new pairing; a failed write leaves the previous one intact.
    renameSync(temp, file);
    try { chmodSync(file, 0o600); } catch { /* Windows permissions are inherited. */ }
  } finally {
    try { unlinkSync(temp); } catch { /* Already renamed or never created. */ }
  }
}
export function clearCredentials(): boolean {
  try { unlinkSync(credFile()); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

export interface PairOptions {
  relayUrl: string;
  name: string;
  deviceId?: string;
  openBrowser?: boolean;
  log: (msg: string) => void;
  signal?: AbortSignal;
}
interface StartResponse { device_code: string; user_code: string; verification_uri: string; verification_uri_complete: string; expires_in: number; interval: number }
interface PollResponse { device_token?: string; device_id?: string; error?: string; interval?: number }
async function postJson<T>(url: string, body: unknown, abort?: AbortSignal): Promise<{ status: number; json: T }> {
  abort?.throwIfAborted();
  const deadline = AbortSignal.timeout(15000);
  const signal = abort ? AbortSignal.any([abort, deadline]) : deadline;
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal });
  const json = (await res.json().catch(() => ({}))) as T;
  signal.throwIfAborted();
  return { status: res.status, json };
}
function verificationUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('Relay returned an invalid pairing page.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || raw.length > 4096) throw new Error('Relay returned an unsafe pairing page.');
  return url.toString();
}

/** Pair until approved/denied/expired/cancelled; persist only the successfully approved credentials. */
export async function pairDevice(opts: PairOptions): Promise<DeviceCredentials> {
  const base = normalizeRelayUrl(opts.relayUrl), deviceId = opts.deviceId ?? randomUUID();
  opts.signal?.throwIfAborted();
  const { status, json: start } = await postJson<StartResponse>(`${base}/device/start`, { client_name: opts.name }, opts.signal);
  if (status !== 200 || typeof start.device_code !== 'string' || !start.device_code || typeof start.user_code !== 'string' || !/^[a-zA-Z0-9-]{4,64}$/.test(start.user_code)) throw new Error(`Relay rejected pairing start (${status}).`);
  if (!Number.isFinite(start.expires_in) || start.expires_in <= 0 || start.expires_in > 3600) throw new Error('Relay returned an invalid pairing expiry.');
  const page = verificationUrl(start.verification_uri);
  const complete = start.verification_uri_complete ? verificationUrl(start.verification_uri_complete) : page;
  opts.log('');
  opts.log('Pairing required. Open this URL and enter the code:');
  opts.log(`   ${page}`);
  opts.log(`   code: ${start.user_code}   (expires in ${Math.round(start.expires_in / 60)} min)`);
  opts.log('');
  if (opts.openBrowser !== false) {
    try { const { default: open } = await import('open'); opts.signal?.throwIfAborted(); await open(complete); }
    catch { /* Approval also works by copying the displayed URL. */ }
  }
  let interval = Math.min(60, Math.max(2, Number(start.interval) || 5)) * 1000;
  const deadline = Date.now() + start.expires_in * 1000;
  while (Date.now() < deadline) {
    await sleep(Math.min(interval, deadline - Date.now()), undefined, { signal: opts.signal });
    if (Date.now() >= deadline) break;
    const { json } = await postJson<PollResponse>(`${base}/device/poll`, { device_code: start.device_code, device_id: deviceId, name: opts.name, platform: `${process.platform}/${process.arch}` }, opts.signal);
    if (json.device_token && json.device_id) {
      const creds = validatedCredentials({ relayUrl: base, deviceId: json.device_id, deviceToken: json.device_token, name: opts.name, pairedAt: new Date().toISOString() });
      opts.signal?.throwIfAborted();
      saveCredentials(creds);
      opts.log(`Paired as "${opts.name}" [${json.device_id}]; credentials saved to ${credFile()}`);
      return creds;
    }
    switch (json.error) {
      case 'authorization_pending': break;
      case 'slow_down': interval = Math.min(interval + 5000, 60000); break;
      case 'access_denied': throw new Error('Pairing denied by the relay owner.');
      case 'expired_token': throw new Error('Pairing code expired; retry to get a new code.');
      default: throw new Error('Pairing failed: the relay returned an unexpected response.');
    }
  }
  throw new Error('Pairing code expired; retry to get a new code.');
}
