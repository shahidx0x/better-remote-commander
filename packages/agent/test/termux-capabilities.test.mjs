import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isTermuxRuntime,availableOnTermux,platformCapabilities,reportedPlatform} from '../dist/runtime/platform-capabilities.js';

test('Android Bionic and Termux are recognized, normal desktop Linux is not',()=>{
  assert.equal(isTermuxRuntime('android',{}),true);
  assert.equal(isTermuxRuntime('linux',{PREFIX:'/data/data/com.termux/files/usr'}),true);
  assert.equal(isTermuxRuntime('linux',{TERMUX_VERSION:'0.119'}),true);
  assert.equal(isTermuxRuntime('linux',{PREFIX:'/usr/local'}),false);
  assert.equal(isTermuxRuntime('win32',{}),false);
  assert.equal(platformCapabilities('android',{}).termux,true);
  assert.equal(platformCapabilities('linux',{}).termux,false);
  assert.equal(reportedPlatform('linux',{TERMUX_VERSION:'1'}),'android');
  assert.equal(reportedPlatform('linux',{}),'linux');
  assert.equal(availableOnTermux('read_file'),true);
  for(const name of ['write_pdf','read_images','ast_search','ast_rewrite','docker_inventory','docker_inspect','sandbox_run'])
    assert.equal(availableOnTermux(name),false,name);
});

test('Termux tool catalogue hides incompatible tools, refuses calls and the service',()=>{
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
  const home=mkdtempSync(path.join(os.tmpdir(),'brc-termux-sim-'));
  try{
    const program=[
      "import {listTools,callTool,hasTool} from './packages/agent/dist/dispatcher.js';",
      "import {installService,uninstallService} from './packages/agent/dist/service.js';",
      "const names=listTools().map(t=>t.name);",
      "if(!names.includes('read_file')||!names.includes('workspace_batch'))throw Error('core tools missing');",
      "for(const name of ['read_images','write_pdf','docker_inventory','ast_search','sandbox_run'])if(names.includes(name)||hasTool(name))throw Error('unsafe tool advertised: '+name);",
      "const result=await callTool('read_images',{});",
      "if(result.structuredContent?.error?.code!=='UNSUPPORTED_ON_TERMUX')throw Error('wrong error for unavailable tool');",
      "for(const f of [()=>installService([]),uninstallService]){let m='';try{f()}catch(e){m=e.message}if(!/Termux/.test(m))throw Error('service not refused: '+m)}",
      "console.log('TERMUX_CAPABILITIES_PASS');",
      "process.exit(0);"
    ].join('\n');
    const run=env=>spawnSync(process.execPath,['--input-type=module','-e',program],{cwd:root,env:{...process.env,BRC_HOME:home,...env},encoding:'utf8',timeout:30000});
    const out=run({TERMUX_VERSION:'0.119'});
    assert.equal(out.status,0,'status='+out.status+' stdout='+out.stdout+' stderr='+out.stderr);
    assert.match(out.stdout,/TERMUX_CAPABILITIES_PASS/);
    // Without Termux markers the same program must fail on the first catalogue assertion.
    const desktop=run({TERMUX_VERSION:'',PREFIX:''});
    assert.notEqual(desktop.status,0);
  }finally{rmSync(home,{force:true,recursive:true})}
});
