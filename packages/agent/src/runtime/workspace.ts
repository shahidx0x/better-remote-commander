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
