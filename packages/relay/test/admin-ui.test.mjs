import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dashboardLayout } from '../dist/pages/dashboard-shell.js';
import { dashboardPage } from '../dist/pages/dashboard.js';
import { connectionLinksPage } from '../dist/pages/admin.js';
import { loginPage } from '../dist/pages/html.js';
import { usageView } from '../dist/features/usage.js';

const now = Date.UTC(2026, 10, 16, 12, 0, 0);
test('admin shell has accessible light theme, coherent navigation and no external assets', () => {
  const html = dashboardLayout('Skills', '<span id="needle">content</span>');
  assert.match(html, /color-scheme:light/);
  assert.match(html, /--brand:#087e79/);
  assert.match(html, /--panel:#ffffff/);
  assert.match(html, /@media\(max-width:640px\)/);
  assert.match(html, /class="shell"/);
  assert.match(html, /<aside class="sidebar">/);
  assert.match(html, /<nav class="nav" aria-label="Admin navigation">/);
  assert.match(html, /href="\/admin\/skills" aria-current="page"/);
  assert.match(html, /<main class="content">/);
  assert.match(html, /Private links/);
  assert.match(html, /MCP marketplace/);
  assert.match(html, /id="needle"/);
  assert.doesNotMatch(html, /fonts\.googleapis|cdn\.jsdelivr|<script src=/);
});
test('overview uses real metrics, preserves secure device actions and escapes user data', () => {
  const usage = usageView([{day:'2026-11-16',input_tokens:1250000,output_tokens:220000,reports:2}], 'day', now);
  const malicious = '<img src=x onerror=alert(1)>';
  const html = dashboardPage('https://relay.example.test',[
    {device_id:'dev-safe',name:malicious,platform:'Windows',online:true,paused:0,last_seen:now,created_at:now}
  ],[{ts:now,device:'Dev',client:'MCP',tool:'read_file',ok:1,ms:14,error:null}],
  {total:2,failed:0,last24h:2},usage);
  assert.match(html, /Everything connected/);
  assert.match(html, /1\.25M/);
  assert.match(html, /220K/);
  assert.match(html, /class="panel token-summary"/);
  assert.match(html, /name="action" value="rename"/);
  assert.match(html, /name="action" value="pause"/);
  assert.match(html, /name="action" value="delete"/);
  assert.match(html, /id="devices"/);
  assert.match(html, /id="activity"/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.ok(!html.includes(malicious));
});
test('empty token usage is explicitly unknown, not fabricated as zero', () => {
  const html=dashboardPage('https://relay.example',[],[],{total:0,failed:0,last24h:0},usageView([],'week',now));
  assert.match(html,/No model usage reported yet/);
  assert.match(html,/Waiting for real provider reports/);
  assert.match(html,/Daily/);
  assert.match(html,/Weekly/);
  assert.match(html,/Monthly/);
});
test('private link forms retain expiry options, CSRF fields, and revoke actions', () => {
  const html=connectionLinksPage([{id:'link-1',name:'Service',mode:'read',created_at:now,expires_at:now+86400000}],
    'csrf-real');
  assert.match(html,/name="csrf" value="csrf-real"/);
  assert.match(html,/name="mode"/);
  assert.match(html,/value="365"/);
  assert.match(html,/value="730"/);
  assert.match(html,/action="\/auth\/links\/revoke"/);
});
test('sign-in page uses the same new teal light palette', () => {
  const html=loginPage('/admin');
  assert.match(html,/--brand:#087e79/);
  assert.match(html,/color-scheme:light/);
  assert.doesNotMatch(html,/prefers-color-scheme:dark/);
  assert.match(html,/autocomplete="current-password"/);
});
