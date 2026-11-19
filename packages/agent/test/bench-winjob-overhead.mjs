import {performance} from 'node:perf_hooks';
import {spawnManaged,managedSpawnStatus} from '../dist/runtime/managed-spawn.js';
const prior=process.env.BRC_WIN_JOB_OBJECT;
const run=async(native)=>{
 process.env.BRC_WIN_JOB_OBJECT=native?'1':'0';
 const start=performance.now();
 const child=spawnManaged(process.execPath,['-e','process.stdout.write("ok")'],
  {windowsHide:true,stdio:['ignore','pipe','pipe']});
 let output='';
 child.stdout?.on('data',x=>{output+=x.toString();});
 const code=await new Promise((resolve,reject)=>{
   child.once('error',reject);child.once('close',resolve);
 });
 if(code!==0||output!=='ok')throw new Error('Fixture process failed: '+code+'/'+output);
 return performance.now()-start;
};
try{
 await run(false);await run(true);
 const results={native:[],legacy:[]};
 for(let i=0;i<10;i++){
  results.native.push(await run(true));
  results.legacy.push(await run(false));
 }
 const median=arr=>[...arr].sort((a,b)=>a-b)[Math.floor(arr.length/2)];
 console.log('WINJOB_OVERHEAD='+JSON.stringify({
  runsPerMode:10,legacyMedianMs:+median(results.legacy).toFixed(1),
  nativeMedianMs:+median(results.native).toFixed(1),
  nativeMultiplier:+(median(results.native)/median(results.legacy)).toFixed(2),
  fixture:'single small Node executable output, not workload CPU/throughput',
  managedSpawnStatus:managedSpawnStatus()
 }));
}finally{
 if(prior===undefined)delete process.env.BRC_WIN_JOB_OBJECT;
 else process.env.BRC_WIN_JOB_OBJECT=prior;
}
