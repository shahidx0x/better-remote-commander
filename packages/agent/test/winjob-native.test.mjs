import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';

const runner=path.resolve('packages/agent/dist/native/winjob/BrcWinJob.dll');
const eligible=process.platform==='win32'&&fs.existsSync(runner);
const run=(argv,{timeout=6000}={})=>new Promise((resolve,reject)=>{
 const child=spawn('dotnet',[runner,'--parent',String(process.pid),'--',process.execPath,...argv],
  {stdio:['ignore','pipe','pipe'],windowsHide:true});
 let stdout='',stderr='';
 child.stdout.on('data',x=>{stdout+=x;});
 child.stderr.on('data',x=>{stderr+=x;});
 child.once('error',reject);
 const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('job runner timeout '+stderr));},timeout);
 child.once('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr});});
});

test('native Windows job runner preserves IO, quoted argv and exit code',{skip:!eligible},async()=>{
 const script='console.log(JSON.stringify(process.argv.slice(1)));console.error("stderr-ready");process.exit(7);';
 const out=await run(['-e',script,'hello space','quoted"argument']);
 assert.equal(out.code,7,out.stderr);
 assert.deepEqual(JSON.parse(out.stdout.trim()),['hello space','quoted"argument']);
 assert.match(out.stderr,/stderr-ready/);
 assert.doesNotMatch(out.stderr,/BRC_WINJOB_ERROR/);
});

test('job kill-on-close terminates a detached grandchild, without calling taskkill',{skip:!eligible},async()=>{
 const script="const {spawn}=require('node:child_process'); const g=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true,detached:true}); console.log(g.pid); setInterval(()=>{},1000);";
 const parent=spawn('dotnet',[runner,'--parent',String(process.pid),'--',
   process.execPath,'-e',script],{stdio:['ignore','pipe','pipe'],windowsHide:true});
 let gpid;
 const getPid=new Promise((resolve,reject)=>{
  let buffer='';
  const timer=setTimeout(()=>reject(new Error('no grandchild pid')),6000);
  parent.stdout.on('data',chunk=>{
   buffer+=chunk;
   const match=buffer.match(/^\s*(\d+)\r?\n/);
   if(match){clearTimeout(timer);resolve(Number(match[1]));}
  });
  parent.once('error',reject);
 });
 let closed=false;
 parent.once('close',()=>{closed=true;});
 try{
  gpid=await getPid;
  assert.ok(Number.isSafeInteger(gpid)&&gpid>0);
  try{process.kill(gpid,0);}catch{assert.fail('grandchild did not start');}
  const close=new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(new Error('job wrapper would not exit')),6000);
   parent.once('close',code=>{clearTimeout(timer);resolve(code);});
  });
  parent.kill('SIGKILL');
  await close;
  let alive=true;
  for(let i=0;i<50;i++){
   try{process.kill(gpid,0);}catch{alive=false;break;}
   await delay(100);
  }
  assert.equal(alive,false,'grandchild escaped the kill-on-close Job');
 }finally{
  if(!closed)parent.kill('SIGKILL');
  if(gpid){try{process.kill(gpid,0);process.kill(gpid,'SIGKILL');}catch{}}
 }
});
