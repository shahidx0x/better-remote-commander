// Read-only per-workflow benchmark for optional shared project discovery.
import {performance} from 'node:perf_hooks';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import {mkdtempSync,realpathSync} from 'node:fs';
const scratch=mkdtempSync(path.join(realpathSync.native(os.tmpdir()),'brc-phase9-bench-'));
const root=path.join(scratch,'repo');
process.env.BRC_HOME=path.join(scratch,'agent');
const {configManager}=await import('../dist/core/config-manager.js');
const {listProjectFiles}=await import('../dist/runtime/workspace.js');
const {projectIndex}=await import('../dist/runtime/project-index.js');
const {sharedProjectManifest}=await import('../dist/runtime/project-manifest.js');
const number=(t)=>+t.toFixed(2);
const median=(arr)=>[...arr].sort((a,b)=>a-b)[Math.floor(arr.length/2)];
try{
 await fs.mkdir(path.join(root,'src'),{recursive:true});
 await fs.writeFile(path.join(root,'package.json'),JSON.stringify({name:'phase9-demo'}));
 for(let i=0;i<350;i++){
  const d=path.join(root,'src','layer'+Math.floor(i/25));
  await fs.mkdir(d,{recursive:true});
  await fs.writeFile(path.join(d,'module'+String(i).padStart(3,'0')+'.ts'),
   'export const phase9Var'+i+' = '+i+';\n');
 }
 await configManager.setValue('allowedDirectories',[root]);
 const run=async(shared,repeats,includeIndex)=>{
  process.env.BRC_SHARED_PROJECT_MANIFEST=shared?'1':'0';
  projectIndex.close();sharedProjectManifest.clear();
  const start=performance.now();
  let last;
  for(let i=0;i<repeats;i++)last=await listProjectFiles(root,16000);
  let index;
  if(includeIndex)index=await projectIndex.manage(root,'enable','',false,1000);
  const duration=performance.now()-start;
  return {duration,count:last.files.length,
   indexTotal:index?.total,scans:sharedProjectManifest.status().scans};
 };
 const legacy=[],shared=[];
 for(let i=0;i<6;i++){
  legacy.push(await run(false,4,true));
  shared.push(await run(true,4,true));
 }
 const cold=median(legacy.map(v=>v.duration)),warm=median(shared.map(v=>v.duration));
 const manyLegacy=await run(false,20,false);
 const manyShared=await run(true,20,false);
 const base=legacy[0],opt=shared[0];
 if(base.count!==opt.count||base.indexTotal!==opt.indexTotal)
  throw new Error('Benchmark invalid: shared listing/index mismatch.');
 console.log('PHASE9_BENCH='+JSON.stringify({
  fixtureFiles:350,
  workflow:'four file enumerations + one index enable',
  rounds:6,legacyMedianMs:number(cold),sharedMedianMs:number(warm),
  reductionPercent:number(100*(1-warm/cold)),
  legacySamples:legacy.map(v=>number(v.duration)),
  sharedSamples:shared.map(v=>number(v.duration)),
  repeated20:{legacyMs:number(manyLegacy.duration),
   sharedMs:number(manyShared.duration),
   reductionPercent:number(100*(1-manyShared.duration/manyLegacy.duration))},
  reusedBaseScanCount:shared[0].scans,
  notes:'Local cold/warm filesystem effects vary; this measures enumeration only, not end-to-end coding or model calls.'
 }));
}finally{
 projectIndex.close();sharedProjectManifest.clear();
 delete process.env.BRC_SHARED_PROJECT_MANIFEST;
 await configManager.close();
 await fs.rm(scratch,{recursive:true,force:true,maxRetries:8,retryDelay:90});
}
