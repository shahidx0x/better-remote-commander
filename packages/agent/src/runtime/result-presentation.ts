import type {ToolResult} from 'brc-shared';

/** Compact-by-default text projection for structured MCP results.
 * No source/result data is dropped from structuredContent. This affects only
 * the duplicate human-readable text representation and is disabled by default.
 */
const THRESHOLD=2048,MAX_SUMMARY=640;
export const resultPresentationMode=()=>['legacy','0'].includes(process.env.BRC_RESULT_TEXT_MODE??'')?'legacy':'compact';
export const resultPresentationStatus=()=>({
 mode:resultPresentationMode(),compactAboveChars:THRESHOLD,
 structuredContentPreserved:true,deduplication:resultDeduplicationStatus(),
 compatibility:'compact mode is the default and preserves structuredContent; set BRC_RESULT_TEXT_MODE=legacy for text-only clients.'
});
export function renderResultText(data:Record<string,unknown>):string{
 if(resultPresentationMode()!=='compact')return JSON.stringify(data,null,2);
 const encoded=JSON.stringify(data);
 if(encoded.length<=THRESHOLD)return JSON.stringify(data,null,2);
 const keys=Object.keys(data).slice(0,16).map(k=>k.slice(0,42));
 const error=data.error as {code?:unknown;message?:unknown}|undefined;
 const errCode=typeof error?.code==='string'?error.code.slice(0,80):undefined;
 const errText=typeof error?.message==='string'?error.message.slice(0,240):undefined;
 const summary=[
  '[BRC] Full result is available in structuredContent; the duplicate text view is compact.',
  'Fields: '+keys.join(', ')+(Object.keys(data).length>keys.length?' (more)':''),
  'Full structured JSON chars: '+encoded.length,
  ...(errCode?['Error code: '+errCode]:[]),
  ...(errText?['Error: '+errText]:[]),
 ].join('\\n');
 return summary.slice(0,MAX_SUMMARY);
}

/** Custom tools sometimes return the SAME large JSON twice: once as a text
 * block, and again as structuredContent. Compact only a proven exact JSON
 * duplicate. Search/file/log human-readable text stays untouched because its
 * structuredContent commonly contains only pagination metadata.
 *
 * This never changes isError, non-text blocks, schemas, _meta, or the full
 * structured result. Text-only MCP clients can set BRC_RESULT_TEXT_MODE=legacy.
 */
const dedupeStats={inspected:0,rewritten:0,avoidedTextChars:0};
export function compactDuplicatedToolText<T extends ToolResult>(out:T):T{
 if(resultPresentationMode()!=='compact'||!out.structuredContent||
    out.content?.length!==1)return out;
 const block=out.content[0];
 if(block?.type!=='text'||typeof block.text!=='string')return out;
 const original=block.text;
 if(original.length<=THRESHOLD||original.length>1024*1024 ||
    !/^\s*[\{\[]/.test(original))return out;
 let compact:string;
 try{compact=JSON.stringify(out.structuredContent);}catch{return out;}
 if(!compact||compact.length<=THRESHOLD)return out;
 dedupeStats.inspected++;
 let same=original.trim()===compact;
 if(!same){
  try{
   const decoded:unknown=JSON.parse(original);
   same=JSON.stringify(decoded)===compact;
  }catch{return out;}
 }
 if(!same)return out;
 const view=renderResultText(out.structuredContent);
 if(view.length>=original.length)return out;
 dedupeStats.rewritten++;
 dedupeStats.avoidedTextChars+=original.length-view.length;
 return {...out,content:[{...block,text:view}]} as T;
}
export function resultDeduplicationStatus(){
 return {...dedupeStats,retainsStructuredContent:true,
  rule:'Only redundant JSON text matching structuredContent is compacted; independent text and media remain unchanged.'};
}
