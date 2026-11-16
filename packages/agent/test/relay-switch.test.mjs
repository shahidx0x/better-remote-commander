import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {mkdtempSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {buildRelay} from '../../relay/dist/app.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
async function waitFor(fn,why,timeout=17000){
  const until=Date.now()+timeout;
  while(Date.now()<until){
    if(await fn())return;
    await sleep(35);
  }
  throw Error('Timed out waiting for '+why);
}
async function createRelay(dir,name){
  const relay=await buildRelay({
    port:0,host:'127.0.0.1',publicUrl:'http://127.0.0.1:32851',
    trustProxy:false,dbFile:path.join(dir,name+'.sqlite'),sessionSecret:'test-'+name,
    adminUser:'admin',adminPassword:'test-admin-password',relayVersion:name,
  },()=>{});
  await new Promise(resolve=>relay.http.listen(0,'127.0.0.1',resolve));
  return {relay,base:'http://127.0.0.1:'+relay.http.address().port};
}
test('live forget stops old reconnect and new pairing uses freshly entered URL, despite stale env', {timeout:50000},async()=>{
  const scratch=mkdtempSync(path.join(os.tmpdir(),'brc-switch-fixture-'));
  const home=path.join(scratch,'local-agent');await fs.mkdir(home);
  let old, next, child;
  try{
    old=await createRelay(scratch,'old');
    next=await createRelay(scratch,'new');
    const firstUser=await old.relay.store.getUserByName('admin');
    const oldDeviceId='test-old-workstation';
    const token=await old.relay.store.issueDeviceToken(oldDeviceId,firstUser.id,'Old machine','Windows');
    await fs.writeFile(path.join(home,'device.json'),JSON.stringify({
      relayUrl:old.base,deviceId:oldDeviceId,deviceToken:token,name:'Local development PC',pairedAt:'test'
    }));
    const env={...process.env,BRC_HOME:home,BRC_PLUGINS:'none',BRC_LOG_LEVEL:'info',
      // Deliberately stale environment credentials: interactive shortcut must
      // prioritize the saved selection, and never resurrect them after Forget.
      BRC_RELAY:'http://127.0.0.1:1',BRC_TOKEN:'STALE_TOKEN_DO_NOT_USE',BRC_DEVICE_ID:'stale-device'};
    child=spawn(process.execPath,[path.resolve('packages/agent/dist/cli.js'),'--auto-connect','--no-browser'],{
      cwd:path.resolve('.'),env,windowsHide:true,stdio:['pipe','pipe','pipe']
    });
    let output='';
    const append=b=>{output=(output+b.toString()).slice(-50000)};
    child.stdout.on('data',append);child.stderr.on('data',append);
    child.stdin.on('error',()=>{});
    await waitFor(()=>output.includes('Auto-connect in 4s.'),'saved URL autostart',9500);
    assert.ok(output.includes('Saved relay: '+old.base),'uses saved URL despite stale BRC_RELAY environment');
    await waitFor(()=>old.relay.hub.list().length===1,'initial connection',13500);
    child.stdin.write('m\n');
    await waitFor(()=>output.includes('Choose [1]:'),'live settings menu');
    child.stdin.write('3\n');
    await waitFor(()=>output.includes('[y/N]:'),'forget confirmation');
    child.stdin.write('yes\n');
    await waitFor(()=>output.includes('Old relay disconnected.'),'old relay cleanup');
    await waitFor(()=>old.relay.hub.list().length===0,'old WebSocket disconnected');
    await waitFor(()=>output.includes('Relay URL:'),'new URL prompt');
    assert.equal(await fs.stat(path.join(home,'device.json')).catch(()=>null),null,
      'old credential file is gone before new pairing starts');
    child.stdin.write(next.base+'/mcp\n');
    await waitFor(()=>output.includes('Device name ['),'device name input');
    child.stdin.write('\n');
    await waitFor(()=>/code: ([A-Z0-9]{4}-[A-Z0-9]{4})/.test(output),'new pairing code');
    const code=/code: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(output)[1];
    assert.ok(output.includes(next.base+'/device/verify?user_code='+code),
      'browser link uses explicitly entered relay hostname, not stale PUBLIC_URL');
    assert.equal(old.relay.hub.list().length,0,'old WebSocket stays disconnected throughout new pairing');
    const row=await next.relay.store.getDeviceCodeByUserCode(code);
    assert.ok(row);
    const newUser=await next.relay.store.getUserByName('admin');
    await next.relay.store.approveDeviceCode(row.device_code,newUser.id,'');
    await waitFor(()=>next.relay.hub.list().length===1,'new WebSocket ready',17000);
    assert.equal(old.relay.hub.list().length,0,'old relay did not reconnect');
    const saved=JSON.parse(await fs.readFile(path.join(home,'device.json'),'utf8'));
    assert.equal(saved.relayUrl,next.base);
    assert.notEqual(saved.deviceToken,token);
    assert.equal(saved.name,'Local development PC');
    assert.ok(!output.includes(token),'never print old token');
    child.stdin.write('m\n');
    await waitFor(()=>(output.match(/Choose \[1\]:/g)??[]).length===2,'new saved settings menu');
    assert.ok(output.includes('Saved relay: '+next.base),'new setup is authoritative after switching');
    child.stdin.write('0\n');
    await waitFor(()=>output.includes('Back to live logs.'),'return to new session');
  }finally{
    if(child&&!child.killed){child.kill('SIGTERM');await Promise.race([
      new Promise(resolve=>child.once('exit',resolve)),sleep(1800)
    ])}
    for(const item of [old,next])if(item){item.relay.http.closeAllConnections();await item.relay.close()}
    await fs.rm(scratch,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
});
