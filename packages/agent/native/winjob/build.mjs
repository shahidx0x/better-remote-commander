/** Optional native process-containment build, entirely inside packages/agent.
 * On unsupported machines the TS agent still builds with explicitly disclosed
 * best-effort fallback. No runtime download or package installation.
 */
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const sourceDir=path.dirname(fileURLToPath(import.meta.url));
if(process.platform==='win32'){
 const check=spawnSync('dotnet',['--version'],{windowsHide:true,timeout:7000,encoding:'utf8'});
 if(check.error||check.status!==0){
  if(process.env.BRC_REQUIRE_WIN_JOB==='1')
   throw new Error('BRC native Windows Job runner requires a local .NET SDK.');
  console.warn('[BRC] .NET SDK unavailable; native Windows Job helper not built. Weaker subprocess containment will be reported.');
 }else{
  const dest=path.resolve(sourceDir,'../../dist/native/winjob');
  const build=spawnSync('dotnet',['build',path.join(sourceDir,'BrcWinJob.csproj'),
   '-c','Release','-o',dest,'--nologo','-v:q','-p:NuGetAudit=false'],{
    windowsHide:true,encoding:'utf8',timeout:120000,env:{
      ...process.env,DOTNET_CLI_TELEMETRY_OPTOUT:'1',DOTNET_NOLOGO:'1'
    }
   });
  if(build.stdout)process.stdout.write(build.stdout);
  if(build.stderr)process.stderr.write(build.stderr);
  if(build.error||build.status!==0)
   throw new Error('BRC native Windows Job helper build failed. The agent build is not verified.');
 }
}
