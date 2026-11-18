// Local agent-only responsive-profile regression tests. No relay or user project is touched.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'brc-low-resource-'));
const project = path.join(scratch, 'project');
process.env.BRC_HOME = path.join(scratch, 'agent-home');
process.env.BRC_RESOURCE_PROFILE = 'responsive';
process.env.BRC_MAX_CONCURRENCY = '1';
process.env.BRC_MAX_JOBS = '1';
process.env.BRC_PARSER_WORKERS = '1';
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

test('responsive profile tracks active work without forcing GC', () => {
  assert.equal(cacheStatus().resourceProfile, 'responsive');
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

test('terminal session keeps only last 20 lines and at most 64 KiB', async () => {
  const {TerminalManager, MAX_BUFFERED_OUTPUT_CHARS, MAX_VISIBLE_TERMINAL_LINES} = await import('../dist/core/terminal-manager.js');
  assert.equal(MAX_BUFFERED_OUTPUT_CHARS,64*1024);
  assert.equal(MAX_VISIBLE_TERMINAL_LINES,20);
  const mgr = new TerminalManager();
  const session = {
    outputLines:[], bufferedChars:0, evictedChars:0, evictedLines:0,
    lastReadIndex:0, pid:1,
  };
  for(let i=0;i<7;i++) mgr.appendToLineBuffer(session,('record-'+i+':'+('x'.repeat(80))+'\n').repeat(5000));
  assert.ok(session.bufferedChars<=MAX_BUFFERED_OUTPUT_CHARS,session.bufferedChars);
  assert.ok(session.outputLines.length<=20, session.outputLines.length);
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

test('agent activity keeps only latest 20 entries, without retaining old text', async () => {
  const {ActivityLog,MAX_VISIBLE_ACTIVITY_LINES} = await import('../dist/runtime/activity.js');
  assert.equal(MAX_VISIBLE_ACTIVITY_LINES,20);
  const log = new ActivityLog(path.join(scratch,'quiet-activity'),true);
  for(let i=0;i<65;i++) log.tool('OK','read_file',String(i),i);
  const recent=log.recent();
  assert.equal(recent.length,20);
  assert.equal(recent[0].id,'45');
  assert.equal(recent.at(-1).id,'64');
  await log.close();
});

test('streaming command output retains the last 20 lines, not 1 MB', async () => {
  const {keepRecentTerminalOutput} = await import('../dist/core/terminal-manager.js');
  let tail='';
  for(let i=0;i<160;i++) tail=keepRecentTerminalOutput(tail,'line-'+i+'\n');
  assert.ok(tail.length<64*1024,tail.length);
  assert.ok(tail.split('\n').length<=20,tail.split('\n').length);
  assert.ok(tail.includes('line-159'));
  assert.ok(!tail.includes('line-0\n'));
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

test('completed terminal session exposes only 20 newest lines and records discarded output', async () => {
  const {TerminalManager} = await import('../dist/core/terminal-manager.js');
  const mgr = new TerminalManager();
  const command = 'node -e "for(let i=0;i<65;i++)console.log(\'entry-\'+i)"';
  const finished = await mgr.executeCommand(command,2000,process.platform==='win32'?'cmd.exe':'/bin/sh');
  assert.ok(finished.pid>0,finished.output);
  const result = mgr.readOutputPaginated(finished.pid,-20,50);
  assert.ok(result);
  assert.ok(result.lines.length<=20);
  assert.ok(result.evictedLines>0,result.evictedLines);
  assert.match(result.lines.join('\n'),/entry-64/);
  assert.doesNotMatch(result.lines.join('\n'),/entry-0\n/);
});
