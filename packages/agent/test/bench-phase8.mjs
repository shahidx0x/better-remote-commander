// Read-only tool discovery footprint, consistent across baseline and optimized builds.
import {listTools} from '../dist/dispatcher.js';
import {Buffer} from 'node:buffer';
import {compactDuplicatedToolText} from '../dist/runtime/result-presentation.js';
import {boundedAgentFrame} from '../dist/transport/result-budget.js';
import {deferredToolDefinitions} from '../dist/runtime/deferred-tool-catalog.js';
const defs=listTools();
const sizes=defs.map(t=>({name:t.name,description:t.description.length,
  metadata:Buffer.byteLength(JSON.stringify(t),'utf8')}));
const sorted=sizes.map(x=>x.description).sort((a,b)=>a-b);
const percentile=p=>sorted[Math.max(0,Math.ceil(sorted.length*p)-1)]??0;
const report={toolCount:defs.length,descriptionsChars:sizes.reduce((n,x)=>n+x.description,0),
  metadataBytes:Buffer.byteLength(JSON.stringify(defs),'utf8'),
  p50DescriptionChars:percentile(.5),p95DescriptionChars:percentile(.95),
  maxDescriptionChars:sorted.at(-1)??0,
  largestMetadata:sizes.sort((a,b)=>b.metadata-a.metadata).slice(0,5)};
console.log('PHASE8_TOOL_DISCOVERY='+JSON.stringify(report));

const data={references:Array.from({length:170},(_,i)=>({
 path:'src/module-'+i+'.ts',hash:'f'.repeat(64),line:i+1,
 matches:['one','two','three']})),partial:false};
const original={content:[{type:'text',text:JSON.stringify(data,null,2)}],
 structuredContent:data,isError:false};
const compact=compactDuplicatedToolText(original);
const before=Buffer.byteLength(boundedAgentFrame({type:'result',id:'fixture',result:original}).encoded,'utf8');
const after=Buffer.byteLength(boundedAgentFrame({type:'result',id:'fixture',result:compact}).encoded,'utf8');
console.log('PHASE8_DUPLICATE_RESULT='+JSON.stringify({synthetic:true,beforeBytes:before,
 afterBytes:after,reductionPercent:Number(((1-after/before)*100).toFixed(1)),
 retainsStructuredContent:JSON.stringify(original.structuredContent)===JSON.stringify(compact.structuredContent)}));

const deferred=deferredToolDefinitions();
console.log('PHASE8_AGENT_DEFERRED='+JSON.stringify({tools:deferred.length,
 metadataBytes:Buffer.byteLength(JSON.stringify(deferred),'utf8'),
 rawCatalogBytes:Buffer.byteLength(JSON.stringify(defs),'utf8'),
 compatibleWithExistingRelayCatalog:false,
 note:'Only the agent-sent catalog shrinks; current relay still merges its fixed MCP catalog.'}));
