// Reproducible local cache benchmark. Disposable fixtures; results go to stdout only.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const scratch=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'brc-context-bench-'));
const root=path.join(scratch,'project');await fs.mkdir(root);
process.env.BRC_HOME=path.join(scratch,'agent');process.env.BRC_LOG_LEVEL='silent';
const {configManager}=await import('../packages/agent/dist/core/config-manager.js');
await configManager.setValue('allowedDirectories',[root]);
const {codeGraph}=await import('../packages/agent/dist/runtime/code-graph.js');
const {clearCodeCache}=await import('../packages/agent/dist/runtime/code-structure.js');
const median=xs=>[...xs].sort((a,b)=>a-b)[Math.floor(xs.length/2)];
try{
 for(let i=0;i<120;i++)await fs.writeFile(path.join(root,`file${String(i).padStart(3,'0')}.cs`),`namespace Bench { public class Item${i} { public int Run() { return ${i}; } } }`);
 const coldStart=performance.now(),cold=await codeGraph.query(root,undefined,'both',1,30,200,true),coldMs=performance.now()-coldStart;
 const warmTimes=[];let warm;
 for(let i=0;i<5;i++){const t=performance.now();warm=await codeGraph.query(root,undefined,'both',1,30,200);warmTimes.push(performance.now()-t);}
 await fs.appendFile(path.join(root,'file005.cs'),'\n// changed');
 const t=performance.now(),changed=await codeGraph.query(root,undefined,'both',1,30,200),changedMs=performance.now()-t;
 console.log(JSON.stringify({fixture:'120 small C# files',coldMs:Math.round(coldMs),coldParses:cold.cache.reparsed,warmMedianMs:Math.round(median(warmTimes)),warmReused:warm.cache.reused,warmParses:warm.cache.reparsed,changedMs:Math.round(changedMs),changedParses:changed.cache.reparsed}));
 console.log('Local synthetic graph timing only; excludes remote network and model latency. Not a production speedup guarantee.');
}finally{codeGraph.clear();clearCodeCache();await configManager.close();await fs.rm(scratch,{recursive:true,force:true,maxRetries:8,retryDelay:100});}
