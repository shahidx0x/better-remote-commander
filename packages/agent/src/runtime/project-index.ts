/** Optional filename-only cache. No source text, database or persistent index. */
import { spawn } from 'node:child_process';
import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { validatePath } from '../core/tools/filesystem.js';
import { getRipgrepPath } from '../core/utils/ripgrep-resolver.js';
import { AgentError } from './errors.js';
import { getCallContext, checkCancelled } from '../context.js';
import {sharedProjectManifest} from './project-manifest.js';
import {observeManagedChild,stopManagedChild} from './process-termination.js';
import {spawnManaged} from './managed-spawn.js';
interface Entry { root: string; accessedAt: number; memoryBytes: number; files: string[]; dirty: boolean; version: number; builtAt: number; truncated: boolean; watcher?: FSWatcher; watching: boolean; building?: Promise<void> }
const EXCLUDED = ['.git','node_modules','.next','dist','build','coverage','.turbo'];
export class ProjectIndex {
  private roots = new Map<string, Entry>();
  private watcherEvents=0;
  private watcherFailures=0;
  private staleScanRetries=0;
  private unstableScanRefusals=0;
  invalidate(file?: string): void {
    sharedProjectManifest.invalidate(file);
    for (const e of this.roots.values()) {
      const relative=file?path.relative(e.root,file):'';
      if(!file || relative==='' || (relative!=='..' && !relative.startsWith('..'+path.sep) && !path.isAbsolute(relative))){
        e.dirty=true;e.version++;
      }
    }
  }
  status() { return [...this.roots.values()].map(e => ({ root:e.root, files:e.files.length, memoryBytes:e.memoryBytes, watching:e.watching, dirty:e.dirty || Date.now()-e.builtAt>(e.watching?5*60_000:30_000), builtAt:e.builtAt, truncated:e.truncated, persistent:false,
    watcherEvents:this.watcherEvents,watcherFailures:this.watcherFailures,
    staleScanRetries:this.staleScanRetries,unstableScanRefusals:this.unstableScanRefusals })); }
  async manage(root: string, action: string, query = '', watchFiles = true, limit = 100) {
    root = await validatePath(root); // Re-check policy on every access, including cached roots.
    const key = process.platform === 'win32' ? root.toLowerCase() : root;
    let e = this.roots.get(key);
    if (action === 'disable') { e?.watcher?.close(); this.roots.delete(key); return { root, enabled:false }; }
    if (!e) {
      if (!['enable','refresh'].includes(action)) throw new AgentError('INDEX_DISABLED', 'Enable the optional project index first.');
      this.pruneIdle();
      if(this.roots.size>=4){const old=[...this.roots.entries()].filter(([,v])=>!v.building).sort((a,b)=>a[1].accessedAt-b[1].accessedAt)[0];if(old){old[1].watcher?.close();this.roots.delete(old[0]);}}
      if(this.roots.size>=4)throw new AgentError('INDEX_BUSY','All indexes are active.');
      e = {root,accessedAt:Date.now(),memoryBytes:0,files:[],dirty:true,version:0,builtAt:0,truncated:false,watching:false}; this.roots.set(key,e);
    }
    e.accessedAt=Date.now();
    if (watchFiles && !e.watcher) {
      const entry = e;
      try {
        e.watcher = watch(root, { recursive:true, persistent:false }, (_event,name) => {
          if (name && name.toString().split(/[\\/]/).some(p => EXCLUDED.includes(p))) return;
          entry.dirty = true; entry.version++;this.watcherEvents++;sharedProjectManifest.invalidate(root);
        });
        e.watching = true;
        e.watcher.on('error', () => { entry.watcher?.close(); entry.watcher=undefined; entry.watching=false; entry.dirty=true; entry.version++;this.watcherFailures++;sharedProjectManifest.invalidate(root); });
      } catch { e.watching=false;this.watcherFailures++; }
    }
    if (!watchFiles && e.watcher) { e.watcher.close(); e.watcher=undefined; e.watching=false; }
    if (action === 'refresh') {e.dirty=true;sharedProjectManifest.invalidate(root);}
    // A working watcher invalidates immediately. Avoid a full enumeration
    // every 30 seconds on unchanged projects; still perform periodic integrity
    // refresh, and refresh often when watching is unavailable.
    const age=Date.now()-e.builtAt;
    if(e.dirty || age>(e.watching?5*60_000:30_000))await this.refresh(e);
    // A watcher may report an external write DURING the first ripgrep scan.
    // A cached filename list with dirty=true is not authoritative even if the
    // scan itself returned success. Retry one READ-ONLY scan, never a mutation.
    if(e.dirty){
      this.staleScanRetries++;
      await this.refresh(e);
      if(e.dirty){
        this.unstableScanRefusals++;
        throw new AgentError('INDEX_CHANGED',
          'Project files changed during two index scans. Retry after filesystem activity settles.');
      }
    }
    checkCancelled();
    const q = query.toLowerCase();
    // Count all matches for accurate totals, but retain only the requested
    // result prefix. Avoid allocating a second list of up to 20k filenames.
    const selected:string[]=[];
    let total=0;
    for(const file of e.files){
      if(q && !file.toLowerCase().includes(q))continue;
      total++;
      if(selected.length<limit)selected.push(file);
    }
    // Validate returned paths too; a watcher is a freshness hint, not an access boundary.
    const safe: string[] = [];
    for(let i=0;i<selected.length;i+=3){
      checkCancelled();
      const verified=await Promise.all(selected.slice(i,i+3).map(async file=>{
        await validatePath(path.join(root,file));return file;
      }));
      safe.push(...verified);
    }
    return {root,files:safe,total,truncated:e.truncated || total>limit,stale:e.dirty,watching:e.watching,builtAt:e.builtAt,persistent:false};
  }
  private async refresh(e: Entry): Promise<void> {
    if (e.building) return e.building;
    e.building = this.build(e).finally(() => { e.building=undefined; });
    return e.building;
  }
  private async build(e: Entry): Promise<void> {
    const version=e.version;
    // Keep index enumeration exact: ripgrep may explicitly include hidden
    // filenames through .gitignore negations (e.g. .env.example), which a
    // "hidden => excluded" projection of --files --hidden cannot reproduce.
    // The shared cache continues serving source/graph/context callers;
    // index queries reuse ProjectIndex's own bounded per-root state.
    const rg = await getRipgrepPath();
    const signal=getCallContext()?.signal;
    signal?.throwIfAborted();
    const files:string[]=[];
    let bytes=0, buffer='', truncated=false;
    await new Promise<void>((resolve,reject) => {
      const args=['--files','--null',...EXCLUDED.flatMap(d => ['-g',`!${d}/**`]),'--','.'];
      const child=spawnManaged(rg,args,{cwd:e.root,windowsHide:true,stdio:['ignore','pipe','pipe']},'fast-read');
      observeManagedChild(child);
      let error='', timedOut=false;
      const abort=()=>{stopManagedChild(child);};
      const timer=setTimeout(()=>{timedOut=true;stopManagedChild(child);},15_000);
      signal?.addEventListener('abort',abort,{once:true});
      const done=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
      child.stdout!.setEncoding('utf8');
      child.stdout!.on('data',(chunk:string)=>{
        if(truncated)return;
        bytes+=Buffer.byteLength(chunk);
        if(bytes>4*1024*1024){truncated=true;stopManagedChild(child);return;}
        buffer+=chunk;
        const parts=buffer.split('\0');buffer=parts.pop()!;
        for(const f of parts){if(files.length>=20_000){truncated=true;stopManagedChild(child);break;}files.push(f.replace(/\\/g,'/').replace(/^\.\//,''));}
      });
      child.stderr!.on('data',(b:Buffer)=>{error=(error+b.toString()).slice(0,2000);});
      child.on('error',err=>{done();reject(err);});
      child.on('close',code=>{done();if(signal?.aborted)reject(signal.reason);else if(timedOut)reject(new AgentError('INDEX_TIMEOUT','Index build timed out. Narrow the project root.'));else if(code!==0 && code!==1 && !truncated)reject(new AgentError('INDEX_FAILED',error||'Could not list project files.'));else resolve();});
    });
    e.files=files.sort();e.memoryBytes=files.reduce((n,f)=>n+f.length*2+64,0);e.builtAt=Date.now();e.truncated=truncated;e.dirty=e.version!==version;
  }
  pruneIdle(now=Date.now(),all=false,ttl=300000){let n=0;for(const [key,e]of this.roots)if(!e.building&&(all||now-e.accessedAt>ttl)){e.watcher?.close();this.roots.delete(key);n++;}return n;}
  close():void {for(const e of this.roots.values())e.watcher?.close();this.roots.clear();}
}
export const projectIndex=new ProjectIndex();
