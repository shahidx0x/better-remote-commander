/** Project-root path helpers: every path used by project tools must stay inside the requested root (symlinks/junctions included). */
import fs from 'node:fs/promises';
import path from 'node:path';
import { validatePath } from '../core/tools/filesystem.js';
import { readBounded, decodeCode, sha256 } from './file-safety.js';
import { AgentError } from './errors.js';

export function inside(root: string, file: string): boolean {
    const relative = path.relative(root, file);
    return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
export async function rootPath(raw: string): Promise<string> {
    const valid = await validatePath(path.resolve(raw));
    let real: string;
    try { real = await fs.realpath(valid); }
    catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT')
            throw new AgentError('PROJECT_NOT_FOUND', 'Project folder does not exist. Check the absolute root path and retry.');
        throw e;
    }
    if (!(await fs.stat(real)).isDirectory())
        throw new AgentError('NOT_A_DIRECTORY', 'Project root must be a directory.');
    return real;
}
export async function projectPath(root: string, raw: string): Promise<string> {
    const absolute = path.resolve(root, raw);
    if (!inside(root, absolute))
        throw new AgentError('OUTSIDE_PROJECT', 'Path is outside the requested project.');
    // Check the project boundary before the wider allowed-directory policy.
    // Resolve the deepest EXISTING ancestor so a planned nested file works,
    // while a symlink/junction escaping this project still fails closed.
    let real: string;
    try { real = await fs.realpath(absolute); }
    catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        let parent = path.dirname(absolute);
        const missing = [path.basename(absolute)];
        while (true) {
            try {
                real = path.join(await fs.realpath(parent), ...missing);
                break;
            } catch (err) {
                if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
                // A dangling symlink/junction is not a safe "new folder".
                const stat = await fs.lstat(parent).catch((x:NodeJS.ErrnoException) => {
                    if (x.code === 'ENOENT') return null;
                    throw x;
                });
                if (stat?.isSymbolicLink())
                    throw new AgentError('OUTSIDE_PROJECT', 'A broken symlink/junction cannot be used as a project path.');
                const ancestor = path.dirname(parent);
                if (ancestor === parent)
                    throw new AgentError('PROJECT_NOT_FOUND', 'No existing ancestor for this project path.');
                missing.unshift(path.basename(parent));
                parent = ancestor;
            }
        }
    }
    if (!inside(root, real))
        throw new AgentError('OUTSIDE_PROJECT', 'Symlink or junction escapes the requested project.');
    await validatePath(real);
    return real;
}
export async function textFile(file: string, max = 2 * 1024 * 1024) {
    file = await validatePath(file);
    const bytes = await readBounded(file, max);
    return { path: file, bytes, text: decodeCode(bytes), sha256: sha256(bytes) };
}

/* ---- Project check helpers (appended): discovery is read-only; preferences/instructions are data, never executable authority. ---- */
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { getRipgrepPath } from '../core/utils/ripgrep-resolver.js';
import { atomicWrite, withFileLocks } from './file-safety.js';
import { checkCancelled, getCallContext } from '../context.js';
export const IGNORED_DIRS = ['.git', 'node_modules', '.next', 'dist', 'build', 'coverage', '.turbo', '.venv', 'venv', '__pycache__', 'target', 'obj', '.vs', '.gradle', '.dart_tool', '.pub-cache'];
export const PreferencesSchema = z.object({
    packageManager: z.enum(['pnpm', 'npm', 'yarn', 'bun']).optional(),
    instructions: z.array(z.string().max(1000)).max(30).optional(),
    verificationScripts: z.array(z.string().regex(/^[a-zA-Z0-9_.:-]+$/)).max(10).optional(),
    style: z.object({ indent: z.enum(['spaces', 'tabs']).optional(), indentSize: z.number().int().min(1).max(8).optional(), quotes: z.enum(['single', 'double']).optional(), semicolons: z.boolean().optional() }).strict().optional(),
}).strict();
export type Preferences = z.infer<typeof PreferencesSchema>;
const transientPreferences = new Map<string, Preferences>();
export const slash = (s: string) => s.replace(/\\/g, '/');
export function sensitive(file: string): boolean {
    const b = path.basename(file).toLowerCase();
    return /^\.env(?:\.|$)/.test(b) || /^(?:id_rsa|id_ed25519|credentials|secrets?)(?:\.|$)/.test(b) || /\.(?:pem|p12|pfx|key)$/.test(b);
}
/** Strip // and /* comments and trailing commas outside strings, then JSON.parse (no runtime dependency on the TypeScript compiler). */
export function parseJsonc(text: string): unknown {
    let out = '', i = 0;
    text = text.replace(/^\uFEFF/, '');
    while (i < text.length) {
        const c = text[i];
        if (c === '"') {
            let j = i + 1;
            while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
            out += text.slice(i, j + 1); i = j + 1;
        } else if (c === '/' && text[i + 1] === '/') {
            while (i < text.length && text[i] !== '\n') i++;
        } else if (c === '/' && text[i + 1] === '*') {
            const end = text.indexOf('*/', i + 2);
            i = end < 0 ? text.length : end + 2;
        } else { out += c; i++; }
    }
    // Trailing commas: remove commas followed (after whitespace) by } or ] outside strings.
    let clean = '';
    for (let k = 0; k < out.length; k++) {
        const c = out[k];
        if (c === '"') {
            let j = k + 1;
            while (j < out.length && out[j] !== '"') j += out[j] === '\\' ? 2 : 1;
            clean += out.slice(k, j + 1); k = j;
        } else if (c === ',' && (() => { const re = /\s*[}\]]/y; re.lastIndex = k + 1; return re.test(out); })()) {
            continue;
        } else clean += c;
    }
    return JSON.parse(clean);
}
export async function jsoncFile(file: string): Promise<{ value: any; sha256: string }> {
    const f = await textFile(file, 256 * 1024);
    try { return { value: parseJsonc(f.text), sha256: f.sha256 }; }
    catch (e) { throw new AgentError('INVALID_JSON', (e as Error).message.slice(0, 500)); }
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
                if (sensitive(name)) continue;
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
export async function readPreferences(root: string) {
    root = await rootPath(root);
    const file = path.join(root, '.brc', 'project.json');
    let saved: Preferences = {}, hash: string | undefined;
    if (await fs.lstat(file).catch(() => null)) {
        const p = await projectPath(root, file), j = await jsoncFile(p);
        saved = PreferencesSchema.parse(j.value);
        hash = j.sha256;
    }
    const memory = transientPreferences.get(root);
    return { preferences: { ...saved, ...memory, style: { ...saved.style, ...memory?.style } }, path: file, sha256: hash, persistent: !!hash, sessionOverride: !!memory };
}
export async function setPreferences(root: string, prefs: Preferences, persist = false, expected?: string) {
    root = await rootPath(root);
    prefs = PreferencesSchema.parse(prefs);
    if (/brc_(?:ak|dev)_[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9_.-]{20,}/i.test(JSON.stringify(prefs)))
        throw new AgentError('SECRET_IN_PREFERENCES', 'Store conventions, not credentials.');
    if (!persist) {
        if (!transientPreferences.has(root) && transientPreferences.size >= 8)
            throw new AgentError('CONTEXT_LIMIT', 'At most eight project preference overrides per agent session.');
        transientPreferences.set(root, prefs);
        return { ...await readPreferences(root), savedToDisk: false };
    }
    const dir = path.join(root, '.brc');
    await validatePath(dir);
    if (await fs.lstat(dir).catch(() => null)) await projectPath(root, dir);
    else await fs.mkdir(dir);
    const file = await projectPath(root, path.join(dir, 'project.json'));
    await withFileLocks([file], async () => {
        const exists = await fs.lstat(file).catch(() => null);
        if (exists && !expected)
            throw new AgentError('HASH_REQUIRED', 'Existing preferences require the current expected_sha256.');
        await atomicWrite(file, JSON.stringify(prefs, null, 2) + '\n', expected);
    });
    transientPreferences.delete(root);
    return { ...await readPreferences(root), savedToDisk: true, note: 'Only explicitly approved preferences are saved. This is configuration, not an activity log.' };
}
export async function packageInfo(root: string) {
    let manifest: any = {}, manifestHash: string | undefined;
    try {
        const j = await jsoncFile(await projectPath(root, 'package.json'));
        manifest = j.value;
        manifestHash = j.sha256;
    }
    catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    const prefs = await readPreferences(root);
    const lockfiles: string[] = [];
    for (const f of ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb'])
        if (await fs.lstat(path.join(root, f)).catch(() => null)) lockfiles.push(f);
    const declared = typeof manifest.packageManager === 'string' ? manifest.packageManager.split('@')[0] : undefined;
    const detected = lockfiles.includes('pnpm-lock.yaml') ? 'pnpm' : lockfiles.includes('yarn.lock') ? 'yarn' : lockfiles.some(f => f.startsWith('bun.lock')) ? 'bun' : 'npm';
    const packageManager = prefs.preferences.packageManager ?? (['pnpm', 'npm', 'yarn', 'bun'].includes(declared) ? declared : detected);
    const deps = { ...manifest.dependencies, ...manifest.devDependencies };
    const frameworks = ['next', 'react', 'vue', 'svelte', '@nestjs/core', 'hono', 'express', 'fastify', 'typescript', 'vitest', 'jest', '@playwright/test'].filter(k => deps[k]).map(name => ({ name, version: String(deps[name]).slice(0, 100) }));
    const scripts = Object.fromEntries(Object.entries(manifest.scripts ?? {}).filter(([k, v]) => typeof v === 'string' && k.length <= 100).slice(0, 100).map(([k, v]) => [k, String(v).slice(0, 2000)]));
    return { name: typeof manifest.name === 'string' ? manifest.name.slice(0, 200) : null, packageManager, packageManagerSource: prefs.preferences.packageManager ? 'preferences' : declared ? 'package.json' : lockfiles.length ? 'lockfile' : 'fallback', manifestHash, lockfiles, frameworks, scripts, engines: manifest.engines, preferences: prefs };
}
export function clearWorkspaceMemory() { transientPreferences.clear(); }
