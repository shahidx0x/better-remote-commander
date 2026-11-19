// Opt-in shared project manifest: no file contents stored, and verification
// must always re-enumerate current source instead of trusting a cached name list.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {mkdtempSync,realpathSync} from 'node:fs';

const tmp=mkdtempSync(path.join(realpathSync.native(os.tmpdir()),'brc-manifest-'));
const root=path.join(tmp,'project');
process.env.BRC_HOME=path.join(tmp,'home');
process.env.BRC_ERROR_LOG='0';
process.env.BRC_LOG_LEVEL='silent';
const old=process.env.BRC_SHARED_PROJECT_MANIFEST;
process.env.BRC_SHARED_PROJECT_MANIFEST='1';
await fs.mkdir(path.join(root,'src'),{recursive:true});
await fs.mkdir(path.join(root,'.private'),{recursive:true});
await fs.mkdir(path.join(root,'.venv'),{recursive:true});
await fs.mkdir(path.join(root,'target'),{recursive:true});
await fs.mkdir(path.join(root,'bin','Debug','net8.0'),{recursive:true});
await fs.mkdir(path.join(root,'build'),{recursive:true});
await fs.writeFile(path.join(root,'src','a.ts'),'export const a=1;\n');
await fs.writeFile(path.join(root,'src','b.ts'),'export const b=2;\n');
await fs.writeFile(path.join(root,'.private','hidden.ts'),'export const hidden=true;\n');
await fs.writeFile(path.join(root,'.env'),'NEVER_SHOW_THIS_SECRET=1\n');
await fs.writeFile(path.join(root,'credentials.json'),'{"credential":"not meant for graph"}\n');
await fs.writeFile(path.join(root,'.venv','vendor.py'),'print("test")\n');
await fs.writeFile(path.join(root,'target','intermediate.rs'),'fn main() {}\n');
await fs.writeFile(path.join(root,'bin','Debug','net8.0','compiled.ts'),'export const compiled=1;\n');
await fs.writeFile(path.join(root,'build','generated.ts'),'export const gen=1;\n');
const {configManager}=await import('../dist/core/config-manager.js');
await configManager.setValue('allowedDirectories',[root]);
const {sharedProjectManifest}=await import('../dist/runtime/project-manifest.js');
const {listProjectFiles}=await import('../dist/runtime/workspace.js');
const {projectIndex}=await import('../dist/runtime/project-index.js');
const {codeGraph}=await import('../dist/runtime/code-graph.js');
const {sourceFingerprint}=await import('../dist/runtime/harness.js');
const names=r=>r.files.map(x=>x.replaceAll('\\','/').replace(/^\.\//,''));
after(async()=>{
 if(old===undefined)delete process.env.BRC_SHARED_PROJECT_MANIFEST;
 else process.env.BRC_SHARED_PROJECT_MANIFEST=old;
 sharedProjectManifest.clear();
 codeGraph.clear();
 projectIndex.close();
 await configManager.close();
 await fs.rm(tmp,{recursive:true,force:true,maxRetries:6,retryDelay:90});
});

test('index uses exact ripgrep rules while source lookups reuse shared file names',async()=>{
 sharedProjectManifest.clear();
 const initial=sharedProjectManifest.status().scans;
 const listing=await listProjectFiles(root,100);
 const srcNames=names(listing);
 assert.ok(srcNames.includes('src/a.ts'));
 assert.ok(srcNames.includes('.private/hidden.ts'),'source mode includes non-sensitive hidden paths');
 assert.ok(!srcNames.includes('.env'),'source mode must exclude secrets');
 assert.ok(!srcNames.includes('credentials.json'),'source mode must exclude sensitive names');
 assert.ok(!srcNames.includes('.venv/vendor.py'),'source mode excludes venv');
 assert.ok(!srcNames.includes('target/intermediate.rs'),'source mode excludes generated target tree');
 assert.ok(!srcNames.includes('bin/Debug/net8.0/compiled.ts'),'source mode excludes debug output');
 assert.ok(!srcNames.includes('build/generated.ts'),'base excludes build output');
 const idx=await projectIndex.manage(root,'enable','',false,100);
 const idxNames=names(idx);
 assert.ok(idxNames.includes('src/a.ts'));
 assert.ok(!idxNames.includes('.env'));
 assert.ok(!idxNames.includes('.private/hidden.ts'));
 assert.ok(idxNames.includes('target/intermediate.rs'),
  'index mode keeps nonhidden target files for original index semantics');
 assert.ok(idxNames.includes('bin/Debug/net8.0/compiled.ts'));
 assert.equal(sharedProjectManifest.status().scans-initial,1,
  'index uses its native exact ripgrep listing while source cache stays reusable');
 const repeated=await listProjectFiles(root,100);
 assert.ok(names(repeated).includes('src/a.ts'));
 assert.equal(sharedProjectManifest.status().scans-initial,1,
  'source callers reuse the existing shared source manifest');
 assert.ok(sharedProjectManifest.status().cacheHits>=1);
 assert.ok(sharedProjectManifest.status().retainedBytes>0);
 assert.equal(sharedProjectManifest.status().persistent,false);
 assert.equal(sharedProjectManifest.status().storedContent,false);
});

test('simultaneous callers share a single discovery, but one cancelled waiter cannot cancel another',async()=>{
 sharedProjectManifest.clear();
 const before=sharedProjectManifest.status().scans;
 const controller=new AbortController();
 const a=sharedProjectManifest.list(root,'source',100,{signal:controller.signal});
 const b=sharedProjectManifest.list(root,'index',100);
 controller.abort(new Error('one caller abandoned the scan'));
 await assert.rejects(a,/one caller abandoned the scan/);
 const done=await b;
 assert.ok(names(done).includes('src/a.ts'));
 assert.equal(sharedProjectManifest.status().scans-before,1);
 assert.ok(sharedProjectManifest.status().inflightJoins>=1);
 assert.equal(sharedProjectManifest.status().abortedUnusedScans,0);
});

test('index and graph invalidation refresh names without retaining stale source content',async()=>{
 sharedProjectManifest.clear();
 const initial=await projectIndex.manage(root,'refresh','addedPhase9',false,100);
 assert.equal(initial.total,0);
 const file=path.join(root,'src','addedPhase9.ts');
 await fs.writeFile(file,'export const addedPhase9=3;\n');
 projectIndex.invalidate(file);
 const after=await projectIndex.manage(root,'query','addedPhase9',false,100);
 assert.equal(after.total,1);
 assert.ok(after.files.some(x=>x.endsWith('addedPhase9.ts')));
 const a=await listProjectFiles(root,100);
 assert.ok(names(a).includes('src/addedPhase9.ts'));
 const before=sharedProjectManifest.status().scans;
 await codeGraph.get(root,60);
 assert.ok(sharedProjectManifest.status().scans>=before);
 assert.ok(codeGraph.status().some(s=>s.root===root));
});

test('sourceFingerprint always triggers a fresh scan, sees out-of-band additions and refuses stale fingerprints',async()=>{
 sharedProjectManifest.clear();
 const before=sharedProjectManifest.status().scans;
 const first=await sourceFingerprint(root);
 const second=await sourceFingerprint(root);
 assert.equal(sharedProjectManifest.status().scans-before,2,
  'each authoritative source fingerprint needs its own file enumeration');
 assert.equal(first.fingerprint,second.fingerprint);
 const extra=path.join(root,'src','unannounced.ts');
 await fs.writeFile(extra,'export const unannounced=9;\n');
 // Deliberately DO NOT issue any cache invalidation. Verification still
 // discovers the external file immediately.
 const next=await sourceFingerprint(root);
 assert.notEqual(next.fingerprint,first.fingerprint);
 assert.ok(next.hashes.has('src/unannounced.ts'));
});

test('manifest has exact prefix budget, bounded memory and no reuse when disabled',async()=>{
 sharedProjectManifest.clear();
 const tiny=await listProjectFiles(root,1);
 assert.equal(tiny.files.length,1);
 assert.equal(tiny.truncated,true);
 const normal=await listProjectFiles(root,100);
 assert.ok(normal.files.length>1);
 const metrics=sharedProjectManifest.status();
 assert.ok(metrics.roots<=4);
 assert.ok(metrics.files<=metrics.maxFilesPerRoot*metrics.maxRoots);
 assert.ok(metrics.retainedBytes<8*1024*1024);
 process.env.BRC_SHARED_PROJECT_MANIFEST='0';
 try{
  const fallback=await listProjectFiles(root,100);
  assert.ok(names(fallback).includes('src/a.ts'));
  assert.ok(!names(fallback).includes('.env'));
  assert.equal(sharedProjectManifest.status().enabled,false);
 }finally{process.env.BRC_SHARED_PROJECT_MANIFEST='1';}
});


test('shared and legacy graph/index views have equivalent file lists on a mixed repository',async()=>{
 sharedProjectManifest.clear();
 process.env.BRC_SHARED_PROJECT_MANIFEST='0';
 let sourceLegacy,indexLegacy;
 try{
  sourceLegacy=await listProjectFiles(root,200);
  indexLegacy=await projectIndex.manage(root,'refresh','',false,200);
 }finally{process.env.BRC_SHARED_PROJECT_MANIFEST='1';}
 sharedProjectManifest.clear();
 const sourceShared=await listProjectFiles(root,200);
 const indexShared=await projectIndex.manage(root,'refresh','',false,200);
 assert.deepEqual(names(sourceShared),names(sourceLegacy));
 assert.deepEqual(names(indexShared),names(indexLegacy));
 assert.equal(sourceShared.truncated,sourceLegacy.truncated);
 assert.equal(indexShared.total,indexLegacy.total);
});

test('cached names do not bypass updated allowed-directory policy',async()=>{
 sharedProjectManifest.clear();
 const cached=await listProjectFiles(root,100);
 assert.ok(names(cached).includes('src/a.ts'));
 const other=path.join(tmp,'other');
 await fs.mkdir(other,{recursive:true});
 await configManager.setValue('allowedDirectories',[other]);
 try{
  await assert.rejects(()=>listProjectFiles(root,100),
   /permission|allowed|access|outside|denied|path/i);
  await assert.rejects(()=>projectIndex.manage(root,'query','a.ts',false,10),
   /permission|allowed|access|outside|denied|path/i);
 }finally{await configManager.setValue('allowedDirectories',[root]);}
});


test('when all subscribers cancel, abort the unused scan and allow a later clean listing',async()=>{
 sharedProjectManifest.clear();
 const before=sharedProjectManifest.status().abortedUnusedScans;
 const controller=new AbortController();
 const first=sharedProjectManifest.list(root,'source',100,{signal:controller.signal});
 controller.abort(new Error('all callers cancelled'));
 await assert.rejects(first,/all callers cancelled/);
 assert.ok(sharedProjectManifest.status().abortedUnusedScans>before);
 // A re-request must not join the aborted enumeration or return an old
 // partially built listing.
 const again=await listProjectFiles(root,100);
 assert.ok(names(again).includes('src/a.ts'));
 assert.equal(sharedProjectManifest.status().inflightScans,0);
});
