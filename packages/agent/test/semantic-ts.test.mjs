// Optional TS compiler-backed navigation uses a lazy, memory-capped child.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {mkdtempSync,realpathSync} from 'node:fs';
const tmp=mkdtempSync(path.join(realpathSync.native(os.tmpdir()),'brc-semantic-ts-'));
const root=path.join(tmp,'project');
process.env.BRC_HOME=path.join(tmp,'home');
process.env.BRC_TS_SEMANTIC='0';
await fs.mkdir(path.join(root,'src'),{recursive:true});
await fs.writeFile(path.join(root,'package.json'),JSON.stringify({name:'semantic-fixture',type:'module',private:true}));
await fs.writeFile(path.join(root,'tsconfig.json'),JSON.stringify({compilerOptions:{
  target:'ES2022',module:'NodeNext',moduleResolution:'NodeNext',strict:true,noEmit:true,skipLibCheck:true
},include:['src/**/*.ts']}));
await fs.writeFile(path.join(root,'src','a.ts'),
  'export function computeValue(x:number){ return x + 1; }\n');
const main=[
  "import { computeValue } from './a.js';",
  'const result = computeValue(2);',
  '// computeValue in a comment is not a reference.',
  'const example = "computeValue";',
  'export { result };',
].join('\n')+'\n';
await fs.writeFile(path.join(root,'src','main.ts'),main);
await fs.writeFile(path.join(root,'src','unrelated.ts'),
  'export function computeValue(x:number){return 88;}\nconst other=computeValue(3);\n');
const {configManager}=await import('../dist/core/config-manager.js');
await configManager.setValue('allowedDirectories',[root]);
const {callTool}=await import('../dist/dispatcher.js');
const {semanticTsManager}=await import('../dist/runtime/semantic-ts-host.js');
const ok=r=>{assert.notEqual(r.isError,true,JSON.stringify(r.structuredContent?.error??r));return r.structuredContent;};
const bad=(r,code)=>{assert.equal(r.isError,true,JSON.stringify(r));assert.equal(r.structuredContent?.error?.code,code,JSON.stringify(r.structuredContent));};
const base={path:root,symbol:'computeValue',file:'src/main.ts',line:2,
 column:main.split('\n')[1].indexOf('computeValue')+1};
after(async()=>{
 semanticTsManager.close();
 delete process.env.BRC_TS_SEMANTIC;
 await configManager.close();
 await fs.rm(tmp,{recursive:true,force:true,maxRetries:7,retryDelay:90});
});

test('semantic navigation is disabled by default and never launches a child for lexical search',async()=>{
 assert.equal(semanticTsManager.status().activeProcess,false);
 const lexical=ok(await callTool('find_references',{path:root,symbol:'computeValue',maxResults:50}));
 assert.match(lexical.semantics,/Lexical/);
 assert.equal(semanticTsManager.status().activeProcess,false);
 bad(await callTool('find_references',{...base,mode:'semantic'}),'SEMANTIC_DISABLED');
 assert.equal(semanticTsManager.status().spawned,0);
});

test('TS compiler references distinguish imported symbol from same-name declaration, comments, and strings',async()=>{
 process.env.BRC_TS_SEMANTIC='1';
 const result=ok(await callTool('find_references',{...base,mode:'semantic',maxResults:100}));
 assert.equal(result.provider,'typescript-language-service');
 assert.equal(result.mode,'semantic');
 assert.equal(result.execution,false);
 assert.equal(result.modelCalls,0);
 assert.ok(result.matches.some(m=>m.file==='src/a.ts'),'expected declaration reference');
 assert.ok(result.matches.some(m=>m.file==='src/main.ts'&&m.line===2),'expected call reference');
 assert.ok(result.definitions.some(m=>m.file==='src/a.ts'),'expected compiler-resolved definition');
 assert.ok(result.matches.every(m=>m.file!=='src/unrelated.ts'),'separate symbols must not be conflated');
 assert.ok(result.matches.every(m=>!(m.file==='src/main.ts'&&m.line>=3)),
  'comments and strings are lexical matches, not semantic references');
 assert.equal(result.projectFilesTruncated,false);
 assert.ok(result.sourceFilesLoaded>=3);
 assert.ok(/^[0-9a-f]{64}$/.test(result.sourceSha256));
 assert.equal(semanticTsManager.status().activeProcess,true);
 assert.equal(semanticTsManager.status().maxWorkers,1);
 assert.equal(semanticTsManager.status().heapLimitMiB,160);
});

test('semantic mode validates arguments, source permissions and actual identifier at the requested position',async()=>{
 bad(await callTool('find_references',{path:root,symbol:'computeValue',mode:'semantic'}),'SEMANTIC_ARGUMENTS');
 bad(await callTool('find_references',{...base,mode:'semantic',filePattern:'*.ts'}),'SEMANTIC_ARGUMENTS');
 bad(await callTool('find_references',{...base,mode:'semantic',symbol:'notReallyHere'}),'SEMANTIC_QUERY_FAILED');
 bad(await callTool('find_references',{...base,mode:'semantic',file:'../outside.ts'}),'OUTSIDE_PROJECT');
});

test('worker is reused for warm queries, and shuts down on idle with no permanent subprocess',async()=>{
 const before=semanticTsManager.status().spawned;
 const second=ok(await callTool('find_references',{...base,mode:'semantic'}));
 assert.ok(second.matches.length>1);
 assert.equal(semanticTsManager.status().spawned,before,'warm navigation should reuse one child');
 const released=semanticTsManager.releaseIdle(Date.now()+61_000);
 assert.equal(released,1);
 assert.equal(semanticTsManager.status().activeProcess,false);
 const third=ok(await callTool('find_references',{...base,mode:'semantic'}));
 assert.ok(third.matches.length>1);
 assert.equal(semanticTsManager.status().spawned,before+1);
 semanticTsManager.close();
 assert.equal(semanticTsManager.status().activeProcess,false);
});


test('simultaneous semantic navigation cannot overwrite another pending IPC query',async()=>{
 process.env.BRC_TS_SEMANTIC='1';
 const first=semanticTsManager.query(root,base.file,base.symbol,base.line,base.column,50);
 const second=semanticTsManager.query(root,base.file,base.symbol,base.line,base.column,50);
 const answers=await Promise.allSettled([first,second]);
 assert.equal(answers.filter(x=>x.status==='fulfilled').length,1);
 const denied=answers.find(x=>x.status==='rejected');
 assert.equal(denied.reason?.code,'SEMANTIC_BUSY');
 const good=answers.find(x=>x.status==='fulfilled');
 assert.ok(good.value.references.some(x=>x.file==='src/a.ts'));
 assert.equal(semanticTsManager.status().busy,false);
 semanticTsManager.close();
});
