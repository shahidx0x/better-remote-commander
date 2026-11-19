/** Authoritative AST rewrite preflight + guarded per-file publication.
 *
 * A scanner returns byte offsets and exact matched text. Those offsets cannot
 * be trusted after another process edits the file: compare all anchored bytes
 * against a freshly read snapshot, optionally enforce a caller-observed hash,
 * and use atomicWrite(expectedSha256) for every resulting replacement.
 *
 * Never claim multi-file transactionality. An external change during a later
 * commit can leave earlier files committed; return a precise partial result.
 */
import path from 'node:path';
import {validatePath} from '../core/tools/filesystem.js';
import {readBounded,sha256,decodeCode,atomicWrite,withFileLocks} from './file-safety.js';
import {AgentError} from './errors.js';
import {sourceObservationMode} from './source-observations.js';
import {checkCancelled} from '../context.js';
import {codeGraph} from './code-graph.js';
import {projectIndex} from './project-index.js';

const MAX_FILES=128,MAX_BYTES=8*1024*1024;
export interface MatchedRewrite {
 text:string;
 range:{byteOffset:{start:number;end:number}};
 replacement:string;
 replacementOffsets?:{start:number;end:number};
}
export interface RewriteTarget {
 file:string; display:string; matches:MatchedRewrite[];
}
export interface PreparedRewrite {
 path:string; display:string;beforeHash:string;afterHash:string;
 old:Buffer;after:Buffer;applied:number;diff:string;
}
type ComputeDiff=(old:Buffer,edits:{start:number;end:number;replacement:Buffer}[],
 display:string,contextLines:number)=>{content:Buffer;diff:string;applied:number};
export interface RewriteOutcome {
 prepared:PreparedRewrite[];
 written:string[];
 totalEdits:number;
 partiallyCommitted:boolean;
 rollbackConflicts:string[];
}
export async function guardedAstRewrite(
 targets:RewriteTarget[],opts:{dryRun:boolean;contextLines:number;
 expectedSha256ByFile?:Record<string,string>},
 computeDiff:ComputeDiff
):Promise<RewriteOutcome>{
 if(targets.length>MAX_FILES)
  throw new AgentError('AST_REWRITE_TOO_WIDE',
   'Too many files in a single rewrite; narrow the target/globs (128-file limit). Nothing changed.');
 const validated=await Promise.all(targets.map(t=>validatePath(t.file)));
 if(new Set(validated.map(f=>process.platform==='win32'?f.toLowerCase():f)).size!==validated.length)
  throw new AgentError('AST_DUPLICATE_FILE','Duplicate/canonical-colliding target. Nothing changed.');
 return withFileLocks(validated,async()=>{
  const prepared:PreparedRewrite[]=[];
  const mode=sourceObservationMode();
  // No file is written before all matches in all files have been verified.
  for(let i=0;i<targets.length;i++){
   checkCancelled();
   const target=targets[i];
   const canonical=await validatePath(target.file);
   if(path.normalize(canonical).toLowerCase()!==path.normalize(validated[i]).toLowerCase())
    throw new AgentError('AST_TARGET_MOVED','Target changed while preparing rewrite. Nothing changed.');
   const old=await readBounded(canonical,MAX_BYTES);
   decodeCode(old);
   const beforeHash=sha256(old);
   const supplied=opts.expectedSha256ByFile?.[target.display]
     ??opts.expectedSha256ByFile?.[canonical];
   if(supplied!==undefined && !/^[0-9a-f]{64}$/i.test(supplied))
    throw new AgentError('INVALID_SOURCE_HASH','Invalid expected SHA-256 for '+target.display+'. Nothing changed.');
   if(!opts.dryRun&&mode==='strict'&&!supplied)
    throw new AgentError('SOURCE_HASH_REQUIRED',
      'Strict mode requires expected_sha256_by_file for '+target.display+
      '. Run the dry-run preview and supply its source hashes.');
   if(supplied&&beforeHash!==supplied.toLowerCase())
    throw new AgentError('FILE_CONFLICT','File changed since preview: '+target.display+'. Nothing changed.');
   const edits:{start:number;end:number;replacement:Buffer}[]=[];
   for(const m of target.matches){
    const start=m.range.byteOffset.start,end=m.range.byteOffset.end;
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||
       start<0||end<=start||end>old.length||
       typeof m.text!=='string'||!m.text||
       !old.subarray(start,end).equals(Buffer.from(m.text,'utf8')))
      throw new AgentError('AST_MATCH_STALE',
       'Source no longer matches ast-grep result in '+target.display+'. Rescan; no files changed.');
    const from=m.replacementOffsets?.start??start;
    const to=m.replacementOffsets?.end??end;
    if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||from<0||
       to<from||to>old.length||typeof m.replacement!=='string')
      throw new AgentError('AST_INVALID_OFFSET','Invalid byte offsets in '+target.display+'. Nothing changed.');
    edits.push({start:from,end:to,replacement:Buffer.from(m.replacement,'utf8')});
   }
   // Do not silently skip overlapping edits: some scanners generate duplicate
   // matches, and publishing one interpretation could mislead the caller.
   const order=[...edits].sort((a,b)=>a.start-b.start||a.end-b.end);
   if(order.some((e,j)=>j>0&&e.start<order[j-1].end))
    throw new AgentError('AST_OVERLAPPING_MATCHES','Overlapping rewrites in '+target.display+'. Narrow the pattern.');
   const next=computeDiff(old,edits,target.display,opts.contextLines);
   prepared.push({path:canonical,display:target.display,beforeHash,
    afterHash:sha256(next.content),old,after:next.content,applied:next.applied,diff:next.diff});
  }
  const applicable=prepared.filter(p=>p.applied>0&&!p.after.equals(p.old));
  if(opts.dryRun)return {prepared:applicable,written:[],totalEdits:applicable.reduce((n,p)=>n+p.applied,0),
    partiallyCommitted:false,rollbackConflicts:[]};
  const written:PreparedRewrite[]=[];
  const rollbackConflicts:string[]=[];
  try{
   for(const item of applicable){
    checkCancelled();
    const revalidated=await validatePath(item.path);
    if(path.normalize(revalidated).toLowerCase()!==path.normalize(item.path).toLowerCase())
     throw new AgentError('AST_TARGET_MOVED','Target moved before commit. Remaining files were not written.');
    await atomicWrite(item.path,item.after,item.beforeHash);
    written.push(item);
    projectIndex.invalidate(item.path);codeGraph.invalidate(item.path);
   }
  }catch(error){
   // Best-effort rollback only when the current bytes still match exactly the
   // version we wrote. Do not clobber a concurrent external modification.
   for(const item of [...written].reverse()){
    try{await atomicWrite(item.path,item.old,item.afterHash,true);
      projectIndex.invalidate(item.path);codeGraph.invalidate(item.path);}
    catch{rollbackConflicts.push(item.display);}
   }
   const reason=error instanceof Error?error.message:String(error);
   throw new AgentError('AST_COMMIT_UNCERTAIN',
    'AST rewrite stopped during publication: '+reason+
    (rollbackConflicts.length?'; manual inspection required for: '+rollbackConflicts.join(', '):
     '; prior writes were rolled back only if unchanged.')+
    ' Inspect current files before retrying; no automatic replay.');
  }
  return {prepared:applicable,written:written.map(t=>t.display),
    totalEdits:applicable.reduce((n,p)=>n+p.applied,0),
    partiallyCommitted:false,rollbackConflicts};
 });
}
