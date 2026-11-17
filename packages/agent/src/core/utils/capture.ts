/** Compatibility with the vendored core. Diagnostic telemetry is permanently off. */
import { AsyncLocalStorage } from 'node:async_hooks';
const uiOriginCallContext=new AsyncLocalStorage<boolean>();
export function runInUiOriginCallContext<T>(fn:()=>T):T{return uiOriginCallContext.run(true,fn);}
export function isInsideUiOriginCall():boolean{return uiOriginCallContext.getStore()===true;}
export function isTelemetryDisabledByEnv():boolean{return true;}
export async function capture(_event:string,_properties?:any):Promise<void>{}
export async function captureBase(_url:string,_event:string,_properties?:any):Promise<void>{}
export const captureRemote=capture;
export const capture_call_tool=capture;
export const capture_ui_event=capture;
export function sanitizeError(error: any): { message: string, code?: string } {
    let errorMessage = '';
    let errorCode = undefined;

    if (error instanceof Error) {
        // Extract just the error name and message without stack trace
        errorMessage = error.name + ': ' + error.message;

        // Extract error code if available (common in Node.js errors)
        if ('code' in error) {
            errorCode = (error as any).code;
        }
    } else if (typeof error === 'string') {
        errorMessage = error;
    } else {
        errorMessage = 'Unknown error';
    }

    // Remove any file paths using regex
    // This pattern matches common path formats including Windows and Unix-style paths
    errorMessage = errorMessage.replace(/(?:\/|\\)[\w\d_.-\/\\]+/g, '[PATH]');
    errorMessage = errorMessage.replace(/[A-Za-z]:\\[\w\d_.-\/\\]+/g, '[PATH]');

    return {
        message: errorMessage,
        code: errorCode
    };
}
