/** Safe, bounded per-tool outcome for the live detailed terminal.
 * Only allowlisted numeric/boolean/short status fields; no output or arguments.
 */
export function summarizeToolOutcome(tool:string,value:unknown):string|undefined{
  if(!value||typeof value!=='object')return;
  const response=value as Record<string,unknown>;
  if(!response.structuredContent||typeof response.structuredContent!=='object')return;
  const m=response.structuredContent as Record<string,unknown>;
  const notes:string[]=[];
  const n=(key:string,label:string,from=m)=>{
    const v=from[key];
    if(typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<1_000_000_000)
      notes.push(label+' '+v);
  };
  if(tool==='read_file'){
    const sub=m.read;
    if(sub&&typeof sub==='object'){
      const v=sub as Record<string,unknown>;
      n('returnedLines','lines',v);
      if(v.hasMoreLines===true||v.truncated===true)notes.push('more lines available');
    }
  } else if(tool==='read_code_file'){
    n('totalLines','total lines');
    if(m.truncated===true)notes.push('partial snapshot');
  } else if(tool==='code_mode'){
    n('completedCalls','nested calls');
    if(m.allCallsSucceeded===false)notes.push('some calls failed');
    if(m.pending===true)notes.push('jobs still running');
  } else if(tool==='run_parallel'){
    n('finished','finished');
    n('total','total');
    n('failed','failed');
    if(m.pending===true)notes.push('jobs still running');
  } else if(tool==='start_search'||tool==='get_more_search_results'){
    n('totalMatches','matches');
    if(m.isComplete===true)notes.push('search complete');
  } else if(tool==='get_job'||tool==='spawn_job'||tool==='wait_jobs'){
    const s=m.status;
    if(typeof s==='string'&&/^[a-z_]{1,24}$/.test(s))notes.push(s);
    const job=m.jobId;
    if(typeof job==='string'&&/^[A-Za-z0-9_-]{1,40}$/.test(job))notes.push('job '+job.slice(0,16));
  } else if(tool==='edit_block'){
    if(m.autoAlignedIndentation===true)notes.push('unique indentation aligned');
    if(m.autoRebasedFromStaleHash===true)notes.push('safe source hash rebase');
  } else if(tool==='write_file'){
    n('bytesWritten','bytes written');
  }
  if(!notes.length&&m.pending===true)notes.push('still running');
  return notes.slice(0,3).join(' | ')||undefined;
}
