/**
 * Local-only agent workflow and Playwright guidance.
 * Returned through existing agent tool responses; no relay tool-list change.
 * The BRC wrapper can guard only Playwright calls routed via call_plugin_tool,
 * not a separate Playwright MCP connector installed directly in ChatGPT.
 */
export const DEFAULT_WORKFLOW = {
  mode:'no-browser-by-default',
  order:[
    'Use BRC file tools to inspect and edit source; avoid browser use for ordinary code changes.',
    'Use run_command with absolute cwd and actual exit codes for builds, tests and diagnostics.',
    'Use installed Serena for symbol-level navigation when it genuinely improves code analysis.',
    'Use Playwright only for visual verification or necessary browser interactions.',
    'Reuse the existing Playwright browser/plugin session, never open a new one without need.',
    'Capture screenshots only at meaningful UI verification checkpoints.'
  ],
  playwright:[
    'Obtain a new browser_snapshot before clicking any element.',
    'Never reuse an older element reference after navigation, resize, reload, DOM changes or React Fast Refresh.',
    'browser_click requires target; name is NOT a substitute. Check the actual installed tool schema.',
    'If a target is rejected, request browser_snapshot and locate the target again.',
    'Verify browser state after navigating or major interactions.',
    'Never retry an identical failed browser call without correcting arguments or target.',
    'Distinguish element-resolution failures from plugin transport failures.',
    'Never restart Playwright just because a target reference is stale.'
  ],
  scope:'Agent runtime guidance. Browser safeguards apply only to Playwright reached through BRC call_plugin_tool, not external MCP servers.'
} as const;

export const BROWSER_WORKFLOW_TEXT = [
  'DEFAULT: NO BROWSER. Files -> run_command for tests -> Serena if useful -> Playwright only for essential UI/visual interaction.',
  'Reuse the existing browser session. Take screenshots only at meaningful checkpoints.',
  'Before browser_click use the latest browser_snapshot; target is required (name is not a substitute).',
  'Any navigate, resize, reload, tab switch, DOM update, React Fast Refresh, or previous browser interaction may invalidate target refs.',
  'On stale/invalid element refs: obtain a fresh browser_snapshot and re-identify target. Do NOT restart Playwright.',
  'Verify navigation/major interaction by snapshot. Never repeat identical failed calls without correcting input.',
  'Differentiate element-resolution errors from MCP transport errors. Tool-specific input schemas remain authoritative.'
].join(' ');

export interface BrowserCallError {code:string;message:string; next?:{tool:string;args:Record<string,unknown>};}
type BrowserResult={isError?:boolean; content?:Array<{type?:string;text?:string}>};
const required:Record<string,string[]>={
  browser_click:['target'],browser_type:['target','text'],
  browser_hover:['target'],browser_select_option:['target','values'],
  browser_drag:['startTarget','endTarget']
};
const noMutation=new Set([
  'browser_snapshot','browser_take_screenshot','browser_console_messages',
  'browser_network_requests','browser_get_url','browser_get_title'
]);
function stableArgs(args:Record<string,unknown>):string {
  try{return JSON.stringify(args)}catch{return '';}
}
export function classifyBrowserError(message:string):'ELEMENT_RESOLUTION'|'PLUGIN_TRANSPORT'|'PLUGIN_TOOL_FAILED' {
  if(/stale|element.+not found|ref.+not found|no element|unable to resolve|strict mode violation|unknown.+ref|locator.+not found|not attached|target.+invalid/i.test(message))
    return 'ELEMENT_RESOLUTION';
  if(/connection closed|transport|not connected|broken pipe|socket|process exited|timed out waiting for.+server/i.test(message))
    return 'PLUGIN_TRANSPORT';
  return 'PLUGIN_TOOL_FAILED';
}
export class PlaywrightCallPolicy {
  private snapshotValid=false;
  private snapshotSerial=0;
  private lastFailure:{tool:string;args:string;serial:number}|null=null;
  private queue:Promise<void>=Promise.resolve();
  reset():void {this.snapshotValid=false;this.lastFailure=null;}
  status(){return {snapshotValid:this.snapshotValid,snapshotSerial:this.snapshotSerial,
    note:'In-memory best-effort freshness; external page mutation/React Fast Refresh cannot be detected by BRC.'};}
  before(tool:string,args:Record<string,unknown>):BrowserCallError|null {
    const missing=(required[tool]??[]).filter(k=>
      typeof args[k]==='string' ? !(args[k] as string).trim() :
      Array.isArray(args[k]) ? !(args[k] as unknown[]).length : args[k]===undefined||args[k]===null);
    if(missing.length){
      const message=tool+' requires '+missing.join(', ')+'. Use the installed Playwright input schema. For browser_click use target, not name; NO browser action executed.';
      return {code:'PLAYWRIGHT_ARGUMENT',message};
    }
    if(this.lastFailure?.tool===tool && this.lastFailure.args===stableArgs(args) &&
       this.lastFailure.serial===this.snapshotSerial) {
      return {code:'PLAYWRIGHT_REPEAT',message:'Identical failed '+tool+' call was blocked. Obtain browser_snapshot to refresh element references, or correct tool args before retrying. Do not restart Playwright.'};
    }
    if((tool==='browser_click'||tool==='browser_type'||tool==='browser_hover'||
        tool==='browser_select_option'||tool==='browser_drag')&&!this.snapshotValid){
      return {code:'PLAYWRIGHT_SNAPSHOT_REQUIRED',
        message:'Obtain a fresh browser_snapshot before '+tool+'. A previous navigation, click, resize, reload, tab change or DOM update can make refs stale. Reuse the current browser session; do not restart it.',
        next:{tool:'browser_snapshot',args:{}}};
    }
    return null;
  }
  after(tool:string,args:Record<string,unknown>,res:BrowserResult):void {
    const error=!!res.isError;
    if(error) {
      this.lastFailure={tool,args:stableArgs(args),serial:this.snapshotSerial};
      if(tool==='browser_snapshot'||!noMutation.has(tool))this.snapshotValid=false;
      return;
    }
    if(tool==='browser_snapshot'){
      // A snapshot saved directly to a file is not necessarily visible to the LLM.
      this.snapshotValid=!(typeof args.filename==='string'&&args.filename.trim());
      if(this.snapshotValid)this.snapshotSerial++;
      this.lastFailure=null;
    } else if(tool==='browser_tabs' && args.action==='list') {
      // Read-only, no tab selection change.
    } else if(!noMutation.has(tool)) {
      this.snapshotValid=false;
      this.lastFailure=null;
    }
  }
  /** Serialize Playwright operations on the same local browser to prevent
   * a resize/navigation from racing a click against a stale snapshot. */
  async serial<T>(job:()=>Promise<T>):Promise<T> {
    const previous=this.queue;
    let done:()=>void=()=>{};
    this.queue=new Promise<void>(r=>{done=r;});
    await previous;
    try{return await job();}finally{done();}
  }
}
export const playwrightPolicy=new PlaywrightCallPolicy();
