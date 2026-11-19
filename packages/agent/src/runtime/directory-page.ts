/** Stable-enough filesystem enumeration without materializing a large directory.
 * Pages refer to the current filesystem view; changes may shift offsets.
 * The global line/byte/depth/offset and duration caps protect agent RAM.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {validatePath} from '../core/tools/filesystem.js';
import {checkCancelled} from '../context.js';
import {AgentError} from './errors.js';
const MAX_ITEMS=500,MAX_BYTES=64*1024,MAX_OFFSET=50_000;
const MAX_NESTED=100,MAX_DURATION_MS=12_000,MAX_DEPTH=5,MAX_NAME=512;
export interface DirectoryPage{
 entries:string[];nextOffset:number|null;offset:number;limit:number;hasMore:boolean;
 bytes:number;depth:number;notSnapshot:true;truncated:boolean;partialReason?:string;
}
export async function listDirectoryPage(opts:{path:string;depth?:number;offset?:number;limit?:number}):Promise<DirectoryPage>{
 const depth=Math.max(1,Math.min(MAX_DEPTH,opts.depth??2));
 const offset=opts.offset??0,limit=Math.max(1,Math.min(MAX_ITEMS,opts.limit??200));
 if(!Number.isSafeInteger(offset)||offset<0||offset>MAX_OFFSET)throw new AgentError('DIRECTORY_OFFSET_INVALID',
   'Directory offset must be a non-negative integer up to '+MAX_OFFSET+'. Narrow path or use start_search(searchType=files).');
 const root=await validatePath(opts.path),stat=await fs.stat(root);
 if(!stat.isDirectory())throw new AgentError('NOT_DIRECTORY','Use read_file for a file; list_directory requires a folder.');
 const deadline=Date.now()+MAX_DURATION_MS;
 const rows:string[]=[],seen=new Set<string>();
 let scanned=0,bytes=0,hasMore=false,reason:string|undefined;
 async function* walk(dir:string,prefix:string,remainingDepth:number,nested:boolean):AsyncGenerator<string>{
  checkCancelled();
  const canonical=await fs.realpath(dir);
  if(seen.has(canonical))return;
  seen.add(canonical);
  const handle=await fs.opendir(dir,{bufferSize:32});
  let count=0;
  try{
   for await(const entry of handle){
    if(Date.now()>deadline)throw new AgentError('DIRECTORY_SCAN_TIMEOUT',
      'Directory listing exceeded its 12-second enumeration budget; narrow the folder or depth.');
    checkCancelled();
    if(nested&&count>=MAX_NESTED){
      yield '[WARNING] '+prefix+': additional nested entries omitted (100-entry cap)';
      break;
    }
    count++;
    const name=entry.name.length>MAX_NAME?entry.name.slice(0,MAX_NAME)+'…':entry.name;
    const relative=prefix?path.join(prefix,name):name;
    const isDir=entry.isDirectory(),isLink=entry.isSymbolicLink();
    yield (isDir?'[DIR] ':isLink?'[LINK] ':'[FILE] ')+relative;
    if(isDir&&remainingDepth>1){
      const child=path.join(dir,entry.name);
      try{
        // Recheck permissions and avoid dereferencing a junction outside scope.
        await validatePath(child);
        yield* walk(child,relative,remainingDepth-1,true);
      }catch(e){
        if(e instanceof AgentError && e.code==='DIRECTORY_SCAN_TIMEOUT')throw e;
        yield '[DENIED] '+relative+' — inaccessible or outside allowed directories';
      }
    }
   }
  }finally{await handle.close().catch(()=>{});}
 }
 try{
  for await(const row of walk(root,'',depth,false)){
   if(scanned++<offset)continue;
   if(rows.length>=limit){hasMore=true;break;}
   const rowBytes=Buffer.byteLength(row,'utf8')+1;
   if(bytes+rowBytes>MAX_BYTES){hasMore=true;reason='BYTE_BUDGET';break;}
   rows.push(row);bytes+=rowBytes;
  }
 }catch(error){
  if(rows.length>0 && error instanceof AgentError && error.code==='DIRECTORY_SCAN_TIMEOUT'){
   hasMore=true;reason='SCAN_TIMEOUT';
  }else throw error;
 }
 return {entries:rows,offset,limit,bytes,depth,hasMore,
  nextOffset:hasMore?offset+rows.length:null,notSnapshot:true,
  truncated:hasMore, ...(reason?{partialReason:reason}:{})};
}
