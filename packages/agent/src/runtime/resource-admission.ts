/** Enabled-by-default, process-local bounded resource lanes for CPU-heavy command and
 * parser work, ripgrep I/O, and local plugin startup. This is NOT a
 * system-wide quota: background jobs and interactive terminals have their
 * own limits, and OS-enforced process and RAM containment remain separate.
 *
 * No args, paths or command output are stored here. Waiters are FIFO and
 * cancellation/timeout remove queued calls BEFORE spawning a child.
 */
import {AgentError} from './errors.js';
import {enabledByDefault} from './feature-defaults.js';

const DEFAULT_WAIT_MS=10000;
interface Waiter {
  done:boolean;started:number;signal?:AbortSignal;timeout:NodeJS.Timeout;
  abort:()=>void;resolve:(release:()=>void)=>void;reject:(error:unknown)=>void;
}
export class CommandCpuAdmission {
  private active=0;
  private queue:Waiter[]=[];
  private totalWaitMs=0;
  private maxWaitMs=0;
  private completed=0;
  private cancelled=0;
  private expired=0;
  private rejected=0;
  private recentWaits:number[]=[];
  constructor(private readonly enabled:()=>boolean=()=>enabledByDefault('BRC_SHARED_CPU_BUDGET'),
      private readonly maxActive=1,private readonly lane='CPU: commands and parsers',
      private readonly maxQueued=24){}
  status(){
    const sorted=[...this.recentWaits].sort((a,b)=>a-b);
    const percentile=(p:number)=>sorted.length?Math.round(sorted[Math.max(0,Math.ceil(sorted.length*p)-1)]):0;
    return {enabled:this.enabled(),active:this.active,queued:this.queue.length,
    maxActive:this.maxActive,maxQueued:this.maxQueued,lane:this.lane,
    completed:this.completed,cancelledQueued:this.cancelled,expiredQueued:this.expired,
    rejected:this.rejected,totalWaitMs:Math.round(this.totalWaitMs),maxWaitMs:Math.round(this.maxWaitMs),
    waitP50Ms:percentile(.5),waitP95Ms:percentile(.95),waitSamples:this.recentWaits.length,
    scope:'Default-on local permits; set the corresponding BRC_SHARED_*_BUDGET=0 to disable. Other execution paths keep their own limits; not an OS process, CPU or RSS quota.'};}
  private recordWait(ms:number){
    const waited=Math.max(0,ms);
    this.totalWaitMs+=waited;
    this.maxWaitMs=Math.max(this.maxWaitMs,waited);
    this.recentWaits.push(waited);
    if(this.recentWaits.length>64)this.recentWaits.shift();
  }
  private release():()=>void{
    let released=false;
    return ()=>{
      if(released)return;
      released=true;this.active=Math.max(0,this.active-1);this.completed++;
      this.drain();
    };
  }
  private drain(){
    while(this.active<this.maxActive && this.queue.length){
      const w=this.queue.shift()!;
      if(w.done)continue;
      w.done=true;clearTimeout(w.timeout);
      w.signal?.removeEventListener('abort',w.abort);
      const waited=Math.max(0,performance.now()-w.started);
      this.recordWait(waited);
      this.active++;
      w.resolve(this.release());
    }
  }
  async acquire(signal?:AbortSignal,maxWaitMs=DEFAULT_WAIT_MS):Promise<()=>void>{
    if(!this.enabled())return ()=>{};
    if(signal?.aborted)throw signal.reason??new AgentError('CANCELLED','Command was cancelled before admission.');
    if(this.active<this.maxActive && this.queue.length===0){
      this.recordWait(0);
      this.active++;return this.release();
    }
    if(this.queue.length>=this.maxQueued){
      this.rejected++;
      throw new AgentError('RESOURCE_ADMISSION_BUSY',
        'Resource admission queue is full ('+this.lane+'); no new task was started.',true);
    }
    const wait=Math.min(30_000,Math.max(1,Math.trunc(maxWaitMs)));
    return new Promise<()=>void>((resolve,reject)=>{
      const started=performance.now();
      const w:Waiter={
        done:false,started,signal,timeout:undefined as unknown as NodeJS.Timeout,
        abort:()=>{},resolve,reject
      };
      const fail=(error:unknown,expired:boolean)=>{
        if(w.done)return;
        w.done=true;clearTimeout(w.timeout);
        w.signal?.removeEventListener('abort',w.abort);
        const i=this.queue.indexOf(w);if(i>=0)this.queue.splice(i,1);
        if(expired)this.expired++;else this.cancelled++;
        reject(error);
      };
      w.abort=()=>fail(signal?.reason??new AgentError('CANCELLED',
        'Command was cancelled before CPU admission; no process was started.'),false);
      w.timeout=setTimeout(()=>fail(new AgentError('RESOURCE_ADMISSION_TIMEOUT',
        'Resource admission timed out ('+this.lane+'). No new task was started.'),true),wait);
      signal?.addEventListener('abort',w.abort,{once:true});
      this.queue.push(w);
      if(signal?.aborted)w.abort();
      else this.drain();
    });
  }
}
export const commandCpuAdmission=new CommandCpuAdmission();
export const searchIoAdmission=new CommandCpuAdmission(
  ()=>enabledByDefault('BRC_SHARED_IO_BUDGET'),2,'I/O: ripgrep sessions',16);
export const pluginStartupAdmission=new CommandCpuAdmission(
  ()=>enabledByDefault('BRC_SHARED_PROCESS_START_BUDGET'),2,'process startup: local plugins',16);
