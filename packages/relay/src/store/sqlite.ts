/**
 * SES-RDP relay store on node:sqlite (Node >= 22.13, no native build).
 * Tables: users, oauth_clients, auth_codes, tokens, devices, device_codes, audit.
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

export function hashPassword(pw: string): string {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(pw, salt, 64).toString('hex')}`;
}
export function verifyPassword(pw: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const a = Buffer.from(hash, 'hex'); const b = scryptSync(pw, salt, 64);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface UserRow { id: string; username: string; password_hash: string; created_at: number }
export interface ClientRow { client_id: string; client_secret: string | null; metadata: string; created_at: number }
export interface AuthCodeRow { code: string; client_id: string; user_id: string; code_challenge: string; redirect_uri: string; scopes: string; resource: string | null; expires_at: number }
export interface TokenRow { token_hash: string; kind: 'access' | 'refresh'; client_id: string; user_id: string; scopes: string; resource: string | null; expires_at: number | null; created_at: number; revoked: number }
export interface DeviceRow { device_id: string; user_id: string; name: string; token_hash: string; platform: string | null; created_at: number; last_seen: number | null; paused: number }
export interface DeviceCodeRow { device_code: string; user_code: string; client_name: string; user_id: string | null; approved: number; denied: number; device_id: string | null; expires_at: number; created_at: number }
export interface AuditRow { id: number; ts: number; user_id: string | null; device_id: string | null; client: string | null; tool: string; args_hash: string | null; ok: number; ms: number | null; error: string | null }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS oauth_clients (client_id TEXT PRIMARY KEY, client_secret TEXT, metadata TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS auth_codes (code TEXT PRIMARY KEY, client_id TEXT NOT NULL, user_id TEXT NOT NULL, code_challenge TEXT NOT NULL, redirect_uri TEXT NOT NULL, scopes TEXT NOT NULL, resource TEXT, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tokens (token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, client_id TEXT NOT NULL, user_id TEXT NOT NULL, scopes TEXT NOT NULL, resource TEXT, expires_at INTEGER, created_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS devices (device_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, platform TEXT, created_at INTEGER NOT NULL, last_seen INTEGER, paused INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS device_codes (device_code TEXT PRIMARY KEY, user_code TEXT UNIQUE NOT NULL, client_name TEXT NOT NULL, user_id TEXT, approved INTEGER NOT NULL DEFAULT 0, denied INTEGER NOT NULL DEFAULT 0, device_id TEXT, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, user_id TEXT, device_id TEXT, client TEXT, tool TEXT NOT NULL, args_hash TEXT, ok INTEGER NOT NULL, ms INTEGER, error TEXT);
CREATE INDEX IF NOT EXISTS audit_ts ON audit(ts);
`;

export class SqliteStore {
  readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  /* ---------- users ---------- */
  getUserByName(username: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
  }
  getUser(id: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  }
  upsertUser(username: string, password: string): UserRow {
    const existing = this.getUserByName(username);
    const hash = hashPassword(password);
    if (existing) {
      this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, existing.id);
      return { ...existing, password_hash: hash };
    }
    const row: UserRow = { id: randomToken(12), username, password_hash: hash, created_at: Date.now() };
    this.db.prepare('INSERT INTO users VALUES (?,?,?,?)').run(row.id, row.username, row.password_hash, row.created_at);
    return row;
  }

  /* ---------- oauth clients ---------- */
  getClient(clientId: string): ClientRow | undefined {
    return this.db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(clientId) as ClientRow | undefined;
  }
  insertClient(row: ClientRow): void {
    this.db.prepare('INSERT INTO oauth_clients VALUES (?,?,?,?)').run(row.client_id, row.client_secret, row.metadata, row.created_at);
  }

  /* ---------- auth codes ---------- */
  insertAuthCode(row: AuthCodeRow): void {
    this.db.prepare('INSERT INTO auth_codes VALUES (?,?,?,?,?,?,?,?)')
      .run(row.code, row.client_id, row.user_id, row.code_challenge, row.redirect_uri, row.scopes, row.resource, row.expires_at);
  }
  takeAuthCode(code: string): AuthCodeRow | undefined {
    const row = this.db.prepare('SELECT * FROM auth_codes WHERE code = ?').get(code) as AuthCodeRow | undefined;
    if (row) this.db.prepare('DELETE FROM auth_codes WHERE code = ?').run(code);
    return row && row.expires_at > Date.now() ? row : undefined;
  }
  peekAuthCode(code: string): AuthCodeRow | undefined {
    const row = this.db.prepare('SELECT * FROM auth_codes WHERE code = ?').get(code) as AuthCodeRow | undefined;
    return row && row.expires_at > Date.now() ? row : undefined;
  }

  /* ---------- tokens ---------- */
  insertToken(row: TokenRow): void {
    this.db.prepare('INSERT INTO tokens VALUES (?,?,?,?,?,?,?,?,?)')
      .run(row.token_hash, row.kind, row.client_id, row.user_id, row.scopes, row.resource, row.expires_at, row.created_at, row.revoked);
  }
  getToken(raw: string, kind: 'access' | 'refresh'): TokenRow | undefined {
    const row = this.db.prepare('SELECT * FROM tokens WHERE token_hash = ? AND kind = ? AND revoked = 0').get(sha256(raw), kind) as TokenRow | undefined;
    if (!row) return undefined;
    if (row.expires_at && row.expires_at < Date.now()) return undefined;
    return row;
  }
  revokeToken(raw: string): void {
    this.db.prepare('UPDATE tokens SET revoked = 1 WHERE token_hash = ?').run(sha256(raw));
  }
  revokeTokensForClient(clientId: string, userId?: string): void {
    if (userId) this.db.prepare('UPDATE tokens SET revoked = 1 WHERE client_id = ? AND user_id = ?').run(clientId, userId);
    else this.db.prepare('UPDATE tokens SET revoked = 1 WHERE client_id = ?').run(clientId);
  }

  /* ---------- devices ---------- */
  getDeviceByToken(raw: string): DeviceRow | undefined {
    return this.db.prepare('SELECT * FROM devices WHERE token_hash = ?').get(sha256(raw)) as DeviceRow | undefined;
  }
  getDevice(deviceId: string): DeviceRow | undefined {
    return this.db.prepare('SELECT * FROM devices WHERE device_id = ?').get(deviceId) as DeviceRow | undefined;
  }
  listDevices(userId: string): DeviceRow[] {
    return this.db.prepare('SELECT * FROM devices WHERE user_id = ? ORDER BY created_at').all(userId) as unknown as DeviceRow[];
  }
  /** Creates (or re-keys) a device and returns the raw token once. */
  issueDeviceToken(deviceId: string, userId: string, name: string, platform: string | null): string {
    const raw = `sesrdp_dev_${randomToken(32)}`;
    const existing = this.getDevice(deviceId);
    if (existing) {
      this.db.prepare('UPDATE devices SET token_hash = ?, name = ?, platform = ?, user_id = ? WHERE device_id = ?').run(sha256(raw), name, platform, userId, deviceId);
    } else {
      this.db.prepare('INSERT INTO devices (device_id, user_id, name, token_hash, platform, created_at) VALUES (?,?,?,?,?,?)')
        .run(deviceId, userId, name, sha256(raw), platform, Date.now());
    }
    return raw;
  }
  touchDevice(deviceId: string): void {
    this.db.prepare('UPDATE devices SET last_seen = ? WHERE device_id = ?').run(Date.now(), deviceId);
  }
  setDevicePaused(deviceId: string, paused: boolean): void {
    this.db.prepare('UPDATE devices SET paused = ? WHERE device_id = ?').run(paused ? 1 : 0, deviceId);
  }
  deleteDevice(deviceId: string): void {
    this.db.prepare('DELETE FROM devices WHERE device_id = ?').run(deviceId);
  }

  /* ---------- device pairing codes ---------- */
  createDeviceCode(clientName: string, ttlMs: number): DeviceCodeRow {
    const row: DeviceCodeRow = {
      device_code: randomToken(32), user_code: SqliteStore.userCode(), client_name: clientName,
      user_id: null, approved: 0, denied: 0, device_id: null, expires_at: Date.now() + ttlMs, created_at: Date.now(),
    };
    this.db.prepare('INSERT INTO device_codes VALUES (?,?,?,?,?,?,?,?,?)')
      .run(row.device_code, row.user_code, row.client_name, row.user_id, row.approved, row.denied, row.device_id, row.expires_at, row.created_at);
    return row;
  }
  getDeviceCode(deviceCode: string): DeviceCodeRow | undefined {
    return this.db.prepare('SELECT * FROM device_codes WHERE device_code = ?').get(deviceCode) as DeviceCodeRow | undefined;
  }
  getDeviceCodeByUserCode(userCode: string): DeviceCodeRow | undefined {
    return this.db.prepare('SELECT * FROM device_codes WHERE user_code = ?').get(userCode.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^(.{4})(.{4})$/, '$1-$2')) as DeviceCodeRow | undefined;
  }
  approveDeviceCode(deviceCode: string, userId: string, deviceId: string): void {
    this.db.prepare('UPDATE device_codes SET approved = 1, user_id = ?, device_id = ? WHERE device_code = ?').run(userId, deviceId, deviceCode);
  }
  denyDeviceCode(deviceCode: string): void {
    this.db.prepare('UPDATE device_codes SET denied = 1 WHERE device_code = ?').run(deviceCode);
  }
  deleteDeviceCode(deviceCode: string): void {
    this.db.prepare('DELETE FROM device_codes WHERE device_code = ?').run(deviceCode);
  }
  private static userCode(): string {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const b = randomBytes(8);
    const s = [...b].map((x) => alphabet[x % alphabet.length]).join('');
    return `${s.slice(0, 4)}-${s.slice(4)}`;
  }

  /* ---------- audit ---------- */
  audit(row: Omit<AuditRow, 'id'>): void {
    this.db.prepare('INSERT INTO audit (ts,user_id,device_id,client,tool,args_hash,ok,ms,error) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(row.ts, row.user_id, row.device_id, row.client, row.tool, row.args_hash, row.ok, row.ms, row.error);
  }
  recentAudit(userId: string, limit = 100): AuditRow[] {
    return this.db.prepare('SELECT * FROM audit WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(userId, limit) as unknown as AuditRow[];
  }

  /** Housekeeping: drop expired codes/tokens. */
  vacuumExpired(): void {
    const now = Date.now();
    this.db.prepare('DELETE FROM auth_codes WHERE expires_at < ?').run(now);
    this.db.prepare('DELETE FROM device_codes WHERE expires_at < ?').run(now);
    this.db.prepare('DELETE FROM tokens WHERE expires_at IS NOT NULL AND expires_at < ?').run(now - 7 * 86_400_000);
  }

  close(): void { this.db.close(); }
}
