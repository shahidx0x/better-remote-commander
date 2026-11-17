import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {DeviceHub} from '../dist/device-hub.js';
import {BRC_PROTOCOL_VERSION} from 'brc-shared';

class FakeSocket extends EventEmitter {
  OPEN=1; readyState=1; bufferedAmount=0; sent=[]; closed=null;
  send(d){this.sent.push(JSON.parse(d));}
  terminate(){this.readyState=3;this.emit('close');}
  close(code){this.closed=code;this.readyState=3;this.emit('close');}
  frame(o){this.emit('message',Buffer.from(JSON.stringify(o)));}
  last(type){return [...this.sent].reverse().find(m=>m.type===type);}
}
const tool=(name='echo')=>({name,description:'d',inputSchema:{type:'object',properties:{}}});
const hello=(id='d1',tools=[tool()])=>({type:'hello',protocol:BRC_PROTOCOL_VERSION,device:{deviceId:id,name:'PC',platform:'linux',arch:'x64',hostname:'h',agentVersion:'1',coreVersion:'1'},tools});
function online(hub,id='d1',tools){const s=new FakeSocket();hub.attach(s,'u1');s.frame(hello(id,tools));return s;}

test('hello with an oversized or malformed tool catalog is rejected',()=>{
  const hub=new DeviceHub('t',()=>{});
  for(const tools of [Array.from({length:257},(_,i)=>tool('t'+i)),[tool('bad name!')],[{name:'x',description:'d'}]]){
    const s=new FakeSocket();hub.attach(s,'u1');s.frame(hello('d1',tools));
    assert.equal(s.closed,1008);assert.equal(hub.list('u1').length,0);
  }
  hub.close();
});
test('plugin-style tool names with dots/colons are accepted',()=>{
  const hub=new DeviceHub('t',()=>{});online(hub,'d1',[tool('a.b:c')]);assert.equal(hub.list('u1').length,1);hub.close();
});
test('frames from a replaced socket cannot complete calls on the new connection',async()=>{
  const hub=new DeviceHub('t',()=>{});
  const old=online(hub);const fresh=online(hub);
  const p=hub.call('d1','echo',{},{timeoutMs:2000});
  const id=fresh.last('call').id;
  old.frame({type:'result',id,result:{content:[{type:'text',text:'forged'}]}});
  fresh.frame({type:'result',id,result:{content:[{type:'text',text:'real'}]}});
  assert.equal((await p).content[0].text,'real');hub.close();
});
test('disconnect fails in-flight calls immediately',async()=>{
  const hub=new DeviceHub('t',()=>{});const s=online(hub);
  const p=hub.call('d1','echo',{},{timeoutMs:60000});
  s.close();
  await assert.rejects(p,/DEVICE_DISCONNECTED/);hub.close();
});
test('abort signal and timeout send a cancel frame to the agent',async()=>{
  const hub=new DeviceHub('t',()=>{});const s=online(hub);
  const ac=new AbortController();
  const p=hub.call('d1','echo',{},{signal:ac.signal,timeoutMs:60000});
  ac.abort();await assert.rejects(p,/CALL_CANCELLED/);assert.equal(s.last('cancel').reason,'client cancelled');
  const t=hub.call('d1','echo',{},{timeoutMs:20});await assert.rejects(t,/CALL_TIMEOUT/);assert.equal(s.last('cancel').reason,'relay deadline');
  hub.close();
});
test('oversized result is replaced by RESULT_TOO_LARGE; normal result passes',async()=>{
  const hub=new DeviceHub('t',()=>{});const s=online(hub);
  const p=hub.call('d1','echo',{});s.frame({type:'result',id:s.last('call').id,result:{content:[{type:'text',text:'x'.repeat(600*1024)}]}});
  const r=await p;assert.equal(r.isError,true);assert.equal(r.structuredContent.error.code,'RESULT_TOO_LARGE');
  hub.close();
});
test('per-device and backpressure limits reject without dispatching',async()=>{
  const hub=new DeviceHub('t',()=>{});const s=online(hub);
  const held=[];for(let i=0;i<64;i++)held.push(hub.call('d1','echo',{},{timeoutMs:60000}).catch(()=>{}));
  await assert.rejects(hub.call('d1','echo',{}),/DEVICE_BUSY/);
  hub.close();await Promise.all(held);
  const hub2=new DeviceHub('t',()=>{});const s2=online(hub2);s2.bufferedAmount=9*1024*1024;
  const before=s2.sent.length;await assert.rejects(hub2.call('d1','echo',{}),/RELAY_BACKPRESSURE/);assert.equal(s2.sent.length,before);hub2.close();
});
