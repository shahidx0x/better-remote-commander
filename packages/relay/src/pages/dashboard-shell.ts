/** Polished, responsive BRC admin shell. No external assets, cookies or JS dependencies. */
import { DASHBOARD_CSS } from './dashboard-theme.js';
import { ADMIN_PAGE_CSS } from './admin-page-theme.js';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

type NavItem = { href: string; title: string; icon: keyof typeof ICONS; pages: string[] };
type NavGroup = { heading: string; items: NavItem[] };

const ICONS = {
  overview: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  devices: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
  activity: '<path d="M3 12h4l3-7 4 14 3-7h4"/>',
  pair: '<rect x="3" y="8" width="10" height="12" rx="2"/><path d="M8 16h0M17 4v8M13 8h8"/>',
  market: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M14 18h7M17.5 14.5v7"/>',
  skills: '<path d="m12 2 2.2 6.8L21 11l-6.8 2.2L12 20l-2.2-6.8L3 11l6.8-2.2L12 2ZM19 18l.6 1.5L21 20l-1.4.5L19 22l-.6-1.5L17 20l1.4-.5L19 18Z"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7.1-7.1l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7.1 7.1l1.7-1.7"/>',
  oauth: '<path d="M12 3 4 7v5c0 5 3.4 8.5 8 9 4.6-.5 8-4 8-9V7l-8-4Z"/><path d="m9 12 2 2 4-4"/>',
  keys: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9 2 2-2 2-2-2-2 2 2 2-3 3"/>',
} as const;
const icon = (name: keyof typeof ICONS) =>
  '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + ICONS[name] + '</svg>';

const GROUPS: NavGroup[] = [
  { heading: 'WORKSPACE', items: [
    { href: '/admin', title: 'Overview', icon: 'overview', pages: ['Admin', 'Overview', 'Usage', 'Relay'] },
    { href: '/admin#devices', title: 'Devices', icon: 'devices', pages: [] },
    { href: '/admin#activity', title: 'Recent activity', icon: 'activity', pages: [] },
    { href: '/device/verify', title: 'Pair a device', icon: 'pair', pages: ['Pair device', 'Approve device'] },
  ] },
  { heading: 'INTEGRATIONS', items: [
    { href: '/admin/marketplace', title: 'MCP marketplace', icon: 'market', pages: ['Marketplace', 'Install plugin', 'Plugin installation'] },
    { href: '/admin/skills', title: 'Agent skills', icon: 'skills', pages: ['Skills', 'Skill library', 'Skill details'] },
  ] },
  { heading: 'ACCESS MANAGEMENT', items: [
    { href: '/auth/links', title: 'Private links', icon: 'link', pages: ['Connect without OAuth'] },
    { href: '/auth/clients', title: 'OAuth clients', icon: 'oauth', pages: ['OAuth clients'] },
    { href: '/auth/apikeys', title: 'API keys', icon: 'keys', pages: ['API keys'] },
  ] },
];

export function dashboardLayout(title: string, body: string): string {
  const menu = GROUPS.map(group =>
    '<div class="nav-head">' + esc(group.heading) + '</div>' +
    group.items.map(item =>
      '<a class="nav-link' + (item.pages.includes(title) ? ' active' : '') +
      '" href="' + esc(item.href) + '"' + (item.pages.includes(title) ? ' aria-current="page"' : '') + '>' +
      '<span class="nav-glyph" aria-hidden="true">' + icon(item.icon) + '</span>' +
      esc(item.title) + '</a>').join('')).join('');
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="theme-color" content="#173849"><title>' + esc(title) +
    ' · Better Remote Commander</title><style>' + DASHBOARD_CSS + ADMIN_PAGE_CSS + '</style></head><body>' +
    '<div class="shell"><aside class="sidebar"><div class="logo">' +
    '<span class="logo-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4" width="8" height="8" rx="2"/><rect x="13" y="4" width="7.5" height="7.5" rx="2"/><rect x="3.5" y="13" width="8" height="7.5" rx="2"/><path d="m14 17 2 2 4-5"/></svg></span>' +
    '<div><strong>Better Remote</strong><small>COMMANDER · RELAY</small></div></div>' +
    '<nav class="nav" aria-label="Admin navigation">' + menu + '</nav>' +
    '<div class="side-end"><span class="side-circle">RC</span><span><strong>Relay workspace</strong><small><span class="online-dot"></span> Self-hosted control</small></span></div></aside>' +
    '<div class="main"><header class="topbar"><div class="crumb">' +
    '<span class="crumb-icon" aria-hidden="true">⌘</span><span>Workspace</span><span> / </span><strong>' + esc(title) + '</strong></div>' +
    '<div class="top-right"><span class="top-pill"><span class="online-dot"></span>Control panel</span>' +
    '<a class="top-action top-action-secondary" href="/device/verify">+ Pair device</a>' +
    '<a class="top-action" href="/auth/logout">Sign out</a><span class="top-avatar" aria-hidden="true">RC</span></div></header>' +
    '<main class="content">' + body + '</main></div></div></body></html>';
}
