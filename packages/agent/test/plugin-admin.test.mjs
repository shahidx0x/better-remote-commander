// Agent side of relay plugin administration (transport/plugin-admin.ts) against the built agent.
// node --test packages/agent/test/plugin-admin.test.mjs   (pnpm build first)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.BRC_HOME = mkdtempSync(path.join(realpathSync.native(tmpdir()), 'brc-padmin-'));
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const dist = (p) => pathToFileURL(path.join(repo, 'packages/agent/dist', p)).href;
const { PluginAdmin } = await import(dist('transport/plugin-admin.js'));
const { stopAllPlugins, callPluginTool } = await import(dist('plugins/host.js'));
const fixture = path.join(repo, 'packages/agent/test/fixtures/echo-mcp.mjs');

const sent = [];
const logs = [];
const admin = new PluginAdmin((m) => sent.push(m), (l, m) => logs.push(m));
admin.start();
let n = 0;
const run = async (msg) => { const id = `r${++n}`; await admin.handle({ type: 'plugin_admin', id, ...msg }); return sent.find((m) => m.type === 'plugin_admin_result' && m.id === id); };
const def = (over = {}) => ({ id: 'echo', name: 'Echo', source: { type: 'command', command: process.execPath, args: [fixture] }, ...over });

test('rejects invalid definitions before touching state', async () => {
  for (const bad of [def({ id: 'Bad Id' }), def({ source: { type: 'remote', url: 'http://x/mcp' } }), def({ source: { type: 'npm', package: 'x', version: '^1' } }), def({ source: { type: 'pypi', package: 'x', version: 'latest' } })]) {
    const r = await run({ action: 'install', plugin: bad });
    assert.equal(r.ok, false, JSON.stringify(bad.source));
    assert.match(r.error, /invalid plugin definition/);
  }
  assert.equal((await run({ action: 'install', plugin: def(), env: { 'BAD-NAME': 'x' } })).ok, false);
  assert.equal((await run({ action: 'explode', pluginId: 'echo' })).ok, false);
  assert.equal((await run({ action: 'enable', pluginId: '../x' })).ok, false);
  assert.equal((await run({ action: 'enable', pluginId: 'missing' })).error, 'unknown plugin "missing"');
});

test('install / env / disable / remove; env values never reported or logged', async () => {
  const secret = 'top-secret-value';
  let r = await run({ action: 'install', plugin: def(), env: { API_KEY: secret } });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.plugin.status, 'installed');
  assert.deepEqual(r.plugin.envKeys, ['API_KEY']);
  assert.equal((await callPluginTool('echo', 'echo', { text: 'hi' })).content[0].text, 'echo: hi');

  r = await run({ action: 'set_env', pluginId: 'echo', env: { OTHER: 'x' }, unsetEnv: ['API_KEY'] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.plugin.envKeys, ['OTHER']);
  const state = JSON.parse(readFileSync(path.join(process.env.BRC_HOME, 'plugins.json'), 'utf8'));
  assert.deepEqual(state.plugins.echo.env, { OTHER: 'x' });

  r = await run({ action: 'refresh', pluginId: 'echo' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.plugin.toolCount, 3);

  r = await run({ action: 'disable', pluginId: 'echo' });
  assert.equal(r.plugin.enabled, false);
  await assert.rejects(callPluginTool('echo', 'echo', { text: 'hi' }), /disabled/);

  await new Promise((res) => setTimeout(res, 400)); // debounced status report
  const reports = sent.filter((m) => m.type === 'plugins');
  assert.ok(reports.length >= 1, 'status reported on change');
  assert.equal(reports.at(-1).plugins.find((p) => p.id === 'echo').enabled, false);

  r = await run({ action: 'remove', pluginId: 'echo' });
  assert.equal(r.ok, true);
  const all = JSON.stringify(sent) + logs.join('\n');
  assert.ok(!all.includes(secret), 'secret never leaves the agent');
});

test('refresh without plugin id re-sends status; BRC_PLUGIN_REMOTE_ADMIN=0 blocks changes', async () => {
  const before = sent.filter((m) => m.type === 'plugins').length;
  assert.equal((await run({ action: 'refresh' })).ok, true);
  assert.equal(sent.filter((m) => m.type === 'plugins').length, before + 1);
  process.env.BRC_PLUGIN_REMOTE_ADMIN = '0';
  try {
    const r = await run({ action: 'install', plugin: def() });
    assert.equal(r.ok, false);
    assert.match(r.error, /disabled on this device/);
  } finally { delete process.env.BRC_PLUGIN_REMOTE_ADMIN; }
  admin.stop();
  await stopAllPlugins();
});
