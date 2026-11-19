// Read-only Phase 11 benchmark: representative existing local projects.
// No source/project edits, network requests, builds, or installations.
import {performance} from 'node:perf_hooks';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {mkdtempSync,realpathSync} from 'node:fs';
const tmp=mkdtempSync(path.join(realpathSync.native(os.tmpdir()),'brc-real-repo-bench-'));
process.env.BRC_HOME=path.join(tmp,'agent');
const roots=process.argv.slice(2);
const {configManager}=await import('../dist/core/config-manager.js');
const {listProjectFiles}=await import('../dist/runtime/workspace.js');
const {projectIndex}=await import('../dist/runtime/project-index.js');
const {sharedProjectManifest}=await import('../dist/runtime/project-manifest.js');
const {managedSpawnStatus}=await import('../dist/runtime/managed-spawn.js');
const median=arr=>[...arr].sort((a,b)=>a-b)[Math.floor(arr.length/2)];
const percentile=(arr,p)=>[...arr].sort((a,b)=>a-b)[Math.ceil(arr.length*p)-1];
const round=v=>+v.toFixed(2);
const run=async(root,shared)=>{
 process.env.BRC_SHARED_PROJECT_MANIFEST=shared?'1':'0';
 projectIndex.close();sharedProjectManifest.clear();
 const cpu=process.cpuUsage(),begin=performance.now(),rssBefore=process.memoryUsage().rss;
 const spawnsBefore=managedSpawnStatus();
 let peakObservedRss=rssBefore;
 let files=0,truncated=false;
 for(let i=0;i<4;i++){
  const listing=await listProjectFiles(root,16000);
  files=listing.files.length;truncated ||= listing.truncated;
  peakObservedRss=Math.max(peakObservedRss,process.memoryUsage().rss);
 }
 const ix=await projectIndex.manage(root,'enable','',false,1000);
 peakObservedRss=Math.max(peakObservedRss,process.memoryUsage().rss);
 const spawnsAfter=managedSpawnStatus();
 return {
  ms:performance.now()-begin,
  cpuUserMs:(process.cpuUsage(cpu).user+process.cpuUsage(cpu).system)/1000,
  rssIncreaseBytes:Math.max(0,process.memoryUsage().rss-rssBefore),
  peakSampledRssIncreaseBytes:Math.max(0,peakObservedRss-rssBefore),
  managedSpawns:(spawnsAfter.nativeSpawns-spawnsBefore.nativeSpawns)+
    (spawnsAfter.legacySpawns-spawnsBefore.legacySpawns),
  files,indexTotal:ix.total,indexTruncated:ix.truncated,truncated,
  scans:sharedProjectManifest.status().scans
 };
};
try{
 const reports=[];
 for(const root of roots){
  if(!(await fs.stat(root).catch(()=>null))?.isDirectory())continue;
  await configManager.setValue('allowedDirectories',[root]);
  const baseline=[],improved=[];
  for(let i=0;i<6;i++){
   baseline.push(await run(root,false));
   improved.push(await run(root,true));
  }
  const equal=baseline.every((v,i)=>v.files===improved[i].files
    &&v.indexTotal===improved[i].indexTotal
    &&v.truncated===improved[i].truncated);
  const old=baseline.map(x=>x.ms),fast=improved.map(x=>x.ms);
  reports.push({
    project:path.basename(root),readOnly:true,
    equalFileAndIndexCounts:equal,
    files:baseline[0]?.files,indexTotal:baseline[0]?.indexTotal,
    samples:6,
    legacyP50Ms:round(median(old)),legacyP95Ms:round(percentile(old,.95)),
    sharedP50Ms:round(median(fast)),sharedP95Ms:round(percentile(fast,.95)),
    speedupP50:equal?round(median(old)/median(fast)):null,
    speedupP95:equal?round(percentile(old,.95)/percentile(fast,.95)):null,
    meanNodeCpuBaselineMs:round(baseline.reduce((n,r)=>n+r.cpuUserMs,0)/6),
    meanNodeCpuSharedMs:round(improved.reduce((n,r)=>n+r.cpuUserMs,0)/6),
    nodeCpuBaselineP50Ms:round(median(baseline.map(r=>r.cpuUserMs))),
    nodeCpuBaselineP95Ms:round(percentile(baseline.map(r=>r.cpuUserMs),.95)),
    nodeCpuSharedP50Ms:round(median(improved.map(r=>r.cpuUserMs))),
    nodeCpuSharedP95Ms:round(percentile(improved.map(r=>r.cpuUserMs),.95)),
    sampledRssBaselineP50MiB:round(median(baseline.map(r=>r.peakSampledRssIncreaseBytes))/1024/1024),
    sampledRssBaselineP95MiB:round(percentile(baseline.map(r=>r.peakSampledRssIncreaseBytes),.95)/1024/1024),
    sampledRssSharedP50MiB:round(median(improved.map(r=>r.peakSampledRssIncreaseBytes))/1024/1024),
    sampledRssSharedP95MiB:round(percentile(improved.map(r=>r.peakSampledRssIncreaseBytes),.95)/1024/1024),
    largestRssIncreaseMiB:round(Math.max(...improved.map(x=>x.rssIncreaseBytes))/1024/1024),
    largestSampledRssIncreaseMiB:round(Math.max(...improved.map(x=>x.peakSampledRssIncreaseBytes))/1024/1024),
    medianLegacyManagedSpawns:median(baseline.map(x=>x.managedSpawns)),
    medianSharedManagedSpawns:median(improved.map(x=>x.managedSpawns)),
    notes:'Node CPU only; ripgrep child CPU not included. Managed spawn count includes direct BRC launches, not descendant OS process count. Sampled RSS is not continuous peak. Cache/antivirus interference and filesystem warmth may affect results.'
  });
 }
 console.log('REAL_REPOSITORY_PHASE11='+JSON.stringify(reports));
}finally{
 projectIndex.close();sharedProjectManifest.clear();
 delete process.env.BRC_SHARED_PROJECT_MANIFEST;
 await configManager.close();
 await fs.rm(tmp,{recursive:true,force:true,maxRetries:8,retryDelay:80});
}
