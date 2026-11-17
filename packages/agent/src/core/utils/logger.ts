import { activity } from '../../runtime/activity.js';
import type { FilteredStdioServerTransport } from '../custom-stdio.js';
declare global { var mcpTransport: FilteredStdioServerTransport | undefined; }
export type LogLevel = 'emergency'|'alert'|'critical'|'error'|'warning'|'notice'|'info'|'debug';
export function log(level:LogLevel,message:string,_data?:unknown):void{activity.log(level,message);}
export function logToStderr(level:LogLevel,message:string):void{activity.log(level,message);}
export const logger={emergency:(m:string,d?:unknown)=>log('emergency',m,d),alert:(m:string,d?:unknown)=>log('alert',m,d),critical:(m:string,d?:unknown)=>log('critical',m,d),error:(m:string,d?:unknown)=>log('error',m,d),warning:(m:string,d?:unknown)=>log('warning',m,d),notice:(m:string,d?:unknown)=>log('notice',m,d),info:(m:string,d?:unknown)=>log('info',m,d),debug:(m:string,d?:unknown)=>log('debug',m,d)};
