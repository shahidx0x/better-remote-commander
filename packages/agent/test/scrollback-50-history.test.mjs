import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ActivityLog, MAX_ACTIVITY_LOG_BYTES, MAX_ACTIVITY_CONSOLE_BYTES,
  MAX_ACTIVITY_EVENT_BYTES, MAX_ACTIVITY_QUEUE_BYTES, formatActivityEvent,
} from '../dist/runtime/activity.js';
import { recentActivity } from '../dist/terminal-ui.js';

test('compact default keeps 75 operations in native terminal scrollback, without clearing the screen', async () => {
  const log = new ActivityLog(undefined, false);
  if(process.env.BRC_CONSOLE_MODE !== 'verbose')
    assert.equal(log.getConsoleMode(), 'compact');
  // The launcher enables rolling mode only for TTY, so emulate it here without
  // changing process.stdout.isTTY in the whole test process.
  log.rollingConsole = true;
  const oldWrite = process.stdout.write;
  const chunks = [];
  process.stdout.write = function(s) { chunks.push(String(s)); return true; };
  try {
    for(let i=0; i<75; i++)
      log.tool('OK','read_file','call-'+i,10,undefined,'read /src/file-'+i+'.ts');
    await new Promise(resolve=>setTimeout(resolve,150));
    const visible = chunks.join('');
    assert.equal((visible.match(/\[OK\] read_file/g)??[]).length,75,
      'each completed call appends once; screen size does not discard it');
    assert.doesNotMatch(visible,/\x1b\[(?:2J|3J|H)/,
      'no full-screen erase, native terminal scrollback remains usable');
    assert.match(visible,/file-0\.ts/);
    assert.match(visible,/file-74\.ts/);
    const history = recentActivity(log.recent());
    assert.equal((history.match(/\[OK\] read_file/g)??[]).length,50);
    assert.doesNotMatch(history,/file-24\.ts/);
    assert.match(history,/file-25\.ts/);
    assert.match(history,/file-74\.ts/);
    assert.ok(Buffer.byteLength(history, 'utf8') < MAX_ACTIVITY_CONSOLE_BYTES);
  } finally {
    process.stdout.write = oldWrite;
    await log.close();
  }
});

test('a failed tool gets an actionable second line but success gets only one', () => {
  const ok = {timestamp:'2026-11-18T14:08:27Z',level:'info',id:'1',phase:'OK',
    tool:'edit_block',ms:5,action:'edit D:/.../components/admin/reservations-screen.tsx'};
  const failed = {...ok,level:'error',phase:'ERROR',tool:'run_command',
    note:'exit 1 | ESLint 428:89 react/no-unescaped-entities'};
  assert.equal(formatActivityEvent(ok,'compact',155).split('\n').length,1);
  const report = formatActivityEvent(failed,'compact',155);
  assert.equal(report.split('\n').length,2);
  assert.match(report,/exit 1.*ESLint 428:89/);
  assert.doesNotMatch(report,/Output preview|Arguments:/);
});

test('1 MiB total retained-text budget allocates 500 KiB to the console ring', async () => {
  assert.equal(MAX_ACTIVITY_LOG_BYTES,1024*1024);
  assert.equal(MAX_ACTIVITY_CONSOLE_BYTES,500*1024);
  assert.equal(MAX_ACTIVITY_QUEUE_BYTES,64*1024);
  assert.equal(MAX_ACTIVITY_EVENT_BYTES+MAX_ACTIVITY_CONSOLE_BYTES+MAX_ACTIVITY_QUEUE_BYTES,
    MAX_ACTIVITY_LOG_BYTES);
  const log = new ActivityLog(undefined,false);
  log.rollingConsole = true;
  log.scheduleRolling = () => {};
  for(let i=0;i<20000;i++)
    log.tool('OK','read_file','item-'+i,1,undefined,'file-'+i+'-'+('x'.repeat(40)));
  assert.ok(log.rollingBytes <= MAX_ACTIVITY_CONSOLE_BYTES);
  assert.ok(log.rollingBytes > 300*1024);
  assert.ok(log.eventsBytes <= MAX_ACTIVITY_EVENT_BYTES);
  assert.ok(log.rollingLines.length > 50);
  assert.ok(log.dropped > 0);
  assert.ok(!log.rollingLines.join('').includes('file-0-'));
  assert.ok(log.rollingLines.at(-1).includes('file-19999-'));
  assert.ok(log.queuedBytes<=MAX_ACTIVITY_QUEUE_BYTES);
  // No need to flush the synthetic 20,000-call test queue to the real console.
  log.consoleQueue.length=0;
  log.queuedBytes=0;
  await log.close();
});
