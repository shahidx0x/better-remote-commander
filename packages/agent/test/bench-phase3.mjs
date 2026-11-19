/**
 * Reproducible Phase 3 microbenchmark. Tests a disposable fixture only.
 * Run from repo root:
 *   node packages/agent/test/bench-phase3.mjs
 * It never changes worker caps or real project files.
 */
import {performance} from 'node:perf_hooks';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {mkdtempSync,realpathSync} from 'node:fs';
const folder=mkdtempSync(path.join(realpathSync.native(os.tmpdir()),'brc-phase3-bench-'));
const src=path.join(folder,'project');
process.env.BRC_HOME=path.join(folder,'agent-home');
process.env.BRC_OPERATION_RECEIPTS='0';
await fs.mkdir(src,{recursive:true});
const paths=Array.from({length:20},(_,i)=>path.join(src,'file'+String(i).padStart(2,'0')+'.ts'));
for(let i=0;i<paths.length;i++)
  await fs.writeFile(paths[i],('export const sample'+i+' = "benchmark-needle";\n').repeat(60));
const {configManager}=await import('../dist/core/config-manager.js');
await configManager.setValue('allowedDirectories',[src]);
const {callTool}=await import('../dist/dispatcher.js');
const {executeToolKernel,executionKernelStatus}=await import('../dist/runtime/execution-kernel.js');
const {projectIndex}=await import('../dist/runtime/project-index.js');
const ms=[];
const bench=async(name,fn)=>{
  const start=performance.now(),cpu=process.cpuUsage();
  const result=await fn();
  const durationMs=+(performance.now()-start).toFixed(2);
  const used=process.cpuUsage(cpu);
  ms.push({name,durationMs,cpuMs:+((used.user+used.system)/1000).toFixed(2),
    rssMiB:+(process.memoryUsage().rss/1048576).toFixed(2),
    isError:!!result?.isError});
  if(result?.isError)throw new Error(name+' failed: '+JSON.stringify(result.structuredContent?.error??{}));
  return result;
};
try{
  await bench('read_multiple_files (cold 20)',()=>callTool('read_multiple_files',{paths}));
  await bench('read_multiple_files (warm 20)',()=>callTool('read_multiple_files',{paths}));
  await bench('project_index enable',()=>callTool('project_index',{path:src,action:'enable'}));
  await bench('project_index query (cold)',()=>callTool('project_index',{path:src,action:'query',query:'file'}));
  await bench('project_index query (warm)',()=>callTool('project_index',{path:src,action:'query',query:'file'}));
  await bench('start_search (ripgrep, 20)',()=>callTool('start_search',{path:src,pattern:'benchmark-needle',searchType:'content',maxResults:30,wait:true,timeout_ms:4500}));
  const target=path.join(src,'benchmark-lock.txt');
  await fs.writeFile(target,'0');
  const locksStart=performance.now();
  await Promise.all(Array.from({length:12},(_,i)=>executeToolKernel({
    name:'write_file',callId:'phase3-bench-'+i,kind:'filesystem_mutation',
    recordReceipt:false,paths:[target],
    perform:async()=>{const n=Number(await fs.readFile(target,'utf8'));await new Promise(r=>setTimeout(r,2));
      await fs.writeFile(target,String(n+1));return{content:[{type:'text',text:'done'}]};}
  })));
  ms.push({name:'12 serialized mutations',durationMs:+(performance.now()-locksStart).toFixed(2),
    finalValue:Number(await fs.readFile(target,'utf8')),
    rssMiB:+(process.memoryUsage().rss/1048576).toFixed(2)});
  console.log(JSON.stringify({operations:ms,kernel:executionKernelStatus(),platform:process.platform},null,2));
}finally{
  try{await projectIndex.manage(src,'disable');}catch{}
  await configManager.close();
  await fs.rm(folder,{recursive:true,force:true,maxRetries:8,retryDelay:100});
}
