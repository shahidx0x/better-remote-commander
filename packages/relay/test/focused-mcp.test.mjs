import {test} from 'node:test';
import assert from 'node:assert/strict';
import {liveTools,exposeMcpAgentTool,FOCUSED_MCP_AGENT_TOOLS,TOOL_ROUTING_GUIDANCE} from '../dist/mcp/server.js';

test('focused MCP discovery reduces the advertised tool list without changing authorization',async()=>{
  assert.equal(exposeMcpAgentTool('write_pdf','full'),true);
  assert.equal(exposeMcpAgentTool('write_pdf','focused'),false);
  assert.equal(exposeMcpAgentTool('read_file','focused'),true);
  assert.ok(FOCUSED_MCP_AGENT_TOOLS.has('worker_integrate'));
  const prior=process.env.BRC_MCP_TOOL_PROFILE;
  process.env.BRC_MCP_TOOL_PROFILE='focused';
  try{
    const hub={list:()=>[],get:()=>null};
    const store={getDevice:async()=>null};
    const {tools}=await liveTools(hub,store,'focused-offline');
    const names=new Set(tools.map(t=>t.name));
    assert.ok(names.size>=40 && names.size<=60,'unexpected focused count '+names.size);
    for(const name of ['read_file','read_multiple_files','write_file','edit_block','run_command','run_parallel','worker_tasks','agent_status'])
      assert.ok(names.has(name),'missing essential '+name);
    for(const name of ['write_pdf','ast_search','ast_rewrite','sandbox_run','workspace_batch','edit_files'])
      assert.ok(!names.has(name),'advanced tool should be hidden '+name);
    for(const tool of tools){
      assert.ok(tool.description.startsWith('USE WHEN:'),'missing routing for '+tool.name);
      assert.ok(tool.inputSchema?.properties?.deviceId,'missing deviceId '+tool.name);
    }
  } finally {
    if(prior===undefined)delete process.env.BRC_MCP_TOOL_PROFILE;
    else process.env.BRC_MCP_TOOL_PROFILE=prior;
  }
});

test('relay initialization instructions explain paging, write safety, worker reality and error recovery',()=>{
  for(const phrase of ['read_file returns read.next','1 MiB/2000 lines','wait_jobs/get_job','never blind-append','BRC never spawns extra AI models','structuredContent.error.code'])
    assert.ok(TOOL_ROUTING_GUIDANCE.includes(phrase),'missing instruction '+phrase);
});
