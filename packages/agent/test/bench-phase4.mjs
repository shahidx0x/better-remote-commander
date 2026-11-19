/** Phase-4 code retrieval benchmark. Uses a disposable fixture; never changes user repositories. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {performance} from 'node:perf_hooks';
import {mkdtempSync,realpathSync} from 'node:fs';
const folder=mkdtempSync(path.join(realpathSync.native(os.tmpdir()),'brc-phase4-bench-'));
const project=path.join(folder,'fixture');
process.env.BRC_HOME=path.join(folder,'agent');
process.env.BRC_ERROR_LOG='0';
process.env.BRC_LOG_LEVEL='silent';
await fs.mkdir(project,{recursive:true});
await fs.writeFile(path.join(project,'package.json'),JSON.stringify({name:'benchmark-ts-project',private:true,packageManager:'pnpm@10.0.0'}));
await fs.writeFile(path.join(project,'AGENTS.md'),'Use scoped edits. Do not run untrusted scripts.\n');
const files=[];
for(let i=0;i<150;i++){
 const p=path.join(project,'file'+i.toString().padStart(3,'0')+'.ts');
 const imports=i>0?'import {item'+(i-1)+'} from \'./file'+(i-1).toString().padStart(3,'0')+'.js\';\n':'';
 const symbols=Array.from({length:8},(_,j)=>'export function benchmarkNeedle_'+i+'_'+j+'(value:number){return value+'+(i+j)+';}\n').join('');
 await fs.writeFile(p,imports+symbols+'export const item'+i+' = benchmarkNeedle_'+i+'_0('+i+');\n');
 files.push(p);
}
const {configManager}=await import('../dist/core/config-manager.js');
const {codeGraph}=await import('../dist/runtime/code-graph.js');
const {gatherContext,packageInfo,projectPath}=await import('../dist/runtime/workspace.js');
const {instructionContext}=await import('../dist/runtime/instruction-context.js');
const {projectIndex}=await import('../dist/runtime/project-index.js');
const {callTool}=await import('../dist/dispatcher.js');
await configManager.setValue('allowedDirectories',[project]);
const metrics=[];
const run=async(name,fn)=>{
 const before=process.cpuUsage(),time=performance.now();
 const output=await fn();
 const elapsed=performance.now()-time,used=process.cpuUsage(before);
 if(output?.isError)throw new Error(name+' failed: '+JSON.stringify(output.structuredContent?.error));
 metrics.push({name,wallMs:+elapsed.toFixed(2),cpuMs:+((used.user+used.system)/1000).toFixed(2),
  rssMiB:+(process.memoryUsage().rss/1048576).toFixed(1),
  jsonChars:output?.structuredContent?JSON.stringify(output.structuredContent).length:undefined});
 return output;
};
try{
 await run('read 20 files',()=>callTool('read_multiple_files',{paths:files.slice(0,20)}));
 await run('read 20 files warm',()=>callTool('read_multiple_files',{paths:files.slice(0,20)}));
 await run('read repeated paths 20x',()=>callTool('read_multiple_files',{paths:Array(20).fill(files[0])}));
 await run('ripgrep file contents',()=>callTool('start_search',{path:project,pattern:'benchmarkNeedle_12_3',searchType:'content',wait:true,maxResults:20,timeout_ms:5000}));
 await run('index enable',()=>callTool('project_index',{path:project,action:'enable'}));
 await run('index query warm',()=>callTool('project_index',{path:project,action:'query',query:'file'}));
 await run('graph 150 cold',()=>callTool('code_graph',{path:project,action:'refresh',maxFiles:200,limit:100}));
 await run('graph 150 warm',()=>callTool('code_graph',{path:project,maxFiles:200,limit:100}));
 await run('outline 150 max 48000',()=>callTool('code_graph',{path:project,format:'compact',maxChars:48000,maxFiles:200,limit:100}));
 await run('outline 150 max 4000',()=>callTool('code_graph',{path:project,format:'compact',maxChars:4000,maxFiles:200,limit:100}));
 await run('full gatherContext',()=>gatherContext(project,'file120.ts',5600));
 await run('packageInfo only',()=>packageInfo(project));
 await run('instructionContext only',()=>instructionContext(project,path.join(project,'file120.ts'),5600));
 await run('codeGraph focused query',()=>codeGraph.query(project,'file120.ts','both',1,30,200));
 await run('context outline focus',()=>callTool('context_pack',{path:project,focus:'file120.ts',query:'benchmarkNeedle_120',mode:'outline',maxChars:16000,maxFiles:200}));
 await run('context balanced focus',()=>callTool('context_pack',{path:project,focus:'file120.ts',query:'benchmarkNeedle_120',mode:'balanced',maxChars:16000,maxFiles:200}));
 console.log('BENCH_PHASE4_JSON='+JSON.stringify(metrics));
}finally{
 codeGraph.clear();
 await projectIndex.manage(project,'disable').catch(()=>{});
 await configManager.close();
 await fs.rm(folder,{recursive:true,force:true,maxRetries:7,retryDelay:70});
}
