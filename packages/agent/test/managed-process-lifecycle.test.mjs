// Real child-process lifecycle regression: no live agent, credentials or project writes.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {
  observeManagedChild,stopManagedChild,requestProcessTreeStop,
  managedChildStatus,managedTerminationState
} from '../dist/runtime/process-termination.js';

test('invalid PID does not issue a stop; root-close state is not descendant proof',()=>{
  assert.equal(requestProcessTreeStop(undefined),false);
  assert.equal(requestProcessTreeStop(-1),false);
  assert.equal(requestProcessTreeStop(1.5),false);
  assert.equal(managedTerminationState(true,false),'unconfirmed');
  assert.equal(managedTerminationState(true,true),'root_exit_observed');
  assert.equal(managedTerminationState(false,false),'not_requested');
  const state=managedChildStatus();
  assert.equal(state.osJobObject,false);
  assert.equal(state.descendantExitProven,false);
  assert.equal(state.tracksArguments,false);
  assert.equal(state.tracksOutput,false);
});

test('a failed child spawn releases ownership and never requests stop for a missing PID',async()=>{
  const before=managedChildStatus();
  const child=spawn('__brc_nonexistent_64fa2_executable__',[],{stdio:'ignore',windowsHide:true});
  observeManagedChild(child);
  // The owner observes errors, so Node does not crash on an unhandled spawn.
  await new Promise(resolve=>child.once('close',resolve));
  assert.equal(stopManagedChild(child),false);
  const after=managedChildStatus();
  assert.equal(after.active,before.active);
  assert.equal(after.spawnErrors,before.spawnErrors+1);
  assert.equal(after.stopRequests,before.stopRequests);
});

test('one owned-child stop request closes parent, prevents duplicate kill, and stops descendants',async()=>{
  const before=managedChildStatus();
  // The descendant is not detached from the parent process group.
  const code=`
    const {spawn}=require('node:child_process');
    const grandchild=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],
      {stdio:'ignore',windowsHide:true});
    console.log(String(grandchild.pid));
    setInterval(()=>{},1000);
  `;
  const child=spawn(process.execPath,['-e',code],{
    stdio:['ignore','pipe','pipe'],windowsHide:true,
    detached:process.platform!=='win32'
  });
  observeManagedChild(child);
  let descendantPid,rootClosed=false,descendantConfirmedDead=false;
  child.once('close',()=>{rootClosed=true;});
  try {
    descendantPid=await new Promise((resolve,reject)=>{
      let buffer='';
      const timer=setTimeout(()=>reject(new Error('child never reported descendant PID')),5000);
      const done=(fn,value)=>{clearTimeout(timer);fn(value);};
      child.stdout.on('data',part=>{
        buffer+=part.toString();
        const line=buffer.split(/\r?\n/)[0].trim();
        if(/^\d+$/.test(line))done(resolve,Number(line));
      });
      child.once('error',e=>done(reject,e));
      child.once('close',()=>done(reject,new Error('root exited before reporting its child')));
    });
    const closed=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('root process failed to close after stop')),7000);
      child.once('close',(...args)=>{clearTimeout(timer);resolve(args);});
    });
    assert.equal(stopManagedChild(child),true);
    assert.equal(stopManagedChild(child),true);
    await closed;
    await delay(200);
    const after=managedChildStatus();
    assert.equal(after.active,before.active);
    assert.equal(after.stopRequests,before.stopRequests+1);
    assert.equal(after.duplicateStopRequests,before.duplicateStopRequests+1);
    // Windows taskkill /T /F should terminate the direct grandchild too.
    // The parent-close event by itself is not proof; check its PID separately.
    if(process.platform==='win32'){
      let alive=true;
      for(let i=0;i<30;i++){
        try{process.kill(descendantPid,0);}catch{alive=false;break;}
        await delay(100);
      }
      descendantConfirmedDead=!alive;
      assert.equal(alive,false,'descendant remained alive after managed tree stop');
    }
  }finally{
    // Never signal a PID after the original root has already closed; the OS
    // may recycle it for an unrelated process.
    if(!rootClosed)requestProcessTreeStop(child.pid);
    if(descendantPid && process.platform==='win32' && !descendantConfirmedDead){
      try{process.kill(descendantPid,'SIGKILL');}catch{}
    }
  }
});
