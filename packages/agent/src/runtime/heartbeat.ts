/** Small local heartbeat: never performs remote polling or captures arguments. */
export const LOG_HEARTBEAT_INTERVAL_MS=30_000;
export interface HeartbeatSnapshot{
 online:boolean;connecting:boolean;inFlight:number;
}
export interface HeartbeatLogStats{
 finished:number;failed:number;lastTool:string|null;
 retainedBytes:number;maxRetainedBytes:number;dropped:number;
}
/** Avoid printing identical idle heartbeats every 30 seconds. The original
 * 30-second check is preserved; terminal output is only written on state
 * changes or once every five minutes so users still see the agent is alive.
 * Memory occupancy is deliberately ignored: logging itself changes it.
 */
export const HEARTBEAT_IDLE_REFRESH_MS=5*60_000;
export interface HeartbeatCheckpoint { signature:string; printedAt:number }
export function heartbeatSignature(connection:HeartbeatSnapshot,stats:HeartbeatLogStats):string{
  return [connection.online,connection.connecting,Math.max(0,connection.inFlight),
    stats.finished,stats.failed,stats.lastTool??'',stats.dropped].join('|');
}
export function shouldPrintHeartbeat(previous:HeartbeatCheckpoint|null,
    connection:HeartbeatSnapshot,stats:HeartbeatLogStats,now=Date.now()):boolean{
  return !previous || previous.signature!==heartbeatSignature(connection,stats) ||
    now-previous.printedAt>=HEARTBEAT_IDLE_REFRESH_MS;
}
export function formatHeartbeat(connection:HeartbeatSnapshot,stats:HeartbeatLogStats):string{
 const status=connection.online?'ONLINE':connection.connecting?'CONNECTING':'OFFLINE';
 const last=typeof stats.lastTool==='string'&&/^[a-z0-9_-]{1,80}$/i.test(stats.lastTool)
   ?stats.lastTool:'none';
 const current=Math.ceil(Math.max(0,stats.retainedBytes)/1024);
 const maximum=Math.floor(stats.maxRetainedBytes/1024);
 return 'Heartbeat | '+status+' | active '+Math.max(0,connection.inFlight)+
   ' | completed '+stats.finished+' | errors '+stats.failed+
   ' | last '+last+' | log '+current+'/'+maximum+' KiB'+
   (stats.dropped>0?' | evicted '+stats.dropped:'');
}
