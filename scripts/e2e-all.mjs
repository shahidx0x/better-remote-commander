// One-shot e2e runner: boots relay + agent on a scratch port/db, auto-pairs, runs all suites, tears down.
// pnpm test:e2e     (needs `pnpm build` first)
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.E2E_PORT ?? 3555);
const base = `http://localhost:${PORT}`;
const pass = 'e2e-pass-' + Math.random().toString(36).slice(2, 8);
const scratch = mkdtempSync(path.join(tmpdir(), 'ses-rdp-e2e-'));
const procs = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const relayCli = path.resolve('packages/relay/dist/cli.js');
const agentCli = path.resolve('packages/agent/dist/cli.js');

function start(name, args, env) {
  const p = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.out = '';
  p.stdout.on('data', (d) => { p.out += d; if (process.env.E2E_VERBOSE) process.stdout.write(`[${name}] ${d}`); });
  p.stderr.on('data', (d) => { p.out += d; if (process.env.E2E_VERBOSE) process.stderr.write(`[${name}] ${d}`); });
  procs.push(p);
  return p;
}

async function waitFor(fn, timeoutMs, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { try { const v = await fn(); if (v) return v; } catch {} await sleep(400); }
  throw new Error(`timeout waiting for ${what}`);
}

function runScript(script, ...args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', () => resolve(out));
  });
}

let failed = 0;
try {
  start('relay', [relayCli], { PORT: String(PORT), PUBLIC_URL: base, SES_RDP_ADMIN_PASSWORD: pass, SES_RDP_SESSION_SECRET: 'e2e', SES_RDP_DB: path.join(scratch, 'relay.sqlite'), LOG_LEVEL: 'warn' });
  await waitFor(async () => (await fetch(`${base}/health`)).ok, 20_000, 'relay');

  const agent = start('agent', [agentCli, '--relay', base, '--name', 'e2e-agent', '--no-browser'], { SES_RDP_HOME: path.join(scratch, 'agent-home') });
  const code = await waitFor(() => agent.out.match(/code: ([A-Z0-9]{4}-[A-Z0-9]{4})/)?.[1], 20_000, 'pairing code');

  let r = await fetch(`${base}/auth/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: 'admin', password: pass, returnTo: '/' }) });
  const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
  r = await fetch(`${base}/device/approve`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ user_code: code, decision: 'allow' }) });
  if (r.status !== 200) throw new Error(`approve failed: ${r.status}`);
  await waitFor(async () => (await (await fetch(`${base}/health`)).json()).devices === 1, 20_000, 'agent online');
  console.log(`relay + agent up on ${base} (pairing code ${code})\n`);

  // rate-limit test must run last: it locks the admin login for 5 minutes.
  for (const s of ['scripts/e2e-oauth.mjs', 'scripts/e2e-gpt-actions.mjs', 'scripts/e2e-admin.mjs']) {
    console.log(`== ${s}`);
    const out = await runScript(s, base, 'admin', pass);
    process.stdout.write(out.split('\n').filter((l) => /^(PASS|FAIL)/.test(l)).map((l) => '  ' + l.slice(0, 110)).join('\n') + '\n');
    const f = (out.match(/^FAIL/gm) ?? []).length;
    if (f || !/^PASS/m.test(out)) { failed += f || 1; if (!/^PASS/m.test(out)) console.log('  (suite crashed)\n' + out.slice(-600)); }
  }
} catch (e) {
  failed++;
  console.error('runner error:', e instanceof Error ? e.message : e);
  for (const p of procs) if (p.out) console.error(p.out.slice(-800));
} finally {
  for (const p of procs) { try { p.kill('SIGTERM'); } catch {} }
  await sleep(500);
  for (const p of procs) { try { p.kill('SIGKILL'); } catch {} }
  rmSync(scratch, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} failure(s)` : '\nall e2e suites passed');
process.exit(failed ? 1 : 0);
