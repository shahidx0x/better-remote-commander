/**
 * MCP server factory: one low-level Server per HTTP request (stateless Streamable HTTP).
 * Publish stable agent tool schemas even with zero connected devices. Many MCP clients
 * snapshot tools/list at first connection and never refresh automatically.
 * Online agents override bundled schemas; authorization and execution always use
 * live owner/device/pause checks in invoke.ts.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { DeviceHub } from '../device-hub.js';
import type { RelayStore } from '../store/types.js';
import { invokeTool, connectionStatus, type InvokeContext } from './invoke.js';
import { BUNDLED_AGENT_TOOL_CATALOG } from './agent-tools.catalog.js';
import { publicToolDescription } from './public-tool-descriptions.js';
import { handlePluginRelayTool, PLUGIN_RELAY_TOOLS } from './plugin-tools.js';
import type { RegistryClient } from '../plugins/registry.js';
import { SKILL_RELAY_TOOLS, handleSkillRelayTool } from './skill-tools.js';
import type { SkillsCatalog } from '../features/skills.js';
import { OperationJournal, RecoveryError } from './operation-journal.js';
import type {CrossRelayCoordinator} from './cross-relay.js';

export type McpContext = InvokeContext;

export const DEVICE_ID_PROP = {
  deviceId: { type: 'string', description: 'Target device id (from list_devices). Required when more than one device is online; may be omitted when only one device is connected.' },
  operationId: {type:'string',pattern:'^[0-9a-fA-F-]{36}$',description:'Optional stable UUID idempotency key. Reusing the SAME key with the same arguments retrieves the prior result/status without re-execution. Never reuse for distinct requests.'},
};

export function withDeviceId(schema: unknown): Record<string, unknown> {
  const s = (schema && typeof schema === 'object' ? { ...(schema as Record<string, unknown>) } : {}) as Record<string, unknown>;
  delete s.$schema;
  s.type = 'object';
  s.properties = { ...((s.properties as Record<string, unknown>) ?? {}), ...DEVICE_ID_PROP };
  return s;
}

// Explicit allowlist: do not trust an unreviewed tool annotation to enforce read-only access.
const READ_ONLY_TOOLS = new Set([
  'read_file', 'read_multiple_files', 'list_directory', 'get_file_info',
  'read_code_file', 'read_code_ranges', 'read_code_context', 'read_symbol', 'code_outline',
  'find_symbols', 'find_references', 'related_files', 'code_diagnostics',
  'project_context', 'project_map', 'context_pack', 'language_capabilities',
  'vscode_tasks', 'git_status', 'git_diff', 'git_log', 'test_impact',
  'docker_inventory', 'docker_inspect', 'read_images', 'agent_status', 'recover_operation',
  'discover_checks', 'review_changes', 'session_handoff',
  'batch_tools', // Read-only clients may batch, but every nested tool is validated below.
]);

/** Prevent a read-only capability URL from using batch_tools as a mutation tunnel. */
export function readOnlyToolAllowed(name: string, args: unknown): boolean {
  if (!READ_ONLY_TOOLS.has(name) && name !== 'search_mcp_registry' && !['list_skills','read_skill','search_skills_catalog'].includes(name)) return false;
  if (name !== 'batch_tools') return true;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const calls = (args as { calls?: unknown }).calls;
  if (!Array.isArray(calls) || calls.length < 1 || calls.length > 64) return false;
  return calls.every((call: unknown) => {
    if (!call || typeof call !== 'object' || Array.isArray(call)) return false;
    const child = call as { tool?: unknown; arguments?: unknown };
    return typeof child.tool === 'string' && child.tool !== 'batch_tools'
      && READ_ONLY_TOOLS.has(child.tool)
      && (child.arguments === undefined || (!!child.arguments && typeof child.arguments === 'object' && !Array.isArray(child.arguments)));
  });
}

export const RECOVER_OPERATION_TOOL = {
 name:'recover_operation',
 description:'USE WHEN: Read the final result or status of a previous durable relay operation after uncertain delivery, without rerunning it. USE INSTEAD: For new work use the original tool; for active local agent activity use agent_status. IMPORTANT: Pass the original operationId, or omit it to list this OAuth client\'s recent operations. Supports byte-offset paging of authorized encrypted results. Never automatically replay uncertain mutations.',
 inputSchema:{type:'object',additionalProperties:false,properties:{
  operationId:{type:'string',pattern:'^[0-9a-fA-F-]{36}$'},
  includeResult:{type:'boolean',default:true},
  offset:{type:'integer',minimum:0,maximum:524288,default:0},
  limit:{type:'integer',minimum:1,maximum:16384}
 }},annotations:{readOnlyHint:true,title:'Recover operation'}
};

export const LIST_DEVICES_TOOL = {
  name: 'list_devices',
  description: 'USE WHEN: identify devices available to THIS OAuth account, with status and relayInstance. USE INSTEAD: for files on a known device use the file/code tools; for agent operations use agent_status. IMPORTANT: zero accessible devices does NOT prove the PC is powered off; no_devices_for_oauth_account means this OAuth principal has no paired PC. A different relayInstance from /health suggests multiple relay processes. Never bypass device ownership.',
  inputSchema: { type: 'object', properties: {} },
  annotations: { title: 'List devices', readOnlyHint: true },
};

/** Redundant or deployment-specific tool entry points are retired from
 * tools/list in ALL profiles, including Full. Their implementations remain
 * available for internal worker integration and cached legacy MCP calls.
 * This is discovery de-duplication, NOT an authorization policy.
 */
export const RETIRED_PUBLIC_AGENT_TOOLS = new Set([
  // Keep simple write_file + edit_block; worker integrations retain the internal
  // hash-checked workspaceBatch engine without showing competing editors.
  'workspace_batch','edit_code_ranges','replace_symbol','ast_rewrite',
  // Keep read_multiple_files and run_parallel, avoid a third composite batch.
  'batch_tools','read_code_context','read_code_ranges',
  // Executed check discovery/checks replace ad-hoc verification.
  'verify_project','project_index','review_changes','code_diagnostics','test_impact',
  // Use agent_status for counters and discover_checks for command definitions.
  'get_usage_stats','get_recent_tool_calls','vscode_tasks','coding_session',
  // Not needed in a general-purpose coding MCP catalog.
  'docker_inventory','docker_inspect','sandbox_run'
]);
/** Default coding-first catalog. Keep 37 useful native agent entries;
 * the relay adds device discovery and the MCP marketplace (up to 40 total).
 * Computer-use, Playwright, Serena and MarkItDown remain reachable through
 * list_plugin_tools + call_plugin_tool, not as dozens of top-level entries.
 * Extra handlers remain available in focused/full and to legacy callers.
 */
export const CORE_MCP_AGENT_TOOLS = new Set([
  'agent_status',
  // Read, search and understand projects.
  'read_file','read_multiple_files','read_code_file','list_directory',
  'start_search','code_mode','project_context','context_pack',
  'project_map','read_images',
  // Safe file changes, including source patching and deletion.
  'write_file','edit_block','edit_files','apply_patch','create_directory','move_file',
  'delete_file',
  // Commands, long processes, independent work, Git and real checks.
  'run_command','start_process','read_process_output','interact_with_process',
  'run_parallel','git_status','git_diff','git_log','discover_checks','run_project_checks',
  'spawn_job','wait_jobs','get_job','cancel_job',
  // Optional installed MCP servers and operational recovery.
  'list_plugin_tools','call_plugin_tool','force_terminate','list_sessions','cancel_operation',
]);
/** Default Code Mode-first catalog: a small direct fallback, with all reviewed
 * coding, test, project and external MCP methods progressively discoverable
 * inside code_mode. This changes visibility only, never tool authorization.
 * The 40-tool 'core' profile is still selectable for legacy/manual clients.
 */
export const CODEMODE_MCP_AGENT_TOOLS = new Set([
  'code_mode',
  'read_file','read_multiple_files','edit_block','run_command',
  'agent_status','get_job','wait_jobs','cancel_job',
  'list_plugin_tools','call_plugin_tool',
]);
/** Optional larger discovery profile. No profile grants additional privileges. */
export const FOCUSED_MCP_AGENT_TOOLS = new Set([
  'get_config','set_config_value','read_file','read_multiple_files','write_file',
  'create_directory','list_directory','move_file','get_file_info','edit_block',
  'start_search','get_more_search_results','stop_search','list_searches','code_mode',
  'start_process','read_process_output','interact_with_process','force_terminate','list_sessions',
  'run_command','git_status','git_diff','git_log','agent_status','cancel_operation',
  'project_context','project_map','context_pack','read_code_file','read_code_ranges',
  'read_code_context','edit_code_ranges','edit_files','apply_patch','workspace_batch','batch_tools',
  'discover_checks','run_project_checks','verify_project','read_images',
  'run_parallel','spawn_job','wait_jobs','get_job','list_jobs','cancel_job',
  'worker_tasks','worker_patch','worker_integrate',
  'list_plugin_tools','call_plugin_tool','code_graph','lsp_query','get_recent_tool_calls',
]);
export type McpToolProfile = 'codemode'|'core'|'focused'|'full';
/** Code Mode-first is the default. 'core' retains the earlier 40-tool profile. */
export function mcpToolProfile(value=process.env.BRC_MCP_TOOL_PROFILE):McpToolProfile {
  return value==='core'||value==='focused'||value==='full'?value:'codemode';
}
export function exposeMcpAgentTool(name:string,profile=process.env.BRC_MCP_TOOL_PROFILE):boolean {
  if(RETIRED_PUBLIC_AGENT_TOOLS.has(name))return false;
  const mode=mcpToolProfile(profile);
  return mode==='full'||({codemode:CODEMODE_MCP_AGENT_TOOLS,
    core:CORE_MCP_AGENT_TOOLS,focused:FOCUSED_MCP_AGENT_TOOLS} as const)[mode].has(name);
}

/** Shared public tool catalog for MCP tools/list and /health.
 * Default codemode: 11 agent + 3 relay tools (14), plus optional
 * recover_operation (15). Legacy core: 37 agent + 3 relay (40);
 * with recovery, list_sessions is hidden to preserve its 40-slot budget.
 * Discovery does NOT imply execution authorization.
 */
export function composeMcpToolList<T extends {name:string;description:string;inputSchema:unknown}>(
  agentTools:T[], options:{
    onlineCount?:number;profile?:McpToolProfile;access?:'read'|'full';
    plugins?:boolean;skills?:boolean;journal?:boolean;
  }={}
) {
  const profile=options.profile??mcpToolProfile();
  const core=profile==='core';
  const access=options.access??'full';
  const selected=core&&options.journal
    ?agentTools.filter(t=>t.name!=='list_sessions'):agentTools;
  const relayTools=[
    {...LIST_DEVICES_TOOL,description:`${LIST_DEVICES_TOOL.description} ${options.onlineCount??0} device(s) currently online.`},
    ...(options.journal?[RECOVER_OPERATION_TOOL]:[]),
    ...(options.plugins?PLUGIN_RELAY_TOOLS.filter(t=>access!=='read'||t.name==='search_mcp_registry'):[]),
    ...(!core&&profile!=='codemode'&&options.skills
      ?SKILL_RELAY_TOOLS.filter(t=>access!=='read'||t.name!=='request_skill_install'):[]),
  ];
  // Code Mode is visibly the PRIMARY action, while direct file/job tools
  // remain available for simple work, troubleshooting and older workflows.
  if(profile==='codemode'){
    const code=selected.find(t=>t.name==='code_mode');
    return [...(code?[code]:[]),...relayTools,...selected.filter(t=>t.name!=='code_mode')];
  }
  return [...relayTools,...selected];
}
// Cache schema transformation only, NEVER authentication, ownership or pause checks.
// Device objects change on reconnect/hello; pause state is read freshly for every tools/list.
type ToolCache = {profile:McpToolProfile;devices:object[];definitions:unknown[];tools:{name:string;description:string;inputSchema:unknown;annotations?:Record<string,unknown>}[]};
const schemaCaches = new WeakMap<DeviceHub,Map<string,ToolCache>>();
// Advertise reviewed guidance for ALL known tools, even when an older agent
// reconnects with verbose or contradictory legacy descriptions. The live INPUT
// SCHEMA still wins for every tool except the explicitly strengthened
// read_multiple_files cross-field schema.
const ROUTING_DESCRIPTIONS = new Map(BUNDLED_AGENT_TOOL_CATALOG.map(t => [t.name, publicToolDescription(t)] as const));
// Keep multi-file JSON Schema's cross-field rule visible even when the online
// agent has not yet been restarted with its updated tool definitions.
const MULTI_FILE_INPUT_SCHEMA = BUNDLED_AGENT_TOOL_CATALOG.find(t => t.name === 'read_multiple_files')?.inputSchema;
/** Stable tool set plus online agent-specific schemas; execution still requires a live, owned device. */
export async function liveTools(hub: DeviceHub, store: RelayStore, userId: string) {
  const connected = hub.list(userId);
  const pauseStates = await Promise.all(connected.map(d => store.getDevice(d.deviceId)));
  const online = connected.filter((d,i) => !pauseStates[i]?.paused);
  const devices=online.map(d=>hub.get(d.deviceId)!).filter(Boolean);
  const profile=mcpToolProfile();
  // With an Android-only connection, don't advertise desktop-only tools from
  // the static catalog. The Android agent reports its actual supported tools
  // in hello; an offline relay still advertises the full stable catalog.
  const androidOnly=devices.length>0 && devices.every(d=>d.info.platform==='android');
  const available=androidOnly ? new Set(devices.flatMap(d=>d.tools.map(t=>t.name))) : null;
  let cache=schemaCaches.get(hub);if(!cache){cache=new Map();schemaCaches.set(hub,cache);}
  const prior=cache.get(userId);
  if(prior&&prior.profile===profile&&prior.devices.length===devices.length&&devices.every((d,i)=>prior.devices[i]===d&&prior.definitions[i]===d.tools)){
    cache.delete(userId);cache.set(userId,prior);return{online:devices.length,tools:prior.tools};
  }
  // Seed with stable definitions so a client connecting while the agent is offline
  // gets the same tools as one connecting while it is online.
  // Do not cache user authorization: this is only static, public schema metadata.
  const merged = new Map<string, { name: string; description: string; inputSchema: unknown; annotations?: Record<string, unknown> }>();
  for (const t of BUNDLED_AGENT_TOOL_CATALOG)
    if (exposeMcpAgentTool(t.name) && (!available || available.has(t.name)))
      merged.set(t.name, { ...t, description: ROUTING_DESCRIPTIONS.get(t.name) ?? t.description,
        inputSchema: withDeviceId(t.inputSchema) });
  // Prefer currently connected agent schemas if its installed version differs.
  // Overriding preserves catalog order for the usual tools/list snapshot.
  for (const d of devices) for (const t of d.tools)
    if(exposeMcpAgentTool(t.name))
    merged.set(t.name, { ...t, description: ROUTING_DESCRIPTIONS.get(t.name) ?? t.description,
      inputSchema: withDeviceId(t.name === 'read_multiple_files' && MULTI_FILE_INPUT_SCHEMA
        ? MULTI_FILE_INPUT_SCHEMA : t.inputSchema) });
  const tools=[...merged.values()];cache.set(userId,{profile,devices,definitions:devices.map(d=>d.tools),tools});
  while(cache.size>128)cache.delete(cache.keys().next().value!);
  return { online: devices.length, tools };
}

/** Concise routing guidance placed in MCP initialize and repeated by key tool descriptions.
 * AI hosts decide which tool to call; this cannot force model behavior. */
export const TOOL_ROUTING_GUIDANCE = [
  'BRC MCP TOOL GUIDE: Tools run on the selected, authorized local device, not on the relay. One known file -> read_file; two or more known files -> read_multiple_files; unknown filenames -> start_search. Create/append a file with write_file; edit a known block with edit_block. For code changes use apply_patch with exact-context Update/Add/Delete/Move sections, or edit_files with hashes. Never replay an uncertain mutation. A truncated result is NOT complete: follow its next offset. Never blindly retry an uncertain write. Process/job IDs mean started, not finished. Tool descriptions do not grant authorization.',
  '2+ known files to read -> ONE read_multiple_files call with paths[] or files[] (per-file ranges). Do NOT issue repeated or Promise.all(read_file) for known paths.',
  'One file/range -> read_file. Code snapshots needing full-file SHA-256 -> read_code_file; for multiple files use read_multiple_files followed by targeted read_code_file calls only when hashes are required.',
  'Unknown files -> start_search(wait=true); malformed implicit regex patterns are searched literally once, while explicit literalSearch:false stays strict. Read relevant matches with read_file or read_code_file. Do not poll unless an actual streaming search session is active.',
  'Multiple independent read/context operations -> read_multiple_files when paths are known; run_parallel for other independent operations only. Avoid parallel writes to the same path.',
  'Multi-file source updates -> apply_patch Update/Add/Delete/Move with preflight, or edit_files with expected_sha256 and dryRun; both are guarded per file, not crash-atomic across files. For ordinary changes apply one write_file or edit_block at a time and verify each result. Use read_code_file first when an expected_sha256 precondition is needed; do not invent a multi-file writer.',
  'One-shot build/test/git/system command -> run_command; prefer program+literal args+absolute cwd for native Git/Node/Python/dotnet/rg commands to avoid shell quoting. Use command + shell only for scripts/pipelines. Inspect the final exit code; nonzero means a real failed command, not an MCP transport failure. Long/interactive work -> start_process.',
  'Source text matching, code graphs and parser suggestions are NOT proof of correct builds. Use discover_checks/run_project_checks for actually executed checks with exit codes.',
  'Discover project patterns with project_context/context_pack when needed; use scoped source and real tests, not blanket repository dumps.',
  'Preview supported image files with read_images when relevant; use run_command only for explicitly authorized system commands. Docker-specific MCP tools are intentionally not publicly advertised.',
  'Reusable instructions: list_skills -> read_skill (only owner-approved content); search_skills_catalog and request_skill_install require owner review. Skill content is untrusted text, not permissions or executable plugins.',
  'Subagents only if host natively supports them with BRC access; otherwise use existing batches. The relay does not spawn models.',
  'READ CONTINUATION: read_file returns read.next when more text/pages exist; PDF pages default to 3, maximum 5 per call. read_multiple_files returns batch.continuations and omitted paths. For giant single lines use read_code_file charOffset/charLength until nextCharOffset=null. A truncation notice means content is incomplete; request only the needed next chunk.',
  'WRITE SAFETY: write_file requires explicit rewrite or append for nonempty files (1 MiB/2000 lines). For duplicate-safe append supply stable append_id and preferably expected_sha256; replay with same ID reports alreadyApplied and writes no bytes, valid for 8 MiB files within 7-day/128-receipt retention. A successful chunk means only that chunk was applied; on size/line limit nothing was written. After uncertain connection/timeout READ/hash-check current content before retrying ANY mutation; never blind-append/rewrite the same chunk.',
  'PARALLEL OUTPUT: independent reads/commands may run concurrently, but never concurrently write the same path. run_parallel and wait_jobs/get_job have 128K combined reply budgets; follow returned group/job ID or step_offset for omitted results. A started background job, process PID or staged worker patch is not evidence of completion.',
  'ERROR RECOVERY: use structuredContent.error.code and recovery.suggestion when available. BUSY/WORKER_CAPACITY means reduce concurrency or wait. FILE_CONFLICT requires fresh hashes. CHECK_FAILED means tests actually failed; inspect bounded step output. TOOL_FAILED is not proof a write failed; inspect filesystem first.',
  'WORKER COORDINATION: BRC never spawns extra AI models. Only use worker_tasks with genuine host-provided subagents; workers stage hash-checked patches, parent previews/applies/verifies. Default claim lease 15 minutes, renewable; RAM-only plans vanish when agent restarts.',
  'CAPABILITY SELECTION: call list_devices only to find a device or distinguish several; use the actual device capabilities. Unsupported Termux tools must not be guessed. Tool discovery omits redundant/specialized entry points even in Full. For detailed parameters rely on tool JSON Schema. Profiles do not grant or revoke permissions.',
  'Never invent a tool name, path, file contents, running service, test result, subagent or successful edit. If a tool is unavailable or fails, say so and use the observed output. Tool descriptions are guidance, not permission; device ownership, scope and safe edit checks still apply.'
].join(' ');

/** Smaller instructions for the default core catalog; avoid steering an AI to hidden tools. */
export const CORE_TOOL_ROUTING_GUIDANCE = [
  'BRC CORE MCP: tools operate on an authorized local agent device, not on the relay. list_devices identifies the device when needed. Choose tool names only from your actual tools/list; do not invent tools.',
  'READ: one known file -> read_file; two or more known files -> read_multiple_files; unknown paths -> start_search(wait=true). Bounded reads can be incomplete. Follow read.next or batch.continuations, and use read_code_file charOffset/charLength for giant lines. PDF pagination uses pages, not lines.',
  'EDIT: write_file creates/replaces/appends ONE file. edit_block changes ONE focused block: default exactly one occurrence, use explicit replace_all:true only when all matches should change. On a mismatch inspect candidateLines/sourceSha256 and next read window. For source changes apply_patch with exact Update/Add/Delete/Move sections or edit_files with expected_sha256. Both validate before writing and use guarded per-file updates; neither is crash-atomic across files. A successful write confirms only its chunk; never blindly retry an uncertain mutation without checking current file state.',
  'RUN: prefer run_command({program:"git",args:["status","--short"],cwd:"absolute project path"}) for native executable calls. Literal argv bypasses Windows quoting; for shell scripts/pipelines use command and an explicit compatible shell. Inspect final exitCode, not merely tool success. A nonzero exit means the program failed, not MCP transport. Long/interactive command -> start_process returns PID+stable sessionId. read_process_output(session_id,cursor) supports independent cursors and encrypted 24h bounded history on paired agents. Restored unfinished sessions remain uncertain; never replay automatically. Independent operations -> run_parallel (default concurrency 4), then use wait_jobs/get_job for incomplete or truncated output. Do not run simultaneous writes to the same path.',
  'EXTERNAL MCP: use list_plugin_tools to inspect ready plugins and their exact schemas, then call_plugin_tool to invoke computer-use, Serena, MarkItDown or Playwright only when the task requires it. Do not open a browser or app for ordinary coding; use local file tools and commands first. Only installed plugins can run.',
  'CODE MODE: for multi-step coding tasks use code_mode with a JavaScript function body. Inside the isolated local worker await tools.search(query), await tools.describe(name), and await tools.call(name,args); inspect actual results, branch and return a compact summary. Every nested operation uses BRC permissions and completion checks. Do not include raw secrets or assume a started background job has passed. For one simple operation prefer its direct tool, and for a long build use spawn_job then get_job/wait_jobs.',
  'MCP INSTALL: search_mcp_registry discovers available servers; request_plugin_install queues an owner-reviewed installation request in BRC Admin. Discovery or a model request cannot install third-party code or supply secret keys on its own.',
  'LONG TASKS: spawn_job starts durable-in-session jobs; wait_jobs/get_job confirm completion and actual exit codes. start_process is for interactive work, read_process_output retrieves updates; use force_terminate for a known session or cancel_operation for an authorized active operation. Never claim completion merely because a job started.',
  'RECOVERY: if recover_operation appears in this catalog, use it with the original operationId after an uncertain MCP delivery rather than rerunning a build or mutation. The optional list_sessions entry is hidden when recovery is available to keep project context and the Core budget at 40.',
  'ERRORS: check structuredContent.error.code and recovery.suggestion. BUSY means wait/reduce concurrency; CHECK_FAILED means actual verification failed; WRITE_LINE_LIMIT/WRITE_SIZE_LIMIT means nothing was written; a disconnected write may still have succeeded, so verify before any retry.',
  'Access controls and user approval are enforced separately from discovery. For code deletions use delete_file only for explicitly identified targets. Do not fabricate file content, completion, tests, extra tools or successful edits.'
].join(' ');

/** Default model instructions: make local Code Mode the planning/execution
 * surface instead of asking the model to shuttle intermediate tool results.
 * A fallback direct call is still encouraged for a single simple action.
 */
export const CODEMODE_TOOL_ROUTING_GUIDANCE = [
  'BRC CODE MODE FIRST (DEFAULT): For most coding, debugging, testing, project exploration and multistep MCP work, call code_mode FIRST. Write a small JavaScript function body with await tools.search(query), await tools.describe(exactName), await tools.call(exactName,args), conditional checks and a compact return value. This is ONE model-to-relay request: local nested tools do not create extra model turns.',
  'DISCOVERY: use tools.search for tool names, tools.describe to inspect the actual JSON parameter schema, and tools.call with correct arguments. Installed external MCP servers: await tools.call("list_plugin_tools",{...}) to inspect a ready plugin, then await tools.call("call_plugin_tool",{plugin,tool,args}) for the selected method. Computer/browser interaction requires an explicit user task; do not open apps or browsers during ordinary coding.',
  'RESULTS: use returned structuredContent and actual command exitCode / test status. A pending tool or background job is NOT finished. For long builds/tests spawn_job through Code Mode, return its jobId, then use the direct get_job/wait_jobs tool on subsequent turns. Default 48 nested calls, maximum 96; the workflow has a deadline, not an unlimited run.',
  'SAFETY: all nested calls go through the original agent dispatcher, path access and user permissions. A Code Mode program cannot install MCP servers or grant itself new permissions. Do not automatically repeat uncertain mutations; inspect affected files and recovery receipts. If a script fails, report partial steps and exact error instead of fabricating completion.',
  'FALLBACK: for ONE trivial, known read, focused edit, or command, a direct read_file/read_multiple_files/edit_block/run_command can be better. Use list_devices only to select a paired device. If Code Mode is unavailable on an older agent, ask to update/restart the agent or switch the relay to BRC_MCP_TOOL_PROFILE=core; do not claim success for unsupported tools.',
  'PLUGIN INSTALL: search_mcp_registry can find candidate servers and request_plugin_install records an owner-reviewed request. It does NOT automatically install third-party packages. A read-only MCP connection must not run Code Mode, file edits or shell commands.',
].join(' ');

export function createMcpServer(hub: DeviceHub, store: RelayStore, ctx: McpContext, relayVersion: string, access: 'read' | 'full' = 'full', plugins?: { registry: RegistryClient; publicUrl: string; skills?: SkillsCatalog; journal?: OperationJournal; crossRelay?: CrossRelayCoordinator },
  onToolTraffic?: (userId:string,tool:string,args:unknown,result:unknown)=>void): Server {
  const server = new Server({ name: 'brc', version: relayVersion }, { capabilities: { tools: {} },
    instructions: (mcpToolProfile()==='codemode' ? CODEMODE_TOOL_ROUTING_GUIDANCE :
      mcpToolProfile()==='core' ? CORE_TOOL_ROUTING_GUIDANCE : TOOL_ROUTING_GUIDANCE) +
      (access === 'read' ? ' THIS CONNECTION IS READ-ONLY: only advertised read tools may be invoked; no writes or terminal mutations.' : '') });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const { online, tools } = await liveTools(hub, store, ctx.userId);
    const onlineCount=plugins?.crossRelay?.enabled?(await plugins.crossRelay.available(ctx.userId)).length:online;
    const selected = access === 'read' ? tools.filter(t => READ_ONLY_TOOLS.has(t.name)).map(t =>
      t.name === 'batch_tools' ? { ...t, description: 'READ-ONLY BATCH: all nested tools must be permitted reads. ' + t.description,
        annotations: { ...t.annotations, readOnlyHint: true, destructiveHint: false } } : t) : tools;
    return { tools: composeMcpToolList(selected, {
      onlineCount,access,plugins:!!plugins,skills:!!plugins?.skills,journal:!!plugins?.journal,
    }) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const { name, arguments: args } = req.params;
    const execute = async () => {
    if (name === 'list_devices') {
      return { content: [{ type: 'text', text: JSON.stringify({ ...await connectionStatus(hub, store, ctx.userId, plugins?.crossRelay), relayInstance: hub.instanceId }, null, 2) }] };
    }
    if(name==='recover_operation'&&plugins?.journal){
      try{
        const recovered=await plugins.journal.recovery(ctx,(args??{}) as Record<string,unknown>);
        return {content:[{type:'text',text:JSON.stringify(recovered)}],structuredContent:recovered};
      }catch(error){
        const e=error instanceof RecoveryError?error:new RecoveryError('RECOVERY_UNAVAILABLE','Operation recovery storage is unavailable.');
        return {content:[{type:'text',text:e.code+': '+e.message}],isError:true,
          structuredContent:{error:{code:e.code,message:e.message,retryable:false}}};
      }
    }
    // Defense in depth: hiding a write tool from tools/list is not enough.
    if (access === 'read' && !readOnlyToolAllowed(name, args))
      return { content: [{ type: 'text', text: 'This connection URL is read-only. Create a full-access URL to use editing or terminal tools.' }], isError: true };
    if (plugins?.skills) {
      const skillResult = await handleSkillRelayTool(store, plugins.skills, ctx, name, args as Record<string, unknown> | undefined);
      if (skillResult) return skillResult;
    }
    if (plugins) {
      const pluginResult = await handlePluginRelayTool({ hub, store, registry: plugins.registry, publicUrl: plugins.publicUrl }, ctx, name, args as Record<string, unknown> | undefined);
      if (pluginResult) return pluginResult;
    }
    const out = await invokeTool(hub, store, ctx, name, args as Record<string, unknown> | undefined, {signal:extra.signal,journal:plugins?.journal,readOnly:readOnlyToolAllowed(name,args),crossRelay:plugins?.crossRelay});
    if (!out.ok) return { content: [{ type: 'text', text: out.message }], isError: true,
      ...(out.operationId?{structuredContent:{operationId:out.operationId,
        recovery:{tool:'recover_operation',args:{operationId:out.operationId}},automaticReplay:false}}:{}) };
    return { ...out.result, isError: out.result.isError ?? false, _meta: { ...out.result._meta, deviceId: out.deviceId, deviceName: out.deviceName, relayDurationMs: out.ms } } as never;
    };
    let result: Awaited<ReturnType<typeof execute>>;
    try { result = await execute(); }
    catch (error) {
      // Even if no tool result was delivered, model-generated call arguments
      // still reached the relay; record that incomplete event without awaiting.
      try { onToolTraffic?.(ctx.userId,name,args,undefined); } catch { /* non-critical */ }
      throw error;
    }
    // No tokenization, copying of payloads or database I/O in this handler.
    // The collector schedules work in a separate worker AFTER this result.
    try { onToolTraffic?.(ctx.userId,name,args,result); } catch { /* diagnostics never break calls */ }
    return result;
  });

  return server;
}
