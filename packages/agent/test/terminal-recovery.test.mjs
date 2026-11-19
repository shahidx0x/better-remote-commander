import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {mkdtempSync,realpathSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
const root=mkdtempSync(path.join(realpathSync.native(os.tmpdir()),'brc-terminal-durable-'));
process.env.BRC_HOME=path.join(root,'home');
const {saveCredentials}=await import('../dist/transport/pairing.js');
saveCredentials({relayUrl:'https://relay.test.invalid',deviceId:randomUUID(),
 deviceToken:'DISPOSABLE_TERMINAL_TEST_DEVICE_TOKEN_NOT_REAL_'+randomUUID(),
 name:'Disposable',pairedAt:new Date().toISOString()});
const {configManager}=await import('../dist/core/config-manager.js');
await configManager.setValue('allowedDirectories',[root]);
const {callTool}=await import('../dist/dispatcher.js');
const {saveTerminalSnapshot,loadTerminalSnapshot,flushTerminalJournal,terminalJournalStatus}
 =await import('../dist/runtime/terminal-journal.js');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
after(async()=>{await configManager.close();await fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:70});});
test('paired terminal journal encrypts a bounded output tail and restores it after interrupted run',async()=>{
 const sessionId=randomUUID(),snapshot={sessionId,pid:3214,startedAt:Date.now(),
  state:'running',exitCode:null,evictedLines:4,lines:['hello','TOP_SECRET_DIAGNOSTIC','tail']};
 assert.equal(terminalJournalStatus().enabled,true);
 assert.equal(await saveTerminalSnapshot(snapshot),true);
 await flushTerminalJournal();
 const file=path.join(root,'home','terminal-journal');
 const found=await fs.readdir(file);
 assert.equal(found.length,1);
 const encrypted=await fs.readFile(path.join(file,found[0]),'utf8');
 assert.equal(encrypted.includes('TOP_SECRET_DIAGNOSTIC'),false,'no plaintext output stored at rest');
 const restored=await loadTerminalSnapshot(sessionId);
 assert.equal(restored.state,'interrupted');
 assert.deepEqual(restored.lines,snapshot.lines);
 assert.equal(restored.evictedLines,4);
});
test('running CLI process returns a stable session ID, encrypted journal and independent output cursor',async()=>{
 const start=await callTool('start_process',{command:'node --version',shell:'cmd.exe',timeout_ms:1000});
 assert.notEqual(start.isError,true,JSON.stringify(start));
 const id=start.structuredContent.sessionId;
 assert.match(id,/^[0-9a-f-]{36}$/i);
 const pid=start.structuredContent.pid;
 assert.ok(pid>0);
 await delay(150);
 const output=await callTool('read_process_output',{session_id:id,cursor:0,length:10,timeout_ms:50});
 assert.notEqual(output.isError,true,JSON.stringify(output));
 assert.equal(output.structuredContent.sessionId,id);
 assert.equal(typeof output.structuredContent.nextCursor,'number');
 assert.equal(output.structuredContent.lostOutput,false);
 await flushTerminalJournal();
 const journal=await loadTerminalSnapshot(id);
 assert.ok(journal,'session is durably journaled with existing pairing');
 assert.equal(journal.sessionId,id);
 const repeated=await callTool('read_process_output',{session_id:id,cursor:0,length:10,timeout_ms:0});
 assert.equal(repeated.structuredContent.nextCursor,output.structuredContent.nextCursor);
});
test('500 KiB journal cap evicts oldest lines without any unbounded source buffer',async()=>{
 const id=randomUUID();
 const lines=Array.from({length:150},(_,i)=>'line'+i+'_'+('X'.repeat(6000)));
 assert.equal(await saveTerminalSnapshot({sessionId:id,pid:1234,startedAt:Date.now(),
  state:'completed',exitCode:0,evictedLines:2,lines}),true);
 const restored=await loadTerminalSnapshot(id);
 assert.ok(restored.lines.length<lines.length);
 assert.ok(restored.evictedLines>2);
 assert.equal(restored.lines.at(-1),lines.at(-1));
});
