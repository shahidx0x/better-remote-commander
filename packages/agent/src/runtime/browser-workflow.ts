/**
 * Advisory Playwright guidance for call_plugin_tool. Nothing here blocks a call or restarts a plugin:
 * the installed plugin's own input schema stays authoritative, and BRC only classifies failures and
 * adds recovery hints. State is in-memory best-effort; BRC cannot see external page mutations.
 */
export const BROWSER_WORKFLOW_TEXT = [
  'Default to no browser for ordinary coding: use file tools and run_command; use Playwright only for necessary UI/visual verification.',
  'Reuse the existing browser session and take screenshots only at meaningful checkpoints.',
  'Element references come from the latest browser_snapshot; navigation, resize, reload, tab changes and DOM updates can invalidate them.',
  'On a stale/unknown element reference take a fresh browser_snapshot and re-identify the element; restarting Playwright is not needed.',
  'Follow the plugin input schema shown below for argument names. Do not resend an identical failed call without changing input.',
].join(' ');

export type BrowserErrorKind = 'ELEMENT_RESOLUTION' | 'PLUGIN_TRANSPORT' | 'PLUGIN_TOOL_FAILED';

/** `thrown` = the error came from the transport layer (exception), not from a tool result. Page text such as "socket hang up" in a tool result is not a plugin transport failure. */
export function classifyBrowserError(message: string, thrown = true): BrowserErrorKind {
  if (/\bstale\b|element.{0,40}not found|\bref\b.{0,40}not found|no element|unable to resolve|strict mode violation|unknown.{0,20}\bref\b|locator.{0,40}not found|not attached|target.{0,30}invalid/i.test(message))
    return 'ELEMENT_RESOLUTION';
  if (thrown && /connection closed|not connected|broken pipe|process exited|transport|timed out waiting for.{0,40}server|request timed out|EPIPE|ECONNRESET/i.test(message))
    return 'PLUGIN_TRANSPORT';
  return 'PLUGIN_TOOL_FAILED';
}

export function recoveryHint(kind: BrowserErrorKind): string {
  return kind === 'ELEMENT_RESOLUTION'
    ? 'Element reference is stale or invalid. Call browser_snapshot, identify the element again and correct the arguments. Restarting Playwright is not needed.'
    : kind === 'PLUGIN_TRANSPORT'
      ? 'The Playwright plugin connection failed (not an element problem). Check list_plugin_tools; do not replay a possibly completed browser action without verifying page state.'
      : 'Inspect the error and the current page (browser_snapshot) before retrying; do not resend an identical failed call.';
}

const READ_ONLY = new Set(['browser_snapshot', 'browser_take_screenshot', 'browser_console_messages', 'browser_network_requests', 'browser_get_url', 'browser_get_title']);

export class PlaywrightAdvisor {
  private fresh = false;
  reset(): void { this.fresh = false; }
  status() { return { snapshotFresh: this.fresh, note: 'In-memory best-effort; external page changes cannot be detected by BRC.' }; }
  /** Record a completed call; returns true when element references should be refreshed before the next element action. */
  after(tool: string, args: Record<string, unknown>, ok: boolean): boolean {
    if (tool === 'browser_snapshot') {
      // A snapshot written only to a file is not visible to the model.
      this.fresh = ok && !(typeof args.filename === 'string' && args.filename.trim());
      return false;
    }
    if (!ok) { this.fresh = false; return false; }
    if (READ_ONLY.has(tool) || !tool.startsWith('browser_') || (tool === 'browser_tabs' && args.action === 'list')) return false;
    this.fresh = false;
    return true;
  }
}
export const playwrightAdvisor = new PlaywrightAdvisor();
