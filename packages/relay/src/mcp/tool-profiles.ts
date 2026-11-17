/**
 * MCP tool profiles: trim what tools/list ADVERTISES to cut model context. Selected with
 * BRC_MCP_TOOL_PROFILE = full (default, advertise everything) | focused | core.
 *
 * SECURITY: hiding is NOT authorisation and NOT removal. A tool left out of tools/list stays
 * callable by exact name, exactly as before (device-side policy, approvals and the read-only
 * link allowlist in server.ts are the only gates). Profiles never grant anything; on a
 * read-only link the advertised set is the INTERSECTION of the profile and the read-only list.
 * `list_devices` is a relay navigation tool and is always advertised.
 */
export type ToolProfile = 'full' | 'focused' | 'core';

/** Everyday tools: config, files, search, commands/processes, git, jobs, batch, images, code navigation, checks. */
export const CORE_TOOLS: readonly string[] = [
  'get_config', 'set_config_value',
  'read_file', 'read_multiple_files', 'write_file', 'edit_block', 'create_directory', 'list_directory', 'move_file', 'delete_file', 'get_file_info',
  'start_search', 'get_more_search_results', 'stop_search', 'list_searches',
  'run_command', 'start_process', 'read_process_output', 'interact_with_process', 'force_terminate', 'list_sessions',
  'git_status', 'git_diff', 'git_log',
  'spawn_job', 'wait_jobs', 'get_job', 'list_jobs', 'cancel_job',
  'workspace_batch', 'read_images',
  'project_context', 'code_outline', 'read_symbol', 'find_symbols',
  'discover_checks', 'run_project_checks',
  // relay-side skill tools (only exist when skills are enabled)
  'list_skills', 'read_skill', 'request_skill_install', 'search_skills_catalog',
];

/** Focused = core + plugins, workers, parallel/sandbox runs, process admin and the rest of code navigation. */
export const FOCUSED_EXTRAS: readonly string[] = [
  'list_processes', 'kill_process',
  'list_plugin_tools', 'call_plugin_tool', 'search_mcp_registry', 'request_plugin_install',
  'run_parallel', 'sandbox_run', 'worker_tasks', 'worker_patch', 'worker_integrate',
  'ast_search', 'ast_rewrite',
  'read_code_file', 'project_map', 'find_references', 'related_files', 'context_pack', 'code_graph', 'language_capabilities', 'project_index',
];

const CORE_SET = new Set(CORE_TOOLS);
const FOCUSED_SET = new Set([...CORE_TOOLS, ...FOCUSED_EXTRAS]);

/** Unknown/empty values fall back to `full` (today's behaviour). */
export function resolveToolProfile(env: NodeJS.ProcessEnv = process.env): ToolProfile {
  const v = (env.BRC_MCP_TOOL_PROFILE ?? '').trim().toLowerCase();
  return v === 'core' || v === 'focused' ? v : 'full';
}

/** Whether tools/list advertises `name`. Advertising only; never use this to authorise a call. */
export function profileAdvertises(profile: ToolProfile, name: string): boolean {
  if (profile === 'full' || name === 'list_devices') return true;
  return (profile === 'core' ? CORE_SET : FOCUSED_SET).has(name);
}
