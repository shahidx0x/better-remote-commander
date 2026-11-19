import {spawn} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const dir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../dist/native/winjob');
const dll=path.join(dir,'BrcWinJob.dll'),exe=path.join(dir,'BrcWinJob.exe');
const args=['--parent',String(process.pid),'--',process.execPath,'-e','process.stdout.write("ok")'];
const modes=[
 ['legacy',process.execPath,['-e','process.stdout.write("ok")']],
 ['dotnet-dll','dotnet',[dll,...args]],
 ['apphost-exe',exe,args]
];
async function measure(command,argv){
 const start=performance.now();
 const child=spawn(command,argv,{stdio:['ignore','pipe','pipe'],windowsHide:true});
 let stdout='',stderr='';
 child.stdout?.on('data',d=>stdout+=d);
 child.stderr?.on('data',d=>stderr+=d);
 const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve)});
 if(code!==0||stdout!=='ok')throw new Error('Invalid benchmark result '+command+' '+code+' '+stderr.slice(0,100));
 return performance.now()-start;
}
const rows={};
for(const [label,cmd,args] of modes){
 await measure(cmd,args);await measure(cmd,args);
 const timings=[];
 for(let i=0;i<12;i++)timings.push(await measure(cmd,args));
 const ordered=timings.sort((a,b)=>a-b);
 rows[label]={medianMs:+ordered[6].toFixed(1),p90Ms:+ordered[10].toFixed(1)};
}
console.log('APPHOST_BENCH='+JSON.stringify({fixture:'tiny Node child through identical kill-on-close Job Object; 12 runs per mode',...rows,
 deltaMs:+(rows['dotnet-dll'].medianMs-rows['apphost-exe'].medianMs).toFixed(1)}));
