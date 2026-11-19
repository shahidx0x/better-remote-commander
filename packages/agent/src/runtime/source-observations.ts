/** Fresh source-write preconditions, enabled by default without changing
 * ordinary tool arguments:
 *  - unset/auto: compute a fresh SHA-256 inside the dispatcher write lock
 *    before mutating existing source/config files (8 MiB per-file bound).
 *  - 1: strict; caller must provide expected_sha256 from an earlier read.
 *  - 0: legacy; only caller-supplied hashes are checked.
 * New files remain creatable. This is NOT a Windows OS sandbox.
 */
import fs from 'node:fs/promises';
import {validatePath} from '../core/tools/filesystem.js';
import {readBounded,sha256} from './file-safety.js';
import {AgentError} from './errors.js';

const CODE=/\.(?:[cm]?[jt]sx?|jsonc?|mdx?|ya?ml|toml|css|s[ac]ss|html|vue|svelte|py|rs|go|java|cs|c|cc|cpp|h|hpp|php|rb|sql|graphql|sh|ps1|cmd|bat|xml|ini|conf|lock)$/i;
const MAX_AUTO_BYTES=8*1024*1024;
export type SourceObservationMode='auto'|'strict'|'off';
export const sourceObservationMode=():SourceObservationMode=>{
 const value=process.env.BRC_REQUIRE_SOURCE_HASH;
 return value==='0'?'off':value==='1'?'strict':'auto';
};
export const strictSourceObservations=()=>sourceObservationMode()==='strict';
export const sourceObservationStatus=()=>({
 enabled:sourceObservationMode()!=='off',
 mode:sourceObservationMode(),
 affectedTools:['write_file','edit_block'],
 automaticPreconditionBytes:MAX_AUTO_BYTES,
 strictRequiresCallerHash:true,
 newFilesCanBeCreated:true,
 note:'Default automatic current-file SHA-256 protects against changes between preflight and mutation without manual hashes. BRC_REQUIRE_SOURCE_HASH=1 enforces caller hashes; =0 disables. Auto mode does not prove prior user observation; large-file fallback and shell/git/specialized mutation paths use existing semantics.'
});
export async function automaticSourcePrecondition(tool:string,args:Record<string,unknown>):Promise<string|undefined>{
 if(sourceObservationMode()!=='auto'||!['write_file','edit_block'].includes(tool)||args.expected_sha256!==undefined)
  return undefined;
 const raw=tool==='edit_block'?args.file_path:args.path;
 if(typeof raw!=='string'||!CODE.test(raw))return undefined;
 const canonical=await validatePath(raw);
 if(!CODE.test(canonical))return undefined;
 try{
  const stat=await fs.stat(canonical);
  if(!stat.isFile()||stat.size>MAX_AUTO_BYTES)return undefined;
  return sha256(await readBounded(canonical,MAX_AUTO_BYTES));
 }catch(error){
  if((error as NodeJS.ErrnoException)?.code==='ENOENT')return undefined;
  throw error;
 }
}
export async function requireSourceObservation(tool:string,args:Record<string,unknown>):Promise<void>{
 if(!strictSourceObservations()||!['write_file','edit_block'].includes(tool))return;
 const raw=tool==='edit_block'?args.file_path:args.path;
 if(typeof raw!=='string')return;
 const canonical=await validatePath(raw);
 if(!CODE.test(canonical))return;
 let exists=false;
 try{
  const stat=await fs.lstat(canonical);
  exists=stat.isFile();
  if(!stat.isFile())return;
 }catch(error){
  if((error as NodeJS.ErrnoException)?.code!=='ENOENT')throw error;
 }
 if(!exists)return;
 if(typeof args.expected_sha256!=='string'||!/^[0-9a-f]{64}$/i.test(args.expected_sha256))
  throw new AgentError('SOURCE_HASH_REQUIRED',
    'Strict source mode is enabled. Read the existing source and supply expected_sha256 before editing. No file was changed.');
}
