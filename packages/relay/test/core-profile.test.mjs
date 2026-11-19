import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BUNDLED_AGENT_TOOL_CATALOG} from '../dist/mcp/agent-tools.catalog.js';
import {liveTools,exposeMcpAgentTool,mcpToolProfile,RETIRED_PUBLIC_AGENT_TOOLS,CORE_MCP_AGENT_TOOLS,FOCUSED_MCP_AGENT_TOOLS,CORE_TOOL_ROUTING_GUIDANCE,readOnlyToolAllowed} from '../dist/mcp/server.js';

test('retired overlapping tools are not advertised by ANY profile, but essential functions remain',async()=>{
 const before=process.env.BRC_MCP_TOOL_PROFILE;
 const hub={list:()=>[],get:()=>null};
 const store={getDevice:async()=>null};
 const account='core-profile-test';
 const known=new Set(BUNDLED_AGENT_TOOL_CATALOG.map(t=>t.name));
 try {
  delete process.env.BRC_MCP_TOOL_PROFILE;
  assert.equal(mcpToolProfile(),'core');
  assert.equal(mcpToolProfile('unrecognized'),'core');
  assert.equal(BUNDLED_AGENT_TOOL_CATALOG.length,81,'new lazy LSP tool has a stable offline schema');
  assert.equal(RETIRED_PUBLIC_AGENT_TOOLS.size,19);
  for(const name of CORE_MCP_AGENT_TOOLS) assert.ok(known.has(name),'unknown core '+name);
  for(const name of RETIRED_PUBLIC_AGENT_TOOLS) {
   assert.ok(known.has(name),'unknown retired tool '+name);
   for(const profile of ['core','focused','full'])assert.equal(exposeMcpAgentTool(name,profile),false,name+' exposed by '+profile);
  }
  const core=(await liveTools(hub,store,account)).tools;
  const names=new Set(core.map(t=>t.name));
  assert.equal(names.size,36);
  for(const name of ['read_file','read_multiple_files','write_file','edit_block','edit_files','lsp_query','run_command','run_project_checks','run_parallel','worker_tasks','worker_patch','worker_integrate','agent_status'])
   assert.ok(names.has(name),'essential tool missing: '+name);
  for(const name of ['workspace_batch','batch_tools','edit_code_ranges','replace_symbol','docker_inventory','docker_inspect','sandbox_run','verify_project'])
   assert.ok(!names.has(name),'retired tool still shown: '+name);
  assert.ok(core.every(t=>t.inputSchema?.properties?.deviceId));
  assert.ok(core.every(t=>t.description.includes('USE INSTEAD:')));
  assert.ok(CORE_TOOL_ROUTING_GUIDANCE.includes('write_file'));
  assert.ok(!CORE_TOOL_ROUTING_GUIDANCE.includes('workspace_batch'));
  assert.equal(readOnlyToolAllowed('write_file',{}),false,'permissions unchanged by profile');
  assert.equal(readOnlyToolAllowed('read_file',{}),true);
  process.env.BRC_MCP_TOOL_PROFILE='focused';
  const focused=(await liveTools(hub,store,account)).tools;
  assert.equal(focused.length,46,'profile switch must invalidate cached snapshot');
  assert.ok(!focused.some(t=>RETIRED_PUBLIC_AGENT_TOOLS.has(t.name)));
  process.env.BRC_MCP_TOOL_PROFILE='full';
  const full=(await liveTools(hub,store,account)).tools;
  assert.equal(full.length,62);
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
