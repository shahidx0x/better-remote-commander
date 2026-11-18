import { AgentError } from './errors.js';
interface Operation { id:string; tool:string; started:number; state:'queued'|'running'; controller:AbortController }
const operations=new Map<string,Operation>();
// One CPU-heavy operation at a time in every profile. Up to two lightweight
// operations may proceed beside it, keeping reads responsive during long builds.
const HEAVY_TOOLS = new Set([
 'run_command','start_process','run_project_checks','verify_project',
 'code_graph','code_outline','code_context','code_relationships','code_symbols',
 'project_context','context_pack','ast_search','ast_rewrite','edit_block','workspace_batch',
 'write_file','move_file','delete_file','create_directory',
 'read_images','sandbox_run','project_index','code_diagnostics','find_symbols',
 'find_references','related_files','test_impact'
]);
export const isHeavyTool = (tool:string):boolean => HEAVY_TOOLS.has(tool);
export function operationStatus(){return [...operations.values()].map(o=>({id:o.id,tool:o.tool,state:o.state,elapsedMs:Date.now()-o.started,cancelRequested:o.controller.signal.aborted}));}
export function cancelOperation(id:string):boolean {const o=operations.get(id);if(!o)return false;o.controller.abort(new AgentError('CANCELLED','Operation cancelled.'));return true;}
interface Job<T=unknown>{operation:Operation;task:(signal:AbortSignal)=>Promise<T>;resolve:(v:T)=>void;reject:(e:unknown)=>void;timer:NodeJS.Timeout;abort:()=>void}
/** Bounded admission queue. Deadlines include time waiting for a worker. */
export class OperationScheduler{
 private active=0;
 private activeHeavy=0;
 private queue:Job<any>[]=[];
 private owned=new Set<Operation>();
 constructor(readonly concurrency=3,readonly capacity=32){}
 run<T>(id:string,tool:string,timeoutMs:number,task:(signal:AbortSignal)=>Promise<T>):Promise<T>{
  if(operations.has(id))return Promise.reject(new AgentError('DUPLICATE_CALL','Duplicate operation ID; not executed again.'));
  if(this.queue.length>=this.capacity)return Promise.reject(new AgentError('BUSY','Agent queue is full. Retry later.',true));
  const operation:Operation={id,tool,started:Date.now(),state:'queued',controller:new AbortController()};
  operations.set(id,operation);this.owned.add(operation);
  return new Promise<T>((resolve,reject)=>{
   const job:Job<T>={operation,task,resolve,reject,timer:setTimeout(()=>operation.controller.abort(new AgentError('TIMEOUT','Operation deadline expired.')),timeoutMs),abort:()=>{}};
   job.abort=()=>{if(operation.state==='queued'){const i=this.queue.indexOf(job);if(i>=0)this.queue.splice(i,1);this.clean(job);reject(operation.controller.signal.reason);}};
   operation.controller.signal.addEventListener('abort',job.abort,{once:true});
   this.queue.push(job);this.drain();
  });
 }
 private clean(job:Job<any>):void{clearTimeout(job.timer);job.operation.controller.signal.removeEventListener('abort',job.abort);if(operations.get(job.operation.id)===job.operation)operations.delete(job.operation.id);this.owned.delete(job.operation);}
 private drain():void{
  while(this.active<this.concurrency && this.queue.length){
   // A CPU-heavy job cannot occupy another core merely because I/O capacity is free.
   // Still admit following read-only jobs instead of blocking the whole connection.
   const i=this.queue.findIndex(j=>!isHeavyTool(j.operation.tool)||this.activeHeavy===0);
   if(i<0)break;
   const [job]=this.queue.splice(i,1);
   if(job.operation.controller.signal.aborted){this.clean(job);job.reject(job.operation.controller.signal.reason);continue;}
   const heavy=isHeavyTool(job.operation.tool);
   job.operation.state='running';this.active++;
   if(heavy)this.activeHeavy++;
   Promise.resolve().then(()=>job.task(job.operation.controller.signal)).then(job.resolve,job.reject).finally(()=>{
    this.clean(job);this.active--;
    if(heavy)this.activeHeavy--;
    this.drain();
   });
  }
 }
 cancelAll(reason='Connection closed.'):void{for(const o of [...this.owned])o.controller.abort(new AgentError('CANCELLED',reason));}
}
