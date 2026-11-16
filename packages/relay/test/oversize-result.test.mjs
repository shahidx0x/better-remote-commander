import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {DeviceHub} from '../dist/device-hub.js';

class FakeSocket extends EventEmitter {
 OPEN=1; readyState=1; bufferedAmount=0; sent=[];
 send(message){this.sent.push(JSON.parse(message));}
 close(){this.readyState=3;this.emit('close');}
 terminate(){this.close();}
}
test('old agent oversized result is stopped at relay boundary, new calls remain healthy',async()=>{
 const hub=new DeviceHub('test',()=>{});
 const socket=new FakeSocket();
 try {
  hub.attach(socket,'owner','pc');
  socket.emit('message',Buffer.from(JSON.stringify({
    type:'hello',protocol:1,device:{deviceId:'pc',name:'PC',platform:'win32',arch:'x64',hostname:'h',agentVersion:'1',coreVersion:'1'},
    tools:[{name:'read_file',description:'Read one file',inputSchema:{type:'object',properties:{path:{type:'string'}}}}],
  })));
  const first=hub.call('pc','read_file',{path:'big'});
  const call=socket.sent.find(msg=>msg.type==='call');
  assert.ok(call);
  socket.emit('message',Buffer.from(JSON.stringify({type:'result',id:call.id,result:{content:[{type:'text',text:'X'.repeat(700000)}]}})));
  const output=await first;
  assert.equal(output.isError,true);
  assert.equal(output.structuredContent.error.code,'RESULT_TOO_LARGE');
  assert.equal(output.structuredContent.recovery.automaticRetry,false);
  const second=hub.call('pc','read_file',{path:'small'});
  const next=socket.sent.filter(msg=>msg.type==='call').at(-1);
  socket.emit('message',Buffer.from(JSON.stringify({type:'result',id:next.id,result:{content:[{type:'text',text:'OK'}]}})));
  const normal=await second;
  assert.equal(normal.isError,undefined);
  assert.equal(normal.content[0].text,'OK');
 } finally { hub.close(); }
});

test('burst of eight oversized concurrent results does not break subsequent tools',async()=>{
 const hub=new DeviceHub('burst-test',()=>{});
 const socket=new FakeSocket();
 try {
  hub.attach(socket,'owner','pc');
  socket.emit('message',Buffer.from(JSON.stringify({
   type:'hello',protocol:1,device:{deviceId:'pc',name:'PC',platform:'win32',arch:'x64',hostname:'h',agentVersion:'old',coreVersion:'old'},
   tools:[{name:'read_file',description:'read',inputSchema:{type:'object',properties:{path:{type:'string'}}}}],
  })));
  const pending=Array.from({length:8},(_,i)=>hub.call('pc','read_file',{path:'test-'+i}));
  const calls=socket.sent.filter(m=>m.type==='call');
  assert.equal(calls.length,8);
  for(const c of calls)socket.emit('message',Buffer.from(JSON.stringify({
   type:'result',id:c.id,result:{content:[{type:'text',text:'Z'.repeat(620000)}]}
  })));
  const results=await Promise.all(pending);
  assert.equal(results.length,8);
  for(const r of results){
   assert.equal(r.isError,true);
   assert.equal(r.structuredContent.error.code,'RESULT_TOO_LARGE');
   assert.ok(JSON.stringify(r).length<10000);
  }
  const followUp=hub.call('pc','read_file',{path:'okay'});
  const latest=socket.sent.filter(m=>m.type==='call').at(-1);
  socket.emit('message',Buffer.from(JSON.stringify({type:'result',id:latest.id,result:{content:[{type:'text',text:'OK'}]}})));
  assert.equal((await followUp).content[0].text,'OK');
 } finally {hub.close();}
});
