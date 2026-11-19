import {performance} from 'node:perf_hooks';
import {managedLaunchSpec,managedSpawnStatus} from '../dist/runtime/managed-spawn.js';
const n=600;
const median=v=>{const s=[...v].sort((a,b)=>a-b);return s[Math.floor(s.length/2)]};
const batches=[];
for(let round=0;round<5;round++){
 const start=performance.now();
 for(let i=0;i<n;i++){
  const choice=managedLaunchSpec(process.execPath,[],{env:process.env});
  if(!choice.nativeJob)throw Error('Native Job not selected: '+choice.reason);
 }
 batches.push((performance.now()-start)*1000/n);
}
console.log('WINJOB_SELECTION_BENCH='+JSON.stringify({
 callsPerBatch:n,rounds:batches.length,medianMicrosecondsPerSelection:+median(batches).toFixed(1),
 samplesUs:batches.map(x=>+x.toFixed(1)),fixture:'native path/PE/dotnet preflight only, no command execution',
 managedSpawnCounters:managedSpawnStatus().nativeSpawns
}));
