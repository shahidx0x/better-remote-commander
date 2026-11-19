import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {mkdtempSync,realpathSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {spawnManaged,managedSpawnStatus} from '../dist/runtime/managed-spawn.js';
const temp=mkdtempSync(path.join(realpathSync.native(os.tmpdir()),'brc-winjob-integration-'));
after(async()=>fs.rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:90}));
const native=process.platform==='win32'&&managedSpawnStatus().nativeAvailable;
const collect=(program,args,classification)=>new Promise((resolve,reject)=>{
 const child=spawnManaged(program,args,{stdio:['ignore','pipe','pipe'],windowsHide:true},classification);
 let stdout='',stderr='';
 child.stdout.on('data',x=>{stdout+=x.toString();});
 child.stderr.on('data',x=>{stderr+=x.toString();});
 child.once('error',reject);
 child.once('close',code=>resolve({code,stdout,stderr}));
});

test('direct executables use native Job; short read-only scans retain fast fallback',{skip:!native},async()=>{
 const prior=process.env.BRC_WIN_JOB_SHORT_READS;
 const before=managedSpawnStatus();
 try{
  delete process.env.BRC_WIN_JOB_SHORT_READS;
  const a=await collect(process.execPath,['-e','console.log("native")']);
  assert.equal(a.code,0,a.stderr);assert.equal(a.stdout.trim(),'native');
  assert.equal(managedSpawnStatus().nativeSpawns,before.nativeSpawns+1);
  const b=await collect(process.execPath,['-e','console.log("fast")'],'fast-read');
  assert.equal(b.code,0);assert.equal(b.stdout.trim(),'fast');
  assert.equal(managedSpawnStatus().legacySpawns,before.legacySpawns+1);
  process.env.BRC_WIN_JOB_SHORT_READS='1';
  const c=await collect(process.execPath,['-e','console.log("strict")'],'fast-read');
  assert.equal(c.code,0);assert.equal(c.stdout.trim(),'strict');
  assert.equal(managedSpawnStatus().nativeSpawns,before.nativeSpawns+2);
 }finally{
  if(prior===undefined)delete process.env.BRC_WIN_JOB_SHORT_READS;
  else process.env.BRC_WIN_JOB_SHORT_READS=prior;
 }
});

test('invalid PE is rejected before native Job startup; never replay a target after native failure',{skip:!native},async()=>{
 const bogus=path.join(temp,'bogus.exe');
 await fs.writeFile(bogus,Buffer.alloc(24,15));
 const before=managedSpawnStatus();
 // The preflight refuses to send this fake executable to the Job launcher.
 // The original Node spawn fails before execution and can be handled by the
 // optional rtk fast-path as an unstarted tool (never replay a mutation).
 await assert.rejects(collect(bogus,['--unlikely-execution']),/spawn|UNKNOWN|ENOEXEC/i);
 assert.equal(managedSpawnStatus().nativeSpawns,before.nativeSpawns);
 assert.equal(managedSpawnStatus().legacySpawns,before.legacySpawns+1);
 assert.equal(managedSpawnStatus().legacyReasons.invalid_windows_exe,1);
});

test('native Job terminates child when the Node parent unexpectedly exits',{skip:!native,timeout:12000},async()=>{
 const runner=path.resolve('packages/agent/dist/native/winjob/BrcWinJob.dll');
 const pidFile=path.join(temp,'child.pid');
 const rootCode="const fs=require('fs');fs.writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000);";
 const parentCode=[
  "const fs=require('fs'),{spawn}=require('node:child_process');",
  "const runner=process.argv[1],file=process.argv[2];",
  "spawn('dotnet',[runner,'--parent',String(process.pid),'--',process.execPath,'-e',"+
    JSON.stringify(rootCode)+",file],{stdio:'ignore',windowsHide:true,detached:true}).unref();",
  "let count=0;const timer=setInterval(()=>{if(fs.existsSync(file)){clearInterval(timer);process.exit(0);}if(++count>150){clearInterval(timer);process.exit(2);}},20);"
 ].join('\n');
 const parent=spawn(process.execPath,['-e',parentCode,runner,pidFile],{
  stdio:['ignore','pipe','pipe'],windowsHide:true
 });
 const exit=await new Promise((resolve,reject)=>{parent.once('error',reject);parent.once('close',resolve);});
 assert.equal(exit,0,'fixture parent never reached active child state');
 const rootPid=Number(await fs.readFile(pidFile,'utf8'));
 assert.ok(Number.isSafeInteger(rootPid)&&rootPid>0);
 let live=true;
 for(let i=0;i<70;i++){
  try{process.kill(rootPid,0);}catch{live=false;break;}
  await delay(70);
 }
 assert.equal(live,false,'child survived native Job parent death');
});

test('strict native-only mode denies unsupported spawns without running any program',{skip:!native},async()=>{
 const prior=process.env.BRC_WIN_JOB_MODE;
 const before=managedSpawnStatus();
 try{
  process.env.BRC_WIN_JOB_MODE='strict';
  assert.throws(()=>spawnManaged('totally-unknown.cmd',[],{shell:true}),/WIN_JOB_REQUIRED.*No program executed/);
  assert.throws(()=>spawnManaged(process.execPath,[],{shell:true}),/WIN_JOB_REQUIRED.*No program executed/);
  assert.equal(managedSpawnStatus().legacySpawns,before.legacySpawns);
  const safe=await collect(process.execPath,['-e','console.log("strict")'],'fast-read');
  assert.equal(safe.code,0,safe.stderr);
  assert.equal(safe.stdout.trim(),'strict');
  assert.equal(managedSpawnStatus().nativeSpawns,before.nativeSpawns+1);
 }finally{
  if(prior===undefined)delete process.env.BRC_WIN_JOB_MODE;
  else process.env.BRC_WIN_JOB_MODE=prior;
 }
});
