import {test} from 'node:test';
import assert from 'node:assert/strict';
import {liveTools,exposeMcpAgentTool,FOCUSED_MCP_AGENT_TOOLS,TOOL_ROUTING_GUIDANCE} from '../dist/mcp/server.js';
const inputSchema={type:'object',properties:{}};
test('relay exposes only Android agent-supported tools when all online devices are Android',async()=>{
 const device={info:{platform:'android'},tools:[
   {name:'read_file',description:'reads a file',inputSchema},
   {name:'worker_tasks',description:'coordination',inputSchema},
 ]};
 const onlineHub={
   list:()=>[{deviceId:'termux-1'}],
   get:()=>device,
 };
 const store={getDevice:async()=>({paused:false})};
 const r=await liveTools(onlineHub,store,'owner-android');
 assert.equal(r.online,1);
 assert.ok(r.tools.some(t=>t.name==='read_file'));
 assert.ok(!r.tools.some(t=>t.name==='worker_tasks'),'Core hides optional worker coordination');
 assert.ok(!r.tools.some(t=>t.name==='read_images'));
 assert.ok(!r.tools.some(t=>t.name==='write_pdf'));
 assert.ok(!r.tools.some(t=>t.name==='docker_inventory'));
});
test('offline relay preserves full advanced catalog if explicitly selected',async()=>{
 const old=process.env.BRC_MCP_TOOL_PROFILE;
 process.env.BRC_MCP_TOOL_PROFILE='full';
 try {
   const hub={list:()=>[],get:()=>null};
   const store={getDevice:async()=>null};
   const r=await liveTools(hub,store,'owner-offline');
   assert.equal(r.online,0);
   assert.ok(r.tools.some(t=>t.name==='read_file'));
   assert.ok(r.tools.some(t=>t.name==='write_pdf'));
   assert.ok(!r.tools.some(t=>t.name==='docker_inventory'),'Docker tool is retired from public MCP discovery');
 } finally {
   if(old===undefined)delete process.env.BRC_MCP_TOOL_PROFILE;
   else process.env.BRC_MCP_TOOL_PROFILE=old;
 }
});
