// Phase 10 reproducible page-integrity benchmark on a disposable output.
import {performance} from 'node:perf_hooks';
import {mkdtempSync,realpathSync} from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const work=mkdtempSync(path.join(realpathSync.native(os.tmpdir()),'brc-spill-bench-'));
process.env.BRC_HOME=path.join(work,'agent');
const {saveJobOutput,readJobOutput,spillVerificationStatus}=
 await import('../dist/runtime/job-output-spill.js');
const payload=('Phase10 output page benchmark: work complete!\n').repeat(37_000);
const median=a=>[...a].sort((x,y)=>x-y)[Math.floor(a.length/2)];
const round=n=>+n.toFixed(2);
const baseline=[],optimized=[],reduction=[],hashBaseline=[],hashOptimized=[];
const run=async(enabled,i)=>{
 process.env.BRC_SPILL_VERIFICATION_CACHE=enabled?'1':'0';
 const id='jphase10'+(enabled?'optimized':'baseline')+i.toString().padStart(2,'0');
 const ref=await saveJobOutput(id,0,payload,true);
 if(!ref||ref.bytes<500_000)throw Error('Invalid spill benchmark fixture');
 const prior=spillVerificationStatus().fullHashes;
 let offset=0,pages=0,bytes=0;
 const start=performance.now();
 while(true){
  const page=await readJobOutput(id,0,offset,8000,ref.sha256);
  if(!page)throw Error('Invalid page during verification');
  pages++;bytes+=Buffer.byteLength(page.text);
  if(!page.hasMore)break;
  if(page.nextByteOffset<=offset)throw Error('Nonadvancing spill offset');
  offset=page.nextByteOffset;
  if(pages>400)throw Error('Unbounded pagination');
 }
 const ms=performance.now()-start,hashes=spillVerificationStatus().fullHashes-prior;
 if(bytes!==ref.bytes)throw Error('Missing output during page retrieval');
 return {ms,hashes,pages,bytes};
};
try{
 for(let i=0;i<5;i++){
  const first=await run(false,i);
  const second=await run(true,i);
  baseline.push(first.ms);optimized.push(second.ms);
  hashBaseline.push(first.hashes);hashOptimized.push(second.hashes);
  if(first.pages!==second.pages||first.bytes!==second.bytes)throw Error('Non-equivalent spill paging');
 }
 const slow=median(baseline),fast=median(optimized);
 console.log('PHASE10_SPILL_BENCH='+JSON.stringify({
  fixtureBytes:Buffer.byteLength(payload),pageSize:8000,rounds:5,
  legacyMedianMs:round(slow),optimizedMedianMs:round(fast),
  speedup:round(slow/fast),reductionPercent:round(100*(1-fast/slow)),
  legacySamples:baseline.map(round),optimizedSamples:optimized.map(round),
  legacyFullHashes:hashBaseline,optimizedFullHashes:hashOptimized,
  note:'Local disposable file; verified file identity cache reduces redundant full-file SHA-256 when metadata is unchanged. Not end-to-end ChatGPT task performance.'
 }));
}finally{
 delete process.env.BRC_SPILL_VERIFICATION_CACHE;
 await fs.rm(work,{recursive:true,force:true,maxRetries:8,retryDelay:80});
}
