/** Execute an explicitly requested toolchain command without a shell or argument interpolation. */
import { spawn } from 'node:child_process';
import os from 'node:os';
import { validatePath } from '../core/tools/filesystem.js';
import { commandManager } from '../core/command-manager.js';
import { checkCancelled, getCallContext } from '../context.js';
import { AgentError, result } from './errors.js';
export async function runProgram(program: string, args: string[], cwd: string, timeoutMs = 60000, options: { maxOutputChars?: number; env?: NodeJS.ProcessEnv } = {}) {
    checkCancelled();
    cwd = await validatePath(cwd);
    if (!program || /[\r\n\0]/.test(program) || args.length > 100 || args.some(a => a.includes('\0')))
        throw new AgentError('INVALID_PROGRAM', 'Invalid executable or argument list.');
    if (!await commandManager.validateCommand(program))
        throw new AgentError('COMMAND_DENIED', 'Toolchain executable is blocked by agent policy.');
    const env = { ...process.env, ...options.env, CARGO_NET_OFFLINE: 'true', GOPROXY: 'off', GOSUMDB: 'off', DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1', DOTNET_NOLOGO: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1' };
    delete (env as NodeJS.ProcessEnv).NODE_TEST_CONTEXT;
    const signal = getCallContext()?.signal, started = Date.now();
    const outputLimit = Math.min(500000, Math.max(2000, options.maxOutputChars ?? 20000));
    return new Promise<ReturnType<typeof result>>((resolve) => {
        let stdout = '', stderr = '', truncated = false, timedOut = false, cancelled = false, done = false, fallback: NodeJS.Timeout | undefined;
        const child = spawn(program, args, { cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], shell: false });
        if (process.platform === 'win32' && child.pid) {
            try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); }
            catch { /* priority adjustments are best effort only */ }
        }
        const capture = (old: string, chunk: string) => { const s = old + chunk; if (s.length > outputLimit) {
            truncated = true;
            return s.slice(0, Math.floor(outputLimit * .25)) + '\n[output truncated]\n' + s.slice(-Math.floor(outputLimit * .7));
        } return s; };
        const finish = (exitCode: number | null, error?: string) => { if (done)
            return; done = true; clearTimeout(timer); clearTimeout(fallback); signal?.removeEventListener('abort', abort); resolve(result({ program, args, exitCode, stdout, stderr, durationMs: Date.now() - started, timedOut, cancelled, truncated, ...(error ? { error: { code: 'PROGRAM_FAILED', message: error.slice(0, 1000), retryable: false } } : {}) }, !!error || exitCode !== 0 || timedOut || cancelled)); };
        const kill = () => {
            if (child.pid) {
                try {
                    if (process.platform === 'win32')
                        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => { try {
                            child.kill();
                        }
                        catch { } });
                    else
                        process.kill(-child.pid, 'SIGKILL');
                }
                catch {
                    try {
                        child.kill();
                    }
                    catch { }
                }
            }
            fallback = setTimeout(() => { child.stdout?.destroy(); child.stderr?.destroy(); child.unref(); finish(null, 'Process termination could not be confirmed.'); }, 2000);
        };
        const abort = () => { cancelled = true; kill(); };
        const timer = setTimeout(() => { timedOut = true; kill(); }, Math.min(110000, Math.max(1, timeoutMs)));
        signal?.addEventListener('abort', abort, { once: true });
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (s: string) => { stdout = capture(stdout, s); });
        child.stderr.on('data', (s: string) => { stderr = capture(stderr, s); });
        child.on('error', e => finish(null, e.message));
        child.on('close', code => finish(code));
        if (signal?.aborted)
            abort();
    });
}
