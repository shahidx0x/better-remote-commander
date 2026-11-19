/**
 * Codex/DeepSeek-style context patch admission for EXISTING UTF-8 files.
 * Whole patch syntax + all hunk contexts are validated before any write.
 * Use existing edit_files transaction engine for per-file atomic replacement,
 * mandatory hashes and best-effort rollback if a later file commit fails.
 * Does not pretend to provide crash-atomic cross-file transactions.
 */
import path from 'node:path';
import {z} from 'zod';
import {zodToJsonSchema} from 'zod-to-json-schema';
import type {ToolResult} from 'brc-shared';
import type {ToolDefinition} from '../core/tool-definitions.js';
import {AgentError} from '../runtime/errors.js';
import {rootPath,projectPath} from '../runtime/workspace.js';
import {readBounded,decodeCode,sha256} from '../runtime/file-safety.js';
import {CODING_TOOL_HANDLERS} from './coding-tools.js';
import {checkCancelled} from '../context.js';
import {workerCoordinator} from '../runtime/worker-coordination.js';

const MAX_PATCH_CHARS=256*1024,MAX_FILES=16,MAX_HUNKS=80;
const PatchSchema=z.object({
 cwd:z.string().min(1).describe('Absolute project root with the existing files to modify.'),
 input:z.string().min(1).max(MAX_PATCH_CHARS).describe('*** Begin Patch / *** Update File / @@ / context (- and +) / *** End Patch. Paths are relative to cwd.'),
 dryRun:z.boolean().optional().default(false).describe('Validate contexts and preview edits without writing.')
}).strict();

interface Hunk{oldLines:string[];newLines:string[];anchor:string;endOfFile:boolean}
interface Target{relative:string;hunks:Hunk[]}

function patchError(message:string):never{throw new AgentError('PATCH_SYNTAX',message.slice(0,1200));}
function parsePatch(input:string):Target[]{
 const lines=input.replace(/\r\n/g,'\n').split('\n');
 if(lines.at(-1)==='')lines.pop();
 if(lines.shift()!=='*** Begin Patch'||lines.pop()!=='*** End Patch')
  patchError('Expected *** Begin Patch and *** End Patch lines. No files written.');
 const targets:Target[]=[];
 let i=0,totalHunks=0;
 while(i<lines.length){
  const header= /^\*\*\* Update File: (.+)$/.exec(lines[i++]);
  if(!header)
   patchError('Only *** Update File: <relative-path> is supported. For creation, deletion or moves use write_file/delete_file/move_file.');
  const relative=header[1].trim();
  if(!relative||path.isAbsolute(relative)||path.win32.isAbsolute(relative)||relative.includes('\0')||
    relative.split(/[\\/]/).includes('..'))
   patchError('Patch targets must be relative paths inside the project root.');
  if(targets.some(t=>t.relative.toLowerCase()===relative.toLowerCase()))
   patchError('List each file once and put its hunks in the same update section.');
  if(targets.length>=MAX_FILES)patchError('Maximum '+MAX_FILES+' files per patch.');
  const target:Target={relative,hunks:[]};targets.push(target);
  let current:Hunk|null=null;
  while(i<lines.length&&!lines[i].startsWith('*** Update File: ') ){
   const row=lines[i++];
   if(row.startsWith('*** ') && row!=='*** End of File')
    patchError('Unsupported patch directive: '+row.slice(0,80));
   if(row.startsWith('@@')){
    if(current)target.hunks.push(current);
    current={oldLines:[],newLines:[],anchor:row.slice(2).trim(),endOfFile:false};
    if(++totalHunks>MAX_HUNKS)patchError('Too many patch hunks; maximum '+MAX_HUNKS+'.');
    continue;
   }
   if(!current)patchError('A file update must contain an @@ hunk before any diff lines.');
   if(row==='*** End of File'){current.endOfFile=true;continue;}
   if(current.endOfFile)patchError('No diff rows are allowed after *** End of File.');
   const tag=row[0],text=row.slice(1);
   if(tag===' '){current.oldLines.push(text);current.newLines.push(text);}
   else if(tag==='-')current.oldLines.push(text);
   else if(tag==='+')current.newLines.push(text);
   else patchError('Hunk lines must start with a space, + or -. This is not shell or free-form text.');
  }
  if(current)target.hunks.push(current);
  if(!target.hunks.length)patchError('Every update must contain at least one @@ hunk.');
  for(const h of target.hunks){
   if(!h.oldLines.length)patchError('An insert-only hunk needs at least one unchanged context line. Use write_file for new files.');
   if(h.oldLines.join('\n')===h.newLines.join('\n'))
    patchError('An unchanged hunk was supplied; remove it or include the intended + / - lines.');
  }
 }
 if(!targets.length)patchError('No update files found.');
 return targets;
}
function normalizeToSource(lines:string[],eol:string){return lines.join(eol);}
function lineBoundedMatches(content:string,old:string,endOfFile:boolean):number[]{
 const matches:number[]=[];
 for(let offset=0;offset<=content.length-old.length;){
  const at=content.indexOf(old,offset);
  if(at<0)break;
  const end=at+old.length;
  const startOK=at===0||content[at-1]==='\n';
  const endOK=end===content.length||content[end]==='\n'||
   (content[end]==='\r'&&content[end+1]==='\n');
  const endAnchorOK=!endOfFile||end===content.length||
   content.slice(end).replace(/^\r?\n/,'')==='';
  if(startOK&&endOK&&endAnchorOK)matches.push(at);
  if(matches.length>1)break; // ambiguous, never pick the first one
  offset=at+1;
 }
 return matches;
}
export async function applyPatch(raw:unknown):Promise<ToolResult>{
 const a=PatchSchema.parse(raw),root=await rootPath(a.cwd),targets=parsePatch(a.input);
 const files: Array<{path:string;expected_sha256:string;edits:Array<{old_string:string;new_string:string;expected_replacements:number}>}>=[];
 let budget=0;
 for(const target of targets){
  checkCancelled();
  const file=await projectPath(root,target.relative);
  const data=await readBounded(file,8*1024*1024);
  budget+=data.length;
  if(budget>16*1024*1024)throw new AgentError('PATCH_TOO_LARGE','Total patch target bytes exceed 16 MiB. No changes written.');
  const original=decodeCode(data);
  const eol=original.includes('\r\n')?'\r\n':'\n';
  let current=original;
  const edits:Array<{old_string:string;new_string:string;expected_replacements:number}>=[];
  for(let index=0;index<target.hunks.length;index++){
   checkCancelled();
   const hunk=target.hunks[index];
   const old=normalizeToSource(hunk.oldLines,eol);
   const replacement=normalizeToSource(hunk.newLines,eol);
   const matches=lineBoundedMatches(current,old,hunk.endOfFile);
   if(matches.length!==1)throw new AgentError('PATCH_CONTEXT_MISMATCH',
     'File '+target.relative+', hunk '+(index+1)+': expected one exact whole-line context, found '+
       (matches.length>1?'multiple':matches.length)+'. No patch files were written. Re-read the current file and add unique surrounding lines.');
   const at=matches[0];
   current=current.slice(0,at)+replacement+current.slice(at+old.length);
   if(Buffer.byteLength(current,'utf8')>8*1024*1024)
    throw new AgentError('PATCH_TOO_LARGE','Patch would produce a file over 8 MiB; no files were written.');
   edits.push({old_string:old,new_string:replacement,expected_replacements:1});
  }
  files.push({path:file,expected_sha256:sha256(data),edits});
 }
 // Revalidate the hashes after acquiring sorted file locks inside edit_files;
 // every write is atomic with conflict-aware rollback on failure.
 await workerCoordinator.guardFileMutation('edit_files',{files,dryRun:a.dryRun});
 const result=await CODING_TOOL_HANDLERS.edit_files({files,dryRun:a.dryRun});
 return {...result,structuredContent:{...result.structuredContent,
  patchFormat:'context-checked-existing-files',hunks:files.reduce((n,f)=>n+f.edits.length,0),
  supportedOperations:['Update File'],validatedFullPatchBeforeWriting:true}};
}
export const PATCH_TOOL_HANDLERS:Record<string,(args:Record<string,unknown>)=>Promise<ToolResult>>={
 apply_patch:applyPatch
};
export function buildPatchToolDefinitions():ToolDefinition[]{
 return [{name:'apply_patch',
  description:'Apply a DeepSeek/Codex-style *** Begin Patch with one or more *** Update File: relative/path and @@ hunks. Requires explicit context lines (space prefix), removed lines (-), added lines (+). Entire multi-file patch is syntax-checked, every hunk must match one unique whole-line context in a current saved UTF-8 file, and all source SHA-256 hashes are checked again under locks before any writes. Per-file atomic replacement; best-effort rollback on later commit failure; not crash-atomic. Only existing-file Update operations are supported; use write_file, delete_file or move_file for other operations. dryRun previews without mutations. No fuzzy replacements, model calls, shell execution, or new external dependencies.',
  inputSchema:zodToJsonSchema(PatchSchema),
  annotations:{title:'Context-checked code patch',readOnlyHint:false,destructiveHint:true}}];
}
