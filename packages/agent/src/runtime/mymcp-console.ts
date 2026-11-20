/**
 * Screenshot-compatible remote-device console previews.
 * Matches Desktop Commander remote-device/device.ts:
 *   🔧 Received tool call <id>: <tool> <args> metadata: <meta>
 *   ✅ Tool call <tool> completed:\n <JSON result>
 *
 * These are LOCAL, ephemeral, redacted previews, not full MCP wire captures.
 * The historical tool-history JSONL has its own separate 4 KiB policy.
 */
import {redactTrace} from './tool-trace.js';
export const MYMCP_CONSOLE_PREVIEW_BYTES=4096;
export const MYMCP_ARGUMENT_PREVIEW_BYTES=2048;
type Input=Record<string,unknown>;
const ALLOWED_SCALARS=new Set([
  'path','file_path','cwd','program','command','destination','root',
  'directory','offset','length','depth','pattern','searchType','literalSearch',
  'include_hidden','maxResults','limit','page','id','ids','group','timeout_ms',
  'max_runtime_ms','max_calls','plugin','tool','shell','mode','pid','wait','query',
  'expected_replacements','expected_sha256','output_chars','step_limit',
]);
const SENSITIVE_FILE=/(?:^|[\\/])(?:\.env(?:\..*)?|id_(?:rsa|ed25519)|credentials?(?:\..*)?|secrets?(?:\..*)?|private[-_.]?key(?:\..*)?)(?:$|[\\/])|\.(?:pem|p12|pfx|key)$/i;
const SOURCE_BLOCKS=new Set(['code_mode','read_images','write_file','edit_block','apply_patch','edit_files']);
function text(value:unknown,max=900):string{
  if(typeof value!=='string')return '';
  return redactTrace(value,Math.max(120,Math.min(max,4096)));
}
function byteTrim(value:string,budget:number):string{
  const bytes=Buffer.from(value,'utf8');
  if(bytes.length<=budget)return value;
  const marker=' … [truncated]';
  const limit=Math.max(0,budget-Buffer.byteLength(marker));
  let s=bytes.subarray(0,limit).toString('utf8');
  while(Buffer.byteLength(s)>limit)s=s.slice(0,-1);
  return s+marker;
}
function safePathList(input:unknown):unknown{
  if(!Array.isArray(input))return '[structured value omitted]';
  const files:unknown[]=input.slice(0,20).map(item=>{
    if(typeof item==='string')return text(item,420);
    if(!item||typeof item!=='object'||Array.isArray(item))return '[entry omitted]';
    const x=item as Input;
    const picked:Input={};
    for(const key of ['path','offset','length','range','sheet']){
      const v=x[key];
      if(typeof v==='string')picked[key]=text(v,420);
      else if(typeof v==='number'&&Number.isFinite(v))picked[key]=v;
    }
    return picked;
  });
  if(input.length>20)files.push({moreFiles:input.length-20});
  return files;
}
/** Selected arguments only: scripts, patches, secrets and unknown keys omitted. */
export function mymcpCallPreview(tool:string,args:unknown,client?:{
  name?:string;version?:string
}|null,remote=false):string{
  const input=args&&typeof args==='object'&&!Array.isArray(args)?args as Input:{};
  const picked:Input={};
  for(const [key,val] of Object.entries(input)){
    if(key==='paths'||key==='files'){
      picked[key]=safePathList(val);
    }else if(key==='args'&&tool==='run_command'&&Array.isArray(val)){
      const isInline=val.some(s=>typeof s==='string'&&
        /^(?:-e|-c|--eval|--execute)$/i.test(s));
      picked[key]=isInline?'[inline script arguments omitted]':
        val.slice(0,12).map(s=>typeof s==='string'?text(s,160):'[value omitted]');
      if(val.length>12)picked.moreArgs=val.length-12;
    }else if(ALLOWED_SCALARS.has(key)){
      if(key==='command'&&typeof val==='string'){
        picked[key]=/[\r\n]|(?:^|\s)(?:-e|-c|--eval)(?=\s|=)|(?:;|&&|\|\|)|\$\{|\$\(/.test(val)
          ?'[inline/multi-command omitted]':text(val,240);
      }else if(key==='expected_sha256'){
        picked[key]='[hash omitted]';
      }else if(typeof val==='string')picked[key]=text(val,420);
      else if(typeof val==='number'||typeof val==='boolean')picked[key]=val;
      else if(Array.isArray(val))picked[key]=val.slice(0,10).map(v=>
        typeof v==='string'?text(v,120):'[entry omitted]');
    }else if(!['metadata','authorization','env','environment','content',
      'old_string','new_string','edits','patch','data','source','input'].includes(key)){
      picked.otherParameters=(Number(picked.otherParameters)||0)+1;
    }
  }
  const meta:Input={origin:remote?'remote':'local'};
  const name=client?.name;
  if(typeof name==='string')meta.client={name:text(name,80),
    ...(typeof client?.version==='string'?{version:text(client.version,40)}:{})};
  let call=JSON.stringify(picked);
  if(Buffer.byteLength(call)>MYMCP_ARGUMENT_PREVIEW_BYTES)
    call=JSON.stringify({preview:byteTrim(call,MYMCP_ARGUMENT_PREVIEW_BYTES-120),
      truncated:true});
  return call+' metadata: '+JSON.stringify(meta);
}
/** Binary payloads and high-risk source/edit bodies are not copied to logs. */
export function mymcpResultPreview(tool:string,result:unknown,args?:unknown):string{
  if(!result||typeof result!=='object')return '{"content":[],"status":"unavailable"}';
  const r=result as Input;
  const metadata=r.structuredContent&&typeof r.structuredContent==='object'?
    r.structuredContent as Input:{};
  const data:Input={};
  // Files can be passed as paths: string[] OR files: {path}[].
  // Do not print content of sensitive paths hidden inside batch entries.
  const hasPrivateFile=(value:unknown,depth=0):boolean=>{
    if(depth>3)return false;
    if(typeof value==='string')return SENSITIVE_FILE.test(value);
    if(Array.isArray(value))return value.some(v=>hasPrivateFile(v,depth+1));
    if(value&&typeof value==='object'){
      const record=value as Input;
      return ['path','file_path','paths','files'].some(key=>
        hasPrivateFile(record[key],depth+1));
    }
    return false;
  };
  const riskyFile=hasPrivateFile(args);
  const omit=SOURCE_BLOCKS.has(tool)||riskyFile;
  const resultBlocks=Array.isArray(r.content)?r.content:[];
  const items:{type:string;text:string}[]=resultBlocks.slice(0,2).map(block=>{
    if(!block||typeof block!=='object')return {type:'unknown',text:'[block omitted]'};
    const x=block as Input;
    const type=typeof x.type==='string'?x.type:'unknown';
    if(type!=='text')return {type,text:'[binary/media data omitted]'};
    const source=typeof x.text==='string'?x.text:'';
    return {type:'text',text:omit?
      '[source/script content omitted from console preview; caller receives full result]':
      byteTrim(redactTrace(source,3200),3200)};
  });
  if(resultBlocks.length>2)items.push({type:'text',
    text:'['+(resultBlocks.length-2)+' additional blocks omitted]'});
  data.content=items;
  if(r.isError===true)data.isError=true;
  if(metadata.pending===true)data.pending=true;
  const safeMeta:Input={};
  for(const key of ['exitCode','durationMs','totalLines','totalMatches','completedCalls',
    'pending','outputTruncated','status','jobId','commandSucceeded']){
    const val=metadata[key];
    if(typeof val==='string')safeMeta[key]=text(val,100);
    else if(typeof val==='boolean'||typeof val==='number')safeMeta[key]=val;
  }
  const err=metadata.error;
  if(err&&typeof err==='object'){
    const x=err as Input;
    safeMeta.error={
      ...(typeof x.code==='string'?{code:text(x.code,80)}:{}),
      ...(typeof x.message==='string'?{message:text(x.message,300)}:{})
    };
  }
  if(Object.keys(safeMeta).length)data.structuredContent=safeMeta;
  let output=JSON.stringify(data);
  if(Buffer.byteLength(output)>MYMCP_CONSOLE_PREVIEW_BYTES){
    const preview=byteTrim(JSON.stringify(items),MYMCP_CONSOLE_PREVIEW_BYTES-320);
    output=JSON.stringify({content:[{type:'text',text:preview}],
      truncated:true,note:'Output preview capped at 4096 bytes; full result returned to caller.'});
  }
  return output;
}
