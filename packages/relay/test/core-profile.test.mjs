import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BUNDLED_AGENT_TOOL_CATALOG} from '../dist/mcp/agent-tools.catalog.js';
import {liveTools,composeMcpToolList,exposeMcpAgentTool,mcpToolProfile,RETIRED_PUBLIC_AGENT_TOOLS,CODEMODE_MCP_AGENT_TOOLS,CORE_MCP_AGENT_TOOLS,FOCUSED_MCP_AGENT_TOOLS,CODEMODE_TOOL_ROUTING_GUIDANCE,CORE_TOOL_ROUTING_GUIDANCE,readOnlyToolAllowed} from '../dist/mcp/server.js';

test('retired overlapping tools are not advertised by ANY profile, but essential functions remain',async()=>{
 const before=process.env.BRC_MCP_TOOL_PROFILE;
 const hub={list:()=>[],get:()=>null};
 const store={getDevice:async()=>null};
 const account='core-profile-test';
 const known=new Set(BUNDLED_AGENT_TOOL_CATALOG.map(t=>t.name));
 try {
  delete process.env.BRC_MCP_TOOL_PROFILE;
  assert.equal(mcpToolProfile(),'codemode');
  assert.equal(mcpToolProfile('unrecognized'),'codemode');
  assert.equal(BUNDLED_AGENT_TOOL_CATALOG.length,83,'Code Mode adds one new stable tool schema');
  assert.equal(RETIRED_PUBLIC_AGENT_TOOLS.size,19);
  for(const name of CORE_MCP_AGENT_TOOLS) assert.ok(known.has(name),'unknown core '+name);
  for(const name of RETIRED_PUBLIC_AGENT_TOOLS) {
   assert.ok(known.has(name),'unknown retired tool '+name);
   for(const profile of ['codemode','core','focused','full'])assert.equal(exposeMcpAgentTool(name,profile),false,name+' exposed by '+profile);
  }
  const code=(await liveTools(hub,store,account)).tools;
  assert.equal(code.length,11,'default profile keeps only a small direct surface');
  assert.ok(code.every(t=>CODEMODE_MCP_AGENT_TOOLS.has(t.name)));
  const compact=composeMcpToolList(code,{plugins:true,skills:true,profile:'codemode'});
  assert.equal(compact.length,14);
  assert.equal(compact[0].name,'code_mode','Code Mode must be the first advertised tool');
  const compactWithRecovery=composeMcpToolList(code,{plugins:true,skills:true,journal:true,profile:'codemode'});
  assert.equal(compactWithRecovery.length,15);
  assert.equal(new Set(compactWithRecovery.map(t=>t.name)).size,15);
  assert.ok(compactWithRecovery.some(t=>t.name==='recover_operation'));
  assert.ok(!compactWithRecovery.some(t=>t.name==='list_skills'));
  assert.match(CODEMODE_TOOL_ROUTING_GUIDANCE,/code_mode FIRST/);
  process.env.BRC_MCP_TOOL_PROFILE='core';
  const core=(await liveTools(hub,store,account)).tools;
  const names=new Set(core.map(t=>t.name));
  assert.equal(names.size,37);
  for(const name of ['read_file','read_multiple_files','read_code_file','project_context','context_pack','project_map','read_images',
    'write_file','edit_block','edit_files','apply_patch','delete_file','run_command','run_project_checks',
    'run_parallel','spawn_job','wait_jobs','get_job','cancel_job','git_status','git_diff','git_log',
    'list_plugin_tools','call_plugin_tool','force_terminate','list_sessions','cancel_operation','agent_status'])
   assert.ok(names.has(name),'essential tool missing: '+name);
  for(const name of ['workspace_batch','batch_tools','edit_code_ranges','replace_symbol','docker_inventory','docker_inspect','sandbox_run','verify_project',
    'worker_tasks','worker_patch','worker_integrate','get_config','set_config_value','lsp_query','code_graph'])
   assert.ok(!names.has(name),'advanced tool should not be in Core: '+name);
  const normal=composeMcpToolList(core,{plugins:true,skills:true,profile:'core'});
  assert.equal(normal.length,40,'Core must expose exactly 40 main tools without durable recovery');
  assert.equal(new Set(normal.map(t=>t.name)).size,40,'no duplicate names in Core');
  for(const name of ['list_devices','search_mcp_registry','request_plugin_install'])
   assert.ok(normal.some(t=>t.name===name),'required relay tool missing: '+name);
  for(const name of ['list_skills','read_skill','search_skills_catalog','request_skill_install'])
   assert.ok(!normal.some(t=>t.name===name),'optional skill management should not crowd Core: '+name);
  const withRecovery=composeMcpToolList(core,{plugins:true,skills:true,journal:true,profile:'core'});
  assert.equal(withRecovery.length,40,'durable recovery must remain available without exceeding 40');
  assert.ok(withRecovery.some(t=>t.name==='recover_operation'));
  assert.ok(!withRecovery.some(t=>t.name==='list_sessions'));
  assert.ok(withRecovery.some(t=>t.name==='context_pack'));
  assert.equal(composeMcpToolList(core,{profile:'core',plugins:true,access:'read'}).filter(t=>t.name==='request_plugin_install').length,0);
  assert.ok(CORE_TOOL_ROUTING_GUIDANCE.includes('call_plugin_tool'));
  assert.ok(CORE_TOOL_ROUTING_GUIDANCE.includes('request_plugin_install'));
  assert.ok(core.every(t=>t.inputSchema?.properties?.deviceId));
  assert.ok(core.every(t=>t.description.includes('USE INSTEAD:')));
  assert.ok(CORE_TOOL_ROUTING_GUIDANCE.includes('write_file'));
  assert.ok(!CORE_TOOL_ROUTING_GUIDANCE.includes('workspace_batch'));
  assert.equal(readOnlyToolAllowed('write_file',{}),false,'permissions unchanged by profile');
  assert.equal(readOnlyToolAllowed('read_file',{}),true);
  process.env.BRC_MCP_TOOL_PROFILE='focused';
  const focused=(await liveTools(hub,store,account)).tools;
  assert.equal(focused.length,48,'Code Mode is available in Focused too');
  assert.ok(!focused.some(t=>RETIRED_PUBLIC_AGENT_TOOLS.has(t.name)));
  const focusedPublic=composeMcpToolList(focused,{profile:'focused',plugins:true,skills:true,journal:true});
  assert.ok(focusedPublic.some(t=>t.name==='list_skills'),'Focused must retain opt-in skill discovery');
  assert.ok(focusedPublic.some(t=>t.name==='context_pack'));
  assert.ok(focusedPublic.some(t=>t.name==='list_sessions'));
  process.env.BRC_MCP_TOOL_PROFILE='full';
  const full=(await liveTools(hub,store,account)).tools;
  assert.equal(full.length,64);
  assert.ok(full.some(t=>t.name==='write_pdf'));
  assert.ok(full.some(t=>t.name==='code_graph'));
  assert.ok(!full.some(t=>RETIRED_PUBLIC_AGENT_TOOLS.has(t.name)));
  for(const t of full) {
   const bad=[...RETIRED_PUBLIC_AGENT_TOOLS].filter(name=>
     new RegExp('\\b'+name+'\\b').test(t.description));
   assert.deepEqual(bad,[],'Public tool '+t.name+' incorrectly recommends retired names: '+bad.join(','));
  }
  process.env.BRC_MCP_TOOL_PROFILE='core';
  const again=(await liveTools(hub,store,account)).tools;
  assert.deepEqual(again.map(t=>t.name),core.map(t=>t.name));
 } finally {
  if(before===undefined)delete process.env.BRC_MCP_TOOL_PROFILE;
  else process.env.BRC_MCP_TOOL_PROFILE=before;
 }
});
