import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { BRC_PROTOCOL_VERSION } from 'brc-shared';
import { WsClient } from '../dist/transport/ws-client.js';
import { ConnectionHealth } from '../dist/transport/connection-health.js';
import { connectionPanel } from '../dist/terminal-ui.js';
import { CODING_TOOL_HANDLERS } from '../dist/tools/coding-tools.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
async function until(predicate,ms=6500) {
  const stop=Date.now()+ms;
  while(Date.now()<stop) {
    if(predicate())return;
    await sleep(15);
  }
  throw new Error('local WebSocket condition did not become true within '+ms+' ms');
}

test('connection health is bounded, metadata only and excludes tool payloads',()=>{
  const h=new ConnectionHealth();
  for(let i=0;i<5000;i++)h.record('socket_error','ECONNRESET');
  h.ping();
  const state=h.snapshot();
  assert.equal(state.socketErrors,5000);
  assert.ok(state.recentEvents.length<=12);
  assert.ok(state.pingsReceived===1 && state.lastHeartbeatAt>0);
  assert.ok(state.agentUptimeMs>=0);
  assert.ok(!JSON.stringify(state).includes('password=') &&
    !JSON.stringify(state).includes('command='));
  assert.equal(state.persistent,false);
});

test('local WebSocket survives repeated heartbeats and reconnects after a broken socket', {timeout:13000},async()=>{
  const server=new WebSocketServer({host:'127.0.0.1',port:0});
  await once(server,'listening');
  let accepted=0,pongs=0;
  const connections=[];
  server.on('connection',socket=>{
    accepted++;
    connections.push(socket);
    socket.on('message',bytes=>{
      let message;
      try{message=JSON.parse(bytes.toString());}catch{return;}
      if(message.type==='hello') {
        socket.send(JSON.stringify({
          type:'welcome',protocol:BRC_PROTOCOL_VERSION,relayVersion:'local-test',
          serverTime:Date.now(),
        }));
      }
      if(message.type==='pong')pongs++;
    });
  });
  const url='http://127.0.0.1:'+server.address().port;
  const logs=[];
  const client=new WsClient({
    relayUrl:url,token:'local-only-test',deviceId:'local-fixture',
    name:'fixture',agentVersion:'test',coreVersion:'test',tools:[],
    callTool:async()=>({content:[]}),log:(level,message)=>logs.push(level+':'+message),
  });
  try{
    client.start();
    await until(()=>client.status().online);
    const first=connections.at(-1);
    for(let i=0;i<65;i++){
      first.send(JSON.stringify({type:'ping',ts:i}));
      await sleep(3);
    }
    await until(()=>pongs>=65);
    assert.equal(client.status().health.missedHeartbeats,0);
    assert.equal(client.status().health.pingsReceived>=65,true);
    // The local socket dies. It should be recorded and automatically replaced,
    // but no mutation or lost request is blindly retried.
    first.terminate();
    await until(()=>accepted>=2 && client.status().online,7500);
    const state=client.status();
    assert.equal(state.online,true);
    assert.ok(state.health.reconnects>=1);
    assert.ok(state.health.lastDisconnectedAt!==null);
    assert.equal(state.health.lastDisconnectCode,'1006');
    assert.ok(state.health.recentEvents.length<=12);
    assert.ok(logs.some(line=>line.includes('reconnecting')));
    assert.ok(!JSON.stringify(state).includes('local-only-test'));
    const panel=connectionPanel(state,{
      name:'fixture',relay:url,deviceId:'local-fixture',version:'test',
      coreVersion:'test',tools:0,
    },false);
    assert.match(panel,/reconnect/);
    assert.match(panel,/Ping/);
  } finally {
    client.stop();
    for(const socket of connections)socket.terminate();
    await new Promise(resolve=>server.close(resolve));
  }
});

test('agent_status exposes local transport only, not a claim about ChatGPT streaming',async()=>{
  const status=await CODING_TOOL_HANDLERS.agent_status({});
  assert.ok(status.structuredContent.transport,'transport snapshot required');
  assert.equal(status.structuredContent.transport.persistent,false);
  assert.equal(typeof status.structuredContent.transport.reconnects,'number');
  assert.equal(Array.isArray(status.structuredContent.transport.recentEvents),true);
});
