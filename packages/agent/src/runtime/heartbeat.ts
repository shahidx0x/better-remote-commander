/** Small local heartbeat: never performs remote polling or captures arguments. */
export const LOG_HEARTBEAT_INTERVAL_MS=30_000;
export interface HeartbeatSnapshot{
 online:boolean;connecting:boolean;inFlight:number;
}
export interface HeartbeatLogStats{
 finished:number;failed:number;lastTool:string|null;
 retainedBytes:number;maxRetainedBytes:number;dropped:number;
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
