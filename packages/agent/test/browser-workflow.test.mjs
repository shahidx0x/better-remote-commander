// All tests run against a FAKE Playwright MCP plugin: no browser, network or GUI.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {mkdtempSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=mkdtempSync(path.join(realpathSync.native(tmpdir()),'brc-browser-policy-'));
process.env.BRC_HOME=path.join(root,'agent');
const project=path.join(root,'project');
await fs.mkdir(project,{recursive:true});
await fs.writeFile(path.join(project,'package.json'),JSON.stringify({name:'brc-workflow-test',scripts:{test:'node -v'}}));
const fixture=path.join(path.dirname(fileURLToPath(import.meta.url)),'fixtures','fake-playwright-mcp.mjs');
const {callTool}=await import('../dist/dispatcher.js');
const {configManager}=await import('../dist/core/config-manager.js');
const plugins=await import('../dist/plugins/manager.js');
const host=await import('../dist/plugins/host.js');
const {playwrightPolicy,classifyBrowserError,PlaywrightCallPolicy}=await import('../dist/runtime/browser-workflow.js');
await configManager.setValue('allowedDirectories',[root]);
await plugins.definePlugin({
 id:'playwright',name:'Fake Playwright (tests only)',description:'No real browser',
 source:{type:'command',command:process.execPath,args:[fixture]},
 enabled:true,origin:'user',status:'installed'
});
const output=r=>(r.content??[]).map(c=>c.text??'').join('\n');
const call=(tool,args={})=>callTool('call_plugin_tool',{plugin:'playwright',tool,args});
after(async()=>{
 await host.stopAllPlugins();
 await configManager.close();
 await fs.rm(root,{recursive:true,force:true,maxRetries:6,retryDelay:100});
});

test('agent_status and project_context disclose the no-browser default without relay changes',async()=>{
 const s=await callTool('agent_status',{});
 assert.equal(s.structuredContent.agentWorkflow.mode,'no-browser-by-default');
 assert.ok(s.structuredContent.agentWorkflow.order.some(x=>x.includes('Serena')));
 assert.equal(s.structuredContent.agentWorkflow.playwright.length,8);
 assert.match(s.structuredContent.agentWorkflow.scope,/external MCP servers/);
 const context=await callTool('project_context',{path:project});
 assert.equal(context.structuredContent.agentWorkflow.mode,'no-browser-by-default');
 assert.match(context.structuredContent.agentWorkflow.browserRule,/fresh browser_snapshot/);
});

test('plugin tool list includes current browser input schema and reliability rules',async()=>{
 const r=await callTool('list_plugin_tools',{plugin:'playwright'});
 assert.ok(!r.isError,output(r));
 assert.match(output(r),/BRC LOCAL PLAYWRIGHT RULES/);
 assert.match(output(r),/DEFAULT: NO BROWSER/);
 assert.match(output(r),/browser_click/);
 assert.match(output(r),/required/);
 assert.match(output(r),/target/);
});

test('missing target and absent snapshot fail before plugin call',async()=>{
 const bad=await call('browser_click',{name:'Submit'});
 assert.equal(bad.isError,true);
 assert.equal(bad.structuredContent.error.code,'PLAYWRIGHT_ARGUMENT');
 assert.match(output(bad),/NO browser action executed/);
 const noSnapshot=await call('browser_click',{target:'submit-0'});
 assert.equal(noSnapshot.isError,true);
 assert.equal(noSnapshot.structuredContent.error.code,'PLAYWRIGHT_SNAPSHOT_REQUIRED');
 assert.equal(noSnapshot.structuredContent.recovery.next.tool,'browser_snapshot');
});

test('fresh snapshot is mandatory after navigation, click, resize and tab changes',async()=>{
 const nav=await call('browser_navigate',{url:'http://localhost/test'});
 assert.equal(nav.isError,undefined,output(nav));
 assert.match(output(nav),/BRC PLAYWRIGHT NEXT/);
 assert.equal(playwrightPolicy.status().snapshotValid,false);
 const before=await call('browser_click',{target:'submit-1'});
 assert.equal(before.structuredContent.error.code,'PLAYWRIGHT_SNAPSHOT_REQUIRED');
 const snapshot=await call('browser_snapshot');
 assert.equal(snapshot.isError,undefined,output(snapshot));
 assert.equal(playwrightPolicy.status().snapshotValid,true);
 const clicked=await call('browser_click',{target:'submit-1'});
 assert.equal(clicked.isError,undefined,output(clicked));
 assert.match(output(clicked),/clicked submit-1/);
 const afterClick=await call('browser_click',{target:'submit-2'});
 assert.equal(afterClick.structuredContent.error.code,'PLAYWRIGHT_SNAPSHOT_REQUIRED');
 await call('browser_snapshot');
 await call('browser_take_screenshot');
 assert.equal(playwrightPolicy.status().snapshotValid,true,'screenshots are read-only');
 await call('browser_resize',{width:1000,height:720});
 assert.equal(playwrightPolicy.status().snapshotValid,false);
 await call('browser_snapshot');
 await call('browser_tabs',{action:'list'});
 assert.equal(playwrightPolicy.status().snapshotValid,true);
 await call('browser_tabs',{action:'select',index:0});
 assert.equal(playwrightPolicy.status().snapshotValid,false);
});

test('stale element failures are distinct from MCP transport failures and never restart the plugin',async()=>{
 await call('browser_snapshot');
 const r=await call('browser_click',{target:'stale'});
 assert.equal(r.isError,true);
 assert.equal(r.structuredContent.error.code,'ELEMENT_RESOLUTION');
 assert.match(output(r),/Never restart Playwright/);
 const retry=await call('browser_click',{target:'stale'});
 assert.equal(retry.isError,true);
 assert.equal(retry.structuredContent.error.code,'PLAYWRIGHT_REPEAT');
 assert.equal(classifyBrowserError('Connection closed unexpectedly'),'PLUGIN_TRANSPORT');
 assert.equal(classifyBrowserError('element ref stale'),'ELEMENT_RESOLUTION');
 assert.equal(playwrightPolicy.status().snapshotValid,false);
});

test('parallel browser clicks are serialized; only first click after snapshot can run',async()=>{
 await call('browser_snapshot');
 const [one,two]=await Promise.all([
  call('browser_click',{target:'first'}),
  call('browser_click',{target:'second'})
 ]);
 assert.equal(one.isError,undefined,output(one));
 assert.equal(two.isError,true);
 assert.equal(two.structuredContent.error.code,'PLAYWRIGHT_SNAPSHOT_REQUIRED');
});

test('browser guard is a bounded in-memory state machine, not a browser server restart',()=>{
 const p=new PlaywrightCallPolicy();
 assert.equal(p.before('browser_click',{target:'a'}).code,'PLAYWRIGHT_SNAPSHOT_REQUIRED');
 p.after('browser_snapshot',{}, {isError:false});
 assert.equal(p.status().snapshotValid,true);
 p.after('browser_wait_for',{text:'updated'}, {isError:false});
 assert.equal(p.status().snapshotValid,false);
 p.after('browser_snapshot',{filename:'hidden.txt'}, {isError:false});
 assert.equal(p.status().snapshotValid,false,'file-only snapshot is not visible to the model');
 p.after('browser_snapshot',{}, {isError:false});
 assert.equal(p.status().snapshotValid,true);
 p.reset();
 assert.equal(p.status().snapshotValid,false);
 p.after('browser_snapshot',{}, {isError:false});
 assert.equal(p.status().snapshotValid,true);
 p.after('browser_snapshot',{}, {isError:true});
 assert.equal(p.status().snapshotValid,false,'failed snapshot must revoke the previous element references');
});
