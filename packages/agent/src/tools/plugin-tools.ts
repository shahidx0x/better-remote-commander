/**
 * AI-facing plugin tools. Plugins (MCP servers running on this device) are reached through two
 * small tools instead of adding every plugin tool to the device's tool list, which keeps the
 * client's context small and works with clients that cap the number of tools.
 *
 *   list_plugin_tools - plugins on this device, their status, and (for one plugin) its tools + schemas
 *   call_plugin_tool  - call one tool of one plugin
 */
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { callPluginTool, getPluginTools, runningPluginIds } from '../plugins/host.js';
import { BROWSER_WORKFLOW_TEXT, classifyBrowserError, playwrightPolicy } from '../runtime/browser-workflow.js';
import { listPlugins } from '../plugins/manager.js';
import { getPlugin } from '../plugins/store.js';
import type { ServerResult } from '../core/types.js';
import type { ToolDefinition } from '../core/tool-definitions.js';

const text = (t: string, isError = false): ServerResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

export const ListPluginToolsArgsSchema = z.object({
  plugin: z.string().optional().describe('Plugin id. Omit to list all plugins; pass one to get its tools with full input schemas.'),
  refresh: z.boolean().optional().default(false).describe('Re-read the tool list from the running plugin instead of the cache.'),
});

export const CallPluginToolArgsSchema = z.object({
  plugin: z.string().min(1).describe('Plugin id, from list_plugin_tools.'),
  tool: z.string().min(1).describe('Tool name inside that plugin.'),
  args: z.record(z.unknown()).optional().default({}).describe('Arguments, following the tool\'s input schema from list_plugin_tools.'),
});

function isPlaywright(id:string):boolean {
  const rec=getPlugin(id);
  return id.toLowerCase()==='playwright' ||
    (rec?.source.type==='npm' && rec.source.package==='@playwright/mcp');
}
function policyError(code:string,message:string,next?:{tool:string;args:Record<string,unknown>}):ServerResult {
  return {isError:true,content:[{type:'text',text:code+': '+message}],
    structuredContent:{error:{code,message,retryable:false},
      recovery:{automaticRetry:false,suggestion:message,...(next?{next}:{})}}};
}
function oneLine(s: string | undefined, max = 160): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
}

export async function handleListPluginTools(args: unknown): Promise<ServerResult> {
  const parsed = ListPluginToolsArgsSchema.safeParse(args);
  if (!parsed.success) return policyError('INVALID_ARGUMENT',
    'Invalid list_plugin_tools arguments: '+parsed.error.message.slice(0,900),
    {tool:'list_plugin_tools',args:{}});
  const { plugin, refresh } = parsed.data;

  if (!plugin) {
    const records = listPlugins();
    const all = records.filter((p) => p.source?.type !== 'binary');
    const programs = records.filter((p) => p.source?.type === 'binary');
    if (!records.length) return text('No plugins are set up on this device.');
    const lines = all.map((p) => {
      const state = !p.enabled ? 'disabled' : p.status === 'installed' ? 'ready' : p.status;
      const cached = Array.isArray(p.toolsCache) ? p.toolsCache : [];
      const tools = cached.length ? ` · ${cached.length} tools: ${cached.slice(0, 12).map((t) => t.name).join(', ')}${cached.length > 12 ? ', ...' : ''}` : '';
      const why = p.status !== 'installed' && (p.error || p.userAction) ? `\n    ${p.userAction ? `needs user: ${p.userAction}` : p.error}` : '';
      return `- ${p.id} [${state}] ${p.name}${p.description ? ` - ${oneLine(p.description, 120)}` : ''}${tools}${why}`;
    });
    const progLines = programs.map((p) => {
      const state = !p.enabled ? 'disabled' : p.status === 'installed' ? 'ready' : p.status;
      return `- ${p.id} [${state}] ${p.name}${p.status !== 'installed' && p.error ? ` (${p.error})` : ''}`;
    });
    const progBlock = progLines.length ? `\n\nPrograms used by BRC's own tools (ast_search, ast_rewrite, run_command; not called through call_plugin_tool):\n${progLines.join('\n')}` : '';
    return text(`Plugins on this device:\n${lines.length ? lines.join('\n') : '(none)'}${progBlock}\n\nDEFAULT: NO BROWSER for normal coding. Use file tools, run_command and Serena when useful. Playwright is for necessary browser/visual verification only. Call list_plugin_tools with {"plugin":"<id>"} for installed tool schemas, then call_plugin_tool.`);
  }

  const rec = getPlugin(plugin);
  if (!rec) return policyError('PLUGIN_NOT_FOUND',
    `Unknown plugin "${plugin}". List the available plugin IDs before selecting one.`,
    {tool:'list_plugin_tools',args:{}});
  if (rec.source.type === 'binary') return policyError('PLUGIN_NOT_MCP',
    `"${plugin}" is an installed program used by BRC's built-in tools, not an MCP plugin. Use the corresponding built-in tool or select a listed MCP plugin.`,
    {tool:'list_plugin_tools',args:{}});
  if (!rec.enabled || rec.status !== 'installed') return policyError('PLUGIN_NOT_READY',
    `Plugin "${plugin}" is ${!rec.enabled ? 'disabled' : rec.status}. Its cached tools (if any) must not be reported as ready. Check the plugin status and complete setup before calling its tools.`,
    {tool:'list_plugin_tools',args:{}});
  try {
    const tools = await getPluginTools(plugin, refresh);
    const body = tools.map((t) => `### ${t.name}\n${t.description ?? ''}\ninput schema: ${JSON.stringify(t.inputSchema ?? {})}`).join('\n\n');
    return text(`Plugin "${plugin}" (${rec.name}) has ${tools.length} tools. Call them with call_plugin_tool {"plugin":"${plugin}","tool":"<name>","args":{...}}.\n\n${isPlaywright(plugin)?'BRC LOCAL PLAYWRIGHT RULES: '+BROWSER_WORKFLOW_TEXT+'\n\n':plugin.toLowerCase()==='serena'?'BRC LOCAL SERENA RULE: Use symbol/navigation tools when appropriate. For ordinary file reads/edits and builds, use core file tools and run_command. No browser required.\n\n':''}${body}`);
  } catch (e) {
    // Discovery failures are explicitly classified. The caller can inspect a
    // previously cached schema without pretending the plugin is currently live.
    const details = oneLine(e instanceof Error ? e.message : String(e), 600);
    const cached = Array.isArray(rec.toolsCache) ? rec.toolsCache : [];
    const isUnavailable = !rec.enabled || rec.status !== 'installed';
    const code = isUnavailable ? 'PLUGIN_NOT_READY' : 'PLUGIN_DISCOVERY_FAILED';
    const suggestion = isUnavailable
      ? 'Check the plugin status and enable/install/repair it before trying its tools.'
      : 'Check plugin installation, its stderr log, and connection status; retry discovery after the plugin is ready.';
    const cacheMessage = cached.length
      ? `\nPreviously cached schemas (${cached.length}, not verified live): ${cached.slice(0,12).map(t=>t.name).join(', ')}${cached.length>12?', ...':''}.`
      : '';
    return {isError:true,
      content:[{type:'text',text:`${code}: Plugin "${plugin}" could not list tools: ${details}.${cacheMessage}\n${suggestion}`}],
      structuredContent:{error:{code,message:details,retryable:!isUnavailable},
        pluginId:plugin,pluginStatus:rec.status,cachedToolsAvailable:cached.length>0,
        recovery:{automaticRetry:false,suggestion,next:{tool:'list_plugin_tools',args:{}}}}};
  }
}

export async function handleCallPluginTool(args: unknown): Promise<ServerResult> {
  const parsed = CallPluginToolArgsSchema.safeParse(args);
  if (!parsed.success) return policyError('INVALID_ARGUMENT',
    'Invalid call_plugin_tool arguments: '+parsed.error.message.slice(0,900));
  const {plugin,tool,args:toolArgs}=parsed.data;
  const browser=isPlaywright(plugin);
  const perform=async():Promise<ServerResult>=>{
    // A closed/idle plugin process cannot retain live browser snapshot refs.
    if(browser&&!runningPluginIds().includes(plugin))playwrightPolicy.reset();
    if(browser){
      const invalid=playwrightPolicy.before(tool,toolArgs);
      if(invalid)return policyError(invalid.code,invalid.message,invalid.next);
    }
    try {
      const res=await callPluginTool(plugin,tool,toolArgs);
      if(!browser)return {content:res.content as unknown as ServerResult['content'],
        ...(res.isError?{isError:true}:{})};
      playwrightPolicy.after(tool,toolArgs,{isError:res.isError,
        content:res.content as Array<{type?:string;text?:string}>});
      const content=[...(res.content as unknown as ServerResult['content'])];
      if(res.isError){
        const details=res.content.filter(c=>c.type==='text').map(c=>String(c.text??'')).join(' ').slice(0,1800);
        const kind=classifyBrowserError(details);
        const suggestion=kind==='ELEMENT_RESOLUTION'
          ? 'Element reference is stale/invalid. Call browser_snapshot, identify the new target and correct args. Never restart Playwright for a stale target.'
          : kind==='PLUGIN_TRANSPORT'
            ? 'Playwright plugin connection failed. Check plugin status with list_plugin_tools and inspect the error; do not treat this as an element-resolution failure.'
            : 'Inspect the Playwright error and the current page with browser_snapshot before retrying. Never resend an identical failed call.';
        content.push({type:'text',text:'BRC PLAYWRIGHT RECOVERY ('+kind+'): '+suggestion});
        return {isError:true,content,structuredContent:{
          error:{code:kind,message:details.slice(0,900),retryable:false},
          recovery:{automaticRetry:false,suggestion},snapshotFresh:false}};
      }
      const needsSnapshot=tool.startsWith('browser_') &&
        !['browser_snapshot','browser_take_screenshot','browser_console_messages','browser_network_requests'].includes(tool) &&
        !(tool==='browser_tabs'&&toolArgs.action==='list');
      if(needsSnapshot)content.push({type:'text',text:'BRC PLAYWRIGHT NEXT: Browser state may have changed. Obtain browser_snapshot before the next browser_click; verify page state after major interactions. Reuse this browser session.'});
      return {content,structuredContent:{browserWorkflow:{...playwrightPolicy.status(),
        ...(needsSnapshot?{nextTool:'browser_snapshot'}:{})}}};
    }catch(e){
      const message=e instanceof Error?e.message:String(e);
      if(browser) {
        playwrightPolicy.after(tool,toolArgs,{isError:true});
        const kind=classifyBrowserError(message);
        const suggestion=kind==='ELEMENT_RESOLUTION'
          ? 'Refresh browser_snapshot and correct target; never restart Playwright solely for stale refs.'
          : 'Check the local plugin connection and inspect this transport error. Do not replay a possibly completed browser action without verifying state.';
        return policyError(kind,'call_plugin_tool '+plugin+'.'+tool+' failed: '+message.slice(0,900)+'. '+suggestion);
      }
      return policyError('PLUGIN_TRANSPORT',
        'call_plugin_tool '+plugin+'.'+tool+' failed: '+message.slice(0,900));
    }
  };
  // Playwright is a stateful browser. Serialize its calls through one agent
  // so resize/navigation cannot race the snapshot checked by a click.
  return browser?playwrightPolicy.serial(perform):perform();
}

export const PLUGIN_TOOL_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<ServerResult>> = {
  list_plugin_tools: handleListPluginTools,
  call_plugin_tool: handleCallPluginTool,
};

export function buildPluginToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: 'list_plugin_tools',
      description: [
        'List plugins installed on this device (extra MCP servers such as browser automation, desktop control,',
        'code intelligence or document conversion) and their status. Pass {"plugin":"<id>"} to get that plugin\'s',
        'tools with their full input schemas, then use call_plugin_tool. Check here whenever a task needs a',
        'capability the core tools do not have (screen/mouse/keyboard, symbol navigation, Office/PDF files...).',
        'DEFAULT: no browser. First use local file tools and run_command, Serena when useful; browser/Playwright only for necessary visual verification or interaction.',
      ].join('\n'),
      inputSchema: zodToJsonSchema(ListPluginToolsArgsSchema),
      annotations: { title: 'List plugin tools', readOnlyHint: true },
    },
    {
      name: 'call_plugin_tool',
      description: 'Call an installed plugin tool: {"plugin":"<id>","tool":"<name>","args":{...}}. First get its schema via list_plugin_tools. Default to NO browser for coding; use Serena for symbols. For Playwright, take fresh browser_snapshot before browser_click, use required target, never name; after navigation/DOM changes refresh refs. BRC serializes browser calls, never auto-retries stale clicks or restarts the browser for element errors.',
      inputSchema: zodToJsonSchema(CallPluginToolArgsSchema),
      annotations: { title: 'Call plugin tool', readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
  ];
}
