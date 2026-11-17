import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
process.env.BRC_HOME = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'brc-home-'));
delete process.env.DOCKER_HOST; delete process.env.DOCKER_CONTEXT;
const S = await import('../dist/tools/sandbox-tools.js');
const scratch = await import('../dist/runtime/scratch-budget.js');
const {callTool, listTools} = await import('../dist/dispatcher.js');
const ID = 'sha256:' + 'a'.repeat(64);
const mk = async () => fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'brc-sb-')));
const ok = (o = {}) => ({isError: false, structuredContent: {stdout: '', stderr: '', exitCode: 0, ...o}, content: []});
const image = (o = {}) => async () => [{id: ID, os: 'linux', volumes: [], ...o}];
const mkRun = (calls, over = {}) => async (prog, args, cwd, t) => {
  calls.push({prog, args});
  if (args[0] === 'context') return ok({stdout: '"unix:///var/run/docker.sock"'});
  return over.run ? over.run(prog, args) : ok();
};
const base = d => ({path: d, image: 'alpine:3', program: '/bin/echo', args: ['hi']});
const scratchDirs = async () => (await fs.readdir(scratch.scratchRoot()).catch(() => [])).filter(n => n.startsWith('sandbox-'));
const runCall = calls => calls.find(c => c.args[0] === 'run');

test('sandbox_run is advertised', () => {
  const t = listTools().find(x => x.name === 'sandbox_run');
  assert.ok(t); assert.equal(t.inputSchema.type, 'object');
});
test('preview by default stages nothing and starts nothing', async () => {
  const d = await mk(), calls = [];
  const r = await S.sandboxRun(base(d), {run: mkRun(calls), inspect: image()});
  assert.equal(r.structuredContent.execute, false); assert.equal(r.structuredContent.staged, false);
  assert.equal(calls.some(c => c.args[0] === 'run'), false);
  assert.deepEqual(await scratchDirs(), []);
});
test('arg vector snapshot', () => {
  const a = S.sandboxArgs('brc-sandbox-x', '/in', ID, '/bin/echo', ['-n', 'hi']);
  assert.deepEqual(a, ['run', '--rm', '--pull=never', '--name', 'brc-sandbox-x', '--label', 'brc.disposable=true',
    '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
    '--user', '65534:65534', '--pids-limit', '64', '--memory', '256m', '--memory-swap', '256m', '--cpus', '1',
    '--ulimit', 'nofile=1024:1024', '--log-driver=none', '--no-healthcheck',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m,mode=1777',
    '--mount', 'type=bind,source=/in,target=/workspace,readonly,bind-recursive=disabled',
    '--workdir', '/workspace', '--env', 'HOME=/tmp', '--env', 'PYTHONDONTWRITEBYTECODE=1',
    '--env', 'DOTNET_CLI_TELEMETRY_OPTOUT=1', '--env', 'CARGO_NET_OFFLINE=true',
    '--entrypoint', '/bin/echo', ID, '-n', 'hi']);
  assert.throws(() => S.sandboxArgs('n', '/in,source=/etc', ID, '/bin/x', []), /unsupported separator/);
});
test('execute stages sanitized copy: secrets and symlinks excluded, scratch removed, container removed', async () => {
  const d = await mk(), calls = [];
  await fs.writeFile(path.join(d, 'a.txt'), 'ok');
  await fs.writeFile(path.join(d, '.env'), 'SECRET=1');
  await fs.writeFile(path.join(d, 'server.pem'), 'k');
  await fs.mkdir(path.join(d, '.ssh')); await fs.writeFile(path.join(d, '.ssh', 'config'), 'x');
  await fs.mkdir(path.join(d, 'src')); await fs.writeFile(path.join(d, 'src', 'b.ts'), 'b');
  let link = true;
  try { await fs.symlink(path.join(d, 'a.txt'), path.join(d, 'link.txt')); } catch { link = false; }
  let seen;
  const run = mkRun(calls, {run: async (p, args) => {
    if (args[0] === 'run') {
      const src = args.find(a => a.startsWith('type=bind')).split(',')[1].slice(7);
      const walk = async (dir, pre = '') => (await Promise.all((await fs.readdir(dir, {withFileTypes: true})).map(async e => e.isDirectory() ? walk(path.join(dir, e.name), pre + e.name + '/') : [pre + e.name]))).flat();
      seen = (await walk(src)).sort();
    }
    return ok();
  }});
  const r = await S.sandboxRun({...base(d), execute: true}, {run, inspect: image()});
  assert.ok(!r.isError, JSON.stringify(r.structuredContent));
  assert.deepEqual(seen, ['a.txt', 'src/b.ts']);
  if (link) assert.ok(!seen.includes('link.txt'));
  const rm = calls.filter(c => c.args[0] === 'container' && c.args[1] === 'rm');
  const name = runCall(calls).args[runCall(calls).args.indexOf('--name') + 1];
  assert.match(name, /^brc-sandbox-[0-9a-f-]{36}$/);
  assert.ok(rm.length >= 1 && rm[0].args.includes(name));
  assert.deepEqual(await scratchDirs(), []);
  assert.equal(S.sandboxStatus().running, false);
  assert.equal(r.structuredContent.cleanupConfirmed, true);
});
test('sandboxExcluded covers credential locations', () => {
  for (const f of ['.env', 'a/.env.local', 'x/.git/config', '.ssh/id', '.aws/credentials', 'k.pem', '.npmrc', 'a/.git-credentials'])
    assert.equal(S.sandboxExcluded(f), true, f);
  assert.equal(S.sandboxExcluded('src/index.ts'), false);
});
test('remote docker endpoints refused, nothing run', async () => {
  const d = await mk(), calls = [];
  process.env.DOCKER_HOST = 'tcp://10.0.0.1:2375';
  try {
    await assert.rejects(S.sandboxRun({...base(d), execute: true}, {run: mkRun(calls), inspect: image()}), e => e.code === 'REMOTE_DOCKER_DENIED');
    process.env.DOCKER_CONTEXT = 'default'; // DOCKER_HOST still overrides contexts
    await assert.rejects(S.sandboxRun({...base(d), execute: true}, {run: mkRun(calls), inspect: image()}), e => e.code === 'REMOTE_DOCKER_DENIED');
  } finally { delete process.env.DOCKER_HOST; delete process.env.DOCKER_CONTEXT; }
  assert.equal(calls.some(c => c.args[0] === 'run'), false);
  // remote context
  const run = async (p, args) => args[0] === 'context' ? ok({stdout: '"ssh://user@host"'}) : ok();
  await assert.rejects(S.sandboxRun({...base(d), execute: true}, {run, inspect: image()}), e => e.code === 'REMOTE_DOCKER_DENIED');
});
test('image with volumes, non-linux or non-immutable id refused', async () => {
  const d = await mk(), calls = [];
  await assert.rejects(S.sandboxRun({...base(d), execute: true}, {run: mkRun(calls), inspect: image({volumes: ['/data']})}), e => e.code === 'SANDBOX_IMAGE_VOLUMES');
  await assert.rejects(S.sandboxRun({...base(d), execute: true}, {run: mkRun(calls), inspect: image({os: 'windows'})}), e => e.code === 'SANDBOX_IMAGE_UNSUPPORTED');
  await assert.rejects(S.sandboxRun({...base(d), execute: true}, {run: mkRun(calls), inspect: image({id: 'latest'})}), e => e.code === 'SANDBOX_IMAGE_UNSUPPORTED');
  assert.equal(calls.some(c => c.args[0] === 'run'), false);
});
test('only one sandbox at a time', async () => {
  const d = await mk(), calls = [];
  let release;
  const gate = new Promise(r => { release = r; });
  const slow = mkRun(calls, {run: async (p, args) => { if (args[0] === 'run') await gate; return ok(); }});
  const first = S.sandboxRun({...base(d), execute: true}, {run: slow, inspect: image()});
  while (!calls.some(c => c.args[0] === 'run')) await new Promise(r => setTimeout(r, 5));
  assert.equal(S.sandboxStatus().running, true);
  await assert.rejects(S.sandboxRun({...base(d), execute: true}, {run: mkRun([]), inspect: image()}), e => e.code === 'SANDBOX_BUSY');
  release(); await first;
  assert.equal(S.sandboxStatus().running, false);
});
test('cleanup attempted when run throws (cancel) and scratch removed', async () => {
  const d = await mk(), calls = [];
  await fs.writeFile(path.join(d, 'a.txt'), 'ok');
  const run = mkRun(calls, {run: async (p, args) => { if (args[0] === 'run') throw new Error('cancelled'); return ok(); }});
  await assert.rejects(S.sandboxRun({...base(d), execute: true}, {run, inspect: image()}), /cancelled/);
  const name = runCall(calls).args[runCall(calls).args.indexOf('--name') + 1];
  assert.ok(calls.some(c => c.args[0] === 'container' && c.args[1] === 'rm' && c.args.includes(name)));
  assert.deepEqual(await scratchDirs(), []);
  assert.equal(S.sandboxStatus().running, false);
});
test('failed container removal is reported, not hidden', async () => {
  const d = await mk(), calls = [];
  const run = mkRun(calls, {run: async (p, args) => args[0] === 'container' ? {isError: true, structuredContent: {stderr: 'daemon error'}} : ok()});
  const r = await S.sandboxRun({...base(d), execute: true}, {run, inspect: image()});
  assert.equal(r.isError, true); assert.equal(r.structuredContent.cleanupConfirmed, false);
  assert.match(r.structuredContent.leftoverContainer, /^brc-sandbox-/);
});
test('scratch prune only deletes its own marked inputs', async () => {
  const root = await scratch.ownedScratch(true);
  const foreign = path.join(root, 'important'); await fs.mkdir(foreign); await fs.writeFile(path.join(foreign, 'f'), 'x');
  const lookalike = path.join(root, 'sandbox-1-' + '0'.repeat(8) + '-0000-0000-0000-' + '0'.repeat(12)); await fs.mkdir(lookalike);
  const stale = path.join(root, 'sandbox-1-' + '1'.repeat(8) + '-1111-1111-1111-' + '1'.repeat(12)); await fs.mkdir(stale);
  await fs.writeFile(path.join(stale, '.owner.json'), JSON.stringify({kind: 'brc-sandbox-input', created: 1, pid: 99999999}));
  const res = await scratch.pruneScratch(0);
  assert.equal(res.removed, 1);
  assert.ok(await fs.stat(foreign)); assert.ok(await fs.stat(lookalike));
  await assert.rejects(fs.stat(stale));
  await assert.rejects(scratch.releaseScratch(foreign), e => e.code === 'UNOWNED_CACHE');
  assert.ok(await fs.stat(foreign));
});
test('unowned scratch root is refused', async () => {
  const prev = process.env.BRC_HOME, other = await mk();
  process.env.BRC_HOME = other;
  try {
    await fs.mkdir(path.join(other, 'scratch-v1'));
    await assert.rejects(scratch.ownedScratch(true), e => e.code === 'UNOWNED_CACHE_ROOT');
  } finally { process.env.BRC_HOME = prev; }
});
