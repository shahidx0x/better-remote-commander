/** Complete context-patch operations with bounded preflight and rollback.
 * No shell, fuzzy matching or silent overwrites. Every source is checked
 * before the first mutation. Crash-atomicity across files is NOT claimed.
 */
import fs from 'node:fs/promises';
import {constants as fsConstants} from 'node:fs';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {z} from 'zod';
import type {ToolResult} from 'brc-shared';
import {AgentError,result,failure} from '../runtime/errors.js';
import {rootPath,projectPath} from '../runtime/workspace.js';
import {readBounded,decodeCode,sha256,atomicWrite,assertHash,withFileLocks} from '../runtime/file-safety.js';
import {moveFileSafely} from '../runtime/safe-move.js';
import {workerCoordinator} from '../runtime/worker-coordination.js';
import {checkCancelled} from '../context.js';

const MAX_FILE=8*1024*1024,MAX_TOTAL=16*1024*1024,MAX_OPS=16,MAX_HUNKS=80;
type Kind='add'|'delete'|'move'|'update';
interface Hunk{old:string[];fresh:string[];eof:boolean}
interface Operation{kind:Kind;src:string;dest?:string;hunks:Hunk[];added:string[]}
interface Plan extends Operation{
 absolute:string;destination?:string;original?:Buffer;beforeHash?:string;
 next?:Buffer;afterHash?:string;
}
function syntax(message:string):never{throw new AgentError('PATCH_SYNTAX',message+' No files were written.');}
function pathSafe(relative:string):void{
 if(!relative||path.isAbsolute(relative)||path.win32.isAbsolute(relative)||
  relative.includes('\0')||relative.split(/[\\/]/).includes('..'))
  syntax('Patch paths must be relative and inside the project root.');
}
function parse(source:string):Operation[]{
 const lines=source.replace(/\r\n/g,'\n').split('\n');
 if(lines.at(-1)==='')lines.pop();
 if(lines.shift()!=='*** Begin Patch'||lines.pop()!=='*** End Patch')
  syntax('Expected *** Begin Patch and *** End Patch.');
 const ops:Operation[]=[];let i=0,hunks=0;
 const used=new Set<string>();
 const claim=(relative:string)=>{
  pathSafe(relative);
  const key=relative.replaceAll('\\','/').toLowerCase();
  if(used.has(key))syntax('A source or destination is present more than once: '+relative);
  used.add(key);
 };
 while(i<lines.length){
  const header=/^\*\*\* (Add|Delete|Move|Update) File: (.+)$/.exec(lines[i++]);
  if(!header)syntax('Unknown patch directive; supported: Add/Delete/Move/Update File.');
  const kind=header[1].toLowerCase() as Kind;
  const parts=kind==='move'?header[2].split(/\s+->\s+/):[header[2]];
  if(kind==='move'&&parts.length!==2)syntax('Move File requires source -> destination.');
  const src=parts[0].trim(),dest=parts[1]?.trim();
  claim(src);if(dest)claim(dest);
  const op:Operation={kind,src,dest,hunks:[],added:[]};
  if(kind==='update'&&lines[i]?.startsWith('*** Move to: ')){
   op.dest=lines[i++].slice('*** Move to: '.length).trim();claim(op.dest);
  }
  if(kind==='add'){
   while(i<lines.length&&!lines[i].startsWith('*** ')){
    const row=lines[i++];if(!row.startsWith('+'))syntax('Add File lines must start with +');
    op.added.push(row.slice(1));
   }
   if(!op.added.length)syntax('Add File must contain at least one + line, including + for an empty line.');
  }else if(kind==='update'){
   let current:Hunk|null=null;
   while(i<lines.length&&(!lines[i].startsWith('*** ') || lines[i]==='*** End of File')){
    const row=lines[i++];
    if(row.startsWith('@@')){
     if(current)op.hunks.push(current);
     current={old:[],fresh:[],eof:false};
     if(++hunks>MAX_HUNKS)syntax('Too many hunks; maximum '+MAX_HUNKS+'.');
    }else if(row==='*** End of File'){
     if(!current)syntax('*** End of File requires an @@ hunk.');
     current.eof=true;
    }else{
     if(!current)syntax('Update File needs an @@ hunk before + / - / context lines.');
     if(current.eof)syntax('Nothing may follow *** End of File inside a hunk.');
     const mark=row[0],value=row.slice(1);
     if(mark===' '){current.old.push(value);current.fresh.push(value);}
     else if(mark==='-')current.old.push(value);
     else if(mark==='+')current.fresh.push(value);
     else syntax('Invalid hunk line marker: expected space, +, or -.');
    }
   }
   if(current)op.hunks.push(current);
   if(!op.hunks.length)syntax('Update File requires at least one hunk.');
   if(op.hunks.some(h=>!h.old.length))
    syntax('Insert-only hunks require at least one unchanged context line.');
  }
  ops.push(op);
  if(ops.length>MAX_OPS)syntax('At most '+MAX_OPS+' files can be modified in one patch.');
 }
 if(!ops.length)syntax('Empty patch.');
 return ops;
}
function onlyMatch(full:string,old:string,eof:boolean):number{
 let chosen=-1;
 for(let offset=0;offset<=full.length-old.length;){
  const at=full.indexOf(old,offset);
  if(at<0)break;
  const end=at+old.length;
  const startLine=at===0||full[at-1]==='\n';
  const endLine=end===full.length||full[end]==='\n'||full.slice(end,end+2)==='\r\n';
  const atEof=!eof||end===full.length||/^\r?\n?$/.test(full.slice(end));
  if(startLine&&endLine&&atEof){
   if(chosen>=0)return -2;
   chosen=at;
  }
  offset=at+1;
 }
 return chosen;
}
async function planning(root:string,ops:Operation[]):Promise<Plan[]>{
 let total=0;
 const plans:Plan[]=[];
 for(const op of ops){
  checkCancelled();
  const absolute=await projectPath(root,op.src);
  const destination=op.dest?await projectPath(root,op.dest):undefined;
  const plan:Plan={...op,absolute,destination};
  if(op.kind==='add'){
   const exists=await fs.lstat(absolute).then(()=>true,e=>{
    if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;
   });
   if(exists)throw new AgentError('PATCH_TARGET_EXISTS','Add File target already exists: '+op.src+'. No files written.');
   const data=Buffer.from(op.added.join('\n')+'\n');
   total+=data.length;plan.next=data;plan.afterHash=sha256(data);
  }else{
   const st=await fs.lstat(absolute);
   if(!st.isFile()||st.isSymbolicLink())throw new AgentError('PATCH_UNSUPPORTED_TARGET',
    'Only existing regular files may be updated, moved or deleted. No files written.');
   const bytes=await readBounded(absolute,MAX_FILE);
   total+=bytes.length;plan.original=bytes;plan.beforeHash=sha256(bytes);
   if(op.kind==='update'){
    const eol=bytes.includes(Buffer.from('\r\n'))?'\r\n':'\n';
    let body=decodeCode(bytes);
    for(const [index,h] of op.hunks.entries()){
     const old=h.old.join(eol),fresh=h.fresh.join(eol);
     const at=onlyMatch(body,old,h.eof);
     if(at<0)throw new AgentError('PATCH_CONTEXT_MISMATCH',
      'File '+op.src+', hunk '+(index+1)+' matched '+(at===-2?'more than once':'no exact whole-line context')+
      '. Entire patch rejected; add unique surrounding lines.');
     body=body.slice(0,at)+fresh+body.slice(at+old.length);
    }
    plan.next=Buffer.from(body,'utf8');plan.afterHash=sha256(plan.next);
    if(plan.next.length>MAX_FILE)throw new AgentError('PATCH_TOO_LARGE','Updated file exceeds 8 MiB.');
    total+=plan.next.length;
   }else if(op.kind==='move'){plan.next=bytes;plan.afterHash=plan.beforeHash;}
  }
  if(destination){
   const found=await fs.lstat(destination).then(()=>true,e=>{
    if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;
   });
   if(found)throw new AgentError('PATCH_TARGET_EXISTS',
     'Move destination already exists: '+op.dest+'. Entire patch rejected.');
  }
  if(total>MAX_TOTAL)throw new AgentError('PATCH_TOO_LARGE','Patch plans exceed the 16 MiB aggregate RAM cap.');
  plans.push(plan);
 }
 return plans;
}
async function publishNew(file:string,bytes:Buffer):Promise<void>{
 const parent=path.dirname(file);
 await fs.mkdir(parent,{recursive:true});
 const validated=await projectPath(parent,file);
 if(validated!==file)throw new AgentError('PATH_CHANGED','Patch destination changed while its parent was created.');
 const stage=path.join(parent,'.'+path.basename(file)+'.brc-patch-'+randomUUID()+'.tmp');
 try{
  const handle=await fs.open(stage,'wx',0o600);
  try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
  try{await fs.link(stage,file);}
  catch(e){
   const code=(e as NodeJS.ErrnoException).code;
   if(code==='EEXIST')throw new AgentError('PATCH_TARGET_EXISTS','Patch add target appeared concurrently: '+file);
   if(!['EPERM','EOPNOTSUPP','ENOTSUP','ENOSYS'].includes(code??''))throw e;
   // No-clobber fallback for filesystem types without hardlinks.
   // A failed copy may leave partial destination bytes: the outer executor
   // reports PATCH_PARTIAL and never removes an unknown externally changed file.
   await fs.copyFile(stage,file,fsConstants.COPYFILE_EXCL);
  }
  await assertHash(file,sha256(bytes));
 }finally{await fs.unlink(stage).catch(()=>{});}
}
async function verifyPlans(plans:Plan[]){
 for(const p of plans){
  checkCancelled();
  if(p.beforeHash)await assertHash(p.absolute,p.beforeHash);
  else if(await fs.lstat(p.absolute).then(()=>true,()=>false))
   throw new AgentError('PATCH_TARGET_EXISTS','Destination unexpectedly exists: '+p.src);
  if(p.destination && await fs.lstat(p.destination).then(()=>true,()=>false))
   throw new AgentError('PATCH_TARGET_EXISTS','Move destination appeared before publication.');
 }
}
async function appliedAction(p:Plan):Promise<void>{
 if(p.kind==='add')await publishNew(p.absolute,p.next!);
 else if(p.kind==='update'&&!p.destination)await atomicWrite(p.absolute,p.next!,p.beforeHash);
 else if(p.kind==='update'&&p.destination){
  await moveFileSafely(p.absolute,p.destination);
  await atomicWrite(p.destination,p.next!,p.beforeHash);
 }else if(p.kind==='move')await moveFileSafely(p.absolute,p.destination!);
 else if(p.kind==='delete'){await assertHash(p.absolute,p.beforeHash!);await fs.unlink(p.absolute);}
}
async function restore(p:Plan):Promise<boolean>{
 try{
  const current=p.destination??p.absolute;
  if(p.kind==='add'){
   if(await fs.lstat(current).then(()=>true,()=>false)){
    await assertHash(current,p.afterHash!);await fs.unlink(current);
   }
  }else if(p.kind==='update'&&!p.destination){
   await assertHash(current,p.afterHash!);await atomicWrite(current,p.original!,p.afterHash);
  }else if(p.kind==='move'){
   await assertHash(current,p.afterHash!);
   if(await fs.lstat(p.absolute).then(()=>true,()=>false))return false;
   await moveFileSafely(current,p.absolute);
  }else if(p.kind==='update'&&p.destination){
   await assertHash(current,p.afterHash!);
   await atomicWrite(current,p.original!,p.afterHash);
   if(await fs.lstat(p.absolute).then(()=>true,()=>false))return false;
   await moveFileSafely(current,p.absolute);
  }else if(p.kind==='delete'){
   if(await fs.lstat(p.absolute).then(()=>true,()=>false))return false;
   await publishNew(p.absolute,p.original!);
  }
  return true;
 }catch{return false;}
}
export async function applyExtendedPatch(input:{cwd:string;input:string;dryRun?:boolean}):Promise<ToolResult>{
 const root=await rootPath(input.cwd),ops=parse(input.input);
 const plans=await planning(root,ops);
 if(input.dryRun)return result({dryRun:true,extended:true,
  files:plans.map(p=>({type:p.kind,path:p.absolute,destination:p.destination??null,
   beforeSha256:p.beforeHash??null,afterSha256:p.afterHash??null})),
  validatedFullPatchBeforeWriting:true,hunks:plans.reduce((n,p)=>n+p.hunks.length,0),
  atomicity:'per-file, best-effort rollback; not cross-file crash-atomic'});
 const touched=plans.flatMap(p=>[p.absolute,...(p.destination?[p.destination]:[])]);
 await workerCoordinator.guardFileMutation('edit_files',{files:plans.map(p=>({path:p.absolute}))});
 return withFileLocks(touched,async()=>{
  await verifyPlans(plans);
  const completed:Plan[]=[];
  let current:Plan|undefined;
  try{
   for(const p of plans){
    current=p;checkCancelled();
    await appliedAction(p);
    completed.push(p);
   }
   return result({dryRun:false,extended:true,validatedFullPatchBeforeWriting:true,
    files:plans.map(p=>({type:p.kind,path:p.absolute,destination:p.destination??null,
      beforeSha256:p.beforeHash??null,afterSha256:p.afterHash??null})),
    hunks:plans.reduce((n,p)=>n+p.hunks.length,0),
    atomicity:'per-file with best-effort rollback; not cross-file crash-atomic'});
  }catch(e){
   // A partially applied current operation may have published a destination
   // before reporting an error. Do not automatically replay it.
   let uncertainCurrent=false;
   if(current&&!completed.includes(current)){
    if(current.kind==='update'&&current.destination||
       current.kind==='move'||current.kind==='delete')uncertainCurrent=true;
    else if(current.kind==='add'){
     const exists=await fs.lstat(current.absolute).then(()=>true,()=>false);
     if(exists)uncertainCurrent=true;
    }
   }
   const rolledBack: string[]=[];
   const incomplete:string[]=[];
   for(const p of completed.reverse()){
    const ok=await restore(p);
    (ok?rolledBack:incomplete).push(p.src);
   }
   const problem=e instanceof Error?e.message:String(e);
   const error=failure(new AgentError(uncertainCurrent||incomplete.length?'PATCH_PARTIAL':'PATCH_FAILED',
    'Patch failed: '+problem+'. '+(uncertainCurrent||incomplete.length?
      'Some publication or rollback outcome is uncertain. Inspect all paths before retrying.':
      'Previously committed steps were rolled back.')));
   return {...error,structuredContent:{...error.structuredContent,extended:true,
    rolledBack,incomplete,uncertainCurrent,automaticRetry:false,
    currentOperation:current?.kind??null,currentPath:current?.src??null}};
  }
 });
}
