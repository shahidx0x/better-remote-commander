/** Provider-reported LLM usage, never inferred from MCP tool payload sizes. */
export interface UsageRecord { id:string; user_id:string; ts:number; day:string; provider:string; model:string; input_tokens:number; output_tokens:number }
export interface UsageDay { day:string; input_tokens:number; output_tokens:number; reports:number }
export type UsagePeriod = 'day'|'week'|'month';
export interface UsageBucket { key:string; label:string; input:number; output:number; total:number; reports:number }
const DAY=86_400_000;
const dayStart=(t:number)=>Math.floor(t/DAY)*DAY;
export const utcDay=(t:number)=>new Date(dayStart(t)).toISOString().slice(0,10);
export function validateUsageReport(x:unknown, user:string, now=Date.now()):UsageRecord {
  if(!x||typeof x!=='object'||Array.isArray(x)) throw Error('Expected a JSON object');
  const r=x as Record<string,unknown>;
  if(typeof r.event_id!=='string'|| !/^[A-Za-z0-9_-]{8,128}$/.test(r.event_id)) throw Error('Invalid event_id');
  const ts=r.timestamp===undefined?now:r.timestamp;
  if(typeof ts!=='number'||!Number.isSafeInteger(ts)||ts>now+300000||ts<now-400*DAY) throw Error('timestamp must be milliseconds within 400 days');
  const count=(key:string)=>{const v=r[key];if(typeof v!=='number'||!Number.isSafeInteger(v)||v<0||v>1e12)throw Error('Invalid '+key);return v};
  const input_tokens=count('input_tokens'),output_tokens=count('output_tokens');
  if(!input_tokens&&!output_tokens)throw Error('No tokens supplied');
  const str=(key:string)=>{const v=r[key];if(typeof v!=='string'|| !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,79}$/.test(v))throw Error('Invalid '+key);return v};
  return {id:r.event_id,user_id:user,ts,day:utcDay(ts),provider:str('provider'),model:str('model'),input_tokens,output_tokens};
}
const monday=(t:number)=>dayStart(t)-((new Date(t).getUTCDay()+6)%7)*DAY;
const start=(t:number,p:UsagePeriod)=>p==='day'?dayStart(t):p==='week'?monday(t):Date.UTC(new Date(t).getUTCFullYear(),new Date(t).getUTCMonth(),1);
const step=(t:number,p:UsagePeriod,i:number)=>p==='day'?t+i*DAY:p==='week'?t+i*7*DAY:Date.UTC(new Date(t).getUTCFullYear(),new Date(t).getUTCMonth()+i,1);
export function usageView(days:UsageDay[],period:UsagePeriod,now=Date.now()){
  const p:UsagePeriod=['day','week','month'].includes(period)?period:'day',today=start(now,p),len=p==='day'?14:12;
  const buckets:UsageBucket[]=[];const map=new Map<string,UsageBucket>();
  for(let i=len-1;i>=0;i--){
    const d=new Date(step(today,p,-i)),key=d.toISOString().slice(0,10);
    const label=d.toLocaleDateString('en-US',{month:'short',...(p==='month'?{year:'2-digit'}:{day:'numeric'}),timeZone:'UTC'});
    const b={key,label,input:0,output:0,total:0,reports:0};buckets.push(b);map.set(key,b);
  }
  for(const d of days){if(!/^\d{4}-\d{2}-\d{2}$/.test(d.day))continue;const key=new Date(start(Date.parse(d.day+'T00:00:00Z'),p)).toISOString().slice(0,10);const b=map.get(key);if(!b)continue;b.input+=d.input_tokens;b.output+=d.output_tokens;b.total+=d.input_tokens+d.output_tokens;b.reports+=d.reports}
  const totals=buckets.reduce((a,b)=>({input:a.input+b.input,output:a.output+b.output,total:a.total+b.total,reports:a.reports+b.reports}),{input:0,output:0,total:0,reports:0});
  return {period:p,buckets,totals,source:'provider-reported' as const};
}
export function formatTokens(n:number){return n>=1e9?(n/1e9).toFixed(2).replace(/\.?0+$/,'')+'B':n>=1e6?(n/1e6).toFixed(2).replace(/\.?0+$/,'')+'M':n>=1e3?(n/1e3).toFixed(1).replace(/\.0$/,'')+'K':n.toLocaleString('en-US')}
