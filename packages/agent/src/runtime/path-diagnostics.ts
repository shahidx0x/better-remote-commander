/** Safe, bounded hints for missing files. Never traverses outside permitted roots,
 * never reads candidate file contents and never creates missing files.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type {ToolResult} from 'brc-shared';
import {validatePath} from '../core/tools/filesystem.js';
import {AgentError,failure} from './errors.js';
export interface MissingPathHints{
 requestedPath:string;nearestExistingDirectory:string|null;
 suggestions:string[];scannedEntries:number;limited:boolean;
 action:'inspect_parent_or_search';automaticCreation:false;
}
function distance(a:string,b:string):number{
 // Small bounded Levenshtein to rank obvious filename typos only.
 if(a.length>100||b.length>100)return 999;
 const prev=Array.from({length:b.length+1},(_,i)=>i);
 for(let i=1;i<=a.length;i++){
  const next=[i];
  for(let j=1;j<=b.length;j++)
   next[j]=Math.min(next[j-1]+1,prev[j]+1,prev[j-1]+(a[i-1]===b[j-1]?0:1));
  for(let j=0;j<next.length;j++)prev[j]=next[j];
 }
 return prev[b.length];
}
export async function diagnoseMissingPath(input:string):Promise<MissingPathHints|null>{
 let target:string;
 try{target=await validatePath(input);}catch{return null;}
 const desired=path.basename(target).toLowerCase();
 let parent=path.dirname(target),steps=0;
 while(steps++<15){
  try{
   const st=await fs.lstat(parent);
   if(st.isDirectory()&&!st.isSymbolicLink())break;
  }catch{}
  const next=path.dirname(parent);
  if(next===parent)return null;
  parent=next;
  try{await validatePath(parent);}catch{return null;}
 }
 let handle:import('node:fs').Dir;
 try{handle=await fs.opendir(parent,{bufferSize:32});}catch{return null;}
 const candidates:{name:string;score:number}[]=[];
 let scanned=0,limited=false;
 try{
  for await(const item of handle){
   if(++scanned>256){limited=true;break;}
   if(item.isSymbolicLink())continue;
   const low=item.name.toLowerCase();
   const score=low===desired?0:low.startsWith(desired)||desired.startsWith(low)?1:
    distance(low,desired)<=3?2:999;
   if(score<999)candidates.push({name:item.name,score});
  }
 }finally{await handle.close().catch(()=>{});}
 candidates.sort((a,b)=>a.score-b.score||a.name.localeCompare(b.name));
 const suggestions:string[]=[];
 for(const item of candidates.slice(0,8)){
  const file=path.join(parent,item.name);
  try{const validated=await validatePath(file);suggestions.push(validated);}
  catch{/* excluded by allowed directory policy */}
  if(suggestions.length>=5)break;
 }
 return {requestedPath:target,nearestExistingDirectory:parent,
  suggestions,scannedEntries:Math.min(scanned,256),limited,
  action:'inspect_parent_or_search',automaticCreation:false};
}
export async function missingFileResponse(input:string):Promise<ToolResult>{
 const hints=await diagnoseMissingPath(input);
 const base=failure(new AgentError('ENOENT',
  'The requested path does not exist. No file was created or modified. Inspect the nearest permitted directory or search for the filename.'));
 const next=hints?{tool:'list_directory',args:{path:hints.nearestExistingDirectory??input,depth:1,limit:200}}:null;
 const readable=hints?('\nNEAREST_ALLOWED_DIRECTORY: '+hints.nearestExistingDirectory+
  (hints.suggestions.length?'\nPOSSIBLE_FILENAMES: '+hints.suggestions.map(s=>JSON.stringify(s)).join(', '):'\nNO_CLOSE_FILENAME_FOUND')+
  '\nNEXT: list_directory('+JSON.stringify(next!.args)+')'+
  (hints.limited?'\nNOTE: filename suggestions cover only the first 256 entries; use start_search for wider discovery.':'')):
  '\nNEXT: Use list_directory or start_search(searchType:"files") with an authorized existing root.';
 return {...base,content:[{type:'text',text:base.content.map(c=>c.type==='text'?c.text:'').join('\n')+readable}],
  structuredContent:{...base.structuredContent,
  ...(hints?{pathRecovery:hints,next}:{})}};
}
