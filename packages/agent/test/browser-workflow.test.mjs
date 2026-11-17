// All tests run against a FAKE Playwright MCP plugin (local stdio script): no browser, network or GUI.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {mkdtempSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=mkdtempSync(path.join(realpathSync.native(tmpdir()),'brc-browser-wf-'));
process.env.BRC_HOME=path.join(root,'agent');
const fixture=path.join(path.dirname(fileURLToPath(import.meta.url)),'fixtures','fake-playwright-mcp.mjs');
const {callTool}=await import('../dist/dispatcher.js');
const {configManager}=await import('../dist/core/config-manager.js');
const plugins=await import('../dist/plugins/manager.js');
const host=await import('../dist/plugins/host.js');
const {classifyBrowserError,PlaywrightAdvisor,BROWSER_WORKFLOW_TEXT}=await import('../dist/runtime/browser-workflow.js');
await configManager.setValue('allowedDirectories',[root]);
await plugins.definePlugin({id:'playwright',name:'Fake Playwright (tests only)',description:'No real browser',
  source:{type:'command',command:process.execPath,args:[fixture]},enabled:true,origin:'user',status:'installed'});
await plugins.definePlugin({id:'other',name:'Other fake',description:'Not a browser',
  source:{type:'command',command:process.execPath,args:[fixture]},enabled:true,origin:'user',status:'installed'});
const output=r=>(r.content??[]).map(c=>c.text??'').join('\n');
const call=(tool,args={},plugin='playwright')=>callTool('call_plugin_tool',{plugin,tool,args});
after(async()=>{await host.stopAllPlugins();await configManager.close();await fs.rm(root,{recursive:true,force:true,maxRetries:6,retryDelay:100});});

test('classification separates element, transport and generic failures',()=>{
  assert.equal(classifyBrowserError('Error: element ref stale; element not found'),'ELEMENT_RESOLUTION');
  assert.equal(classifyBrowserError('strict mode violation: locator resolved to 2 elements'),'ELEMENT_RESOLUTION');
  assert.equal(classifyBrowserError('Connection closed unexpectedly'),'PLUGIN_TRANSPORT');
  assert.equal(classifyBrowserError('MCP error -32001: Request timed out'),'PLUGIN_TRANSPORT');
  assert.equal(classifyBrowserError('page.goto: net::ERR_CONNECTION_REFUSED'),'PLUGIN_TOOL_FAILED');
  // page text in a tool RESULT must not be mistaken for a dead plugin connection
  assert.equal(classifyBrowserError('socket hang up while loading page; connection closed',false),'PLUGIN_TOOL_FAILED');
});
test('advisor tracks snapshot freshness without blocking',()=>{
  const p=new PlaywrightAdvisor();
  assert.equal(p.status().snapshotFresh,false);
  p.after('browser_snapshot',{},true);assert.equal(p.status().snapshotFresh,true);
  assert.equal(p.after('browser_take_screenshot',{},true),false);assert.equal(p.status().snapshotFresh,true);
  assert.equal(p.after('browser_tabs',{action:'list'},true),false);assert.equal(p.status().snapshotFresh,true);
  assert.equal(p.after('browser_click',{target:'a'},true),true);assert.equal(p.status().snapshotFresh,false);
  p.after('browser_snapshot',{filename:'x.md'},true);assert.equal(p.status().snapshotFresh,false,'file-only snapshot is not visible to the model');
  p.after('browser_snapshot',{},true);p.after('browser_snapshot',{},false);assert.equal(p.status().snapshotFresh,false);
  p.after('browser_snapshot',{},true);p.reset();assert.equal(p.status().snapshotFresh,false);
});
test('list_plugin_tools adds guidance for Playwright only, keeps the real schema',async()=>{
  const r=await callTool('list_plugin_tools',{plugin:'playwright'});
  assert.ok(!r.isError,output(r));assert.ok(output(r).includes(BROWSER_WORKFLOW_TEXT));
  assert.match(output(r),/input schema/);assert.match(output(r),/browser_click/);
  const o=await callTool('list_plugin_tools',{plugin:'other'});
  assert.ok(!output(o).includes('BRC PLAYWRIGHT GUIDANCE'));
});
test('calls are never blocked by BRC: schema-correct and unusual args reach the plugin',async()=>{
  const first=await call('browser_click',{target:'submit-0'});
  assert.equal(first.isError,undefined,output(first));assert.match(output(first),/clicked submit-0/);
  assert.match(output(first),/BRC PLAYWRIGHT NOTE/);
  assert.equal(first.structuredContent.browserWorkflow.nextTool,'browser_snapshot');
  const snap=await call('browser_snapshot');
  assert.equal(snap.isError,undefined);assert.ok(!output(snap).includes('BRC PLAYWRIGHT'));
  // identical repeat of a failing call is allowed through (plugin decides)
  const a=await call('browser_click',{target:'stale'}),b=await call('browser_click',{target:'stale'});
  for(const r of [a,b]){assert.equal(r.isError,true);assert.equal(r.structuredContent.error.code,'ELEMENT_RESOLUTION');
    assert.match(output(r),/stale/);assert.match(output(r),/BRC PLAYWRIGHT RECOVERY \(ELEMENT_RESOLUTION\)/);assert.equal(r.structuredContent.recovery.automaticRetry,false);}
});
test('plugin errors that are not element problems stay generic; non-browser plugins are untouched',async()=>{
  const bad=await call('browser_nope');
  assert.equal(bad.isError,true);assert.equal(bad.structuredContent.error.code,'PLUGIN_TOOL_FAILED');
  const other=await call('browser_click',{target:'stale'},'other');
  assert.equal(other.isError,true);assert.ok(!output(other).includes('BRC PLAYWRIGHT'));assert.equal(other.structuredContent,undefined);
  const ok=await call('browser_navigate',{url:'http://localhost/'},'other');
  assert.ok(!output(ok).includes('BRC PLAYWRIGHT'));
});
test('unknown plugin is a normal error',async()=>{
  const r=await call('x',{},'does-not-exist');
  assert.equal(r.isError,true);
});
