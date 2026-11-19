/** Shared best-effort process-tree stop requests and owned-child lifecycle.
 * A requested stop, a root-process close, and complete descendant exit are
 * DIFFERENT facts. This is not a native Windows Job Object or sandbox.
 *
 * Child handles are tracked with a WeakMap; no arguments, environment, source
 * content, stdout or executable paths are retained here.
 */
import {spawn,type ChildProcess} from 'node:child_process';

export type ManagedTerminationState='not_requested'|'root_exit_observed'|'unconfirmed';
export function managedTerminationState(stopRequested:boolean,rootCloseObserved:boolean):ManagedTerminationState{
  return !stopRequested?'not_requested':rootCloseObserved?'root_exit_observed':'unconfirmed';
}

interface OwnedChild {
  closeObserved:boolean;
  stopRequested:boolean;
  spawnErrored:boolean;
  nativeJobOwner:boolean;
}
const owners=new WeakMap<ChildProcess,OwnedChild>();
const counters={active:0,peakActive:0,registered:0,closed:0,spawnErrors:0,
  stopRequests:0,duplicateStopRequests:0,stopRequestFailures:0};

/** Observe an actual ChildProcess, not a numeric PID that can be recycled.
 * Idempotent registration survives multiple callers on one child.
 */
export function observeManagedChild(child:ChildProcess):void{
  if(owners.has(child))return;
  const state:OwnedChild={closeObserved:false,stopRequested:false,spawnErrored:false,nativeJobOwner:false};
  owners.set(child,state);
  counters.active++;counters.registered++;
  counters.peakActive=Math.max(counters.peakActive,counters.active);
  const release=()=>{
    if(state.closeObserved)return;
    state.closeObserved=true;
    counters.active=Math.max(0,counters.active-1);counters.closed++;
  };
  child.once('close',release);
  child.once('error',()=>{
    if(!child.pid)state.spawnErrored=true;
    counters.spawnErrors++;
    // A failed spawn has no root PID. Some Node versions emit close after
    // error; releasing here avoids reporting a phantom active owner.
    if(!child.pid)release();
  });
}
export function markNativeJobOwner(child:ChildProcess):void{
  observeManagedChild(child);
  owners.get(child)!.nativeJobOwner=true;
}
export function managedChildStatus(){
  return {...counters,tracksArguments:false,tracksOutput:false,
    // Not every process uses the native provider (IPC/shell fallbacks).
    osJobObject:false,osJobObjectSupported:process.platform==='win32',
    // Native Job ownership exists per observed child, not for every legacy
    // subprocess. Job-empty certainty is reported only on natural exit by
    // the native runner; a forced stop must not imply completed side effects.
    descendantExitProven:false};
}
const hasLiveRoot=(child:ChildProcess,state:OwnedChild)=>{
  return !state.closeObserved && !state.spawnErrored &&
    typeof child.pid==='number' && child.pid>0 &&
    child.exitCode===null && child.signalCode===null;
};

/** Requests a best-effort process-tree stop once per owned child.
 * Never claims children or their side effects were rolled back.
 */
export function stopManagedChild(child:ChildProcess):boolean{
  observeManagedChild(child);
  const state=owners.get(child)!;
  if(state.stopRequested){counters.duplicateStopRequests++;return true;}
  if(!hasLiveRoot(child,state))return false;
  counters.stopRequests++;
  // A native runner holds a kill-on-close Job handle. Terminate ONLY its
  // original wrapper handle; Windows automatically kills contained children
  // without a second taskkill PID-based race or a new helper process.
  const nativeAccepted=state.nativeJobOwner?(()=>{try{return child.kill('SIGKILL');}catch{return false;}})():false;
  const accepted=nativeAccepted||requestProcessTreeStop(child.pid,()=>hasLiveRoot(child,state));
  if(accepted)state.stopRequested=true;
  else counters.stopRequestFailures++;
  return accepted;
}

/** Legacy PID-only stop request. Prefer stopManagedChild(child) when the
 * caller has the original ChildProcess to prevent duplicate kill attempts
 * and to guard delayed fallbacks against reused PIDs.
 */
export function requestProcessTreeStop(pid:number|undefined,stillOwned?:()=>boolean):boolean{
  if(!pid||!Number.isSafeInteger(pid)||pid<1)return false;
  if(stillOwned && !stillOwned())return false;
  if(process.platform==='win32'){
    let fallbackAttempted=false;
    const fallback=()=>{
      if(fallbackAttempted)return;
      fallbackAttempted=true;
      // Windows taskkill can race with a normally exiting root. With an
      // owned child, never issue a delayed fallback against a recycled PID.
      if(stillOwned && !stillOwned())return;
      try{process.kill(pid,'SIGKILL');}catch{}
    };
    try{
      const killer=spawn('taskkill',['/pid',String(pid),'/T','/F'],
        {windowsHide:true,stdio:'ignore'});
      killer.on('error',fallback);
      killer.on('close',code=>{if(code!==0)fallback();});
      return true;
    }catch{fallback();return true;}
  }
  try{process.kill(-pid,'SIGKILL');return true;}
  catch{
    if(stillOwned && !stillOwned())return false;
    try{process.kill(pid,'SIGKILL');return true;}catch{return false;}
  }
}
