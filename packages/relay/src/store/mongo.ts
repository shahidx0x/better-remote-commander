/**
 * MongoDB-backed relay persistence. MongoDB is the only durable store in this
 * mode: no SQLite database file is created, and credentials are stored hashed.
 * Every security-sensitive write is awaited before HTTP responses are sent.
 */
import { MongoClient, type Db, type Document } from 'mongodb';
import { randomBytes } from 'node:crypto';
import { hashPassword, randomToken, sha256, type UserRow, type ClientRow, type AuthCodeRow, type TokenRow,
  type DeviceRow, type DeviceCodeRow, type AuditRow, type ConnectionLinkRow } from './sqlite.js';
import type { RelayStore } from './types.js';
import { MAX_PENDING_PLUGIN_REQUESTS, type PluginRequestStatus, type PluginRequestRow } from './sqlite.js';
import type { UsageRecord, UsageDay, McpEstimateDelta, McpEstimateDay } from '../features/usage.js';
import type { SkillRow, SkillRequest } from '../features/skills.js';
import { MAX_OPERATION_ROWS_PER_USER, MAX_OPERATION_STORED_BYTES, type OperationRow, type OperationUpdate } from './operation-record.js';

export class MongoStore implements RelayStore {
  readonly auditRetentionMs = 0;
  private liveAudit: AuditRow[] = [];
  private auditSequence = 0;
  private lastTouches = new Map<string, number>();

  private constructor(private readonly client: MongoClient, private readonly db: Db) {}

  static async connect(uri: string, dbName?: string): Promise<MongoStore> {
    if (!/^mongodb(?:\+srv)?:\/\//i.test(uri)) throw new Error('MONGODB_URI must begin with mongodb:// or mongodb+srv://');
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 6000, connectTimeoutMS: 6000,
      maxPoolSize: 12, minPoolSize: 0, retryWrites: true, appName: 'brc-relay' });
    try {
      await client.connect();
      const configuredDatabase = dbName || ((new URL(uri).pathname || '/').replace(/^\//, '') ? undefined : 'brc_relay');
      const db = client.db(configuredDatabase);
      await db.command({ ping: 1 });
      const store = new MongoStore(client, db);
      await store.ensureIndexes();
      return store;
    } catch (err) {
      await client.close().catch(() => undefined);
      // Mongo client errors may contain full hostnames/credentials. Don't log the URI.
      // Do not attach the driver error as cause: it can contain credentials in URI fragments.
      throw new Error('MongoDB connection or index initialization failed; check MONGODB_URI, permissions and network');
    }
  }

  /** No credentials in diagnostics. */
  get databaseName(): string { return this.db.databaseName; }
  async ping(): Promise<void> { await this.db.command({ ping: 1 }); }
  private col(name: string) { return this.db.collection<Document & { _id: string }>(name); }

  private async ensureIndexes(): Promise<void> {
    const indexes = [
      this.col('users').createIndex({ username: 1 }, { unique: true }),
      this.col('oauth_clients').createIndex({ created_at: -1 }),
      this.col('connection_links').createIndex({ key_hash: 1 }, { unique: true }),
      this.col('connection_links').createIndex({ user_id: 1, expires_at: 1 }),
      this.col('devices').createIndex({ token_hash: 1 }, { unique: true }),
      this.col('devices').createIndex({ user_id: 1, created_at: 1 }),
      this.col('device_codes').createIndex({ user_code: 1 }, { unique: true }),
      this.col('api_keys').createIndex({ user_id: 1, prefix: 1 }),
      this.col('tokens').createIndex({ client_id: 1, user_id: 1 }),
      this.col('plugin_requests').createIndex({ user_id: 1, status: 1, created_at: -1 }),
      this.col('device_plugins').createIndex({ updated_at: -1 }),
      this.col('model_usage').createIndex({ user_id: 1, day: 1 }),
      this.col('model_usage').createIndex({ expire_on: 1 }, { expireAfterSeconds: 0 }),
      this.col('mcp_estimate_daily').createIndex({ user_id: 1, day: 1 }),
      this.col('mcp_estimate_daily').createIndex({ expire_on: 1 }, { expireAfterSeconds: 0 }),
      this.col('skills').createIndex({ user_id: 1, name: 1 }),
      this.col('skill_requests').createIndex({ user_id: 1, skill_id: 1 }, { unique: true }),
      this.col('durable_operations').createIndex({ user_id:1,client_id:1,created_at:-1 }),
      this.col('durable_operations').createIndex({ expire_on:1 }, { expireAfterSeconds:0 }),
    ];
    // TTL indexes remove expired records without a background relay database process.
    for (const name of ['auth_codes', 'device_codes', 'connection_links', 'tokens']) {
      indexes.push(this.col(name).createIndex({ expire_on: 1 }, { expireAfterSeconds: 0 }));
    }
    await Promise.all(indexes);
  }

  private static row<T>(doc: Document | null): T | undefined {
    if (!doc) return undefined;
    const { _id: _ignored, expire_on: _expiry, ...row } = doc;
    return row as T;
  }
  private static expire(expires: number, extraMs = 0): Date {
    return new Date(expires + extraMs);
  }

  /* ---------- durable operation receipts ---------- */
  async claimOperation(row:OperationRow):Promise<boolean>{
    if(await this.getOperation(row.id))return false;
    const count=await this.col('durable_operations').countDocuments({user_id:row.user_id,expires_at:{$gt:Date.now()}});
    if(count>=MAX_OPERATION_ROWS_PER_USER)throw new Error('RECOVERY_CAPACITY');
    try{
      await this.col('durable_operations').insertOne({ _id:row.id,...row,expire_on:new Date(row.expires_at) },
        {writeConcern:{j:true}});
      return true;
    }catch(error){
      if((error as {code?:unknown})?.code===11000)return false;
      throw error;
    }
  }
  async getOperation(id:string):Promise<OperationRow|undefined>{
    return MongoStore.row<OperationRow>(await this.col('durable_operations').findOne({_id:id,expires_at:{$gt:Date.now()}}));
  }
  async recentOperations(userId:string,clientId:string,limit:number):Promise<OperationRow[]>{
    return (await this.col('durable_operations').find({user_id:userId,client_id:clientId,expires_at:{$gt:Date.now()}})
      .sort({created_at:-1}).limit(Math.max(1,Math.min(20,limit))).toArray()).map(r=>MongoStore.row<OperationRow>(r)!);
  }
  async settleOperation(id:string,update:OperationUpdate):Promise<void>{
    let payload=update.encrypted_result;
    if(payload!==null){
      const rows=await this.col('durable_operations').aggregate<{bytes:number}>([
        {$match:{encrypted_result:{$type:'string'},expires_at:{$gt:Date.now()}}},
        {$group:{_id:null,bytes:{$sum:{$strLenBytes:'$encrypted_result'}}}}
      ]).toArray();
      const existing=await this.getOperation(id);
      const total=rows[0]?.bytes??0;
      const previous=existing?.encrypted_result?Buffer.byteLength(existing.encrypted_result,'utf8'):0;
      if(Buffer.byteLength(payload,'utf8')+total-previous>MAX_OPERATION_STORED_BYTES)payload=null;
    }
    await this.col('durable_operations').updateOne({_id:id,state:{$ne:'settled'}},{$set:{
      state:update.state,updated_at:update.updated_at,encrypted_result:payload,
      result_bytes:update.result_bytes,
      result_sha256:update.result_sha256,
      result_is_error:update.result_is_error,error_code:update.error_code
    }},{writeConcern:{j:true}});
  }
  async pruneOperations(now=Date.now()):Promise<number>{
    return (await this.col('durable_operations').deleteMany({expires_at:{$lte:now}})).deletedCount;
  }

  /* ---------- users ---------- */
  async getUserByName(username: string): Promise<UserRow | undefined> {
    return MongoStore.row<UserRow>(await this.col('users').findOne({ username }));
  }
  async getUser(id: string): Promise<UserRow | undefined> {
    return MongoStore.row<UserRow>(await this.col('users').findOne({ _id: id }));
  }
  async upsertUser(username: string, password: string): Promise<UserRow> {
    const password_hash = hashPassword(password);
    const created_at = Date.now();
    const id = randomToken(12);
    await this.col('users').updateOne({ username }, {
      $set: { password_hash },
      $setOnInsert: { _id: id, id, username, created_at },
    }, { upsert: true });
    const user = await this.getUserByName(username);
    if (!user) throw new Error('Admin user update failed');
    return user;
  }

  /* ---------- OAuth clients ---------- */
  async getClient(clientId: string): Promise<ClientRow | undefined> {
    return MongoStore.row<ClientRow>(await this.col('oauth_clients').findOne({ _id: clientId }));
  }
  async insertClient(row: ClientRow): Promise<void> {
    await this.col('oauth_clients').insertOne({ _id: row.client_id, ...row });
  }
  async updateClientMetadata(clientId: string, metadata: string): Promise<void> {
    const result = await this.col('oauth_clients').updateOne({ _id: clientId }, { $set: { metadata } });
    if (result.matchedCount !== 1) throw new Error('OAuth client was removed while its callback was being approved');
  }
  async listClients(): Promise<ClientRow[]> {
    return (await this.col('oauth_clients').find({}).sort({ created_at: -1 }).toArray())
      .map(d => MongoStore.row<ClientRow>(d)!);
  }
  async deleteClient(clientId: string): Promise<void> {
    await this.col('tokens').updateMany({ client_id: clientId }, { $set: { revoked: 1 } });
    await this.col('oauth_clients').deleteOne({ _id: clientId });
  }

  /* ---------- authorization codes ---------- */
  async insertAuthCode(row: AuthCodeRow): Promise<void> {
    await this.col('auth_codes').insertOne({ _id: row.code, ...row, expire_on: MongoStore.expire(row.expires_at) });
  }
  async peekAuthCode(code: string): Promise<AuthCodeRow | undefined> {
    return MongoStore.row<AuthCodeRow>(await this.col('auth_codes').findOne({ _id: code, expires_at: { $gt: Date.now() } }));
  }
  async takeAuthCode(code: string): Promise<AuthCodeRow | undefined> {
    // Atomic one-time use even with multiple relay processes.
    return MongoStore.row<AuthCodeRow>(await this.col('auth_codes').findOneAndDelete({ _id: code, expires_at: { $gt: Date.now() } }));
  }

  /* ---------- access & refresh tokens ---------- */
  async insertToken(row: TokenRow): Promise<void> {
    await this.col('tokens').insertOne({ _id: row.token_hash, ...row,
      ...(row.expires_at === null ? {} : { expire_on: MongoStore.expire(row.expires_at, 7 * 86_400_000) }) });
  }
  async getToken(raw: string, kind: 'access' | 'refresh'): Promise<TokenRow | undefined> {
    const row = MongoStore.row<TokenRow>(await this.col('tokens').findOne({
      _id: sha256(raw), kind, revoked: 0, $or: [{ expires_at: null }, { expires_at: { $gt: Date.now() } }],
    }));
    return row;
  }
  async revokeToken(raw: string): Promise<void> {
    await this.col('tokens').updateOne({ _id: sha256(raw) }, { $set: { revoked: 1 } });
  }
  async revokeTokensForClient(clientId: string, userId?: string): Promise<void> {
    await this.col('tokens').updateMany({ client_id: clientId, ...(userId ? { user_id: userId } : {}) }, { $set: { revoked: 1 } });
  }

  /* ---------- paired devices ---------- */
  async getDeviceByToken(raw: string): Promise<DeviceRow | undefined> {
    return MongoStore.row<DeviceRow>(await this.col('devices').findOne({ token_hash: sha256(raw) }));
  }
  async getDevice(deviceId: string): Promise<DeviceRow | undefined> {
    return MongoStore.row<DeviceRow>(await this.col('devices').findOne({ _id: deviceId }));
  }
  async listDevices(userId: string): Promise<DeviceRow[]> {
    return (await this.col('devices').find({ user_id: userId }).sort({ created_at: 1 }).toArray())
      .map(d => MongoStore.row<DeviceRow>(d)!);
  }
  async issueDeviceToken(deviceId: string, userId: string, name: string, platform: string | null): Promise<string> {
    const raw = 'brc_dev_' + randomToken(32);
    const created_at = Date.now();
    await this.col('devices').updateOne({ _id: deviceId }, {
      $set: { user_id: userId, name, platform, token_hash: sha256(raw) },
      $setOnInsert: { _id: deviceId, device_id: deviceId, created_at, last_seen: null, paused: 0 },
    }, { upsert: true });
    return raw;
  }
  async touchDevice(deviceId: string): Promise<void> {
    const now = Date.now();
    if (now - (this.lastTouches.get(deviceId) ?? 0) < 5000) return;
    await this.col('devices').updateOne({ _id: deviceId }, { $set: { last_seen: now } });
    this.lastTouches.delete(deviceId);
    this.lastTouches.set(deviceId, now);
    while (this.lastTouches.size > 1024) this.lastTouches.delete(this.lastTouches.keys().next().value!);
  }
  async setDevicePaused(deviceId: string, paused: boolean): Promise<void> {
    await this.col('devices').updateOne({ _id: deviceId }, { $set: { paused: paused ? 1 : 0 } });
  }
  async renameDevice(deviceId: string, name: string): Promise<void> {
    await this.col('devices').updateOne({ _id: deviceId }, { $set: { name } });
  }
  async deleteDevice(deviceId: string): Promise<void> {
    this.lastTouches.delete(deviceId);
    await this.col('devices').deleteOne({ _id: deviceId });
    await this.col('device_plugins').deleteOne({ _id: deviceId });
  }

  /* ---------- device pairing ---------- */
  private static userCode(): string {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const b = randomBytes(8);
    const s = [...b].map(x => alphabet[x % alphabet.length]).join('');
    return s.slice(0, 4) + '-' + s.slice(4);
  }
  async createDeviceCode(clientName: string, ttlMs: number): Promise<DeviceCodeRow> {
    const row: DeviceCodeRow = {
      device_code: randomToken(32), user_code: MongoStore.userCode(), client_name: clientName,
      user_id: null, approved: 0, denied: 0, device_id: null,
      expires_at: Date.now() + ttlMs, created_at: Date.now(),
    };
    await this.col('device_codes').insertOne({ _id: row.device_code, ...row, expire_on: MongoStore.expire(row.expires_at) });
    return row;
  }
  async getDeviceCode(deviceCode: string): Promise<DeviceCodeRow | undefined> {
    return MongoStore.row<DeviceCodeRow>(await this.col('device_codes').findOne({ _id: deviceCode }));
  }
  async getDeviceCodeByUserCode(userCode: string): Promise<DeviceCodeRow | undefined> {
    const normalized = userCode.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^(.{4})(.{4})$/, '$1-$2');
    return MongoStore.row<DeviceCodeRow>(await this.col('device_codes').findOne({ user_code: normalized }));
  }
  async approveDeviceCode(deviceCode: string, userId: string, deviceId: string): Promise<void> {
    await this.col('device_codes').updateOne({ _id: deviceCode }, { $set: { approved: 1, user_id: userId, device_id: deviceId } });
  }
  async denyDeviceCode(deviceCode: string): Promise<void> {
    await this.col('device_codes').updateOne({ _id: deviceCode }, { $set: { denied: 1 } });
  }
  async deleteDeviceCode(deviceCode: string): Promise<void> {
    await this.col('device_codes').deleteOne({ _id: deviceCode });
  }

  /* ---------- operational API keys ---------- */
  async createApiKey(userId: string, name: string): Promise<{ raw: string; prefix: string }> {
    const raw = 'brc_ak_' + randomToken(32);
    const prefix = raw.slice(0, 18);
    await this.col('api_keys').insertOne({ _id: sha256(raw), key_hash: sha256(raw), user_id: userId, name, prefix,
      created_at: Date.now(), last_used: null, revoked: 0 });
    return { raw, prefix };
  }
  async getApiKey(raw: string): Promise<{ user_id: string; name: string; prefix: string } | undefined> {
    const doc = await this.col('api_keys').findOne({ _id: sha256(raw), revoked: 0 });
    if (!doc) return undefined;
    const now = Date.now();
    if (typeof doc.last_used !== 'number' || now - doc.last_used >= 30_000)
      await this.col('api_keys').updateOne({ _id: doc._id, revoked: 0 }, { $set: { last_used: now } });
    return { user_id: doc.user_id as string, name: doc.name as string, prefix: doc.prefix as string };
  }
  async listApiKeys(userId: string): Promise<{ prefix: string; name: string; created_at: number; last_used: number | null }[]> {
    const docs = await this.col('api_keys').find({ user_id: userId, revoked: 0 }).sort({ created_at: -1 }).toArray();
    return docs.map(d => ({ prefix: String(d.prefix), name: String(d.name), created_at: Number(d.created_at),
      last_used: typeof d.last_used === 'number' ? d.last_used : null }));
  }
  async revokeApiKey(userId: string, prefix: string): Promise<void> {
    await this.col('api_keys').updateOne({ user_id: userId, prefix }, { $set: { revoked: 1 } });
  }

  /* ---------- private URL capabilities ---------- */
  async createConnectionLink(userId: string, rawName: string, mode: 'read' | 'full', days = 7): Promise<{ id: string; key: string; expiresAt: number }> {
    if (!['read', 'full'].includes(mode)) throw new Error('Invalid connection access mode');
    if (![1, 7, 30, 90, 365, 730].includes(days)) throw new Error('Invalid connection lifetime');
    const name = rawName.trim().slice(0, 80);
    if (!name) throw new Error('Connection name is required');
    const n = await this.col('connection_links').countDocuments({ user_id: userId, expires_at: { $gt: Date.now() } }, { limit: 21 });
    if (n >= 20) throw new Error('Maximum 20 active connection URLs. Revoke an unused URL first.');
    const id = randomToken(12), key = 'brc_link_' + randomToken(32);
    const expiresAt = Date.now() + days * 86_400_000;
    await this.col('connection_links').insertOne({ _id: id, id, user_id: userId, name, mode, key_hash: sha256(key),
      created_at: Date.now(), expires_at: expiresAt, expire_on: MongoStore.expire(expiresAt) });
    return { id, key, expiresAt };
  }
  async listConnectionLinks(userId: string): Promise<ConnectionLinkRow[]> {
    return (await this.col('connection_links').find({ user_id: userId, expires_at: { $gt: Date.now() } })
      .sort({ created_at: -1 }).toArray()).map(d => MongoStore.row<ConnectionLinkRow>(d)!);
  }
  async getConnectionLink(key: string): Promise<ConnectionLinkRow | undefined> {
    if (!/^brc_link_[A-Za-z0-9_-]{43}$/.test(key)) return undefined;
    return MongoStore.row<ConnectionLinkRow>(await this.col('connection_links').findOne({ key_hash: sha256(key),
      expires_at: { $gt: Date.now() } }));
  }
  async revokeConnectionLink(userId: string, id: string): Promise<boolean> {
    return (await this.col('connection_links').deleteOne({ _id: id, user_id: userId })).deletedCount > 0;
  }

  /* ---------- volatile audit: NEVER saved in MongoDB ---------- */
  audit(row: Omit<AuditRow, 'id'>): void {
    this.liveAudit.push({ ...row, id: ++this.auditSequence, args_hash: null, error: row.ok ? null : 'TOOL_FAILED' });
    if (this.liveAudit.length > 1000) this.liveAudit.shift();
  }
  recentAudit(userId: string, limit = 100): AuditRow[] {
    return this.liveAudit.filter(r => r.user_id === userId)
      .slice(-Math.min(1000, Math.max(1, limit))).reverse().map(r => ({ ...r }));
  }
  auditStats(userId: string): { total: number; failed: number; last24h: number } {
    const rows = this.liveAudit.filter(r => r.user_id === userId);
    return { total: rows.length, failed: rows.filter(r => !r.ok).length,
      last24h: rows.filter(r => r.ts > Date.now() - 86_400_000).length };
  }
  pruneAudit(): number { return 0; }
  async vacuumExpired(): Promise<void> {
    const now = Date.now();
    await Promise.all([
      this.col('auth_codes').deleteMany({ expires_at: { $lte: now } }),
      this.col('device_codes').deleteMany({ expires_at: { $lte: now } }),
      this.col('connection_links').deleteMany({ expires_at: { $lte: now } }),
      this.col('tokens').deleteMany({ expires_at: { $lte: now - 7 * 86_400_000 } }),
    ]);
  }

  /* ---------- plugin install requests (AI -> owner approval) ---------- */
  async createPluginRequest(row: Pick<PluginRequestRow, 'user_id' | 'device_id' | 'client' | 'registry_name' | 'custom_type' | 'custom_spec' | 'plugin_id' | 'reason'>): Promise<PluginRequestRow> {
    const count = await this.col('plugin_requests').countDocuments({ user_id: row.user_id, status: 'pending' }, { limit: MAX_PENDING_PLUGIN_REQUESTS });
    if (count >= MAX_PENDING_PLUGIN_REQUESTS) throw new Error('Too many pending plugin requests; ask the owner to review /admin');
    const full: PluginRequestRow = { ...row, id: 'pr_' + randomToken(9), status: 'pending', created_at: Date.now(), decided_at: null, result: null };
    await this.col('plugin_requests').insertOne({ _id: full.id, ...full });
    return full;
  }
  async findPendingPluginRequest(userId: string, deviceId: string | null, registryName: string | null, customType: string | null, customSpec: string | null): Promise<PluginRequestRow | undefined> {
    return MongoStore.row<PluginRequestRow>(await this.col('plugin_requests').findOne({ user_id: userId, status: 'pending', device_id: deviceId, registry_name: registryName, custom_type: customType, custom_spec: customSpec }));
  }
  async getPluginRequest(id: string): Promise<PluginRequestRow | undefined> {
    return MongoStore.row<PluginRequestRow>(await this.col('plugin_requests').findOne({ _id: id }));
  }
  async listPluginRequests(userId: string, opts: { status?: PluginRequestStatus; limit?: number } = {}): Promise<PluginRequestRow[]> {
    const limit = Math.min(100, Math.max(1, Math.trunc(opts.limit ?? 50)));
    const docs = await this.col('plugin_requests').find({ user_id: userId, ...(opts.status ? { status: opts.status } : {}) }).sort({ created_at: -1 }).limit(limit).toArray();
    return docs.map(d => MongoStore.row<PluginRequestRow>(d)!);
  }
  async setPluginRequestStatus(id: string, status: PluginRequestStatus, result: string | null = null, from: PluginRequestStatus[] = ['pending', 'approved']): Promise<boolean> {
    if (!from.length) return false;
    const update = await this.col('plugin_requests').updateOne({ _id: id, status: { $in: from } }, { $set: { status, result: result ? result.slice(0, 2000) : null, decided_at: Date.now() } });
    return update.modifiedCount > 0;
  }
  /* ---------- last-known plugin lists, never secret values ---------- */
  async saveDevicePlugins(deviceId: string, plugins: unknown[]): Promise<void> {
    await this.col('device_plugins').updateOne({ _id: deviceId }, { $set: { plugins, updated_at: Date.now() } }, { upsert: true });
  }
  async getDevicePlugins(deviceId: string): Promise<{ plugins: unknown[]; updated_at: number } | undefined> {
    const row = await this.col('device_plugins').findOne({ _id: deviceId });
    if (!row) return undefined;
    return { plugins: Array.isArray(row.plugins) ? row.plugins : [], updated_at: Number(row.updated_at || 0) };
  }

  /* ---------- provider-reported model usage: never in MCP hot path ---------- */
  async recordTokenUsage(r: UsageRecord): Promise<boolean> {
    try {
      await this.col('model_usage').insertOne({ _id: r.user_id + '/' + r.id, ...r,
        expire_on: new Date(r.ts + 400*86_400_000) });
      return true;
    } catch(e) {
      if((e as {code?:number}).code===11000)return false;
      throw e;
    }
  }
  async usageDays(userId:string,sinceDay:string):Promise<UsageDay[]> {
    const rows=await this.col('model_usage').aggregate([
      { $match: { user_id:userId, day:{ $gte:sinceDay } } },
      { $group: { _id:'$day', input_tokens:{ $sum:'$input_tokens' }, output_tokens:{ $sum:'$output_tokens' }, reports:{ $sum:1 } } },
      { $sort: { _id:1 } }
    ]).toArray();
    return rows.map(r=>({day:String(r._id),input_tokens:Number(r.input_tokens),output_tokens:Number(r.output_tokens),reports:Number(r.reports)}));
  }

  /* ---------- batched estimated MCP traffic: daily totals only ---------- */
  async recordMcpEstimates(rows: McpEstimateDelta[]): Promise<void> {
    if (!rows.length) return;
    await this.col('mcp_estimate_daily').bulkWrite(rows.map(r => ({
      updateOne: {
        filter: { _id: r.user_id + '/' + r.day },
        update: {
          $setOnInsert: {
            user_id:r.user_id,day:r.day,
            expire_on:new Date(Date.parse(r.day+'T00:00:00Z')+401*86_400_000)
          },
          $inc: {
            input_tokens:r.input_tokens,output_tokens:r.output_tokens,
            calls:r.calls,partial_calls:r.partial_calls,
            to_agent_bytes:r.to_agent_bytes,from_agent_bytes:r.from_agent_bytes,
            matched_calls:r.matched_calls,universal_calls:r.universal_calls
          }
        },
        upsert:true
      }
    })),{ordered:false});
  }
  async mcpEstimateDays(userId:string,sinceDay:string):Promise<McpEstimateDay[]> {
    const rows=await this.col('mcp_estimate_daily').find({user_id:userId,day:{$gte:sinceDay}}).sort({day:1}).toArray();
    return rows.map(r=>({
      day:String(r.day),input_tokens:Number(r.input_tokens),output_tokens:Number(r.output_tokens),
      reports:Number(r.calls),partial_calls:Number(r.partial_calls),
      to_agent_bytes:Number(r.to_agent_bytes ?? 0),from_agent_bytes:Number(r.from_agent_bytes ?? 0),
      matched_calls:Number(r.matched_calls ?? 0),universal_calls:Number(r.universal_calls ?? 0)
    }));
  }

  /* ---------- owner-approved skills, stored per account ---------- */
  async saveSkill(r:SkillRow):Promise<void> {
    await this.col('skills').updateOne({_id:r.user_id+'/'+r.id},
      {$set:{...r}},{upsert:true});
    await this.col('skill_requests').deleteMany({user_id:r.user_id,skill_id:r.id});
  }
  async listSkills(userId:string):Promise<SkillRow[]> {
    return (await this.col('skills').find({user_id:userId}).sort({name:1}).toArray()).map(r=>MongoStore.row<SkillRow>(r)!);
  }
  async getSkill(userId:string,id:string):Promise<SkillRow|undefined> {
    return MongoStore.row<SkillRow>(await this.col('skills').findOne({_id:userId+'/'+id,user_id:userId}));
  }
  async deleteSkill(userId:string,id:string):Promise<boolean> {
    return (await this.col('skills').deleteOne({_id:userId+'/'+id,user_id:userId})).deletedCount>0;
  }
  async createSkillRequest(userId:string,skillId:string,client:string,reason:string):Promise<SkillRequest> {
    const prior=MongoStore.row<SkillRequest>(await this.col('skill_requests').findOne({user_id:userId,skill_id:skillId}));
    if(prior)return prior;
    const n=await this.col('skill_requests').countDocuments({user_id:userId},{limit:21});
    if(n>=20)throw Error('Maximum 20 pending skill requests');
    const r:SkillRequest={id:'sr_'+randomToken(9),user_id:userId,skill_id:skillId,client:client.slice(0,120),reason:reason.slice(0,500),created_at:Date.now()};
    try {await this.col('skill_requests').insertOne({_id:r.id,...r});return r}
    catch(e){if((e as {code?:number}).code===11000){
      const existing=MongoStore.row<SkillRequest>(await this.col('skill_requests').findOne({user_id:userId,skill_id:skillId}));
      if(existing)return existing;
    }throw e}
  }
  async listSkillRequests(userId:string):Promise<SkillRequest[]> {
    return (await this.col('skill_requests').find({user_id:userId}).sort({created_at:-1}).limit(50).toArray())
      .map(d=>MongoStore.row<SkillRequest>(d)!);
  }
  async deleteSkillRequest(userId:string,id:string):Promise<boolean> {
    return (await this.col('skill_requests').deleteOne({_id:id,user_id:userId})).deletedCount>0;
  }

  async close(): Promise<void> {
    this.liveAudit.length = 0;
    this.lastTouches.clear();
    await this.client.close();
  }
}
