import test from 'node:test';
import assert from 'node:assert/strict';
import {activity} from '../dist/runtime/activity.js';
import {callTool} from '../dist/dispatcher.js';

test('a real dispatched read-only call emits MyMCP Received and Completed messages',async()=>{
 const previous=activity.getConsoleMode();
 activity.setConsoleMode('mymcp');
 const resume=activity.pauseConsole();
 const before=activity.consoleQueue.length;
 try{
   const reply=await callTool('agent_status',{});
   assert.notEqual(reply.isError,true,JSON.stringify(reply.structuredContent?.error));
   const emitted=activity.consoleQueue.slice(before);
   assert.equal(emitted.length,2,emitted.map(x=>x.slice(0,200)).join('\n'));
   assert.match(emitted[0],/🔧 Received tool call [a-zA-Z0-9_-]+: agent_status/);
   assert.match(emitted[0],/metadata: \{"origin":"local"/);
   assert.match(emitted[1],/✅ Tool call agent_status completed:/);
   const json=emitted[1].split('\n ').slice(1).join('\n ');
   assert.doesNotThrow(()=>JSON.parse(json));
   assert.ok(Buffer.byteLength(json,'utf8')<=4096);
 }finally{
   activity.consoleQueue.splice(before);
   activity.queuedBytes=activity.consoleQueue.reduce((n,v)=>n+Buffer.byteLength(v),0);
   resume();
   activity.setConsoleMode(previous);
 }
});
