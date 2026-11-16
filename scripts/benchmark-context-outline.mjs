// Benchmarks context WIRE size only; this is not model inference or tokenizer measurement.
import {mkdtempSync,realpathSync} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {performance} from 'node:perf_hooks';
import {codeGraph} from '../packages/agent/dist/runtime/code-graph.js';
import {compactGraph} from '../packages/agent/dist/runtime/graph-outline.js';
const root=mkdtempSync(path.join(realpathSync.native(os.tmpdir()),'brc-outline-bench-'));
try{
 for(let i=0;i<56;i++){
  const prior=i?'import { handler'+(i-1)+" } from './mod"+(i-1)+".js';\n":'';
  await fs.writeFile(path.join(root,'mod'+i+'.ts'),prior+'export function handler'+i+'(value: number) { return value + '+i+'; }\n');
 }
 const full=await codeGraph.query(root,undefined,'both',1,100,100,true);
 const t=performance.now(),compressed=compactGraph(full,{maxChars:48000,maxSymbolsPerFile:20}),renderMs=performance.now()-t;
 const before=Buffer.byteLength(JSON.stringify(full)),after=Buffer.byteLength(JSON.stringify(compressed));
 console.log(JSON.stringify({
  fixture:'56 linked TypeScript files (synthetic, local)',files:compressed.files.length,edges:compressed.relations.length,
  bytesFull:before,bytesOutline:after,bytesSaved:before-after,reductionPercent:Math.round((1-after/before)*100),
  outlineCpuMs:Math.round(renderMs*100)/100,
  omissions:compressed.coverage,
  note:'Only on-wire graph/context bytes, not actual model tokens, ChatGPT usage, conversation compression or retrieval quality.'
 }));
}finally{codeGraph.clear();await fs.rm(root,{recursive:true,force:true,maxRetries:4,retryDelay:50})}
