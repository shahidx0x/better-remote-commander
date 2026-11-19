/** Observe and terminate MCP SDK-owned local stdio children.
 *
 * This adapter is deliberately confined to the installed MCP SDK's current
 * StdioClientTransport. The SDK exposes a public pid but not a ChildProcess
 * handle; inspect the runtime _process only after start() resolves. Fail
 * closed if the expected handle is absent instead of claiming ownership.
 *
 * NOT a Windows Job Object: the plugin may run briefly before observation.
 * Native containment and descendant quiescence remain separate work.
 */
import type {ChildProcess} from 'node:child_process';
import type {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {observeManagedChild,stopManagedChild,markNativeJobOwner} from '../runtime/process-termination.js';

export interface StdioOwnership {
  readonly pid:()=>number|null;
  /** Requests best-effort tree termination of the original owned process. */
  readonly stop:()=>boolean;
}

/** Install before client.connect() so the SDK's start path is intercepted. */
export function attachManagedStdio(transport:StdioClientTransport,nativeJob=false):StdioOwnership {
  const sdkStart=transport.start.bind(transport);
  let child:ChildProcess|undefined;
  let stopWhenStarted=false;

  const inspect=():ChildProcess|undefined=>{
    const candidate=(transport as unknown as {_process?:ChildProcess})._process;
    if(!candidate || typeof candidate.once!=='function' ||
       !Number.isSafeInteger(candidate.pid) || (candidate.pid??0)<1)return;
    child=candidate;
    if(nativeJob)markNativeJobOwner(candidate);
    else observeManagedChild(candidate);
    return candidate;
  };
  transport.start=async()=>{
    try {
      await sdkStart();
    }catch(error){
      // A failed SDK start may still have spawned a child. Do not silently
      // leave it running when client.connect rejects before initialization.
      if(inspect())stopManagedChild(child!);
      throw error;
    }
    if(!inspect()){
      await transport.close().catch(()=>{});
      throw new Error('PLUGIN_PROCESS_UNOBSERVABLE: MCP SDK did not expose an owned local process.');
    }
    if(stopWhenStarted){
      stopManagedChild(child!);
      throw new Error('PLUGIN_START_CANCELLED: plugin startup was stopped before it completed.');
    }
  };
  return {
    pid:()=>child?.pid??null,
    stop:()=>{
      stopWhenStarted=true;
      return child?stopManagedChild(child):false;
    }
  };
}
