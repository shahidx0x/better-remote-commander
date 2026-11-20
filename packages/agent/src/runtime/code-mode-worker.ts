/**
 * QuickJS/WASM Code Mode guest. This worker is trusted infrastructure; the
 * model-authored program runs ONLY inside QuickJS, with no Node globals,
 * module loader, filesystem, process, network, or native object handles.
 * The sole bridge is a JSON-only, parent-validated RPC function.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { getQuickJS } from 'quickjs-emscripten';

type RpcRequest = {type:'call'|'search'|'describe';name?:string;args?:unknown;query?:string};
type RpcReply = {ok:boolean;value?:unknown;error?:{code:string;message:string}};
type Incoming = {type:'reply';id:number;reply:RpcReply}|{type:'cancel'};
type Inputs = {source:string;deadline:number};

if (!parentPort) throw new Error('Code Mode worker requires a parent thread.');
const port=parentPort;
const input=workerData as Inputs;
const pending=new Map<number,{resolve:(value:RpcReply)=>void;reject:(error:Error)=>void}>();
// A guest can launch tools.call() without awaiting it. Never destroy the VM
// while its bridge promises are still live: JS_FreeRuntime can abort on them.
const inFlightGuestCalls=new Set<Promise<void>>();
let sequence=0;
let cancelled=false;

port.on('message',(message:Incoming)=>{
  if(message?.type==='cancel'){
    cancelled=true;
    for(const waiter of pending.values())waiter.reject(new Error('CODE_MODE_CANCELLED'));
    pending.clear();
  }else if(message?.type==='reply'){
    const waiter=pending.get(message.id);
    if(waiter){pending.delete(message.id);waiter.resolve(message.reply);}
  }
});

function rpc(request:RpcRequest):Promise<RpcReply>{
  if(cancelled||Date.now()>=input.deadline)
    return Promise.reject(new Error('CODE_MODE_CANCELLED'));
  const id=++sequence;
  return new Promise<RpcReply>((resolve,reject)=>{
    pending.set(id,{resolve,reject});
    port.postMessage({type:'rpc',id,request});
  });
}

function safeError(error:unknown):string{
  const value=error instanceof Error?error.message:String(error);
  return value.slice(0,900);
}

async function execute():Promise<unknown>{
  const vm=(await getQuickJS()).newContext();
  vm.runtime.setMemoryLimit(32*1024*1024);
  vm.runtime.setMaxStackSize(512*1024);
  vm.runtime.setInterruptHandler(()=>cancelled||Date.now()>=input.deadline);
  try {
    const bridge=vm.newFunction('__brcCodeModeRpc',requestHandle=>{
      // Extract the string BEFORE returning from the callback: QuickJS handles
      // provided as callback parameters are no longer valid asynchronously.
      const raw=vm.getString(requestHandle);
      const pendingResult=vm.newPromise();
      const settle=(reply:RpcReply)=>{
        if(!vm.alive)return;
        const handle=vm.newString(JSON.stringify(reply));
        pendingResult.resolve(handle);
        handle.dispose();
      };
      if(raw.length>512*1024){
        settle({ok:false,error:{code:'CODE_MODE_INPUT_LIMIT',message:'Tool arguments exceed 512 KiB.'}});
      }else{
        try{
          const request=JSON.parse(raw) as RpcRequest;
          const operation=rpc(request).then(settle,error=>settle({ok:false,error:{
            code:'CODE_MODE_BRIDGE_FAILED',message:safeError(error)}}));
          inFlightGuestCalls.add(operation);
          // Observe both outcomes without creating an unhandled rejection.
          void operation.then(()=>inFlightGuestCalls.delete(operation),
            ()=>inFlightGuestCalls.delete(operation));
        }catch(error){
          settle({ok:false,error:{code:'CODE_MODE_BRIDGE_FAILED',message:safeError(error)}});
        }
      }
      pendingResult.settled.then(()=>{
        if(vm.alive)vm.runtime.executePendingJobs();
      }).catch(()=>undefined);
      return pendingResult.handle;
    });
    bridge.consume(fn=>vm.setProp(vm.global,'__brcCodeModeRpc',fn));

    // Tools return a QuickJS Promise. The bridge resumes guest microtasks
    // after a local BRC tool completes; generated code uses await tools.call.
    const prelude=[
      'const __rpc = async function(request) {',
      ' const response = JSON.parse(await __brcCodeModeRpc(JSON.stringify(request)));',
      ' if (!response.ok) {',
      '   const e = new Error((response.error && response.error.code || "CODE_MODE_ERROR") + ": " + (response.error && response.error.message || "Tool operation failed"));',
      '   e.code = response.error && response.error.code || "CODE_MODE_ERROR";',
      '   throw e;',
      ' }',
      ' return response.value;',
      '};',
      'const tools = Object.freeze({',
      ' search(query) { return __rpc({type:"search",query}); },',
      ' describe(name) { return __rpc({type:"describe",name}); },',
      ' call(name,args={}) { return __rpc({type:"call",name,args}); }',
      '});',
    ].join('\n');

    const program='(async function(){\n"use strict";\n'+prelude+'\n'+input.source+'\n})()';
    const evaluation=vm.evalCode(program,'brc-code-mode.js');
    if(evaluation.error){
      const detail=vm.dump(evaluation.error) as {message?:unknown}|string;
      evaluation.error.dispose();
      throw new Error(typeof detail==='string'?detail:String(detail?.message??'Sandbox evaluation failed.'));
    }
    const promiseHandle=evaluation.value;
    try{
      // The bridge's deferred promises trigger executePendingJobs as each
      // host operation settles. resolvePromise then awaits the real final
      // guest value without polling or blocking the event loop.
      const awaiting=vm.resolvePromise(promiseHandle);
      // Start the guest async function even when no host RPC is called.
      // Later RPC completions wake the remaining microtasks automatically.
      vm.runtime.executePendingJobs();
      const settled=await awaiting;
      const unawaited=inFlightGuestCalls.size;
      if(unawaited){
        // A detached tools.call() promise can outlive the guest script. Drain
        // already-started host calls and guest microtasks before disposing the
        // QuickJS runtime; do not report a successful workflow prematurely.
        // Follow-on guest continuations may enqueue more calls as jobs run.
        // The parent owns the deadline and terminates a stuck worker. Never
        // call JS_FreeRuntime with unresolved QuickJS bridge promises.
        while(inFlightGuestCalls.size){
          await Promise.allSettled([...inFlightGuestCalls]);
          if(vm.alive)vm.runtime.executePendingJobs();
        }
        if(settled.error)settled.error.dispose();
        else settled.value.dispose();
        throw new Error('CODE_MODE_UNAWAITED_CALLS: '+unawaited+
          ' asynchronous bridge call(s) were not awaited. Use await tools.call(...) or await Promise.all(...). The started calls have settled; inspect their results before retrying writes.');
      }
      if(settled.error){
        const detail=vm.dump(settled.error) as {message?:unknown}|string;
        settled.error.dispose();
        throw new Error(typeof detail==='string'?detail:String(detail?.message??'Sandbox promise rejected.'));
      }
      try{return vm.dump(settled.value);}
      finally{settled.value.dispose();}
    }finally{promiseHandle.dispose();}
  }finally{
    vm.dispose();
  }
}

void execute().then(value=>{
  port.postMessage({type:'done',value});
}).catch(error=>{
  port.postMessage({type:'error',message:safeError(error)});
});
