import test from 'node:test';
import assert from 'node:assert/strict';
import {ActivityLog,activityAction,formatActivityEvent} from '../dist/runtime/activity.js';
import {summarizeCommandActivity} from '../dist/runtime/command-log-summary.js';
import {recentActivity} from '../dist/terminal-ui.js';

test('ESLint exit 1 shows actionable location and rule without raw output',()=>{
  const result=summarizeCommandActivity({
    isError:true,
    structuredContent:{exitCode:1,error:{code:'COMMAND_FAILED'}},
    content:[{type:'text',text:"$ pnpm exec eslint components/admin/reservations-screen.tsx\n"+
      " 428:89  error  apostrophe should be escaped  react/no-unescaped-entities\n"+
      "SECRET_NOT_FOR_CONSOLE"}
    ],
  });
  assert.equal(result.exitCode,1);
  assert.match(result.detail,/exit 1.*ESLint 428:89 react\/no-unescaped-entities/);
  assert.doesNotMatch(result.detail,/SECRET_NOT_FOR_CONSOLE|apostrophe should/);
});

test('short activity cards use 2-3 lines and retain job identity',()=>{
  const action=activityAction('run_command',{
    cwd:'D:\\client-project\\restaurants\\frontend',
    command:'pnpm exec eslint components/admin/reservations-screen.tsx --token SUPERPRIVATE',
  });
  assert.match(action,/pnpm eslint/);
  assert.match(action,/reservations-screen\.tsx/);
  assert.doesNotMatch(action,/SUPERPRIVATE|token/);
  const e={timestamp:'2026-11-18T14:08:27.000Z',level:'error',
    phase:'ERROR',tool:'run_command',id:'jmwm758yfed21',
    ms:4505,code:'EXIT_1',action,
    note:'Job jmwm758yfed21 | exit 1 | ESLint 428:89 react/no-unescaped-entities'};
  const display=formatActivityEvent(e,'compact',150);
  assert.equal(display.split('\n').length,3);
  assert.match(display,/FAIL.*run_command/);
  assert.match(display,/Task:.*reservations-screen\.tsx/);
  assert.match(display,/jmwm758yfed21.*react\/no-unescaped-entities/);
  const history=recentActivity([e],100);
  assert.match(history,/FAIL/);
  assert.doesNotMatch(history,/SUPERPRIVATE/);
});

test('polling disappears from compact stream but completion does not',async()=>{
  const log=new ActivityLog(undefined,false);
  log.setConsoleMode('compact');
  const resume=log.pauseConsole();
  log.tool('PENDING','run_command','request-123',1801,undefined,'pnpm build in frontend',
    'Job job-123 | running locally');
  const afterStart=log.consoleQueue.join('');
  assert.match(afterStart,/\[RUN\].*run_command/);
  assert.match(afterStart,/Job job-123/);
  log.tool('OK','wait_jobs','request-234',1,undefined,'job job-123');
  log.tool('OK','get_job','request-235',1,undefined,'job job-123');
  assert.equal(log.consoleQueue.join(''),afterStart,
    'routine status polling should not add another success line');
  log.tool('ERROR','run_command','job-123',4505,'EXIT_1','pnpm eslint in frontend',
    'Job job-123 | exit 1 | ESLint 428:89 react/no-unescaped-entities');
  assert.equal(log.consoleQueue.length,2);
  assert.match(log.consoleQueue[1],/\[FAIL\].*run_command/);
  assert.match(log.consoleQueue[1],/Task:/);
  assert.match(log.consoleQueue[1],/ESLint 428:89/);
  log.consoleQueue.length=0;log.queuedBytes=0;
  resume();await log.close();
});

test('no error claims on truly successful build result',()=>{
  const r=summarizeCommandActivity({isError:false,structuredContent:{exitCode:0},content:[]});
  assert.equal(r.detail,'exit 0');
});
