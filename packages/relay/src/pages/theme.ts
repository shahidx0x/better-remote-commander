/** Shared look for every server-rendered page: one CSS string, local SVG icons, no fonts/CDNs/scripts. */

export const CSS = `
:root{color-scheme:light dark;--bg:#f4f7f8;--panel:#fff;--panel2:#f6f9f9;--text:#17323d;--muted:#566b75;--line:#dde7e9;--brand:#0a6f6a;--brand2:#085b57;--onbrand:#fff;--ok:#117155;--err:#b42f3a;--input:#fff;--shadow:0 6px 24px rgba(24,55,64,.06);--side:#12303f;--sidetext:#b7ccd3;--sideact:#1f4a57}
@media(prefers-color-scheme:dark){:root{--bg:#0c1519;--panel:#131f25;--panel2:#18272e;--text:#e6f0f2;--muted:#9fb3ba;--line:#26373f;--brand:#4fd1c0;--brand2:#7be0d3;--onbrand:#06201d;--ok:#5fd3a6;--err:#ff8c93;--input:#0f1b20;--shadow:0 6px 24px rgba(0,0,0,.35);--side:#0a1216;--sideact:#17323a}}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--brand);text-decoration:none}a:hover{text-decoration:underline}
:focus-visible{outline:3px solid var(--brand);outline-offset:2px}
.skip{position:absolute;left:-999px;top:8px;background:var(--panel);padding:8px 12px;border-radius:8px;z-index:50}.skip:focus{left:8px}
h1{font-size:clamp(22px,3vw,28px);line-height:1.2;font-weight:750;letter-spacing:-.02em;margin:0 0 6px}h2{font-size:16px;font-weight:700;margin:0 0 6px}h3{font-size:14px;margin:0 0 4px}
p{margin:6px 0 10px;color:var(--muted)}strong{font-weight:650}.muted{color:var(--muted)}.ok{color:var(--ok)}.err{color:var(--err)}.danger{color:var(--err)}
code,pre,.mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
code{font-size:12px;background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:1px 6px;overflow-wrap:anywhere;color:var(--text)}
pre{background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:12px;overflow:auto;max-width:100%}
ul{padding-left:20px}li+li{margin-top:8px}details{margin-top:10px}summary{cursor:pointer;font-weight:600}
label{display:block;font-size:12px;font-weight:650;margin:14px 0 5px;color:var(--muted)}
input,textarea,select{width:100%;min-height:40px;padding:9px 12px;border:1px solid var(--line);border-radius:10px;background:var(--input);color:var(--text);font:inherit}
input:focus,textarea:focus,select:focus{outline:none;border-color:var(--brand);box-shadow:0 0 0 3px color-mix(in srgb,var(--brand) 30%,transparent)}
input[type=checkbox]{width:16px;min-height:0;height:16px;vertical-align:middle;accent-color:var(--brand)}
textarea{resize:vertical}input.code{font:22px/1 ui-monospace,Consolas,monospace;letter-spacing:.2em;text-align:center;text-transform:uppercase}
button,.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:38px;padding:8px 14px;border-radius:10px;border:1px solid transparent;font:600 13px/1.2 inherit;cursor:pointer;text-decoration:none;color:var(--text);background:transparent}
.primary{background:var(--brand);color:var(--onbrand)}.primary:hover{background:var(--brand2);text-decoration:none}
.secondary{background:var(--panel);border-color:var(--line);color:var(--text)}.secondary:hover{background:var(--panel2);border-color:var(--brand);text-decoration:none}
button.danger,.btn.danger{border-color:color-mix(in srgb,var(--err) 40%,var(--line));color:var(--err)}
button[disabled]{opacity:.5;cursor:not-allowed}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:16px}.row>a{display:flex}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px;box-shadow:var(--shadow);min-width:0;margin:0 0 12px}
.section{margin-top:26px}.section-head{display:flex;justify-content:space-between;align-items:center;gap:14px;margin-bottom:12px;flex-wrap:wrap}.section-head p{margin:2px 0 0;font-size:13px}
.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.grid>.panel{margin:0}
.stat{position:relative;padding-top:20px}.stat:before{content:"";position:absolute;left:18px;top:0;width:44px;height:3px;border-radius:0 0 4px 4px;background:var(--brand)}
.stat strong{display:block;font-size:28px;letter-spacing:-.03em;font-variant-numeric:tabular-nums}
.device-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.device{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px;box-shadow:var(--shadow);min-width:0}
.device-top{display:flex;justify-content:space-between;gap:10px;align-items:flex-start}.device-top>div{min-width:0;flex:1}
.device p{margin:6px 0}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;padding-top:12px;border-top:1px solid var(--line)}.actions button{min-height:34px;padding:6px 11px}
.pill{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);border-radius:999px;padding:2px 9px;background:var(--panel2);font-size:12px;font-weight:600;white-space:nowrap}
.pill.ok{border-color:color-mix(in srgb,var(--ok) 40%,var(--line))}.pill.err{border-color:color-mix(in srgb,var(--err) 40%,var(--line))}
.dot{width:7px;height:7px;border-radius:50%;background:currentColor;flex:0 0 7px}
.table-wrap{overflow:auto;padding:0}table{width:100%;border-collapse:collapse;min-width:520px}
th{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em;background:var(--panel2)}th,td{padding:10px 14px;border-bottom:1px solid var(--line);text-align:left;vertical-align:middle}tbody tr:last-child td{border-bottom:0}
.empty{padding:22px;text-align:center;border:1px dashed var(--line);border-radius:12px;color:var(--muted)}
.brand{font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--brand);margin-bottom:14px}
.auth{min-height:100vh;display:flex;align-items:flex-start;justify-content:center;padding:clamp(16px,8vh,72px) 14px}
.auth-card{width:min(460px,100%);background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:26px;box-shadow:var(--shadow)}
.shell{display:flex;min-height:100vh}
.sidebar{width:248px;flex:0 0 248px;position:sticky;top:0;height:100vh;display:flex;flex-direction:column;padding:20px 12px;background:var(--side);color:var(--sidetext);overflow:auto}
.logo{display:flex;align-items:center;gap:11px;padding:0 8px 18px;margin-bottom:12px;border-bottom:1px solid rgba(255,255,255,.1)}
.logo-mark{width:38px;height:38px;border-radius:12px;display:grid;place-items:center;background:#1c8a82;color:#fff;flex:0 0 38px}.logo-mark svg{width:22px;height:22px}
.logo strong{display:block;color:#fff;font-size:15px;line-height:1.2}.logo small{display:block;font-size:10px;letter-spacing:.14em;color:#9ab5bd}
.nav-head{font-size:10px;letter-spacing:.14em;font-weight:700;color:#8fabb3;padding:14px 10px 6px}
.nav-link{display:flex;align-items:center;gap:11px;min-height:40px;padding:8px 10px;margin:2px 0;border-radius:10px;color:var(--sidetext);font-weight:550;white-space:nowrap;border:1px solid transparent}
.nav-link:hover{background:var(--sideact);color:#fff;text-decoration:none}.nav-link.active{background:var(--sideact);color:#fff;border-color:rgba(120,230,210,.3);box-shadow:inset 3px 0 0 #49d8bd}
.nav-link svg{width:18px;height:18px;flex:0 0 18px;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.sidebar :focus-visible{outline-color:#7be0d3}
.main{flex:1;min-width:0;display:flex;flex-direction:column}
.topbar{display:flex;justify-content:space-between;align-items:center;gap:12px;min-height:56px;padding:8px clamp(16px,3vw,36px);background:var(--panel);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:10}
.crumb{color:var(--muted);font-size:13px}.crumb strong{color:var(--text)}.top-right{display:flex;gap:8px;align-items:center}.top-right .btn{min-height:34px;padding:5px 12px}
.content{width:100%;margin:0 auto;padding:clamp(18px,3vw,34px) clamp(14px,3vw,36px) 60px}.content.narrow{max-width:860px}.content.wide{max-width:1240px}
@media(max-width:900px){.shell{display:block}.sidebar{width:100%;height:auto;position:static;padding:12px}.logo{padding-bottom:10px;margin-bottom:8px}.nav{display:flex;overflow-x:auto;gap:4px;padding-bottom:4px}.nav-head{display:none}.nav-link{flex:0 0 auto;margin:0}.device-grid{grid-template-columns:1fr}.topbar{position:static}}
@media(max-width:640px){.grid{grid-template-columns:1fr}.panel,.device{padding:14px}.auth-card{padding:20px}.section-head{align-items:flex-start;flex-direction:column}.top-right .optional{display:none}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
`.replace(/\n\s*/g, '\n');

const ICONS = {
  overview: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  devices: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
  activity: '<path d="M3 12h4l3-7 4 14 3-7h4"/>',
  pair: '<rect x="3" y="8" width="10" height="12" rx="2"/><path d="M17 4v8M13 8h8"/>',
  market: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M14 18h7M17.5 14.5v7"/>',
  skills: '<path d="m12 2 2.2 6.8L21 11l-6.8 2.2L12 20l-2.2-6.8L3 11l6.8-2.2L12 2Z"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7.1-7.1l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7.1 7.1l1.7-1.7"/>',
  oauth: '<path d="M12 3 4 7v5c0 5 3.4 8.5 8 9 4.6-.5 8-4 8-9V7l-8-4Z"/><path d="m9 12 2 2 4-4"/>',
  keys: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9 2 2-2 2-2-2-2 2 2 2-3 3"/>',
} as const;
type IconName = keyof typeof ICONS;
const svg = (n: IconName) => `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[n]}</svg>`;

/** Static navigation (no user data). `titles` are the page titles that highlight an entry. */
const NAV: { heading: string; items: { href: string; label: string; icon: IconName; titles: string[]; skills?: boolean }[] }[] = [
  { heading: 'WORKSPACE', items: [
    { href: '/admin', label: 'Overview', icon: 'overview', titles: ['Admin', 'Relay'] },
    { href: '/admin#devices', label: 'Devices', icon: 'devices', titles: [] },
    { href: '/admin#activity', label: 'Recent activity', icon: 'activity', titles: [] },
    { href: '/device/verify', label: 'Pair a device', icon: 'pair', titles: [] },
  ] },
  { heading: 'INTEGRATIONS', items: [
    { href: '/admin/marketplace', label: 'Plugin marketplace', icon: 'market', titles: ['Marketplace', 'Install plugin', 'Plugin install'] },
    { href: '/admin/skills', label: 'Skill library', icon: 'skills', titles: ['Skills'], skills: true },
  ] },
  { heading: 'ACCESS', items: [
    { href: '/auth/links', label: 'Private links', icon: 'link', titles: ['Private MCP links'] },
    { href: '/auth/clients', label: 'OAuth clients', icon: 'oauth', titles: ['OAuth clients'] },
    { href: '/auth/apikeys', label: 'API keys', icon: 'keys', titles: ['API keys'] },
  ] },
];

export function sidebar(title: string): string {
  const skillsOn = process.env.BRC_SKILLS === '1';
  const menu = NAV.map((g) => `<div class="nav-head">${g.heading}</div>` + g.items.filter((i) => !i.skills || skillsOn).map((i) => {
    const on = i.titles.includes(title);
    return `<a class="nav-link${on ? ' active' : ''}" href="${i.href}"${on ? ' aria-current="page"' : ''}>${svg(i.icon)}${i.label}</a>`;
  }).join('')).join('');
  return `<aside class="sidebar"><div class="logo"><span class="logo-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4" width="8" height="8" rx="2"/><rect x="13" y="4" width="7.5" height="7.5" rx="2"/><rect x="3.5" y="13" width="8" height="7.5" rx="2"/><path d="m14 17 2 2 4-5"/></svg></span><div><strong>Better Remote Commander</strong><small>BRC RELAY</small></div></div><nav class="nav" aria-label="Admin navigation">${menu}</nav></aside>`;
}
