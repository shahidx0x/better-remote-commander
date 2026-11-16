import {test} from 'node:test';
import assert from 'node:assert/strict';
import {liveTools} from '../dist/mcp/server.js';
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
 assert.ok(r.tools.some(t=>t.name==='worker_tasks'));
 assert.ok(!r.tools.some(t=>t.name==='read_images'));
 assert.ok(!r.tools.some(t=>t.name==='write_pdf'));
 assert.ok(!r.tools.some(t=>t.name==='docker_inventory'));
});
test('offline relay keeps existing stable catalog for later desktop connections',async()=>{
 const hub={list:()=>[],get:()=>null};
 const store={getDevice:async()=>null};
 const r=await liveTools(hub,store,'owner-offline');
 assert.equal(r.online,0);
 assert.ok(r.tools.some(t=>t.name==='read_file'));
 assert.ok(r.tools.some(t=>t.name==='write_pdf'));
});
