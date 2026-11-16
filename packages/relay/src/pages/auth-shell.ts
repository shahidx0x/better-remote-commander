/** Shared full-height public/authentication shell. No remote assets or runtime library. */
import { AUTH_CSS } from './auth-theme.js';
import { PAIRING_CSS } from './pairing-theme.js';

const esc=(x:unknown)=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));

export function authLayout(title:string,body:string):string{
  const brandIcon='<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4" width="8" height="8" rx="2"/><rect x="13" y="4" width="7.5" height="7.5" rx="2"/><rect x="3.5" y="13" width="8" height="7.5" rx="2"/><path d="m14 17 2 2 4-5"/></svg>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="theme-color" content="#173849"><title>${esc(title)} · Better Remote Commander</title>
    <style>${AUTH_CSS}${PAIRING_CSS}@media(max-width:800px){.auth-main{align-items:flex-start}}</style></head><body><main class="auth-root">
    <aside class="auth-story" aria-label="About Better Remote Commander">
      <a href="/" class="auth-brand"><span class="auth-mark">${brandIcon}</span>
        <span><strong>Better Remote</strong><small>COMMANDER · RELAY</small></span></a>
      <div class="auth-story-inner"><span class="story-eyebrow">YOUR SELF-HOSTED WORKSPACE</span>
        <h2>Control your devices.<br><em>Keep your freedom.</em></h2>
        <p class="story-description">A focused workspace for connecting your AI tools to the computers you trust, with clear access controls and visibility.</p>
        <ul class="story-features">
          <li class="story-feature"><span class="story-icon" aria-hidden="true">⌁</span>
            <span><strong>One place for every device</strong><span>Manage pairing, availability and the tools your devices expose.</span></span></li>
          <li class="story-feature"><span class="story-icon" aria-hidden="true">◇</span>
            <span><strong>Access on your terms</strong><span>Choose OAuth, API keys or revocable private connections.</span></span></li>
          <li class="story-feature"><span class="story-icon" aria-hidden="true">✧</span>
            <span><strong>Built for focused work</strong><span>Discover skills and integrations without cluttering the workflow.</span></span></li>
        </ul></div>
      <div class="auth-story-footer"><span class="story-signal"></span>Independent · Self-hosted · Under your control</div>
    </aside>
    <section class="auth-main"><div class="auth-panel">
      <div class="auth-trail"><span class="trail-line"></span>BETTER REMOTE COMMANDER <span style="color:#a7babd">/</span> ${esc(title.toUpperCase())}</div>
      <div class="auth-card">${body}</div>
      <div class="auth-footer">© Better Remote Commander · <strong>Private workspace</strong> · <a href="/">Home</a></div>
    </div></section></main></body></html>`;
}
