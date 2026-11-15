/**
 * BRC relay store on node:sqlite (Node >= 22.13, no native build).
 * Tables: users, oauth_clients, auth_codes, tokens, devices, device_codes, audit.
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite';
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
export interface ConnectionLinkRow { id: string; user_id: string; name: string; mode: 'read' | 'full'; key_hash: string; created_at: number; expires_at: number }
export interface AuthCodeRow { code: string; client_id: string; user_id: string; code_challenge: string; redirect_uri: string; scopes: string; resource: string | null; expires_at: number }
export interface TokenRow { token_hash: string; kind: 'access' | 'refresh'; client_id: string; user_id: string; scopes: string; resource: string | null; expires_at: number | null; created_at: number; revoked: number }
export interface DeviceRow { device_id: string; user_id: string; name: string; token_hash: string; platform: string | null; created_at: number; last_seen: number | null; paused: number }
export interface DeviceCodeRow { device_code: string; user_code: string; client_name: string; user_id: string | null; approved: number; denied: number; device_id: string | null; expires_at: number; created_at: number }
export interface AuditRow { id: number; ts: number; user_id: string | null; device_id: string | null; client: string | null; tool: string; args_hash: string | null; ok: number; ms: number | null; error: string | null }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS oauth_clients (client_id TEXT PRIMARY KEY, client_secret TEXT, metadata TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS connection_links (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, mode TEXT NOT NULL CHECK (mode IN ('read','full')), key_hash TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS connection_links_owner_expiry ON connection_links(user_id, expires_at);
CREATE TABLE IF NOT EXISTS auth_codes (code TEXT PRIMARY KEY, client_id TEXT NOT NULL, user_id TEXT NOT NULL, code_challenge TEXT NOT NULL, redirect_uri TEXT NOT NULL, scopes TEXT NOT NULL, resource TEXT, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tokens (token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, client_id TEXT NOT NULL, user_id TEXT NOT NULL, scopes TEXT NOT NULL, resource TEXT, expires_at INTEGER, created_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS devices (device_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, platform TEXT, created_at INTEGER NOT NULL, last_seen INTEGER, paused INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS device_codes (device_code TEXT PRIMARY KEY, user_code TEXT UNIQUE NOT NULL, client_name TEXT NOT NULL, user_id TEXT, approved INTEGER NOT NULL DEFAULT 0, denied INTEGER NOT NULL DEFAULT 0, device_id TEXT, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, user_id TEXT, device_id TEXT, client TEXT, tool TEXT NOT NULL, args_hash TEXT, ok INTEGER NOT NULL, ms INTEGER, error TEXT);
CREATE INDEX IF NOT EXISTS audit_ts ON audit(ts);
`;

export class SqliteStore {
  readonly db: DatabaseSync;
  readonly auditRetentionMs = 0;
  private liveAudit: AuditRow[] = [];
  private auditSequence = 0;
  private apiKeysReady = false;
  private statements = new Map<string, StatementSync>();
  // Cache compiled SQL, never authorization results. Every lookup executes against current rows.
  private statement(sql: string): StatementSync {
    let s=this.statements.get(sql);
    if(!s){s=this.db.prepare(sql);this.statements.set(sql,s);}
    return s;
  }
  private lastTouches = new Map<string,number>();

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON; PRAGMA busy_timeout = 1000;');
    this.db.exec(SCHEMA);
    this.pruneAudit();
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
  updateClientMetadata(clientId: string, metadata: string): void {
    if (Number(this.db.prepare('UPDATE oauth_clients SET metadata = ? WHERE client_id = ?').run(metadata, clientId).changes) !== 1)
      throw new Error('OAuth client was removed while its callback was being approved');
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
    const row = this.statement('SELECT * FROM tokens WHERE token_hash = ? AND kind = ? AND revoked = 0').get(sha256(raw), kind) as TokenRow | undefined;
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
    return this.statement('SELECT * FROM devices WHERE token_hash = ?').get(sha256(raw)) as DeviceRow | undefined;
  }
  getDevice(deviceId: string): DeviceRow | undefined {
    return this.statement('SELECT * FROM devices WHERE device_id = ?').get(deviceId) as DeviceRow | undefined;
  }
  listDevices(userId: string): DeviceRow[] {
    return this.statement('SELECT * FROM devices WHERE user_id = ? ORDER BY created_at').all(userId) as unknown as DeviceRow[];
  }
  /** Creates (or re-keys) a device and returns the raw token once. */
  issueDeviceToken(deviceId: string, userId: string, name: string, platform: string | null): string {
    const raw = `brc_dev_${randomToken(32)}`;
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
    const now=Date.now();if(now-(this.lastTouches.get(deviceId)??0)<5000)return;
    this.db.prepare('UPDATE devices SET last_seen = ? WHERE device_id = ?').run(now, deviceId);
    this.lastTouches.delete(deviceId);this.lastTouches.set(deviceId,now);
    while(this.lastTouches.size>1024)this.lastTouches.delete(this.lastTouches.keys().next().value!);
  }
  setDevicePaused(deviceId: string, paused: boolean): void {
    this.db.prepare('UPDATE devices SET paused = ? WHERE device_id = ?').run(paused ? 1 : 0, deviceId);
  }
  deleteDevice(deviceId: string): void {
    this.lastTouches.delete(deviceId);
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
  // Volatile dashboard metadata only. No SQL INSERT for tool-call activity.
  audit(row: Omit<AuditRow, 'id'>): void {
    this.liveAudit.push({...row,id:++this.auditSequence,args_hash:null,error:row.ok?null:'TOOL_FAILED'});
    if(this.liveAudit.length>1000)this.liveAudit.shift();
  }
  recentAudit(userId:string,limit=100):AuditRow[]{
    return this.liveAudit.filter(r=>r.user_id===userId).slice(-Math.min(1000,Math.max(1,limit))).reverse().map(r=>({...r}));
  }
  pruneAudit(_now=Date.now()):number{
    // Secure-delete legacy rows on upgrade, preserving authentication/device state.
    const removed=Number(this.db.prepare('DELETE FROM audit').run().changes);
    if(removed)this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return removed;
  }
  /** Housekeeping: drop expired codes/tokens. */
  vacuumExpired(): void {
    const now = Date.now();
    this.pruneAudit(now);
    this.db.prepare('DELETE FROM auth_codes WHERE expires_at < ?').run(now);
    this.db.prepare('DELETE FROM device_codes WHERE expires_at < ?').run(now);
    this.statement('DELETE FROM connection_links WHERE expires_at <= ?').run(now);
    this.db.prepare('DELETE FROM tokens WHERE expires_at IS NOT NULL AND expires_at < ?').run(now - 7 * 86_400_000);
  }

  /* ---------- OAuth clients (management) ---------- */
  listClients(): ClientRow[] {
    return this.db.prepare('SELECT * FROM oauth_clients ORDER BY created_at DESC').all() as unknown as ClientRow[];
  }
  deleteClient(clientId: string): void {
    this.db.prepare('UPDATE tokens SET revoked = 1 WHERE client_id = ?').run(clientId);
    this.db.prepare('DELETE FROM oauth_clients WHERE client_id = ?').run(clientId);
  }

  renameDevice(deviceId: string, name: string): void {
    this.db.prepare('UPDATE devices SET name = ? WHERE device_id = ?').run(name, deviceId);
  }
  auditStats(userId:string):{total:number;failed:number;last24h:number}{
    const rows=this.liveAudit.filter(r=>r.user_id===userId);
    return {total:rows.length,failed:rows.filter(r=>!r.ok).length,last24h:rows.filter(r=>r.ts>Date.now()-86400000).length};
  }

  /* ---------- API keys (static bearer tokens) ---------- */
  private ensureApiKeys(): void {
    if(this.apiKeysReady)return;
    this.db.exec('CREATE TABLE IF NOT EXISTS api_keys (key_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, prefix TEXT NOT NULL, created_at INTEGER NOT NULL, last_used INTEGER, revoked INTEGER NOT NULL DEFAULT 0)');
    this.apiKeysReady=true;
  }
  createApiKey(userId: string, name: string): { raw: string; prefix: string } {
    this.ensureApiKeys();
    const raw = `brc_ak_${randomToken(32)}`;
    const prefix = raw.slice(0, 18);
    this.db.prepare('INSERT INTO api_keys (key_hash, user_id, name, prefix, created_at) VALUES (?,?,?,?,?)').run(sha256(raw), userId, name, prefix, Date.now());
    return { raw, prefix };
  }
  getApiKey(raw: string): { user_id: string; name: string; prefix: string } | undefined {
    this.ensureApiKeys();
    const keyHash=sha256(raw);
    const row = this.statement('SELECT user_id, name, prefix, last_used FROM api_keys WHERE key_hash = ? AND revoked = 0').get(keyHash) as { user_id: string; name: string; prefix: string; last_used: number | null } | undefined;
    if (!row) return undefined;
    const now=Date.now();
    if(row.last_used===null || now-row.last_used>=30000) this.statement('UPDATE api_keys SET last_used = ? WHERE key_hash = ?').run(now,keyHash);
    return {user_id:row.user_id,name:row.name,prefix:row.prefix};
  }
  listApiKeys(userId: string): { prefix: string; name: string; created_at: number; last_used: number | null }[] {
    this.ensureApiKeys();
    return this.db.prepare('SELECT prefix, name, created_at, last_used FROM api_keys WHERE user_id = ? AND revoked = 0 ORDER BY created_at DESC').all(userId) as unknown as { prefix: string; name: string; created_at: number; last_used: number | null }[];
  }
  revokeApiKey(userId: string, prefix: string): void {
    this.ensureApiKeys();
    this.db.prepare('UPDATE api_keys SET revoked = 1 WHERE user_id = ? AND prefix = ?').run(userId, prefix);
  }

  /* ---------- OAuth-free MCP capability URLs (explicitly user-created configuration) ---------- */
  createConnectionLink(userId: string, rawName: string, mode: 'read' | 'full', days = 7): { id: string; key: string; expiresAt: number } {
    if (!['read', 'full'].includes(mode)) throw new Error('Invalid connection access mode');
    if (![1, 7, 30, 90, 365, 730].includes(days)) throw new Error('Invalid connection lifetime');
    const name = rawName.trim().slice(0, 80);
    if (!name) throw new Error('Connection name is required');
    const active = this.statement('SELECT COUNT(*) AS n FROM connection_links WHERE user_id = ? AND expires_at > ?').get(userId, Date.now()) as { n: number };
    if (active.n >= 20) throw new Error('Maximum 20 active connection URLs. Revoke an unused URL first.');
    const id = randomToken(12);
    const key = 'brc_link_' + randomToken(32);
    const expiresAt = Date.now() + days * 86_400_000;
    this.statement('INSERT INTO connection_links (id, user_id, name, mode, key_hash, created_at, expires_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, userId, name, mode, sha256(key), Date.now(), expiresAt);
    return { id, key, expiresAt };
  }
  listConnectionLinks(userId: string): ConnectionLinkRow[] {
    return this.statement('SELECT * FROM connection_links WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC')
      .all(userId, Date.now()) as unknown as ConnectionLinkRow[];
  }
  getConnectionLink(key: string): ConnectionLinkRow | undefined {
    // Do not cache authorization: revoking a URL takes effect on the next request.
    if (!/^brc_link_[A-Za-z0-9_-]{43}$/.test(key)) return undefined;
    return this.statement('SELECT * FROM connection_links WHERE key_hash = ? AND expires_at > ?')
      .get(sha256(key), Date.now()) as ConnectionLinkRow | undefined;
  }
  revokeConnectionLink(userId: string, id: string): boolean {
    return Number(this.statement('DELETE FROM connection_links WHERE id = ? AND user_id = ?').run(id, userId).changes) > 0;
  }

  close(): void { this.liveAudit=[]; this.statements.clear(); this.lastTouches.clear(); this.db.close(); }
}