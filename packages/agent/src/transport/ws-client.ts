import WebSocket from 'ws';
import os from 'node:os';
import { DEFAULTS,BRC_PROTOCOL_VERSION,parseMessage,type AgentMessage,type RelayMessage,type CallMessage,type DeviceInfo,type ToolDefinition,type ToolResult } from 'brc-shared';
import { withCallContext } from '../context.js';
import { OperationScheduler,cancelOperation } from '../runtime/operations.js';
import { AgentError,failure } from '../runtime/errors.js';
export interface WsClientOptions {
 relayUrl:string;token:string;deviceId:string;name:string;agentVersion:string;coreVersion:string;tools:ToolDefinition[];
 callTool:(name:string,args:Record<string,unknown>)=>Promise<unknown>;
 log?:(level:'info'|'warn'|'error'|'debug',msg:string)=>void;
 onUnauthorized?:()=>Promise<boolean>;
}
export class WsClient {
 private ws:WebSocket|null=null;
 private stopped=false;
 private settingsPaused=false;
 private callsInFlight=0;
 private backoff:number=DEFAULTS.reconnectMinMs;
 private pongTimer?:NodeJS.Timeout;
 private reconnectTimer?:NodeJS.Timeout;
 private unauthorizedCount=0;
 private scheduler=new OperationScheduler(Math.min(16,Math.max(1,Number(process.env.BRC_MAX_CONCURRENCY)||4)),32);
 private seen=new Map<string,number>();
 private readonly log:NonNullable<WsClientOptions['log']>;
 readonly wsUrl:string;
 constructor(private readonly opts:WsClientOptions){this.log=opts.log??(()=>{});this.wsUrl=WsClient.toWsUrl(opts.relayUrl);}
 static toWsUrl(url:string):string{
  const u=new URL(url);
  if(!['http:','https:','ws:','wss:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw new Error('Use a relay base URL without credentials, query or fragment.');
  if(u.pathname.endsWith('/mcp'))throw new Error('Use the relay base URL, not its /mcp endpoint.');
  u.protocol=u.protocol==='https:'?'wss:':u.protocol==='http:'?'ws:':u.protocol;
  if(!u.pathname.endsWith('/ws'))u.pathname=u.pathname.replace(/\/$/,'')+'/ws';
  return u.toString();
 }
 start():void{if(this.ws)return;this.stopped=false;this.connect();}
 stop():void{this.stopped=true;clearTimeout(this.pongTimer);clearTimeout(this.reconnectTimer);this.scheduler.cancelAll('Agent stopping.');const ws=this.ws;this.ws=null;ws?.close(1000,'agent stopped');}
 /** Pause only when idle: opening settings never cancels an in-flight tool call. */
 pauseForSettings():boolean{if(this.callsInFlight>0)return false;this.settingsPaused=true;return true;}
 resumeAfterSettings():void{this.settingsPaused=false;}
 private connect():void{
  if(this.stopped)return;
  this.log('info',`Connecting to ${this.wsUrl}`);
  const ws=new WebSocket(this.wsUrl,{headers:{Authorization:`Bearer ${this.opts.token}`,'X-BRC-Protocol':String(BRC_PROTOCOL_VERSION)},handshakeTimeout:15000,maxPayload:16*1024*1024});
  this.ws=ws;let unauthorized=false;
  ws.on('open',()=>{this.send({type:'hello',protocol:BRC_PROTOCOL_VERSION,device:this.deviceInfo(),tools:this.opts.tools},ws);this.armHeartbeat();this.log('info','Connected; waiting for relay welcome');});
  ws.on('message',data=>{if(this.ws===ws)void this.onMessage(data as Buffer,ws).catch(()=>this.log('error','Invalid relay message rejected'));});
  ws.on('unexpected-response',(_req,res)=>{unauthorized=res.statusCode===401||res.statusCode===403;this.log('error',`Relay refused connection: HTTP ${res.statusCode}`);res.resume();ws.terminate();});
  ws.on('close',(code)=>{
   if(this.ws!==ws)return;
   clearTimeout(this.pongTimer);this.ws=null;this.scheduler.cancelAll('Relay disconnected; active operations are not automatically retried.');
   if(this.stopped)return;
   if(code===4401||code===4403||unauthorized){void this.handleUnauthorized();return;}
   this.log('warn',`Disconnected (${code}); reconnecting`);this.retry();
  });
  ws.on('error',()=>this.log('warn','WebSocket connection error; waiting for reconnect'));
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
   case 'welcome':if(msg.protocol!==BRC_PROTOCOL_VERSION){this.stop();return;}this.backoff=DEFAULTS.reconnectMinMs;this.unauthorizedCount=0;this.log('info',`Ready: relay ${msg.relayVersion}; ${this.opts.tools.length} tools`);return;
   case 'ping':this.armHeartbeat();this.send({type:'pong',ts:msg.ts},ws);return;
   case 'cancel':if(typeof msg.id==='string')cancelOperation(msg.id);return;
   case 'call':await this.handleCall(msg,ws);return;
   case 'error':this.log('error',`Relay error ${msg.code}`);if(msg.fatal)this.stop();return;
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
  let out:ToolResult;
  try{
   if(this.seen.has(msg.id))throw new AgentError('DUPLICATE_CALL','This request was already received; not executing it twice.');
   this.seen.set(msg.id,Date.now());
   for(const [id,time]of this.seen){if(time<Date.now()-300000||this.seen.size>1000)this.seen.delete(id);else break;}
   const timeout=Math.min(115000,Math.max(100,Number(msg.timeoutMs)||DEFAULTS.callTimeoutMs));
   const deadline=Date.now()+timeout;
   const run=(signal?:AbortSignal)=>{executionStarted=performance.now();return withCallContext({id:msg.id,client:msg.client??null,remote:true,signal,deadline},()=>this.opts.callTool(msg.tool,msg.args)) as Promise<ToolResult>;};
   out=['agent_status','cancel_operation','stop_search','force_terminate'].includes(msg.tool)?await run():await this.scheduler.run(msg.id,msg.tool,timeout,run);
  }catch(err){out=failure(err,msg.id);}
  out={...out,_meta:{...out._meta,agentQueueMs:Math.max(0,Math.round(executionStarted-received)),agentTotalMs:Math.round(performance.now()-received)}};
  // Never route an old connection's result onto a new connection.
  if(this.ws===ws)this.send({type:'result',id:msg.id,result:out},ws);
  } finally {this.callsInFlight--;}
 }
 private send(msg:AgentMessage,ws=this.ws):void{
  if(ws?.readyState!==WebSocket.OPEN)return;
  let encoded=JSON.stringify(msg);
  if(Buffer.byteLength(encoded)>8*1024*1024&&msg.type==='result')encoded=JSON.stringify({type:'result',id:msg.id,result:failure(new AgentError('RESULT_TOO_LARGE','Result exceeds 8 MiB. Use smaller ranges; mutations may already have completed. Do not blindly retry.'))});
  if(ws.bufferedAmount>8*1024*1024){ws.terminate();return;}
  try{ws.send(encoded);}catch{ws.terminate();}
 }
 private deviceInfo():DeviceInfo{return{deviceId:this.opts.deviceId,name:this.opts.name,platform:process.platform,arch:process.arch,hostname:os.hostname(),agentVersion:this.opts.agentVersion,coreVersion:this.opts.coreVersion};}
 private armHeartbeat():void{clearTimeout(this.pongTimer);this.pongTimer=setTimeout(()=>{this.log('warn','Relay heartbeat missing; reconnecting');this.ws?.terminate();},DEFAULTS.pongTimeoutMs);}
}
