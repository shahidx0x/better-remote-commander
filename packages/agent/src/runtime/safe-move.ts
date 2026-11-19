/** Verified no-clobber Windows-friendly move.
 * Files: fast hardlink/unlink on same volume, hash-verified streaming
 * copy/no-clobber publish across volumes. Never deletes source until
 * destination is verified. Directories retain native same-volume rename;
 * cross-volume directory moves fail explicitly rather than partially erasing
 * an unrestricted tree.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {constants as fsConstants,createReadStream} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {validatePath} from '../core/tools/filesystem.js';
import {AgentError} from './errors.js';
import {checkCancelled} from '../context.js';
export interface SafeMoveResult {
 source:string;destination:string;method:'native_directory_rename'|'hardlink_unlink'|'verified_copy';
 verified:boolean;sourceRemoved:boolean;bytes:number;
}
const missing=async(file:string)=>{
 try{await fs.lstat(file);return false;}catch(e){
  if((e as NodeJS.ErrnoException).code==='ENOENT')return true;
  throw e;
 }
};
async function digest(file:string):Promise<{sha256:string;bytes:number}>{
 const stream=createReadStream(file,{highWaterMark:64*1024});
 const hash=createHash('sha256');let bytes=0;
 try{
  for await(const data of stream){
   checkCancelled();
   const chunk=data as Buffer;bytes+=chunk.length;hash.update(chunk);
  }
 }finally{stream.destroy();}
 return {sha256:hash.digest('hex'),bytes};
}
const uncertain=(detail:string)=>new AgentError('MOVE_PARTIAL',
  'Destination may be present and the source has been preserved: '+detail+
  '. Inspect BOTH paths before deciding what to delete or retry.');
export async function moveFileSafely(source:string,destination:string):Promise<SafeMoveResult>{
 const src=await validatePath(source),dst=await validatePath(destination);
 if(src===dst)throw new AgentError('MOVE_IDENTICAL_PATH','Source and destination are identical. No move was performed.');
 const parent=path.dirname(dst);
 await fs.mkdir(parent,{recursive:true});
 if(await validatePath(destination)!==dst)throw new AgentError('PATH_CHANGED',
   'Destination resolved to a different path after its parent was prepared. No file moved.');
 if(!(await missing(dst)))throw new AgentError('MOVE_DEST_EXISTS',
   'Destination already exists. No existing file or directory was overwritten.');
 const stat=await fs.lstat(src);
 if(stat.isSymbolicLink())throw new AgentError('MOVE_SYMLINK_UNSUPPORTED',
   'Moving a symlink is not supported; verify its canonical destination before moving.');
 if(stat.isDirectory()){
  if(dst.startsWith(src+path.sep))throw new AgentError('MOVE_INVALID_DESTINATION','Cannot move a directory into itself.');
  try{await fs.rename(src,dst);return {source:src,destination:dst,
   method:'native_directory_rename',verified:true,sourceRemoved:true,bytes:0};}
  catch(e){
   if((e as NodeJS.ErrnoException).code==='EXDEV')
    throw new AgentError('MOVE_DIRECTORY_EXDEV',
      'Cross-volume directory moves need a dedicated recursive verified-copy workflow. Source and destination were not changed.');
   throw e;
  }
 }
 if(!stat.isFile())throw new AgentError('MOVE_FILE_TYPE_UNSUPPORTED',
  'Only regular files and same-volume directories are supported. No source was removed.');
 // Optimized path: an atomic no-clobber hardlink preserves file content with
 // no double I/O and works on NTFS when source/destination share a volume.
 try{
  await fs.link(src,dst);
  try{await fs.unlink(src);}
  catch(e){throw uncertain('Linked destination exists, source deletion failed: '+(e as Error).message);}
  return {source:src,destination:dst,method:'hardlink_unlink',verified:true,
   sourceRemoved:true,bytes:stat.size};
 }catch(e){
  if(e instanceof AgentError)throw e;
  const code=(e as NodeJS.ErrnoException).code;
  if(code==='EEXIST')throw new AgentError('MOVE_DEST_EXISTS','Destination appeared concurrently. Source retained.');
  if(!['EXDEV','EPERM','EOPNOTSUPP','ENOTSUP','ENOSYS'].includes(code??''))throw e;
 }
 // Cross-volume or filesystems without hardlinks. Stage on the destination
 // volume, compare exact SHA-256, then publish with no-clobber semantics.
 const temp=path.join(parent,'.'+path.basename(dst)+'.brc-move-'+randomUUID()+'.tmp');
 let published=false;
 try{
  const before=await digest(src);
  await fs.copyFile(src,temp,fsConstants.COPYFILE_EXCL);
  const staged=await digest(temp);
  if(before.sha256!==staged.sha256||before.bytes!==staged.bytes)
   throw new AgentError('MOVE_COPY_MISMATCH','Staged copy did not match source SHA-256. The source was not deleted.');
  checkCancelled();
  try{await fs.link(temp,dst);}
  catch(e){
   const code=(e as NodeJS.ErrnoException).code;
   if(code==='EEXIST')throw new AgentError('MOVE_DEST_EXISTS','Destination appeared concurrently. Source retained.');
   if(!['EPERM','EOPNOTSUPP','ENOTSUP','ENOSYS','EXDEV'].includes(code??''))throw e;
   await fs.copyFile(temp,dst,fsConstants.COPYFILE_EXCL);
  }
  published=true;
  const confirmed=await digest(dst);
  if(confirmed.sha256!==before.sha256||confirmed.bytes!==before.bytes)
   throw uncertain('Published destination could not be verified against source');
  const latest=await digest(src);
  if(latest.sha256!==before.sha256||latest.bytes!==before.bytes)
   throw uncertain('Source changed during verified copy');
  try{await fs.unlink(src);}
  catch(e){throw uncertain('Verified destination exists but source deletion failed: '+(e as Error).message);}
  return {source:src,destination:dst,method:'verified_copy',verified:true,
   sourceRemoved:true,bytes:before.bytes};
 }finally{
  await fs.unlink(temp).catch(()=>{});
  // A published destination is kept if verification or unlink fails.
  // Never silently destroy the only possible usable copy.
  if(!published){/* no source was deleted */ }
 }
}
