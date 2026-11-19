/** Deterministic lexical routing benchmark, NOT a model selection benchmark. */
import {listTools} from '../dist/dispatcher.js';
import {discoverNativeTools} from '../dist/runtime/deferred-tool-catalog.js';
const cases=[
 ['read several known files together','read_multiple_files'],
 ['search a repository for unknown file names','start_search'],
 ['run a one-shot build command and check the exit code','run_command'],
 ['make a precise exact text replacement in one file','edit_block'],
 ['inspect git working tree changes and staging','git_status'],
 ['review the actual modified git hunks','git_diff'],
 ['read more output from an existing running process','read_process_output'],
 ['inspect the agent status and operations','agent_status'],
 ['read source code and full-file SHA-256 for safe edits','read_code_file'],
 ['list entries in a known directory','list_directory'],
 ['read a source code declaration by name','read_symbol'],
 ['show currently running background jobs','list_jobs'],
 ['execute checks discovered from a project manifest','run_project_checks'],
 ['preview coordinated edits across several source files','workspace_batch'],
];
const defs=listTools(),details=cases.map(([query,expected])=>{
 const got=discoverNativeTools({query,limit:8},defs);
 const ranks=got.tools.map(t=>t.name);
 return {query,expected,rank:ranks.indexOf(expected)+1,top3:ranks.slice(0,3)};
});
const stats={fixtureType:'deterministic lexical selection; not a model, no LLM call',
 scenarios:cases.length,top1Hits:details.filter(x=>x.rank===1).length,
 top3Hits:details.filter(x=>x.rank>0&&x.rank<=3).length,
 top8Hits:details.filter(x=>x.rank>0).length,
 toolRoundTrips:{directToolCall:1,deferredLookupPlusCall:2},
 hostCatalogActuallyReduced:false,details};
console.log('PHASE8_ROUTING_HEURISTIC='+JSON.stringify(stats));
