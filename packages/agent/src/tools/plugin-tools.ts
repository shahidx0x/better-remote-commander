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
import { BROWSER_WORKFLOW_TEXT, classifyBrowserError, recoveryHint, playwrightAdvisor } from '../runtime/browser-workflow.js';
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

function isPlaywright(id: string): boolean {
  const rec = getPlugin(id);
  return id.toLowerCase() === 'playwright' || (rec?.source.type === 'npm' && rec.source.package === '@playwright/mcp');
}

function oneLine(s: string | undefined, max = 160): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
}

export async function handleListPluginTools(args: unknown): Promise<ServerResult> {
  const parsed = ListPluginToolsArgsSchema.safeParse(args);
  if (!parsed.success) return text(`Invalid arguments for list_plugin_tools: ${parsed.error.message}`, true);
  const { plugin, refresh } = parsed.data;

  if (!plugin) {
    const records = listPlugins();
    const all = records.filter((p) => p.source.type !== 'binary');
    const programs = records.filter((p) => p.source.type === 'binary');
    if (!records.length) return text('No plugins are set up on this device.');
    const lines = all.map((p) => {
      const state = !p.enabled ? 'disabled' : p.status === 'installed' ? 'ready' : p.status;
      const tools = p.toolsCache?.length ? ` · ${p.toolsCache.length} tools: ${p.toolsCache.slice(0, 12).map((t) => t.name).join(', ')}${p.toolsCache.length > 12 ? ', ...' : ''}` : '';
      const why = p.status !== 'installed' && (p.error || p.userAction) ? `\n    ${p.userAction ? `needs user: ${p.userAction}` : p.error}` : '';
      return `- ${p.id} [${state}] ${p.name}${p.description ? ` - ${oneLine(p.description, 120)}` : ''}${tools}${why}`;
    });
    const progLines = programs.map((p) => {
      const state = !p.enabled ? 'disabled' : p.status === 'installed' ? 'ready' : p.status;
      return `- ${p.id} [${state}] ${p.name}${p.status !== 'installed' && p.error ? ` (${p.error})` : ''}`;
    });
    const progBlock = progLines.length ? `\n\nPrograms used by BRC's own tools (ast_search, ast_rewrite, run_command; not called through call_plugin_tool):\n${progLines.join('\n')}` : '';
    return text(`Plugins on this device:\n${lines.length ? lines.join('\n') : '(none)'}${progBlock}\n\nCall list_plugin_tools with {"plugin":"<id>"} for that plugin's tools and input schemas, then call_plugin_tool.`);
  }

  const rec = getPlugin(plugin);
  if (!rec) return text(`Unknown plugin "${plugin}". Call list_plugin_tools without arguments to see available plugins.`, true);
  if (rec.source.type === 'binary') return text(`"${plugin}" is a program used by BRC's own tools, not an MCP plugin.`, true);
  try {
    const tools = await getPluginTools(plugin, refresh);
    const body = tools.map((t) => `### ${t.name}\n${t.description ?? ''}\ninput schema: ${JSON.stringify(t.inputSchema ?? {})}`).join('\n\n');
    return text(`Plugin "${plugin}" (${rec.name}) has ${tools.length} tools. Call them with call_plugin_tool {"plugin":"${plugin}","tool":"<name>","args":{...}}.\n\n${isPlaywright(plugin) ? `BRC PLAYWRIGHT GUIDANCE (advisory): ${BROWSER_WORKFLOW_TEXT}\n\n` : ''}${body}`);
  } catch (e) {
    return text(`Plugin "${plugin}" is not available: ${e instanceof Error ? e.message : String(e)}`, true);
  }
}

export async function handleCallPluginTool(args: unknown): Promise<ServerResult> {
  const parsed = CallPluginToolArgsSchema.safeParse(args);
  if (!parsed.success) return text(`Invalid arguments for call_plugin_tool: ${parsed.error.message}`, true);
  const { plugin, tool, args: toolArgs } = parsed.data;
  const browser = isPlaywright(plugin);
  // A stopped plugin process cannot retain live element references.
  if (browser && !runningPluginIds().includes(plugin)) playwrightAdvisor.reset();
  try {
    const res = await callPluginTool(plugin, tool, toolArgs as Record<string, unknown>);
    const content = res.content as unknown as ServerResult['content'];
    if (!browser) return { content, ...(res.isError ? { isError: true } : {}) };
    const stale = playwrightAdvisor.after(tool, toolArgs as Record<string, unknown>, !res.isError);
    if (res.isError) {
      const details = res.content.filter((c) => c.type === 'text').map((c) => String((c as { text?: string }).text ?? '')).join(' ').slice(0, 1800);
      const kind = classifyBrowserError(details, false), suggestion = recoveryHint(kind);
      return { isError: true, content: [...content, { type: 'text', text: `BRC PLAYWRIGHT RECOVERY (${kind}): ${suggestion}` }],
        structuredContent: { error: { code: kind, message: details.slice(0, 900), retryable: false }, recovery: { automaticRetry: false, suggestion } } };
    }
    if (!stale) return { content };
    return { content: [...content, { type: 'text', text: 'BRC PLAYWRIGHT NOTE: page state may have changed; take browser_snapshot before using element references again.' }],
      structuredContent: { browserWorkflow: { ...playwrightAdvisor.status(), nextTool: 'browser_snapshot' } } };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (browser) {
      playwrightAdvisor.after(tool, toolArgs as Record<string, unknown>, false);
      const kind = classifyBrowserError(message), suggestion = recoveryHint(kind);
      return { isError: true, content: [{ type: 'text', text: `${kind}: call_plugin_tool ${plugin}.${tool} failed: ${message.slice(0, 900)}\nNEXT ACTION: ${suggestion}` }],
        structuredContent: { error: { code: kind, message: message.slice(0, 900), retryable: false }, recovery: { automaticRetry: false, suggestion } } };
    }
    return text(`call_plugin_tool ${plugin}.${tool} failed: ${message}`, true);
  }
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
        'capability the core tools do not have (web browser, screen/mouse/keyboard, symbol navigation, Office/PDF files...).',
      ].join('\n'),
      inputSchema: zodToJsonSchema(ListPluginToolsArgsSchema),
      annotations: { title: 'List plugin tools', readOnlyHint: true },
    },
    {
      name: 'call_plugin_tool',
      description: 'Call a tool of a plugin on this device: {"plugin":"<id>","tool":"<name>","args":{...}}. Get ids, tool names and input schemas from list_plugin_tools first. The plugin starts on first use (can take a few seconds). For Playwright, BRC adds advisory recovery hints (fresh browser_snapshot after page changes; stale element refs are not a reason to restart the browser) and never blocks or auto-retries a call.',
      inputSchema: zodToJsonSchema(CallPluginToolArgsSchema),
      annotations: { title: 'Call plugin tool', readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
  ];
}
