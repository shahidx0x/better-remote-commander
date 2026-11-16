import { Buffer } from 'node:buffer';
import type { AgentMessage } from 'brc-shared';

/** Keep one tool result substantially smaller than typical host message-stream limits.
 * Only tool result frames are changed: authentication, hello, pings and calls
 * retain their protocol behavior. This is a last-resort safety net.
 */
export const DEFAULT_RESULT_FRAME_BYTES = 512 * 1024;
export function maxResultFrameBytes(envValue=process.env.BRC_MAX_RESULT_BYTES):number {
  const requested=Number(envValue);
  return envValue && Number.isFinite(requested) && requested>=65536
    ? Math.min(DEFAULT_RESULT_FRAME_BYTES, Math.max(65536,Math.floor(requested)))
    : DEFAULT_RESULT_FRAME_BYTES;
}

export function boundedAgentFrame(msg:AgentMessage, maxBytes=maxResultFrameBytes()):{encoded:string;replaced:boolean} {
  try {
    const encoded=JSON.stringify(msg);
    if(msg.type!=='result'||Buffer.byteLength(encoded,'utf8')<=maxBytes)
      return {encoded,replaced:false};
  } catch (err) {
    if(msg.type!=='result') throw err;
  }
  if(msg.type!=='result') throw new Error('Unexpected non-result frame');
  // A mutation may have completed before its output became oversized.
  // Never return an unstructured success or automatically retry that mutation.
  const message='The tool result exceeds the agent response budget ('+maxBytes+
    ' bytes), or its result could not be encoded safely. The operation MAY already have completed. '+
    'For reads, request fewer files, pages, images, or a narrower line/character range. '+
    'For writes/commands, inspect the current files/job state BEFORE retrying. Do not replay an append blindly.';
  const fallback:AgentMessage={
    type:'result',id:msg.id,
    result:{
      isError:true,
      content:[{type:'text',text:'RESULT_TOO_LARGE: '+message}],
      structuredContent:{
        error:{code:'RESULT_TOO_LARGE',message,retryable:false},
        recovery:{automaticRetry:false,suggestion:'Request a smaller result; check for completed side effects before any retry.'},
        truncated:true,
      },
    },
  };
  return {encoded:JSON.stringify(fallback),replaced:true};
}
