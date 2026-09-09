/**
 * SES-RDP agent device pairing (OAuth device-authorization style) + credential persistence.
 * Credentials: $SES_RDP_HOME/device.json (mode 0600) -> { relayUrl, deviceId, deviceToken, name, pairedAt }
 */
import { mkdirSync, readFileSync, writeFileSync, chmodSync, unlinkSync, existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

export interface DeviceCredentials { relayUrl: string; deviceId: string; deviceToken: string; name: string; pairedAt: string }

const longPath = (p: string): string => { try { return realpathSync.native(p); } catch { const parent = path.dirname(p); return parent === p ? p : path.join(longPath(parent), path.basename(p)); } };
/** Agent home. Resolved to a long path: Windows 8.3 short paths crash libuv's fs.watch (used by the config watcher). */
export const homeDir = () => longPath(process.env.SES_RDP_HOME ?? path.join(os.homedir(), '.ses-rdp'));
const credFile = () => path.join(homeDir(), 'device.json');

export function loadCredentials(): DeviceCredentials | null {
  try { return JSON.parse(readFileSync(credFile(), 'utf8')) as DeviceCredentials; } catch { return null; }
}

export function saveCredentials(c: DeviceCredentials): void {
  mkdirSync(homeDir(), { recursive: true });
  writeFileSync(credFile(), JSON.stringify(c, null, 2), { mode: 0o600 });
  try { chmodSync(credFile(), 0o600); } catch { /* windows */ }
}

export function clearCredentials(): boolean {
  if (!existsSync(credFile())) return false;
  unlinkSync(credFile());
  return true;
}

export interface PairOptions {
  relayUrl: string;
  name: string;
  deviceId?: string;
  openBrowser?: boolean;
  log: (msg: string) => void;
}

interface StartResponse { device_code: string; user_code: string; verification_uri: string; verification_uri_complete: string; expires_in: number; interval: number }
interface PollResponse { device_token?: string; device_id?: string; error?: string; interval?: number }

async function postJson<T>(url: string, body: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, json };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs the pairing flow until approved, denied or expired. Returns saved credentials. */
export async function pairDevice(opts: PairOptions): Promise<DeviceCredentials> {
  const base = opts.relayUrl.replace(/\/$/, '');
  const deviceId = opts.deviceId ?? randomUUID();
  const { status, json: start } = await postJson<StartResponse>(`${base}/device/start`, { client_name: opts.name });
  if (status !== 200 || !start.device_code) throw new Error(`relay rejected pairing start (${status})`);

  opts.log('');
  opts.log('Pairing required. Open this URL and enter the code:');
  opts.log(`   ${start.verification_uri}`);
  opts.log(`   code: ${start.user_code}   (expires in ${Math.round(start.expires_in / 60)} min)`);
  opts.log('');
  if (opts.openBrowser !== false) {
    try { const { default: open } = await import('open'); await open(start.verification_uri_complete); } catch { /* headless */ }
  }

  let interval = Math.max(2, start.interval ?? 5) * 1000;
  const deadline = Date.now() + start.expires_in * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);
    const { json } = await postJson<PollResponse>(`${base}/device/poll`, {
      device_code: start.device_code, device_id: deviceId, name: opts.name, platform: `${process.platform}/${process.arch}`,
    });
    if (json.device_token && json.device_id) {
      const creds: DeviceCredentials = { relayUrl: base, deviceId: json.device_id, deviceToken: json.device_token, name: opts.name, pairedAt: new Date().toISOString() };
      saveCredentials(creds);
      opts.log(`Paired as "${opts.name}" [${json.device_id}]; credentials saved to ${credFile()}`);
      return creds;
    }
    switch (json.error) {
      case 'authorization_pending': break;
      case 'slow_down': interval += 5000; break;
      case 'access_denied': throw new Error('pairing denied by the relay owner');
      case 'expired_token': throw new Error('pairing code expired; start the agent again');
      default: throw new Error(`pairing failed: ${json.error ?? 'unknown error'}`);
    }
  }
  throw new Error('pairing code expired; start the agent again');
}
