import WebSocket from 'ws';
import os from 'node:os';
import { DEFAULTS,BRC_PROTOCOL_VERSION,parseMessage,type AgentMessage,type RelayMessage,type CallMessage,type DeviceInfo,type ToolDefinition,type ToolResult } from 'brc-shared';
import { withCallContext } from '../context.js';
import { OperationScheduler,cancelOperation } from '../runtime/operations.js';
import { AgentError,failure } from '../runtime/errors.js';
import { PluginAdmin } from './plugin-admin.js';
import { isTermuxRuntime } from '../runtime/platform-capabilities.js';
import { boundedAgentFrame,recordResultFrameQueued } from './result-budget.js';
import { connectionHealth } from './connection-health.js';
import {beginCallOutcome,settleCallOutcome,lookupCallOutcome,acknowledgeCallOutcome,type CallOutcomeRecord} from '../runtime/call-outcomes.js';
export interface WsClientOptions {
 relayUrl:string;token:string;deviceId:string;name:string;agentVersion:string;coreVersion:string;tools:ToolDefinition[];
 callTool:(name:string,args:Record<string,unknown>)=>Promise<unknown>;
 log?:(level:'info'|'warn'|'error'|'debug',msg:string)=>void;
 onUnauthorized?:()=>Promise<boolean>;
 onConnected?:()=>void;
}
export class WsClient {
 private ws:WebSocket|null=null;
 private stopped=false;
 private welcomed=false;
 private settingsPaused=false;
 private callsInFlight=0;
 private backoff:number=DEFAULTS.reconnectMinMs;
 private pongTimer?:NodeJS.Timeout;
 private reconnectTimer?:NodeJS.Timeout;
 private unauthorizedCount=0;
 private scheduler=new OperationScheduler(Math.min(3,Math.max(1,Number(process.env.BRC_MAX_CONCURRENCY)||(isTermuxRuntime()?2:3))),isTermuxRuntime()?16:32);
 private seen=new Map<string,number>();
 private readonly log:NonNullable<WsClientOptions['log']>;
 private readonly plugins:PluginAdmin;
 readonly wsUrl:string;
 constructor(private readonly opts:WsClientOptions){this.log=opts.log??(()=>{});this.wsUrl=WsClient.toWsUrl(opts.relayUrl);this.plugins=new PluginAdmin(m=>this.send(m),this.log);}
 static toWsUrl(url:string):string{
  const u=new URL(url);
  if(!['http:','https:','ws:','wss:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw new Error('Use a relay base URL without credentials, query or fragment.');
  if(u.pathname.endsWith('/mcp'))throw new Error('Use the relay base URL, not its /mcp endpoint.');
  u.protocol=u.protocol==='https:'?'wss:':u.protocol==='http:'?'ws:':u.protocol;
  if(!u.pathname.endsWith('/ws'))u.pathname=u.pathname.replace(/\/$/,'')+'/ws';
  return u.toString();
 }
 start():void{if(this.ws)return;this.stopped=false;this.welcomed=false;this.plugins.start();this.connect();}
 /** O(1) live console status; no heartbeat poll or network request. */
 status(){return {online:this.welcomed && this.ws?.readyState===WebSocket.OPEN,connecting:!!this.ws&&this.ws.readyState===WebSocket.CONNECTING,inFlight:this.callsInFlight,health:connectionHealth.snapshot()};}
 stop():void{this.stopped=true;this.welcomed=false;this.plugins.stop();clearTimeout(this.pongTimer);clearTimeout(this.reconnectTimer);this.scheduler.cancelAll('Agent stopping.');const ws=this.ws;this.ws=null;ws?.close(1000,'agent stopped');}
 /** Pause only when idle: opening settings never cancels an in-flight tool call. */
 pauseForSettings():boolean{if(this.callsInFlight>0)return false;this.settingsPaused=true;return true;}
 resumeAfterSettings():void{this.settingsPaused=false;}
 private connect():void{
  if(this.stopped)return;
  connectionHealth.record('connecting');
  this.log('info',`Connecting to ${this.wsUrl}`);
  const ws=new WebSocket(this.wsUrl,{headers:{Authorization:`Bearer ${this.opts.token}`,'X-BRC-Protocol':String(BRC_PROTOCOL_VERSION)},handshakeTimeout:15000,maxPayload:16*1024*1024});
  this.ws=ws;let unauthorized=false;
  ws.on('open',()=>{this.send({type:'hello',protocol:BRC_PROTOCOL_VERSION,device:this.deviceInfo(),tools:this.opts.tools},ws);this.armHeartbeat(ws);this.log('info','Connected; waiting for relay welcome');});
  ws.on('message',data=>{if(this.ws===ws)void this.onMessage(data as Buffer,ws).catch(()=>{connectionHealth.record('relay_error','INVALID_MESSAGE');this.log('error','Invalid relay message rejected');});});
  ws.on('unexpected-response',(_req,res)=>{unauthorized=res.statusCode===401||res.statusCode===403;connectionHealth.record('socket_error',`HTTP_${res.statusCode??'UNKNOWN'}`);this.log('error',`Relay refused connection: HTTP ${res.statusCode}`);res.resume();ws.terminate();});
  ws.on('close',(code)=>{
   if(this.ws!==ws)return;
   clearTimeout(this.pongTimer);this.ws=null;this.welcomed=false;
   connectionHealth.record('disconnected',code,this.callsInFlight);
   this.scheduler.cancelAll('Relay disconnected; active operations are not automatically retried.');
   if(this.stopped)return;
   if(code===4401||code===4403||unauthorized){void this.handleUnauthorized();return;}
   this.log('warn',`Disconnected (${code}); reconnecting`);this.retry();
  });
  ws.on('error',(error:Error & {code?:string})=>{connectionHealth.record('socket_error',error.code??'SOCKET_ERROR');this.log('warn','WebSocket '+(error.code??'connection error')+'; waiting for reconnect');});
 }
 private retry(delay=this.backoff):void{clearTimeout(this.reconnectTimer);this.reconnectTimer=setTimeout(()=>this.connect(),Math.round(delay*(.8+Math.random()*.4)));this.backoff=Math.min(this.backoff*2,DEFAULTS.reconnectMaxMs);}
 private async handleUnauthorized():Promise<void>{
  this.unauthorizedCount++;
  if(this.opts.onUnauthorized&&this.unauthorizedCount===1){
   const handled=await this.opts.onUnauthorized().catch(()=>false);
   if(handled||this.stopped)return;
  }
  this.log('error','Device authorization rejected; approve pairing or revoke this agent');
  if(!this.stopped)this.retry(Math.min(30000,10000*this.unauthorizedCount));
 }
 private async onMessage(raw:Buffer,ws:WebSocket):Promise<void>{
  const msg=parseMessage<RelayMessage>(raw);if(!msg)return;
  switch(msg.type){
   case 'welcome':if(msg.protocol!==BRC_PROTOCOL_VERSION){connectionHealth.record('relay_error','PROTOCOL_MISMATCH');this.stop();return;}this.welcomed=true;connectionHealth.record('connected');this.backoff=DEFAULTS.reconnectMinMs;this.unauthorizedCount=0;this.log('info',`Ready: relay ${msg.relayVersion}; ${this.opts.tools.length} tools`);this.plugins.sendStatus();try{this.opts.onConnected?.();}catch{}return;
   case 'ping':connectionHealth.ping();this.armHeartbeat(ws);this.send({type:'pong',ts:msg.ts},ws);return;
   case 'cancel':if(typeof msg.id==='string')cancelOperation(msg.id);return;
   case 'result_ack':
     if(msg.relayPersisted===true&&typeof msg.id==='string'&&msg.id.length>=8&&msg.id.length<=100)
       void acknowledgeCallOutcome(msg.id);
     return;
   case 'call':await this.handleCall(msg,ws);return;
   case 'plugin_admin':await this.plugins.handle(msg);return;
   case 'error':connectionHealth.record('relay_error',msg.code);this.log('error',`Relay error ${msg.code}`);if(msg.fatal)this.stop();return;
  }
 }
 private async handleCall(msg:CallMessage,ws:WebSocket):Promise<void>{
  if(typeof msg.id!=='string'||msg.id.length>100||typeof msg.tool!=='string'||!msg.args||typeof msg.args!=='object'||Array.isArray(msg.args))return;
  if(this.settingsPaused){
   this.send({type:'result',id:msg.id,result:failure(new AgentError('SETTINGS_OPEN','Local connection settings are open; this call was not executed.',true),msg.id)},ws);
   return;
  }
  this.callsInFlight++;
  try {
  const received=performance.now();let executionStarted=received;
  let out:ToolResult,receipt:CallOutcomeRecord|null=null;
  // Read-only commands can safely be reissued as fresh reads after a
  // disconnect. Only potentially side-effecting calls need durable metadata.
  const maybeMutation=this.opts.tools.find(t=>t.name===msg.tool)?.annotations?.readOnlyHint!==true;
  try{
   if(this.seen.has(msg.id))throw new AgentError('DUPLICATE_CALL',
     'This request was already received; never re-run a mutation based on a duplicate call id.');
   // Survive a local-agent restart without replaying a potentially
   // side-effecting tool with the same remote call id.
   if(maybeMutation&&(await lookupCallOutcome(msg.id)).found)
     throw new AgentError('DUPLICATE_CALL',
       'A prior call receipt exists. Query agent_status with lookupCallId; inspect actual state before any new mutation.');
   this.seen.set(msg.id,Date.now());
   for(const [id,time]of this.seen){if(time<Date.now()-300000||this.seen.size>1000)this.seen.delete(id);else break;}
   const timeout=Math.min(115000,Math.max(100,Number(msg.timeoutMs)||DEFAULTS.callTimeoutMs));
   const deadline=Date.now()+timeout;
   const run=(signal?:AbortSignal)=>{
     executionStarted=performance.now();
     return withCallContext({id:msg.id,client:msg.client??null,remote:true,signal,deadline},async()=>{
       if(maybeMutation)receipt=await beginCallOutcome(msg.id,msg.tool);
       if(signal?.aborted)throw signal.reason??new AgentError('CANCELLED','Remote call cancelled before execution.');
       return await this.opts.callTool(msg.tool,msg.args) as ToolResult;
     });
   };
   out=['agent_status','cancel_operation','stop_search','force_terminate'].includes(msg.tool)?await run():await this.scheduler.run(msg.id,msg.tool,timeout,run);
  }catch(err){out=failure(err,msg.id);}
  // Persist ONLY the observed outcome, not any arguments or payload.
  // Await settlement before the socket send: disconnect between these
  // steps must still permit lookup after reconnect or an agent restart.
  if(receipt)await settleCallOutcome(receipt,out,performance.now()-executionStarted);
  out={...out,_meta:{...out._meta,agentQueueMs:Math.max(0,Math.round(executionStarted-received)),agentTotalMs:Math.round(performance.now()-received)}};
  // Never route an old connection's result onto a new connection.
  if(this.ws===ws)this.send({type:'result',id:msg.id,result:out},ws);
  else connectionHealth.record('result_dropped','STALE_CONNECTION',this.callsInFlight);
  } finally {this.callsInFlight--;}
 }
 private send(msg:AgentMessage,ws=this.ws):void{
  if(ws?.readyState!==WebSocket.OPEN){if(msg.type==='result')connectionHealth.record('result_dropped','NOT_CONNECTED',this.callsInFlight);return;}
  let encoded:string,replaced=false;
  try {
    const frame=boundedAgentFrame(msg);
    replaced=frame.replaced;
    encoded=frame.encoded;
    if(frame.replaced){connectionHealth.record('result_dropped','OVERSIZED_RESULT',this.callsInFlight);this.log('warn','Oversized/invalid result replaced with bounded recovery error; call '+(msg.type==='result'?msg.id:'?'));}
  } catch(e) {
    this.log('warn','Unable to encode non-result WebSocket frame: '+(e instanceof Error?e.message:'unknown'));
    ws.terminate();
    return;
  }
  if(ws.bufferedAmount>8*1024*1024){connectionHealth.record('send_backpressure','BUFFER_LIMIT',this.callsInFlight);ws.terminate();return;}
  try{
    ws.send(encoded);
    if(msg.type==='result')recordResultFrameQueued(encoded,replaced);
  }catch{connectionHealth.record('socket_error','SEND_FAILED');ws.terminate();}
 }
 private deviceInfo():DeviceInfo{return{deviceId:this.opts.deviceId,name:this.opts.name,platform:isTermuxRuntime()?'android':process.platform,arch:process.arch,hostname:os.hostname(),agentVersion:this.opts.agentVersion,coreVersion:this.opts.coreVersion};}
 private armHeartbeat(ws:WebSocket):void{clearTimeout(this.pongTimer);this.pongTimer=setTimeout(()=>{
   // A timer from a replaced socket must not terminate the new connection.
   if(this.ws!==ws || this.stopped || ws.readyState!==WebSocket.OPEN)return;
   connectionHealth.record('heartbeat_missed','PONG_TIMEOUT',this.callsInFlight);
   this.log('warn','Relay heartbeat missing; reconnecting');ws.terminate();
  },DEFAULTS.pongTimeoutMs);}
}
