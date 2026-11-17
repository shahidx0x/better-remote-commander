// Worker coordination tests: disposable projects only, RAM-only state, no model/provider invoked.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { mkdtempSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
const scratch = mkdtempSync(path.join(realpathSync.native(tmpdir()), 'brc-workers-test-'));
process.env.BRC_HOME = path.join(scratch, 'home'); process.env.BRC_LOG_LEVEL = 'silent';
const { configManager } = await import('../dist/core/config-manager.js');
await configManager.setValue('allowedDirectories', [scratch]);
const { callTool, listTools } = await import('../dist/dispatcher.js');
const { workerCoordinator, WorkerCoordinator, WORKER_LIMITS } = await import('../dist/runtime/worker-coordination.js');
const { sha256 } = await import('../dist/runtime/file-safety.js');
const ok = r => { assert.notEqual(r.isError, true, JSON.stringify(r)); return r.structuredContent; };
const bad = (r, code) => { assert.equal(r.isError, true, JSON.stringify(r)); assert.equal(r.structuredContent.error.code, code); };
let seq = 0;
async function fixture() {
  const root = path.join(scratch, 'project-' + (++seq)); await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n'); await fs.writeFile(path.join(root, 'src', 'b.ts'), 'export const b = 1;\n');
  return root;
}
const task = (id, scope, dependsOn = [], readOnly = false) => ({ id, goal: 'Implement ' + id, scope, dependsOn, readOnly });
const create = (root, tasks, extra = {}) => callTool('worker_tasks', { action: 'create', path: root, goal: 'work', tasks, ...extra }).then(ok);
const claim = (plan, id, extra = {}) => callTool('worker_tasks', { action: 'claim', planId: plan.planId, taskId: id, workerId: 'w-' + id, ...extra }).then(ok);
const patch = (plan, id, lease, changes, extra = {}) => callTool('worker_patch', { planId: plan.planId, taskId: id, claimKey: lease.claimKey, submissionId: 'sub-' + id, summary: 'proposal', changes, ...extra });
const integrate = (plan, action, extra = {}) => callTool('worker_integrate', { planId: plan.planId, coordinatorKey: plan.coordinatorKey, action, ...extra });
const replacement = async (root, file, content) => ({ path: file, expected_sha256: sha256(await fs.readFile(path.join(root, file))), content });
beforeEach(() => workerCoordinator.clear());
after(async () => { workerCoordinator.clear(); await configManager.close(); await fs.rm(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); });

test('tools are advertised, never fabricate spawning, never mention missing tools', async () => {
  const defs = listTools().filter(t => t.name.startsWith('worker_'));
  assert.deepEqual(defs.map(d => d.name).sort(), ['worker_integrate', 'worker_patch', 'worker_tasks']);
  for (const d of defs) assert.doesNotMatch(d.description, /batch_tools|context_pack|run_project_checks|harness/);
  const root = await fixture(), p = await create(root, [task('a', ['src/a.ts'])], { hostMode: 'native_workers' });
  assert.equal(p.spawnedModels, 0); assert.equal(p.persistent, false); assert.ok(p.coordinatorKey);
  assert.ok(!JSON.stringify(ok(await callTool('worker_tasks', { action: 'status', planId: p.planId }))).includes(p.coordinatorKey));
});

test('happy path: plan -> claim -> submit -> preview -> integrate (hash-checked write)', async () => {
  const root = await fixture(), p = await create(root, [task('a', ['src/a.ts']), task('b', ['src/b.ts'])]);
  const a = await claim(p, 'a', { reads: [{ path: 'src/a.ts' }] }); assert.equal(a.snapshot.reads[0].sha256, sha256('export const a = 1;\n'));
  const b = await claim(p, 'b');
  ok(await patch(p, 'a', a, [await replacement(root, 'src/a.ts', 'export const a = 2;\n')]));
  ok(await patch(p, 'b', b, [await replacement(root, 'src/b.ts', 'export const b = 2;\n')]));
  assert.equal(await fs.readFile(path.join(root, 'src/a.ts'), 'utf8'), 'export const a = 1;\n', 'submit must not write');
  const prev = ok(await integrate(p, 'preview')); assert.equal(prev.writesPerformed, 0);
  bad(await integrate(p, 'apply', { review_sha256: 'f'.repeat(64) }), 'STALE_REVIEW');
  const done = ok(await integrate(p, 'apply', { review_sha256: prev.review_sha256 })); assert.equal(done.committed, true); assert.equal(done.changes.length, 2);
  assert.equal(await fs.readFile(path.join(root, 'src/a.ts'), 'utf8'), 'export const a = 2;\n');
  assert.equal(workerCoordinator.stats().patchBytes, 0);
  assert.equal(ok(await integrate(p, 'apply', { review_sha256: prev.review_sha256 })).replay, true);
  bad(await integrate(p, 'verify'), 'VERIFIER_UNAVAILABLE');
  const fin = ok(await integrate(p, 'finish')); assert.equal(fin.state, 'finished'); assert.equal(fin.verified, false);
});

test('stale hash at submit and at integrate (file changed after submit) is a conflict, nothing written', async () => {
  const root = await fixture(), p = await create(root, [task('a', ['src/a.ts'])]), a = await claim(p, 'a');
  bad(await patch(p, 'a', a, [{ path: 'src/a.ts', expected_sha256: '0'.repeat(64), content: 'x' }]), 'FILE_CONFLICT');
  ok(await patch(p, 'a', a, [await replacement(root, 'src/a.ts', 'new\n')]));
  const prev = ok(await integrate(p, 'preview'));
  await fs.writeFile(path.join(root, 'src/a.ts'), 'external edit\n');
  const r = await integrate(p, 'apply', { review_sha256: prev.review_sha256 });
  bad(r, 'FILE_CONFLICT'); assert.equal(r.structuredContent.committed, false);
  assert.equal(await fs.readFile(path.join(root, 'src/a.ts'), 'utf8'), 'external edit\n');
});

test('expired claim cannot submit; renew extends; re-claim issues a new key', async () => {
  let time = 1_000_000; const c = new WorkerCoordinator(() => time), root = await fixture();
  const p = await c.create({ path: root, goal: 'lease', tasks: [task('a', ['src/a.ts'])] });
  const lease = await c.manage({ action: 'claim', planId: p.planId, taskId: 'a', workerId: 'w', leaseSeconds: 30 });
  time += 20000; await c.manage({ action: 'renew', planId: p.planId, taskId: 'a', claimKey: lease.claimKey, leaseSeconds: 30 });
  time += 20000; assert.equal((await c.manage({ action: 'status', planId: p.planId })).tasks[0].state, 'claimed');
  time += 11000;
  await assert.rejects(c.submit({ planId: p.planId, taskId: 'a', claimKey: lease.claimKey, submissionId: 's', summary: 's', changes: [await replacement(root, 'src/a.ts', 'n')] }), e => e.code === 'WORKER_ACCESS_DENIED');
  const fresh = await c.manage({ action: 'claim', planId: p.planId, taskId: 'a', workerId: 'new' }); assert.notEqual(fresh.claimKey, lease.claimKey);
  // lease is capped at 15 minutes even if more is requested
  assert.ok(fresh.expiresAt - time <= 900_000 + 1);
  c.clear(); assert.equal(c.stats().plans, 0);
});

test('wrong keys are rejected for coordinator and worker actions', async () => {
  const root = await fixture(), p = await create(root, [task('a', ['src/a.ts'])]), a = await claim(p, 'a');
  bad(await patch(p, 'a', { claimKey: 'x'.repeat(32) }, []), 'WORKER_ACCESS_DENIED');
  bad(await patch(p, 'a', { claimKey: p.coordinatorKey }, [await replacement(root, 'src/a.ts', 'n')]), 'WORKER_ACCESS_DENIED');
  bad(await integrate(p, 'preview', { coordinatorKey: a.claimKey }), 'WORKER_ACCESS_DENIED');
  bad(await callTool('worker_tasks', { action: 'cancel', planId: p.planId, coordinatorKey: 'y'.repeat(32) }), 'WORKER_ACCESS_DENIED');
  bad(await callTool('worker_tasks', { action: 'release', planId: p.planId, taskId: 'a', claimKey: 'z'.repeat(32) }), 'WORKER_ACCESS_DENIED');
});

test('capacity limits: worker slots, concurrent claim winner, task count, plan count, patch quota', async () => {
  const root = await fixture(), p = await create(root, [task('a', ['src/a.ts']), task('b', ['src/b.ts']), task('c', ['src'], [], true)], { maxWorkers: 2 });
  const outs = await Promise.all([1, 2, 3].map(i => callTool('worker_tasks', { action: 'claim', planId: p.planId, taskId: 'a', workerId: 'w' + i })));
  assert.equal(outs.filter(r => !r.isError).length, 1);
  await claim(p, 'b'); bad(await callTool('worker_tasks', { action: 'claim', planId: p.planId, taskId: 'c', workerId: 'x' }), 'WORKER_CAPACITY');
  const r2 = await fixture();
  assert.equal((await callTool('worker_tasks', { action: 'create', path: r2, goal: 'g', tasks: Array.from({ length: 33 }, (_, i) => task('t' + i, ['n' + i + '.txt'])) })).isError, true);
  // plan limit (distinct non-overlapping roots)
  const plans = []; for (let i = 0; i < WORKER_LIMITS.plans - 1; i++) plans.push(await create(await fixture(), [task('a', ['src/a.ts'])]));
  bad(await callTool('worker_tasks', { action: 'create', path: await fixture(), goal: 'g', tasks: [task('a', ['src/a.ts'])] }), 'WORKER_PLAN_LIMIT');
  workerCoordinator.clear();
  const root3 = await fixture(), big = await create(root3, Array.from({ length: 10 }, (_, i) => task('t' + i, ['new' + i + '.txt'])));
  let accepted = 0;
  for (let i = 0; i < 10; i++) {
    const lease = await claim(big, 't' + i); const r = await patch(big, 't' + i, lease, [{ path: 'new' + i + '.txt', expected_sha256: null, content: 'x'.repeat(900000) }]);
    if (r.isError) { bad(r, 'WORKER_MEMORY_LIMIT'); break; } accepted++;
  }
  assert.equal(accepted, 9); assert.ok(workerCoordinator.stats().patchBytes <= WORKER_LIMITS.planPatchBytes);
  assert.equal(await fs.stat(path.join(root3, 'new0.txt')).catch(() => null), null);
});

test('overlapping roots/scopes, cycles, unsafe scopes fail closed', async () => {
  const root = await fixture();
  bad(await callTool('worker_tasks', { action: 'create', path: root, goal: 'g', tasks: [task('a', ['src']), task('b', ['src/a.ts'])] }), 'OVERLAPPING_SCOPE');
  for (const [tasks, code] of [[[task('a', ['../x'])], 'INVALID_SCOPE'], [[task('a', ['.git'])], 'INVALID_SCOPE'], [[task('a', ['.env'])], 'INVALID_SCOPE'],
    [[task('a', ['src/a.ts'], ['b']), task('b', ['src/b.ts'], ['a'])], 'TASK_CYCLE'], [[task('a', ['src/a.ts'], ['zz'])], 'UNKNOWN_DEPENDENCY']])
    bad(await callTool('worker_tasks', { action: 'create', path: root, goal: 'g', tasks }), code);
  const out = await Promise.all([1, 2].map(() => callTool('worker_tasks', { action: 'create', path: root, goal: 'g', tasks: [task('a', ['src'])] })));
  assert.equal(out.filter(r => !r.isError).length, 1);
});

test('submission scope, read-only, binary and idempotent replay', async () => {
  const root = await fixture(), p = await create(root, [task('a', ['src/a.ts']), task('r', ['src'], [], true)]), a = await claim(p, 'a'), r = await claim(p, 'r');
  bad(await patch(p, 'a', a, [await replacement(root, 'src/b.ts', 'x')]), 'TASK_SCOPE_VIOLATION');
  bad(await patch(p, 'r', r, [await replacement(root, 'src/a.ts', 'x')]), 'READ_ONLY_TASK');
  bad(await patch(p, 'a', a, [{ path: 'src/a.ts', expected_sha256: sha256('export const a = 1;\n'), content: 'x'.repeat(2 * 1024 * 1024) }]), 'PATCH_TOO_LARGE');
  const ch = [await replacement(root, 'src/a.ts', 'new')];
  assert.equal(ok(await patch(p, 'a', a, ch)).replay, false); assert.equal(ok(await patch(p, 'a', a, ch)).replay, true);
  bad(await patch(p, 'a', a, ch, { summary: 'different' }), 'TASK_ALREADY_SUBMITTED');
});

test('dependent tasks wait for integration of their prerequisite', async () => {
  const root = await fixture(), p = await create(root, [task('first', ['src/a.ts']), task('second', ['src/a.ts'], ['first'])]);
  const f = await claim(p, 'first'); ok(await patch(p, 'first', f, [await replacement(root, 'src/a.ts', 'export const a = 3;\n')]));
  bad(await callTool('worker_tasks', { action: 'claim', planId: p.planId, taskId: 'second', workerId: 'x' }), 'TASK_BLOCKED');
  ok(await integrate(p, 'apply', { review_sha256: ok(await integrate(p, 'preview')).review_sha256 }));
  const s = await claim(p, 'second', { reads: [{ path: 'src/a.ts' }] }); assert.match(s.snapshot.reads[0].text, /a = 3/);
  bad(await callTool('worker_tasks', { action: 'reset', planId: p.planId, taskId: 'first', coordinatorKey: p.coordinatorKey }), 'DEPENDENTS_ACTIVE');
});

test('guard blocks direct writes to owned paths (and not to unrelated ones); cancel releases', async () => {
  const root = await fixture(), other = await fixture(), p = await create(root, [task('a', ['src/a.ts'])]);
  bad(await callTool('write_file', { path: path.join(root, 'src/a.ts'), content: 'bad', mode: 'rewrite' }), 'COORDINATED_WRITE_REQUIRED');
  bad(await callTool('edit_block', { file_path: path.join(root, 'src/a.ts'), old_string: 'a', new_string: 'z' }), 'COORDINATED_WRITE_REQUIRED');
  bad(await callTool('workspace_batch', { path: root, dryRun: false, changes: [await replacement(root, 'src/a.ts', 'bad')] }), 'COORDINATED_WRITE_REQUIRED');
  bad(await callTool('delete_file', { path: path.join(root, 'src') }), 'COORDINATED_WRITE_REQUIRED');
  assert.equal(await fs.readFile(path.join(root, 'src/a.ts'), 'utf8'), 'export const a = 1;\n');
  // dry-run and unowned files / other projects are fine
  ok(await callTool('workspace_batch', { path: root, changes: [await replacement(root, 'src/a.ts', 'dry')] }));
  ok(await callTool('write_file', { path: path.join(root, 'src/unowned.ts'), content: 'ok', mode: 'rewrite' }));
  ok(await callTool('write_file', { path: path.join(other, 'src/a.ts'), content: 'ok', mode: 'rewrite' }));
  ok(await callTool('worker_tasks', { action: 'cancel', planId: p.planId, coordinatorKey: p.coordinatorKey }));
  ok(await callTool('write_file', { path: path.join(root, 'src/a.ts'), content: 'after', mode: 'rewrite' }));
});

test('plan cleanup: cancel discards patches, terminal plans expire, clear() drops everything', async () => {
  const root = await fixture(), p = await create(root, [task('a', ['src/a.ts'])]), a = await claim(p, 'a');
  ok(await patch(p, 'a', a, [await replacement(root, 'src/a.ts', 'never')])); assert.ok(workerCoordinator.stats().patchBytes > 0);
  ok(await callTool('worker_tasks', { action: 'cancel', planId: p.planId, coordinatorKey: p.coordinatorKey }));
  assert.equal(workerCoordinator.stats().patchBytes, 0); assert.equal(await fs.readFile(path.join(root, 'src/a.ts'), 'utf8'), 'export const a = 1;\n');
  bad(await patch(p, 'a', a, []), 'WORKER_PLAN_CLOSED');
  assert.ok(workerCoordinator.prune(Date.now() + WORKER_LIMITS.terminalMs + 100) > 0); assert.equal(workerCoordinator.stats().plans, 0);
  const p2 = await create(await fixture(), [task('a', ['src/a.ts'])]);
  assert.ok(workerCoordinator.prune(Date.now() + WORKER_LIMITS.idleMs + 100) > 0);
  bad(await callTool('worker_tasks', { action: 'status', planId: p2.planId }), 'WORKER_PLAN_NOT_FOUND');
  await create(await fixture(), [task('a', ['src/a.ts'])]); workerCoordinator.clear(); assert.equal(workerCoordinator.stats().plans, 0);
});

test('optional verification hook: absent by default, required by finish when installed', async () => {
  const root = await fixture(), p = await create(root, [task('a', ['src/a.ts'])]), a = await claim(p, 'a');
  ok(await patch(p, 'a', a, [await replacement(root, 'src/a.ts', 'v\n')])); ok(await integrate(p, 'apply', { review_sha256: ok(await integrate(p, 'preview')).review_sha256 }));
  workerCoordinator.setVerificationHook(async () => ({ passed: true, summary: 'hook ok' }));
  try {
    bad(await integrate(p, 'finish'), 'VERIFICATION_REQUIRED');
    assert.equal(ok(await integrate(p, 'verify')).verification.passed, true);
    assert.equal(ok(await integrate(p, 'finish')).verified, true);
  } finally { workerCoordinator.setVerificationHook(undefined); }
});

test('scope symlink retarget cannot escape the project', async () => {
  const root = await fixture(), outside = await fixture(), link = path.join(root, 'alias');
  await fs.symlink(path.join(root, 'src'), link, process.platform === 'win32' ? 'junction' : 'dir');
  const p = await create(root, [task('a', ['alias'])]), lease = await claim(p, 'a');
  await fs.unlink(link); await fs.symlink(path.join(outside, 'src'), link, process.platform === 'win32' ? 'junction' : 'dir');
  const r = await patch(p, 'a', lease, [{ path: 'alias/a.ts', expected_sha256: sha256('export const a = 1;\n'), content: 'escape' }]);
  assert.equal(r.isError, true); assert.ok(['OUTSIDE_PROJECT', 'SCOPE_CHANGED'].includes(r.structuredContent.error.code));
  assert.equal(await fs.readFile(path.join(outside, 'src/a.ts'), 'utf8'), 'export const a = 1;\n');
});
