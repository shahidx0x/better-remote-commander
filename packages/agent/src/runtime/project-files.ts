/** Project file enumeration shared by navigation tools. Ripgrep-backed, bounded, secret-aware. */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { getRipgrepPath } from '../core/utils/ripgrep-resolver.js';
import { rootPath } from './workspace.js';
import { AgentError } from './errors.js';
import { checkCancelled, getCallContext } from '../context.js';

export const IGNORED_DIRS = ['.git', 'node_modules', '.next', 'dist', 'build', 'coverage', '.turbo', '.venv', 'venv', '__pycache__', 'target', 'obj', '.vs', '.gradle', '.dart_tool', '.pub-cache'];
export const slash = (s: string) => s.replace(/\\/g, '/');
/** Likely credential files: never listed, indexed, graphed or summarised. */
export function sensitive(file: string): boolean {
    const b = path.basename(file).toLowerCase();
    return /^\.env(?:\.|$)/.test(b) || /^(?:id_rsa|id_ed25519|credentials|secrets?)(?:\.|$)/.test(b) || /\.(?:pem|p12|pfx|key)$/.test(b);
}
export async function listProjectFiles(root: string, limit = 5000): Promise<{ files: string[]; truncated: boolean }> {
    root = await rootPath(root);
    const rg = await getRipgrepPath();
    checkCancelled();
    const signal = getCallContext()?.signal;
    return new Promise((resolve, reject) => {
        const args = ['--files', '--hidden', '--null', '--no-config', ...IGNORED_DIRS.flatMap(d => ['-g', `!**/${d}/**`]), '-g', '!**/bin/Debug/**', '-g', '!**/bin/Release/**', '--', '.'];
        const child = spawn(rg, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        const files: string[] = [];
        let buffer = '', bytes = 0, truncated = false, error = '', timedOut = false;
        const abort = () => child.kill();
        const timer = setTimeout(() => { timedOut = true; child.kill(); }, 15000);
        signal?.addEventListener('abort', abort, { once: true });
        const clean = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
            if (truncated) return;
            bytes += Buffer.byteLength(chunk);
            if (bytes > 4 * 1024 * 1024) { truncated = true; child.kill(); return; }
            buffer += chunk;
            const parts = buffer.split('\0');
            buffer = parts.pop() ?? '';
            for (let name of parts) {
                name = slash(name).replace(/^\.\//, '');
                if (!name || sensitive(name)) continue;
                if (files.length >= limit) { truncated = true; child.kill(); break; }
                files.push(name);
            }
        });
        child.stderr.on('data', (b: Buffer) => { error = (error + b).slice(0, 1000); });
        child.on('error', e => { clean(); reject(e); });
        child.on('close', code => {
            clean();
            if (signal?.aborted) reject(signal.reason);
            else if (timedOut) reject(new AgentError('SEARCH_TIMEOUT', 'Project enumeration timed out. Narrow the project root.'));
            else if (code !== 0 && code !== 1 && !truncated) reject(new AgentError('SEARCH_FAILED', error || 'Project enumeration failed.'));
            else resolve({ files: files.sort(), truncated });
        });
    });
}
