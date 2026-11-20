import test from 'node:test';
import assert from 'node:assert/strict';
import {formatActivityEvent} from '../dist/runtime/activity.js';
import {mymcpCallPreview,mymcpResultPreview} from '../dist/runtime/mymcp-console.js';

const at='2026-11-20T03:36:15.000Z';
const render=(tool,phase,trace,other={})=>formatActivityEvent({
  timestamp:at,level:phase==='ERROR'?'error':'info',phase,
  tool,id:'a82f91d1-2222-3333',ms:42,trace,...other
},'mymcp',120);

test('read_file displays a short result receipt instead of the entire JSX source',()=>{
  const source='export const secretValue = "must-not-appear";\n'.repeat(100);
  const input={path:'D:\\client-project\\shop-accounting\\src\\Dashboard.tsx'};
  const fullResult={content:[{type:'text',
    text:'[Reading 16 lines from start (total: 128 lines, 112 remaining)]\n\n'+source}]};
  const trace=mymcpResultPreview('read_file',fullResult,input);
  const displayed=render('read_file','OK',trace);
  assert.match(displayed,/✅ Tool call read_file completed/);
  assert.match(displayed,/Call #a82f91d1 • 42ms/);
  assert.match(displayed,/Result preview\n\s+File read successfully • 16 of 128 lines/);
  assert.match(displayed,/Target: .*shop-accounting\/src\/Dashboard\.tsx/);
  assert.ok(displayed.split('\n').length<=6);
  assert.doesNotMatch(displayed,/secretValue|export const|\\n|\\t|"content"/);
  assert.doesNotMatch(trace,/secretValue|must-not-appear/);
  // The actual tool result, not the logging preview, still includes the source.
  assert.match(fullResult.content[0].text,/secretValue/);
});

test('started tool uses only one line, including the tracking ID',()=>{
  const line=render('read_file','START',
    mymcpCallPreview('read_file',{path:'D:/project/app/page.tsx'}));
  assert.match(line,/🔧 Tool call read_file started\s+#a82f91d1/);
  assert.equal(line.split('\n').length,1);
  assert.doesNotMatch(line,/arguments|metadata|\{"path"/i);
});

test('failed code mode displays a safe code and an actionable recovery hint',()=>{
  const noisy='Aborted(Assertion failed: list_empty(&rt->gc_obj_list), JS_FreeRuntime)';
  const trace=mymcpResultPreview('code_mode',{
    isError:true,
    content:[{type:'text',text:noisy+' \n potentially sensitive code'}],
    structuredContent:{error:{code:'CODE_MODE_UNAWAITED_CALLS',message:noisy}}
  });
  const displayed=render('code_mode','ERROR',trace,{code:'CODE_MODE_UNAWAITED_CALLS'});
  assert.match(displayed,/❌ Tool call code_mode failed/);
  assert.match(displayed,/Operation failed • CODE_MODE_UNAWAITED_CALLS/);
  assert.match(displayed,/Next: Await all tools.call\(\) operations/);
  assert.doesNotMatch(displayed,/Assertion failed|JS_FreeRuntime|potentially sensitive code|"content"/);
});

test('list_directory prints only counts, not hundreds of file entries',()=>{
  const result={content:[{type:'text',
    text:Array.from({length:100},(_,i)=>i%2?'[FILE] file'+i:'[DIR] folder'+i).join('\n')}]};
  const displayed=render('list_directory','OK',
    mymcpResultPreview('list_directory',result,{path:'D:/projects/foo'}));
  assert.match(displayed,/50 files, 50 folders/);
  assert.doesNotMatch(displayed,/file99|folder98|\[FILE\]|\[DIR\]/);
  assert.ok(displayed.length<380);
});

test('sensitive file paths and content are not exposed in either preview',()=>{
  const args={path:'D:/project/.env'};
  const result={content:[{type:'text',text:'MONGODB_URI=private secret'}]};
  const start=render('read_file','START',mymcpCallPreview('read_file',args));
  const end=render('read_file','OK',mymcpResultPreview('read_file',result,args));
  assert.doesNotMatch(start+end,/MONGODB_URI|private secret|D:\/project\/\.env/);
  assert.match(end,/\[private file\]/);
});
