/**
 * BRC relay store on node:sqlite (Node >= 22.13, no native build).
 * Tables: users, oauth_clients, auth_codes, tokens, devices, device_codes, audit.
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { UsageRecord, UsageDay, McpEstimateDelta, McpEstimateDay } from '../features/usage.js';
import type { SkillRow, SkillRequest } from '../features/skills.js';
import { MAX_OPERATION_ROWS_PER_USER, MAX_OPERATION_STORED_BYTES, type OperationRow, type OperationUpdate } from './operation-record.js';

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

/* Plugins: AI install requests awaiting owner approval, and last-known plugin lists per device.
   Neither table ever holds env values or header values (secrets go straight to the agent). */
const OPERATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS durable_operations (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, client_id TEXT NOT NULL,
 device_id TEXT NOT NULL, tool TEXT NOT NULL, args_hash TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('claimed','settled','uncertain')),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 encrypted_result TEXT, result_bytes INTEGER NOT NULL DEFAULT 0,
 result_sha256 TEXT, result_is_error INTEGER, error_code TEXT
);
CREATE INDEX IF NOT EXISTS durable_operations_owner ON durable_operations(user_id,client_id,created_at DESC);
CREATE INDEX IF NOT EXISTS durable_operations_expiry ON durable_operations(expires_at);
`;

const PLUGIN_SCHEMA = `
CREATE TABLE IF NOT EXISTS plugin_requests (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, device_id TEXT, client TEXT, registry_name TEXT, custom_type TEXT, custom_spec TEXT, plugin_id TEXT, reason TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, decided_at INTEGER, result TEXT);
CREATE INDEX IF NOT EXISTS plugin_requests_user ON plugin_requests(user_id, status);
CREATE TABLE IF NOT EXISTS device_plugins (device_id TEXT PRIMARY KEY, plugins TEXT NOT NULL, updated_at INTEGER NOT NULL);
`;

const FEATURE_SCHEMA = `
CREATE TABLE IF NOT EXISTS model_usage (id TEXT NOT NULL, user_id TEXT NOT NULL, day TEXT NOT NULL, ts INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, PRIMARY KEY (user_id,id));
CREATE INDEX IF NOT EXISTS model_usage_user_day ON model_usage(user_id,day);
-- Only anonymous aggregate counters: no prompts, code, paths or tool transcripts.
CREATE TABLE IF NOT EXISTS mcp_estimate_daily (
 user_id TEXT NOT NULL, day TEXT NOT NULL,
 input_tokens INTEGER NOT NULL DEFAULT 0,
 output_tokens INTEGER NOT NULL DEFAULT 0,
 calls INTEGER NOT NULL DEFAULT 0,
 partial_calls INTEGER NOT NULL DEFAULT 0,
 to_agent_bytes INTEGER NOT NULL DEFAULT 0,
 from_agent_bytes INTEGER NOT NULL DEFAULT 0,
 matched_calls INTEGER NOT NULL DEFAULT 0,
 universal_calls INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY (user_id,day));
CREATE INDEX IF NOT EXISTS mcp_estimate_day ON mcp_estimate_daily(day);
CREATE TABLE IF NOT EXISTS skills (user_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, source TEXT NOT NULL, files_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id,id));
CREATE TABLE IF NOT EXISTS skill_requests (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, skill_id TEXT NOT NULL, client TEXT NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS skill_requests_user ON skill_requests(user_id,created_at);
`;

export type PluginRequestStatus = 'pending' | 'approved' | 'installed' | 'failed' | 'rejected';
export interface PluginRequestRow {
  id: string; user_id: string; device_id: string | null; client: string | null;
  registry_name: string | null; custom_type: string | null; custom_spec: string | null; plugin_id: string | null;
  reason: string; status: PluginRequestStatus; created_at: number; decided_at: number | null; result: string | null;
}
export const MAX_PENDING_PLUGIN_REQUESTS = 20;

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
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON; PRAGMA busy_timeout = 1000;');
    this.db.exec(SCHEMA);
    this.db.exec(PLUGIN_SCHEMA);
    this.db.exec(FEATURE_SCHEMA);
    this.db.exec(OPERATION_SCHEMA);
    // Additive schema migration: preserves previously aggregated token history.
    const cols = new Set((this.db.prepare('PRAGMA table_info(mcp_estimate_daily)').all() as {name:string}[]).map(c=>c.name));
    for (const name of ['to_agent_bytes','from_agent_bytes','matched_calls','universal_calls']) {
      if (!cols.has(name)) this.db.exec('ALTER TABLE mcp_estimate_daily ADD COLUMN '+name+' INTEGER NOT NULL DEFAULT 0');
    }
    this.pruneAudit();
  }

  /* ---------- durable operation receipts ---------- */
  claimOperation(row:OperationRow):boolean{
    if(this.getOperation(row.id))return false;
    const count=this.statement('SELECT COUNT(*) AS n FROM durable_operations WHERE user_id=? AND expires_at>?')
      .get(row.user_id,Date.now()) as {n:number};
    if(count.n>=MAX_OPERATION_ROWS_PER_USER)throw new Error('RECOVERY_CAPACITY');
    return this.statement('INSERT OR IGNORE INTO durable_operations (id,user_id,client_id,device_id,tool,args_hash,state,created_at,updated_at,expires_at,encrypted_result,result_bytes,result_sha256,result_is_error,error_code) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(row.id,row.user_id,row.client_id,row.device_id,row.tool,row.args_hash,row.state,row.created_at,row.updated_at,row.expires_at,null,0,null,null,null).changes===1;
  }
  getOperation(id:string):OperationRow|undefined{
    return this.statement('SELECT * FROM durable_operations WHERE id=? AND expires_at>?')
      .get(id,Date.now()) as unknown as OperationRow|undefined;
  }
  recentOperations(userId:string,clientId:string,limit:number):OperationRow[]{
    return this.statement('SELECT * FROM durable_operations WHERE user_id=? AND client_id=? AND expires_at>? ORDER BY created_at DESC LIMIT ?')
      .all(userId,clientId,Date.now(),Math.max(1,Math.min(20,limit))) as unknown as OperationRow[];
  }
  settleOperation(id:string,update:OperationUpdate):void{
    let payload=update.encrypted_result;
    if(payload!==null){
      const amount=Buffer.byteLength(payload,'utf8');
      const previous=this.statement('SELECT COALESCE(LENGTH(encrypted_result),0) AS size FROM durable_operations WHERE id=?').get(id) as {size:number}|undefined;
      const total=this.statement('SELECT COALESCE(SUM(LENGTH(encrypted_result)),0) AS size FROM durable_operations').get() as {size:number};
      if(amount>MAX_OPERATION_STORED_BYTES || total.size-(previous?.size??0)+amount>MAX_OPERATION_STORED_BYTES)payload=null;
    }
    this.statement("UPDATE durable_operations SET state=?,updated_at=?,encrypted_result=?,result_bytes=?,result_sha256=?,result_is_error=?,error_code=? WHERE id=? AND state!='settled'")
      .run(update.state,update.updated_at,payload,update.result_bytes,
        update.result_sha256,update.result_is_error,update.error_code,id);
  }
  pruneOperations(now=Date.now()):number{
    return Number(this.statement('DELETE FROM durable_operations WHERE expires_at<=?').run(now).changes);
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
    this.db.prepare('DELETE FROM device_plugins WHERE device_id = ?').run(deviceId);
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
    this.pruneOperations(now);
    this.pruneAudit(now);
    this.statement('DELETE FROM model_usage WHERE day < ?').run(new Date(now - 400*86_400_000).toISOString().slice(0,10));
    this.statement('DELETE FROM mcp_estimate_daily WHERE day < ?').run(new Date(now - 400*86_400_000).toISOString().slice(0,10));
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

  /* ---------- plugin install requests (AI -> owner approval) ---------- */
  createPluginRequest(row: Pick<PluginRequestRow, 'user_id' | 'device_id' | 'client' | 'registry_name' | 'custom_type' | 'custom_spec' | 'plugin_id' | 'reason'>): PluginRequestRow {
    const pending = this.db.prepare("SELECT COUNT(*) AS n FROM plugin_requests WHERE user_id = ? AND status = 'pending'").get(row.user_id) as { n: number };
    if (pending.n >= MAX_PENDING_PLUGIN_REQUESTS) throw new Error(`too many pending plugin requests (${pending.n}); ask the owner to review /admin`);
    const full: PluginRequestRow = { ...row, id: `pr_${randomToken(9)}`, status: 'pending', created_at: Date.now(), decided_at: null, result: null };
    this.db.prepare('INSERT INTO plugin_requests (id,user_id,device_id,client,registry_name,custom_type,custom_spec,plugin_id,reason,status,created_at,decided_at,result) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(full.id, full.user_id, full.device_id, full.client, full.registry_name, full.custom_type, full.custom_spec, full.plugin_id, full.reason, full.status, full.created_at, full.decided_at, full.result);
    return full;
  }
  /** Same request still pending (dedupe repeated AI calls). */
  findPendingPluginRequest(userId: string, deviceId: string | null, registryName: string | null, customType: string | null, customSpec: string | null): PluginRequestRow | undefined {
    return this.db.prepare("SELECT * FROM plugin_requests WHERE user_id = ? AND status = 'pending' AND device_id IS ? AND registry_name IS ? AND custom_type IS ? AND custom_spec IS ?")
      .get(userId, deviceId, registryName, customType, customSpec) as PluginRequestRow | undefined;
  }
  getPluginRequest(id: string): PluginRequestRow | undefined {
    return this.db.prepare('SELECT * FROM plugin_requests WHERE id = ?').get(id) as PluginRequestRow | undefined;
  }
  listPluginRequests(userId: string, opts: { status?: PluginRequestStatus; limit?: number } = {}): PluginRequestRow[] {
    const limit = opts.limit ?? 50;
    return (opts.status
      ? this.db.prepare('SELECT * FROM plugin_requests WHERE user_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?').all(userId, opts.status, limit)
      : this.db.prepare('SELECT * FROM plugin_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(userId, limit)) as unknown as PluginRequestRow[];
  }
  /** Move a request to a new status. `from` guards against double decisions. Returns false if not in `from`. */
  setPluginRequestStatus(id: string, status: PluginRequestStatus, result: string | null = null, from: PluginRequestStatus[] = ['pending', 'approved']): boolean {
    const placeholders = from.map(() => '?').join(',');
    const r = this.db.prepare(`UPDATE plugin_requests SET status = ?, result = ?, decided_at = ? WHERE id = ? AND status IN (${placeholders})`)
      .run(status, result ? result.slice(0, 2000) : null, Date.now(), id, ...from);
    return Number(r.changes) > 0;
  }

  /* ---------- last-known plugin lists ---------- */
  saveDevicePlugins(deviceId: string, plugins: unknown[]): void {
    this.db.prepare('INSERT INTO device_plugins (device_id, plugins, updated_at) VALUES (?,?,?) ON CONFLICT(device_id) DO UPDATE SET plugins = excluded.plugins, updated_at = excluded.updated_at')
      .run(deviceId, JSON.stringify(plugins), Date.now());
  }
  getDevicePlugins(deviceId: string): { plugins: unknown[]; updated_at: number } | undefined {
    const row = this.db.prepare('SELECT plugins, updated_at FROM device_plugins WHERE device_id = ?').get(deviceId) as { plugins: string; updated_at: number } | undefined;
    if (!row) return undefined;
    try { return { plugins: JSON.parse(row.plugins) as unknown[], updated_at: row.updated_at }; } catch { return undefined; }
  }

  /* ---------- explicitly reported model tokens: never sampled from MCP calls ---------- */
  recordTokenUsage(r: UsageRecord): boolean {
    return Number(this.statement('INSERT OR IGNORE INTO model_usage (id,user_id,day,ts,provider,model,input_tokens,output_tokens) VALUES (?,?,?,?,?,?,?,?)')
      .run(r.id,r.user_id,r.day,r.ts,r.provider,r.model,r.input_tokens,r.output_tokens).changes) === 1;
  }
  usageDays(userId: string, sinceDay: string): UsageDay[] {
    return this.statement('SELECT day,SUM(input_tokens) AS input_tokens,SUM(output_tokens) AS output_tokens,COUNT(*) AS reports FROM model_usage WHERE user_id = ? AND day >= ? GROUP BY day ORDER BY day')
      .all(userId,sinceDay).map(v => ({ day:String(v.day), input_tokens:Number(v.input_tokens), output_tokens:Number(v.output_tokens), reports:Number(v.reports) }));
  }

  /* ---------- batched estimated MCP traffic: daily totals, no payload storage ---------- */
  recordMcpEstimates(rows: McpEstimateDelta[]): void {
    if (!rows.length) return;
    const statement = this.statement(
      'INSERT INTO mcp_estimate_daily (user_id,day,input_tokens,output_tokens,calls,partial_calls,to_agent_bytes,from_agent_bytes,matched_calls,universal_calls) VALUES (?,?,?,?,?,?,?,?,?,?) ' +
      'ON CONFLICT(user_id,day) DO UPDATE SET input_tokens=input_tokens+excluded.input_tokens, ' +
      'output_tokens=output_tokens+excluded.output_tokens, calls=calls+excluded.calls, partial_calls=partial_calls+excluded.partial_calls, ' +
      'to_agent_bytes=to_agent_bytes+excluded.to_agent_bytes,from_agent_bytes=from_agent_bytes+excluded.from_agent_bytes, ' +
      'matched_calls=matched_calls+excluded.matched_calls,universal_calls=universal_calls+excluded.universal_calls'
    );
    this.db.exec('BEGIN');
    try {
      for (const r of rows) statement.run(r.user_id,r.day,r.input_tokens,r.output_tokens,r.calls,r.partial_calls,r.to_agent_bytes,r.from_agent_bytes,r.matched_calls,r.universal_calls);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  mcpEstimateDays(userId: string, sinceDay: string): McpEstimateDay[] {
    return this.statement(
      'SELECT day,input_tokens,output_tokens,calls AS reports,partial_calls,to_agent_bytes,from_agent_bytes,matched_calls,universal_calls FROM mcp_estimate_daily ' +
      'WHERE user_id = ? AND day >= ? ORDER BY day'
    ).all(userId,sinceDay).map(v => ({
      day:String(v.day), input_tokens:Number(v.input_tokens),output_tokens:Number(v.output_tokens),
      reports:Number(v.reports),partial_calls:Number(v.partial_calls),
      to_agent_bytes:Number(v.to_agent_bytes),from_agent_bytes:Number(v.from_agent_bytes),
      matched_calls:Number(v.matched_calls),universal_calls:Number(v.universal_calls)
    }));
  }

  /* ---------- owner-controlled skill library and review queue ---------- */
  saveSkill(r: SkillRow): void {
    this.statement('INSERT INTO skills (user_id,id,name,description,source,files_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(user_id,id) DO UPDATE SET name=excluded.name,description=excluded.description,source=excluded.source,files_json=excluded.files_json,updated_at=excluded.updated_at')
      .run(r.user_id,r.id,r.name,r.description,r.source,r.files_json,r.created_at,r.updated_at);
    this.statement('DELETE FROM skill_requests WHERE user_id = ? AND skill_id = ?').run(r.user_id,r.id);
  }
  listSkills(userId: string): SkillRow[] {
    return this.statement('SELECT * FROM skills WHERE user_id = ? ORDER BY name COLLATE NOCASE').all(userId) as unknown as SkillRow[];
  }
  getSkill(userId: string, id: string): SkillRow | undefined {
    return this.statement('SELECT * FROM skills WHERE user_id = ? AND id = ?').get(userId,id) as SkillRow | undefined;
  }
  deleteSkill(userId: string, id: string): boolean {
    return Number(this.statement('DELETE FROM skills WHERE user_id = ? AND id = ?').run(userId,id).changes)>0;
  }
  createSkillRequest(userId:string,skillId:string,client:string,reason:string): SkillRequest {
    const prior=this.statement('SELECT * FROM skill_requests WHERE user_id=? AND skill_id=?').get(userId,skillId) as SkillRequest|undefined;
    if(prior)return prior;
    const pending=this.statement('SELECT COUNT(*) AS n FROM skill_requests WHERE user_id=?').get(userId) as {n:number};
    if(pending.n>=20)throw Error('Maximum 20 pending skill requests');
    const r:SkillRequest={id:'sr_'+randomToken(9),user_id:userId,skill_id:skillId,client:client.slice(0,120),reason:reason.slice(0,500),created_at:Date.now()};
    this.statement('INSERT INTO skill_requests VALUES (?,?,?,?,?,?)').run(r.id,r.user_id,r.skill_id,r.client,r.reason,r.created_at);
    return r;
  }
  listSkillRequests(userId:string):SkillRequest[] {
    return this.statement('SELECT * FROM skill_requests WHERE user_id=? ORDER BY created_at DESC LIMIT 50').all(userId) as unknown as SkillRequest[];
  }
  deleteSkillRequest(userId:string,id:string):boolean {
    return Number(this.statement('DELETE FROM skill_requests WHERE user_id=? AND id=?').run(userId,id).changes)>0;
  }

  close(): void { this.liveAudit=[]; this.statements.clear(); this.lastTouches.clear(); this.db.close(); }
}