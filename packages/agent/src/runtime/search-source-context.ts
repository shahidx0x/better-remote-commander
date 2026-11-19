/** Fresh, bounded source context for results from the *same* ripgrep search.
 * No second search, no cached source text, no edits and no model calls.
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import {validatePath} from '../core/tools/filesystem.js';
import {readBounded,sha256,decodeCode} from './file-safety.js';
import {checkCancelled} from '../context.js';

interface Match {type:string;file:string;line?:number;isContext?:boolean}
export interface SearchSourceSnippet {
 path:string;sourceSha256?:string;matchLines:number[];
 startLine?:number;endLine?:number;text?:string;totalLines?:number;
 status:'fresh'|'too_large'|'unavailable'|'changed_since_search';
}
const FILE_CAP=512*1024,MAX_FILES=4,MAX_MATCH_LINES=5,MAX_SNIPPET_CHARS=1800;
export async function hydrateSearchSources(
 rootPath:string,results:Match[],recorded:Map<string,string> = new Map()
):Promise<{files:SearchSourceSnippet[];limited:boolean;fetched:number}>{
 const root=await validatePath(rootPath);
 const realRoot=await fs.realpath(root);
 const grouped=new Map<string,number[]>();
 for(const hit of results){
  if(hit.type!=='content'||hit.isContext||!Number.isInteger(hit.line)||hit.line! < 1)continue;
  const full=path.resolve(root,hit.file);
  const rel=path.relative(root,full);
  if(rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))continue;
  const existing=grouped.get(full);
  if(existing){if(existing.length<MAX_MATCH_LINES&&!existing.includes(hit.line!))existing.push(hit.line!);}
  else if(grouped.size<MAX_FILES)grouped.set(full,[hit.line!]);
 }
 const files:SearchSourceSnippet[]=[];
 for(const [filename,matchLines] of grouped){
  checkCancelled();
  try{
   const valid=await validatePath(filename);
   const actual=await fs.realpath(valid);
   const relative=path.relative(realRoot,actual);
   if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))
    throw new Error('SOURCE_OUTSIDE_PROJECT');
   const stat=await fs.lstat(valid);
   if(!stat.isFile()||stat.isSymbolicLink())throw new Error('UNSAFE_FILE');
   if(stat.size>FILE_CAP){files.push({path:valid,matchLines,status:'too_large'});continue;}
   const data=await readBounded(valid,FILE_CAP);
   const lines=decodeCode(data).split(/\r?\n/);
   const start=Math.max(1,Math.min(...matchLines)-2),end=Math.min(lines.length,Math.max(...matchLines)+3);
   const original=lines.slice(start-1,end).map((line,i)=>String(start+i)+': '+line).join('\n');
   const expected=recorded.get(filename);
   files.push({path:valid,sourceSha256:sha256(data),matchLines,
    startLine:start,endLine:end,totalLines:lines.length,
    text:original.slice(0,MAX_SNIPPET_CHARS),
    status:expected!==undefined&&expected!==sha256(data)?'changed_since_search':'fresh'});
  }catch{files.push({path:filename,matchLines,status:'unavailable'});}
 }
 const distinct=new Set(results.filter(h=>h.type==='content'&&!h.isContext).map(h=>path.resolve(root,h.file))).size;
 return {files,limited:distinct>grouped.size,fetched:files.filter(f=>f.status==='fresh').length};
}
