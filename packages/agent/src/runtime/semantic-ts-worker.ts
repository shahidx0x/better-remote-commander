/** Child process for opt-in TypeScript/JavaScript semantic navigation.
 * Never runs project scripts, installs packages, writes files or calls a model.
 * Parent enforces filesystem policy and the per-project/heap/time limits.
 */
import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';

interface Query {
  id:number;root:string;file:string;line:number;column:number;
  symbol:string;maxResults:number;
}
interface Reference {
  file:string;line:number;column:number;endLine:number;endColumn:number;
  isDefinition:boolean;
}
let languageService:ts.LanguageService|undefined;
let activeRoot='',projectFiles:string[]=[];
let coverageTruncated=false;
const MAX_FILES=400,MAX_SOURCE_BYTES=16*1024*1024;
const inside=(root:string,p:string)=>{
 const r=path.relative(root,p);
 return r===''||(r!=='..'&&!r.startsWith('..'+path.sep)&&!path.isAbsolute(r));
};
const pathSafe=(root:string,file:string)=>{
 try{return inside(root,fs.realpathSync(file));}
 catch{return false;}
};
function createService(root:string,file:string){
 if(languageService&&activeRoot===root)return;
 languageService?.dispose();languageService=undefined;
 const conf=ts.findConfigFile(root,ts.sys.fileExists,'tsconfig.json')??
  ts.findConfigFile(root,ts.sys.fileExists,'jsconfig.json');
 let files:string[]=[],opts:ts.CompilerOptions={
   target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.NodeNext,
   moduleResolution:ts.ModuleResolutionKind.NodeNext,
   allowJs:true,checkJs:false,skipLibCheck:true,noEmit:true
 };
 if(conf){
  const read=ts.readConfigFile(conf,ts.sys.readFile);
  if(read.error)throw Error('SEMANTIC_CONFIG_ERROR');
  const parsed=ts.parseJsonConfigFileContent(read.config,ts.sys,path.dirname(conf),undefined,conf);
  opts={...parsed.options,noEmit:true,skipLibCheck:true};
  files=parsed.fileNames;
 }else{
  files=ts.sys.readDirectory(root,['.ts','.tsx','.js','.jsx','.mts','.cts','.mjs','.cjs'],
   ['**/node_modules','**/.git','**/dist','**/.next','**/build','**/coverage'],['**/*'],6);
 }
 const allowed=(p:string)=>/\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/.test(p)&&inside(root,p)&&pathSafe(root,p);
 files=files.filter(allowed);
 const same=(a:string,b:string)=>process.platform==='win32'?path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase():path.resolve(a)===path.resolve(b);
 const included=files.some(x=>same(x,file));
 const sorted=[file,...files.filter(x=>!same(x,file))];
 let bytes=0;
 projectFiles=[];
 for(const name of sorted){
  try{
   const stat=fs.statSync(name);
   if(stat.size>1024*1024)continue;
   if(bytes+stat.size>MAX_SOURCE_BYTES)break;
   projectFiles.push(name);bytes+=stat.size;
   if(projectFiles.length>=MAX_FILES)break;
  }catch{}
 }
 coverageTruncated=files.length+Number(!included)>projectFiles.length;
 if(!projectFiles.includes(file))throw Error('SEMANTIC_INPUT_TOO_LARGE');
 const host:ts.LanguageServiceHost={
   getScriptFileNames:()=>projectFiles,
   getScriptVersion:(name:string)=>{
    try{const s=fs.statSync(name);return s.size+':'+s.mtimeMs+':'+s.ctimeMs;}
    catch{return 'deleted';}
   },
   getScriptSnapshot:(name:string)=>{
    const contents=ts.sys.readFile(name);
    return contents===undefined?undefined:ts.ScriptSnapshot.fromString(contents);
   },
   getCurrentDirectory:()=>root,
   getCompilationSettings:()=>opts,
   getDefaultLibFileName:(o)=>ts.getDefaultLibFilePath(o),
   fileExists:ts.sys.fileExists,
   readFile:ts.sys.readFile,
   readDirectory:ts.sys.readDirectory,
   directoryExists:ts.sys.directoryExists,
   getDirectories:ts.sys.getDirectories,
   useCaseSensitiveFileNames:()=>ts.sys.useCaseSensitiveFileNames,
   realpath:ts.sys.realpath,
 };
 languageService=ts.createLanguageService(host,ts.createDocumentRegistry());
 activeRoot=root;
}
function location(root:string,file:string,start:number,length:number,isDefinition:boolean):Reference|null{
 if(!pathSafe(root,file))return null;
 const relative=path.relative(root,file).replace(/\\/g,'/');
 const source=languageService?.getProgram()?.getSourceFile(file);
 if(!source)return null;
 const from=source.getLineAndCharacterOfPosition(start);
 const end=source.getLineAndCharacterOfPosition(start+length);
 return {file:relative,line:from.line+1,column:from.character+1,
  endLine:end.line+1,endColumn:end.character+1,isDefinition};
}
function query(request:Query){
 const {root,file,line,column,symbol,maxResults}=request;
 if(!path.isAbsolute(root)||!path.isAbsolute(file)||!inside(root,file)||!pathSafe(root,file))
  throw Error('SEMANTIC_PATH_DENIED');
 const contents=fs.readFileSync(file,'utf8');
 if(Buffer.byteLength(contents)>1024*1024)throw Error('SEMANTIC_INPUT_TOO_LARGE');
 const source=ts.createSourceFile(file,contents,ts.ScriptTarget.Latest,true);
 if(line<1||line>source.getLineAndCharacterOfPosition(contents.length).line+1)
  throw Error('SEMANTIC_INVALID_POSITION');
 let pos=source.getPositionOfLineAndCharacter(line-1,column-1);
 const isWord=(c:string)=>/^[A-Za-z0-9_$]$/.test(c);
 if(!isWord(contents[pos]??'')&&pos>0&&isWord(contents[pos-1]??''))pos--;
 let start=pos,end=pos;
 while(start>0&&isWord(contents[start-1]))start--;
 while(end<contents.length&&isWord(contents[end]))end++;
 if(contents.slice(start,end)!==symbol)throw Error('SEMANTIC_SYMBOL_MISMATCH');
 createService(root,file);
 const refs=languageService!.getReferencesAtPosition(file,pos)??[];
 const defs=languageService!.getDefinitionAtPosition(file,pos)??[];
 const seen=new Set<string>();
 const mapped:Reference[]=[];
 for(const item of refs){
  const resolved=location(root,item.fileName,item.textSpan.start,item.textSpan.length,false);
  if(!resolved)continue;
  const id=resolved.file+':'+resolved.line+':'+resolved.column;
  if(seen.has(id))continue;
  seen.add(id);mapped.push(resolved);
 }
 const definitions:Reference[]=[];
 for(const item of defs){
  const resolved=location(root,item.fileName,item.textSpan.start,item.textSpan.length,true);
  if(resolved)definitions.push(resolved);
 }
 const matched=mapped.slice(0,maxResults);
 return {file:path.relative(root,file).replace(/\\/g,'/'),symbol,
  references:matched,definitions:definitions.slice(0,20),
  totalReferences:mapped.length,truncated:coverageTruncated||mapped.length>maxResults,
  sourceFilesLoaded:projectFiles.length,projectFilesTruncated:coverageTruncated,
  semantics:'typescript-language-service: semantic bindings limited to bounded saved project sources; no unsaved editor buffers or guarantee of complete project coverage.',
  modelCalls:0,execution:false};
}
process.on('message',(input:unknown)=>{
 const req=input as Query;
 if(!req||typeof req.id!=='number')return;
 try{
  const output=query(req);
  process.send?.({id:req.id,ok:true,data:output});
 }catch(err){
  const message=err instanceof Error?err.message:'SEMANTIC_QUERY_FAILED';
  process.send?.({id:req.id,ok:false,error:message.slice(0,250)});
 }
});
process.on('disconnect',()=>{languageService?.dispose();process.exit(0);});
