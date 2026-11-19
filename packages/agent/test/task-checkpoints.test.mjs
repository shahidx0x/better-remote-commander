import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {mkdtempSync,realpathSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

const scratch=mkdtempSync(path.join(realpathSync.native(os.tmpdir()),'brc-task-checkpoint-'));
process.env.BRC_HOME=path.join(scratch,'brc');
const {saveTaskCheckpoint,loadTaskCheckpoints,deleteTaskCheckpoint}=await import('../dist/runtime/task-checkpoints.js');
after(async()=>{delete process.env.BRC_TASK_PERSIST;await fs.rm(scratch,{recursive:true,force:true,maxRetries:6,retryDelay:80});});
const sample=(id=randomUUID())=>({
 version:1,id,root:path.join(scratch,'project'),goal:'Refactor the backend',
 scope:['src'],requiredChecks:['test'],baseline:[['src/a.ts','a'.repeat(64)]],
 state:'active',touchedAt:Date.now(),events:[{at:Date.now(),type:'started'}]
});

test('task checkpoints persist only bounded task metadata and hashes',async()=>{
 const c=sample();
 assert.equal(await saveTaskCheckpoint(c),true);
 const list=await loadTaskCheckpoints();
 assert.equal(list.length,1);
 assert.equal(list[0].goal,c.goal);
 assert.deepEqual(list[0].baseline,c.baseline);
 const p=path.join(process.env.BRC_HOME,'task-checkpoints',c.id+'.json');
 const body=await fs.readFile(p,'utf8');
 assert.ok(body.length<512*1024);
 assert.ok(!body.includes('sourceCode'));
 await deleteTaskCheckpoint(c.id);
 assert.deepEqual(await loadTaskCheckpoints(),[]);
});

test('corrupted, stale and oversized snapshots are ignored',async()=>{
 const corrupt=sample();
 const d=path.join(process.env.BRC_HOME,'task-checkpoints');
 await fs.mkdir(d,{recursive:true});
 await fs.writeFile(path.join(d,corrupt.id+'.json'),'{bad');
 const stale=sample();stale.touchedAt-=9*24*60*60*1000;
 await fs.writeFile(path.join(d,stale.id+'.json'),JSON.stringify(stale));
 const large=sample();large.goal='x'.repeat(600000);
 assert.equal(await saveTaskCheckpoint(large),false);
 assert.deepEqual(await loadTaskCheckpoints(),[]);
});

test('opt-out disables persistence and cannot return old records',async()=>{
 process.env.BRC_TASK_PERSIST='0';
 try{assert.equal(await saveTaskCheckpoint(sample()),false);assert.deepEqual(await loadTaskCheckpoints(),[]);}
 finally{delete process.env.BRC_TASK_PERSIST;}
});
