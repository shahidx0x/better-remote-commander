import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {mkdtempSync,realpathSync} from 'node:fs';
import {PassThrough} from 'node:stream';
const scratch=mkdtempSync(path.join(realpathSync.native(os.tmpdir()),'brc-outline-test-'));
const root=path.join(scratch,'workspace');
await fs.mkdir(root);
process.env.BRC_HOME=path.join(scratch,'agent');
process.env.BRC_LOG_LEVEL='silent';
const {configManager}=await import('../dist/core/config-manager.js');
await configManager.setValue('allowedDirectories',[root]);
const {callTool}=await import('../dist/dispatcher.js');
const {codeGraph}=await import('../dist/runtime/code-graph.js');
const {compactGraph}=await import('../dist/runtime/graph-outline.js');
const {ActivityLog}=await import('../dist/runtime/activity.js');
const {consoleBanner,controlHint,connectionPanel,recentActivity}=await import('../dist/terminal-ui.js');
const {listenForTerminalShortcuts,waitForSavedConnection}=await import('../dist/terminal-shortcuts.js');
const result=r=>{assert.notEqual(r.isError,true,JSON.stringify(r));return r.structuredContent};
after(async()=>{codeGraph.clear();await configManager.close();await fs.rm(scratch,{recursive:true,force:true,maxRetries:6,retryDelay:50})});
test('graph outline is smaller, retains valid file IDs, sha, source line references and provenance',{timeout:30000},async()=>{
 for(let i=0;i<42;i++){
   const previous=i===0?'':"import { compute"+(i-1)+" } from './file"+(i-1)+".js';\n";
   const code=previous+'export function compute'+i+'(n: number) { return n + '+i+'; }\n'
      +'export const answer'+i+' = '+i+';\n';
   await fs.writeFile(path.join(root,'file'+i+'.ts'),code);
 }
 await fs.writeFile(path.join(root,'.env'),'MODEL_SECRET_SHOULD_NOT_LEAK=1');
 const full=result(await callTool('code_graph',{path:root,action:'refresh',maxFiles:90,limit:80}));
 const outline=result(await callTool('code_graph',{path:root,format:'compact',maxFiles:90,limit:80,maxChars:12000}));
 assert.equal(outline.format,'graph-outline-v1');
 assert.ok(outline.files.length>=30);
 assert.ok(JSON.stringify(outline).length<JSON.stringify(full).length,
  'dictionary graph must be smaller than legacy full JSON');
 assert.ok(!JSON.stringify(outline).includes('MODEL_SECRET_SHOULD_NOT_LEAK'));
 assert.ok(outline.declarations.some(d=>d[1].includes('compute10')));
 for(const [index,name,kind,start,end] of outline.declarations){
    assert.ok(index>=0&&index<outline.files.length);
    assert.ok(name&&kind&&start>=1&&end>=start);
 }
 for(const [from,to] of outline.relations){assert.ok(from>=0&&from<outline.files.length);assert.ok(to>=0&&to<outline.files.length)}
 const bounded=result(await callTool('code_graph',{path:root,format:'compact',limit:80,maxFiles:90,maxChars:2000}));
 assert.ok(JSON.stringify(bounded).length<=2000,JSON.stringify(bounded).length);
 assert.ok(bounded.partial);
 assert.ok(bounded.coverage.omittedFiles>0||bounded.coverage.omittedDeclarations>0);
 const focus=result(await callTool('context_pack',{path:root,focus:'file21.ts',query:'compute21',mode:'outline',maxFiles:90,maxChars:6000}));
 assert.equal(focus.mode,'outline');
 assert.equal(focus.persistent,false);
 assert.equal(focus.graph.format,'graph-outline-v1');
 assert.ok(JSON.stringify(focus).length<=6000);
 assert.ok(!JSON.stringify(focus).includes('return n + 21'));
 const found=focus.graph.declarations.find(d=>d[1].includes('compute21'));
 assert.ok(found,'focused symbol should survive compression');
 const rel=focus.graph.files[found[0]][0];
 const source=await fs.readFile(path.join(root,rel),'utf8');
 assert.match(source,/return n \+ 21/,'exact contents remain available on demand');
 assert.equal(source.split('\n')[found[3]-1].includes('compute21'),true,'line range references exact source');
 const oldHash=outline.files.find(f=>f[0]==='file21.ts')[1];
 await fs.appendFile(path.join(root,'file21.ts'),'\n// changed\n');
 const refreshed=result(await callTool('code_graph',{path:root,format:'compact',limit:80,maxFiles:90}));
 assert.notEqual(refreshed.files.find(f=>f[0]==='file21.ts')[1],oldHash,'stale hashes are refreshed after source edits');
});
test('compact console hides START lines but preserves full in-memory events and errors',()=>{
 const logger=new ActivityLog(path.join(scratch,'logger'),false);
 logger.setConsoleMode('compact');
 const writes=[],original=process.stdout.write;
 process.stdout.write=function(text){writes.push(String(text));return true};
 try{
    logger.tool('START','read_file','id1');
    logger.tool('OK','read_file','id1',12);
    logger.tool('ERROR','run_command','id2',15,'NONZERO_EXIT');
    logger.log('info','Connected; waiting for relay welcome');
    logger.log('warn','Disconnected (1006); reconnecting');
    assert.equal(logger.recent().filter(e=>e.phase==='START').length,1,'START is still in memory');
    assert.equal(writes.filter(s=>s.includes('read_file')).length,1,'one completion per successful call in compact mode');
    assert.ok(writes.some(s=>s.includes('[FAIL]')&&s.includes('run_command')));
    assert.ok(writes.some(s=>s.includes('Disconnected')));
    assert.ok(!writes.some(s=>s.includes('waiting for relay welcome')));
    logger.setConsoleMode('verbose');logger.tool('START','list_devices','id3');
    assert.ok(writes.some(s=>s.includes('START')&&s.includes('list_devices')));
 }finally{process.stdout.write=original}
});
test('console is readable without ANSI and shortcuts do not interrupt a running operation',async()=>{
 const info={name:'Code Workstation',relay:'https://relay.example',deviceId:'device123456',version:'2.0.7',coreVersion:'2.0.7',tools:80};
 const banner=consoleBanner(info,84,false);
 assert.match(banner,/BRC/);assert.match(banner,/Code Workstation/);
 assert.ok(!banner.includes('\x1b['));
 assert.match(controlHint(true,false),/\[M\].*\[S\].*\[L\].*\[V\]/);
 assert.match(connectionPanel({online:true,connecting:false,inFlight:2},info,false),/ONLINE/);
 assert.match(recentActivity([{timestamp:'2026-11-16T12:00:00.000Z',level:'info',message:'OK run_command',phase:'OK'}]),/run_command/);
 const input=new PassThrough();input.isTTY=true;input.isRaw=false;input.setRawMode=function(v){this.isRaw=v;return this};
 const choices=[],listener=listenForTerminalShortcuts(input,c=>choices.push(c),{liveCommands:true});
 for(const value of ['s','l','v','?','m'])input.write(value);
 await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(choices,['status','activity','verbose','help','settings']);
 listener.close();assert.equal(input.isRaw,false);input.destroy();
 const startup=new PassThrough();startup.isTTY=true;startup.isRaw=false;startup.setRawMode=function(v){this.isRaw=v;return this};
 const saved={relayUrl:'https://relay.example',deviceId:'test',deviceToken:'secret',name:'PC',pairedAt:'test'};
 const wait=waitForSavedConnection(saved,undefined,startup,new PassThrough(),30);
 startup.write('s');
 assert.equal(await wait,'connect','status shortcut during countdown does not skip startup decision');
 startup.destroy();
});
