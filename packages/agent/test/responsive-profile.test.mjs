// Local agent-only Normal-profile resource-safety tests. No relay or user project is touched.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'brc-low-resource-'));
const project = path.join(scratch, 'project');
process.env.BRC_HOME = path.join(scratch, 'agent-home');
// Simulate stale launcher settings from an older responsive build. Normal must override them.
process.env.BRC_RESOURCE_PROFILE = 'responsive';
process.env.BRC_LOW_RESOURCE_MODE = '1';
process.env.BRC_MAX_CONCURRENCY = '1';
process.env.BRC_MAX_JOBS = '1';
process.env.BRC_PARSER_WORKERS = '1';
await import('../dist/runtime/resource-profile.js');
process.env.BRC_ERROR_LOG = '0';
process.env.BRC_LOG_LEVEL = 'silent';
await fs.mkdir(project, { recursive: true });
const { configManager } = await import('../dist/core/config-manager.js');
await configManager.setValue('allowedDirectories', [project]);
const { callTool } = await import('../dist/dispatcher.js');
const { searchManager } = await import('../dist/core/search-manager.js');
const { cacheStatus, markToolStarted, markToolFinished, stopResourceMaintenance } =
  await import('../dist/runtime/resource-limits.js');
after(async () => {
  stopResourceMaintenance();
  await configManager.close();
  await fs.rm(scratch, { recursive: true, force: true, maxRetries: 4, retryDelay: 60 });
});
const text = r => (r.content ?? []).map(c => c.text ?? '').join('\n');

test('Normal profile overrides stale responsive settings and tracks active work without forcing GC', () => {
  assert.equal(cacheStatus().resourceProfile, 'normal');
  assert.ok(cacheStatus().hardware.maxConcurrentJobs >= 1 && cacheStatus().hardware.maxConcurrentJobs <= 3);
  assert.ok(cacheStatus().hardware.maxToolConcurrency >= 1 && cacheStatus().hardware.maxToolConcurrency <= 3);
  assert.ok(cacheStatus().hardware.parserWorkers >= 1 && cacheStatus().hardware.parserWorkers <= 2);
  assert.equal(process.env.BRC_RESOURCE_PROFILE, 'normal');
  assert.equal(process.env.BRC_LOW_RESOURCE_MODE, undefined);
  markToolStarted();
  assert.equal(cacheStatus().activeToolCalls, 1);
  markToolFinished();
  assert.equal(cacheStatus().activeToolCalls, 0);
});

test('invalid large edit fails fast without fuzzy scanning and keeps file intact', async () => {
  const p = path.join(project, 'large-source.ts');
  const before = 'export const stable = true;\n' + '// comment\n'.repeat(6000);
  await fs.writeFile(p, before);
  const r = await callTool('edit_block', {
    file_path: p,
    old_string: 'export const nonexistent = false;',
    new_string: 'changed',
  });
  assert.equal(r.isError, true, text(r));
  assert.equal(r.structuredContent.error.code, 'EDIT_TEXT_NOT_FOUND', text(r));
  assert.equal(r.structuredContent.changed, false);
  assert.doesNotMatch(text(r), /closest match|similarity|fuzzy worker/i);
  assert.equal(await fs.readFile(p,'utf8'), before);
});

test('ripgrep is configured as one thread with capped column preview', () => {
  const args = searchManager.buildRipgrepArgs({
    rootPath: project, pattern: 'a', searchType: 'content', maxResults: 12,
  });
  const t = args.indexOf('--threads');
  assert.notEqual(t, -1);
  assert.equal(args[t+1], '1');
  assert.ok(args.includes('--max-columns'));
});

test('responsive scheduling keeps reads fast while CPU-heavy calls run sequentially', async () => {
  const { OperationScheduler } = await import('../dist/runtime/operations.js');
  const scheduler = new OperationScheduler(3, 12);
  const seen = [];
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  const first = scheduler.run('heavy-a', 'run_command', 2000, async () => {
    seen.push('heavy-a');
    await hold;
    return 'done-a';
  });
  const second = scheduler.run('heavy-b', 'run_command', 2000, async () => {
    seen.push('heavy-b');
    return 'done-b';
  });
  const read = scheduler.run('fast-read', 'read_file', 2000, async () => {
    seen.push('read');
    return 'fast';
  });
  assert.equal(await read, 'fast');
  assert.deepEqual(seen, ['heavy-a', 'read']);
  release();
  assert.deepEqual(await Promise.all([first, second]), ['done-a','done-b']);
  assert.deepEqual(seen, ['heavy-a','read','heavy-b']);
});

test('command output capture retains only bounded head/tail without repeated large concatenations', async () => {
  const { CappedOutput } = await import('../dist/tools/brc-tools.js');
  const c = new CappedOutput(5, 7);
  c.push('abcdefghij');
  c.push('klmnop');
  assert.equal(c.toString(), 'abcde\n\n[... 4 characters truncated ...]\n\njklmnop');
  assert.equal(c.truncated, true);
  const many = new CappedOutput(10, 40);
  for (let i = 0; i < 700; i++) many.push('x'.repeat(20));
  const body = many.toString();
  assert.match(body, /^x{10}\n\n\[\.\.\. 13950 characters truncated \.\.\.\]\n\nx{40}$/);
});

test('large-file edit preview remains a small window with identical LF and CRLF output', async () => {
  const {boundedEditPreview} = await import('../dist/core/tools/edit.js');
  for(const ending of ['\n','\r\n']) {
    const content = Array.from({length:2200},(_,i)=>'line-'+i).join(ending)+ending;
    for(const changed of [0,37,1190,2199]) {
      const sought = 'line-'+changed;
      const offset = content.indexOf(sought);
      const got = boundedEditPreview(content,offset,sought);
      const lines = content.split('\n');
      const changeStartLine = content.substring(0, offset).split('\n').length-1;
      const start = Math.max(0,changeStartLine-10);
      const end = Math.min(lines.length,changeStartLine+1+10);
      const expected = '[Reading '+(end-start)+' lines from '+(start===0?'start':'line '+start)+' (total: '+lines.length+' lines, '+(lines.length-end)+' remaining)]\n\n';
      assert.equal(got.statusLine,expected);
      assert.equal(got.previewContent,lines.slice(start,end).join('\n'));
    }
  }
});

test('safe rewrite remains atomic and preserves source bytes', async () => {
  const file = path.join(project,'safe-rewrite.txt');
  await fs.writeFile(file,'original\r\n');
  const response = await callTool('write_file',{path:file,content:'replacement\r\n',mode:'rewrite'});
  assert.ok(!response.isError, text(response));
  assert.equal(await fs.readFile(file,'utf8'),'replacement\r\n');
});

test('terminal session keeps all lines up to 500 KiB, then evicts only by size', async () => {
  const {TerminalManager, MAX_BUFFERED_OUTPUT_CHARS, MAX_VISIBLE_TERMINAL_LINES} = await import('../dist/core/terminal-manager.js');
  assert.equal(MAX_BUFFERED_OUTPUT_CHARS,500*1024);
  assert.equal(MAX_VISIBLE_TERMINAL_LINES,Number.POSITIVE_INFINITY);
  const mgr = new TerminalManager();
  const session = {
    outputLines:[], bufferedChars:0, evictedChars:0, evictedLines:0,
    lastReadIndex:0, pid:1,
  };
  for(let i=0;i<7;i++) mgr.appendToLineBuffer(session,('record-'+i+':'+('x'.repeat(80))+'\n').repeat(1400));
  assert.ok(session.bufferedChars<=MAX_BUFFERED_OUTPUT_CHARS,session.bufferedChars);
  assert.ok(session.outputLines.length>20, session.outputLines.length);
  assert.ok(session.outputLines.some(line=>line.startsWith('record-6:')));
  assert.ok(session.outputLines.every(line=>!line.startsWith('record-0:')));
  assert.ok(session.evictedChars>0);
  assert.ok(session.evictedLines>0);
});

test('terminal process admission rejects overload without starting more commands', async () => {
  const {TerminalManager} = await import('../dist/core/terminal-manager.js');
  const mgr = new TerminalManager();
  mgr.sessions.set(1,{});
  mgr.sessions.set(2,{});
  const result = await mgr.executeCommand('node -v',1000,'cmd.exe');
  assert.equal(result.pid,-1);
  assert.match(result.output,/TERMINAL_BUSY/);
});

test('start_process path completes a simple native command without shell persistence', async () => {
  const {TerminalManager} = await import('../dist/core/terminal-manager.js');
  const mgr = new TerminalManager();
  const started = await mgr.executeCommand('node -v', 1000, process.platform === 'win32' ? 'cmd.exe' : '/bin/sh');
  assert.ok(started.pid > 0,started.output);
  assert.match(started.output,/v\d+\.\d+/);
  assert.equal(mgr.listActiveSessions().length,0);
});

test('activity history stays within its share of the combined 100-KiB log budget', async () => {
  const {ActivityLog,MAX_ACTIVITY_LOG_BYTES,MAX_ACTIVITY_EVENT_BYTES} = await import('../dist/runtime/activity.js');
  const {recentActivity} = await import('../dist/terminal-ui.js');
  assert.equal(MAX_ACTIVITY_LOG_BYTES, 100 * 1024);
  const log = new ActivityLog(path.join(scratch,'quiet-activity'),true);
  for (let i=0;i<3000;i++) log.tool('OK','read_file',String(i),i);
  const recent=log.recent();
  assert.ok(recent.length>20, 'no arbitrary 20-entry truncation');
  assert.ok(recent.length<3000, 'older activity must be released when the byte cap is exceeded');
  assert.equal(recent.at(-1).id,'2999');
  assert.notEqual(recent[0].id,'0');
  assert.ok(recent.reduce((n,e)=>n+Buffer.byteLength(JSON.stringify(e),'utf8'),0)<=MAX_ACTIVITY_EVENT_BYTES);
  assert.ok(MAX_ACTIVITY_EVENT_BYTES + (MAX_ACTIVITY_LOG_BYTES - MAX_ACTIVITY_EVENT_BYTES) === MAX_ACTIVITY_LOG_BYTES);
  const screen=recentActivity(recent,10000);
  assert.ok(screen.split('\n').length>20, 'L activity view should show more than 20 entries');
  assert.ok(Buffer.byteLength(screen,'utf8')<MAX_ACTIVITY_LOG_BYTES+256);
  await log.close();
});

test('initial command output keeps every line until its 500-KiB text cap', async () => {
  const {keepRecentTerminalOutput} = await import('../dist/core/terminal-manager.js');
  let tail='';
  for(let i=0;i<160;i++) tail=keepRecentTerminalOutput(tail,'line-'+i+'\n');
  assert.ok(tail.split('\n').length>20);
  assert.ok(tail.includes('line-0\n'));
  assert.ok(tail.includes('line-159\n'));
  const large=keepRecentTerminalOutput(tail, 'x'.repeat(520*1024)+'END');
  assert.equal(large.length,500*1024);
  assert.ok(large.endsWith('END'));
  assert.ok(!large.includes('line-0\n'));
});

test('text line-count optimization matches prior semantics without splitting source', async () => {
  const {TextFileHandler} = await import('../dist/core/utils/files/text.js');
  for(const source of ['', 'first', 'first\n', 'one\ntwo\nthree', '\n\n', 'one\r\ntwo\r\n','x'.repeat(60000)+'\nsecond']) {
    const old = source.length ? source.split('\n').length-(source.endsWith('\n')?1:0) : 0;
    assert.equal(TextFileHandler.countLines(source),old);
  }
});

test('fast reading preserves CRLF and UTF-16 BOM for small files', async () => {
  const {TextFileHandler} = await import('../dist/core/utils/files/text.js');
  const handler = new TextFileHandler();
  const utf8=path.join(project,'quick-read.txt');
  await fs.writeFile(utf8,'first\r\nsecond\r\nthird\r\n','utf8');
  const a=await handler.read(utf8,{offset:1,length:2});
  assert.match(String(a.content),/second\nthird/);
  const utf16=path.join(project,'utf16-note.txt');
  await fs.writeFile(utf16,Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from('hello\r\nworld\r\n','utf16le')]));
  const c=await handler.read(utf16,{offset:0,length:2});
  assert.match(String(c.content),/hello/);
  assert.match(String(c.content),/world/);
});

test('completed terminal session keeps all 65 lines when below the 500-KiB cap', async () => {
  const {TerminalManager} = await import('../dist/core/terminal-manager.js');
  const mgr = new TerminalManager();
  const command = 'node -e "for(let i=0;i<65;i++)console.log(\'entry-\'+i)"';
  const finished = await mgr.executeCommand(command,2000,process.platform==='win32'?'cmd.exe':'/bin/sh');
  assert.ok(finished.pid>0,finished.output);
  const result = mgr.readOutputPaginated(finished.pid,-100,100);
  assert.ok(result);
  assert.ok(result.lines.length>=65, result.lines.length);
  assert.equal(result.evictedLines,0);
  assert.match(result.lines.join('\n'),/entry-0\n/);
  assert.match(result.lines.join('\n'),/entry-64/);
});

test('completed 350-KiB command output survives in memory for read_process_output', async () => {
  const {TerminalManager} = await import('../dist/core/terminal-manager.js');
  const mgr = new TerminalManager();
  const command = 'node -e "process.stdout.write(\'x\'.repeat(350000))"';
  const finished = await mgr.executeCommand(command,2000,process.platform==='win32'?'cmd.exe':'/bin/sh');
  assert.ok(finished.pid>0,finished.output.slice(0,200));
  const result = mgr.readOutputPaginated(finished.pid,-100,100);
  assert.ok(result,'completed output should still exist');
  assert.equal(result.evictedLines,0);
  assert.ok(result.lines.join('').length>=350000,'output should not be lost on completion');
});

test('rolling BRC console stays within its 40-KiB share of the 100-KiB log budget', async () => {
  const {ActivityLog,MAX_ACTIVITY_CONSOLE_BYTES} = await import('../dist/runtime/activity.js');
  const log = new ActivityLog(path.join(scratch, 'rolling-activity'),false);
  // Exercise the console buffer without drawing terminal screens during tests.
  log.rollingConsole = true;
  log.scheduleRolling = () => {};
  for(let i=0;i<3200;i++) log.tool('OK','read_file',String(i),i);
  assert.ok(log.rollingLines.length>20, log.rollingLines.length);
  assert.ok(log.rollingBytes<=MAX_ACTIVITY_CONSOLE_BYTES, log.rollingBytes);
  assert.ok(log.rollingBytes>20*1024, 'the console ring should make useful use of its allocated budget');
  assert.equal(log.rollingBytes, log.rollingLines.reduce((n,s)=>n+Buffer.byteLength(s+'\n','utf8'),0));
  assert.ok(log.rollingLines.at(-1).includes('read_file'));
  assert.ok(!log.rollingLines.some(s=>s.includes('[0]')));
  await log.close();
});

test('paused console queue stays within its 40-KiB share of the 100-KiB log budget', async () => {
  const {ActivityLog,MAX_ACTIVITY_CONSOLE_BYTES} = await import('../dist/runtime/activity.js');
  const log = new ActivityLog(path.join(scratch, 'queue-activity'),false);
  const resume = log.pauseConsole();
  for(let i=0;i<3200;i++) log.tool('OK','read_file',String(i),i);
  assert.ok(log.consoleQueue.length>20);
  assert.ok(log.queuedBytes<=MAX_ACTIVITY_CONSOLE_BYTES,log.queuedBytes);
  assert.equal(log.queuedBytes,log.consoleQueue.reduce((n,s)=>n+Buffer.byteLength(s,'utf8'),0));
  // Do not dump test data to the real console on resume.
  log.consoleQueue.length=0;
  log.queuedBytes=0;
  resume();
  await log.close();
});
