#!/usr/bin/env node
/**
 * One-time SQLite -> MongoDB migration. Run before switching storage modes.
 * Never migrates audit/activity logs; preserves hashed OAuth/device/API credentials.
 * Does not overwrite documents already in MongoDB.
 */
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { MongoClient, type Document } from 'mongodb';

const TABLES: Record<string, string> = {
  users: 'id', oauth_clients: 'client_id', connection_links: 'id',
  auth_codes: 'code', tokens: 'token_hash', devices: 'device_id',
  device_codes: 'device_code', api_keys: 'key_hash',
};
const EXPIRABLE = new Set(['auth_codes', 'device_codes', 'connection_links', 'tokens']);

async function main(): Promise<void> {
  const file = process.env.BRC_DB || 'data/relay.sqlite';
  const uri = process.env.MONGODB_URI || '';
  const databaseName = process.env.MONGODB_DB || undefined;
  const resume = process.argv.includes('--resume');
  const dryRun = process.argv.includes('--dry-run');

  if (!existsSync(file)) throw new Error('SQLite source file does not exist. Restore the old /data volume or backup first.');
  if (!uri && !dryRun) throw new Error('Set MONGODB_URI before migrating');
  const sqlite = new DatabaseSync(file, { readOnly: true });
  const rowsByTable = new Map<string, Document[]>();
  try {
    const now = Date.now();
    for (const [table, idField] of Object.entries(TABLES)) {
      const present = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
      if (!present) { rowsByTable.set(table, []); continue; }
      const rows = sqlite.prepare('SELECT * FROM ' + table).all() as Record<string, unknown>[];
      rowsByTable.set(table, rows.filter(row => !(EXPIRABLE.has(table) &&
        typeof row.expires_at === 'number' && row.expires_at <= now)).map(row => ({
        _id: String(row[idField]), ...row,
        ...(EXPIRABLE.has(table) && typeof row.expires_at === 'number' ? {
          expire_on: new Date(row.expires_at + (table === 'tokens' ? 7 * 86_400_000 : 0)),
        } : {}),
      })));
    }
  } finally { sqlite.close(); }
  console.log('SQLite records to migrate (activity/audit excluded):');
  for (const [table, rows] of rowsByTable) console.log(table + ': ' + rows.length);
  if (dryRun) return;

  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 6000, maxPoolSize: 4, appName: 'brc-migrate' });
  try {
    await client.connect();
    const defaultName = ((new URL(uri).pathname || '/').replace(/^\//, '') ? undefined : 'brc_relay');
    const db = client.db(databaseName || defaultName);
    await db.command({ ping: 1 });
    for (const table of Object.keys(TABLES)) {
      const n = await db.collection(table).estimatedDocumentCount();
      if (n > 0 && !resume)
        throw new Error('MongoDB collection ' + table + ' already contains records. Use a fresh BRC database; --resume is only for an interrupted import.');
    }
    for (const [table, rows] of rowsByTable) {
      for (let i = 0; i < rows.length; i += 100) {
        const chunk = rows.slice(i, i + 100);
        await db.collection(table).bulkWrite(chunk.map(doc => ({
          updateOne: { filter: { _id: doc._id }, update: { $setOnInsert: doc }, upsert: true },
        })), { ordered: true });
      }
    }
    console.log('MongoDB import complete. Credentials remain hashed. No audit logs migrated.');
    console.log('Use MONGODB_URI (and optional MONGODB_DB) for BRC Relay startup. Keep the SQLite backup.');
  } catch {
    // Driver errors can include hostnames and authentication information.
    throw new Error('MongoDB import failed. Verify URI/network and use --resume only when recovering a partial import.');
  } finally { await client.close(); }
}

main().catch(err => { console.error(err instanceof Error ? err.message : 'Migration failed'); process.exitCode = 1; });
