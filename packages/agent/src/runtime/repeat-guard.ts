/** Advisory loop-hygiene: metadata only, no tool args/results retained.
 * Identical failing calls may indicate a stuck agent, but callers are never
 * blocked and mutations are never automatically retried.
 */
import {createHash} from 'node:crypto';

const MAX_ENTRIES=128,TTL_MS=10*60_000;
const ADVISE=new Set([3,5,8]);
// Normalize only already JSON-serializable arguments. Arrays retain order,
// object keys are sorted at every depth, and the 16 KiB input cap prevents
// pathological recursive work. Only SHA-256 hashes remain in memory.
function stableArguments(args:unknown):string|null{
 try{
  const serialized=JSON.stringify(args)??'';
  if(serialized.length>16*1024)return null;
  const parsed:unknown=JSON.parse(serialized||'null');
  const sort=(value:unknown,depth:number):unknown=>{
   if(depth>20)throw new Error('Argument nesting too deep');
   if(Array.isArray(value))return value.map(x=>sort(x,depth+1));
   if(value&&typeof value==='object'){
    const record=value as Record<string,unknown>;
    const result:Record<string,unknown>={};
    for(const key of Object.keys(record).sort())result[key]=sort(record[key],depth+1);
    return result;
   }
   return value;
  };
  return JSON.stringify(sort(parsed,0));
 }catch{return null;}
}
const OMIT=new Set(['get_job','list_jobs','wait_jobs','read_process_output',
 'get_more_search_results','agent_status','list_sessions','get_recent_tool_calls']);
interface Entry {count:number;at:number;code:string}
const guidance=(code:string)=>{
 if(/^(EDIT_TEXT_NOT_FOUND|EDIT_COUNT_MISMATCH|EDIT_MISMATCH|FILE_CONFLICT)$/.test(code))
  return 'Read the current file and hash, then submit a corrected unique anchor. Do not replay the same edit.';
 if(code==='SEARCH_BUSY')return 'Let an existing search finish; do not create more identical search sessions.';
 if(code==='SEARCH_INVALID_PATTERN')return 'Correct the regular expression or explicitly choose literal search.';
 if(code==='COMMAND_FAILED'||code==='SHELL_SYNTAX')return 'Inspect stderr, exit code and shell; change the failing command before another attempt.';
 if(code==='ENOENT')return 'Verify the exact path and parent directory before retrying.';
 if(code==='PATH_CHANGED')return 'Re-check the actual canonical path and the allowed directory policy; never reuse a stale target.';
 if(code.includes('UNCERTAIN'))return 'Inspect actual side effects before repeating this operation.';
 return 'Inspect the error and change the request or diagnose the underlying tool. Do not loop unchanged.';
};
export class RepeatFailureGuard {
 private seen=new Map<string,Entry>();
 constructor(private readonly now:()=>number=Date.now){}
 observe(tool:string,args:unknown,isError:boolean,code='TOOL_FAILED'):{count:number;hint:string}|null{
  if(OMIT.has(tool))return null;
  const raw=stableArguments(args);
  if(raw===null)return null;
  const key=createHash('sha256').update(tool).update('\0').update(raw).digest('hex');
  const now=this.now();
  if(!isError){this.seen.delete(key);return null;}
  const old=this.seen.get(key);
  const count=old&&old.code===code&&now-old.at<TTL_MS?old.count+1:1;
  this.seen.delete(key);
  this.seen.set(key,{count,at:now,code});
  for(const [k,v] of this.seen){
   if(this.seen.size<=MAX_ENTRIES && now-v.at<TTL_MS)break;
   this.seen.delete(k);
  }
  return ADVISE.has(count)?{count,hint:guidance(code)}:null;
 }
 status(){return {trackedFingerprints:this.seen.size,maxFingerprints:MAX_ENTRIES,
  ttlMs:TTL_MS,persisted:false,argumentTextStored:false,canonicalizedJsonKeys:true};}
 reset(){this.seen.clear();}
}
export const repeatFailureGuard=new RepeatFailureGuard();
