/** BRC-owned disposable execution inputs only. Never clean projects, Docker images, credentials or the relay DB. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { AgentError } from './errors.js';
export const SCRATCH_BUDGET = 256 * 1024 * 1024;
export const STAGE_LIMIT = 64 * 1024 * 1024;
const MARKER = 'brc-disposable-scratch-v1\n';
const active = new Set<string>();
export const scratchRoot = () => path.join(process.env.BRC_HOME ?? path.join(os.homedir(), '.brc'), 'scratch-v1');
export async function ownedScratch(create = false): Promise<string | null> {
    const root = scratchRoot(), stat = await fs.lstat(root).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT')
        return null; throw e; });
    if (!stat) {
        if (!create)
            return null;
        await fs.mkdir(root, { recursive: true, mode: 0o700 });
        await fs.writeFile(path.join(root, '.brc-owned'), MARKER, { flag: 'wx', mode: 0o600 });
    }
    else if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new AgentError('UNSAFE_CACHE_ROOT', 'Scratch directory must not be a symlink.');
    if (await fs.readFile(path.join(root, '.brc-owned'), 'utf8').catch(() => '') !== MARKER)
        throw new AgentError('UNOWNED_CACHE_ROOT', 'Refusing to modify an unrecognized scratch directory.');
    return root;
}
async function sizeOf(root: string): Promise<number> {
    let total = 0, count = 0;
    const queue = [root];
    while (queue.length) {
        for (const entry of await fs.readdir(queue.pop()!, { withFileTypes: true }).catch(() => [])) {
            const file = path.join(entry.parentPath, entry.name);
            if (entry.isSymbolicLink())
                continue;
            if (entry.isDirectory())
                queue.push(file);
            else if (entry.isFile())
                total += (await fs.lstat(file)).size;
            if (++count > 10000)
                throw new AgentError('SCRATCH_LIMIT', 'Owned scratch has too many entries; review it manually.');
        }
    }
    return total;
}
export async function pruneScratch(reserve = 0, now = Date.now()) {
    const root = await ownedScratch();
    if (!root)
        return { bytes: 0, removed: 0, budgetBytes: SCRATCH_BUDGET };
    const entries: {
        file: string;
        time: number;
        bytes: number;
        live: boolean;
    }[] = [];
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^sandbox-\d+-[a-f0-9-]{36}$/.test(entry.name))
            continue;
        const file = path.join(root, entry.name), marker = await fs.readFile(path.join(file, '.owner.json'), 'utf8').catch(() => '');
        let info: {
            kind?: string;
            pid?: number;
            created?: number;
        };
        try {
            info = JSON.parse(marker);
        }
        catch {
            continue;
        }
        if (info.kind !== 'brc-sandbox-input' || !Number.isFinite(info.created))
            continue;
        let live = active.has(file);
        if (!live && now - info.created! < 2 * 3600000 && Number.isInteger(info.pid)) {
            try {
                process.kill(info.pid!, 0);
                live = true;
            }
            catch { }
        }
        entries.push({ file, time: info.created!, bytes: await sizeOf(file), live });
    }
    entries.sort((a, b) => a.time - b.time);
    let total = entries.reduce((n, e) => n + e.bytes, 0), removed = 0;
    for (const e of entries)
        if (!e.live && (now - e.time > 2 * 3600000 || total + reserve > SCRATCH_BUDGET)) {
            await fs.rm(e.file, { recursive: true, force: true });
            total -= e.bytes;
            removed++;
        }
    if (total + reserve > SCRATCH_BUDGET)
        throw new AgentError('SCRATCH_BUDGET', 'Scratch budget is full with active inputs; no user files were deleted.');
    return { bytes: total, removed, budgetBytes: SCRATCH_BUDGET };
}
export async function createScratch() {
    const root = await ownedScratch(true);
    await pruneScratch(STAGE_LIMIT + 4096);
    const file = path.join(root!, `sandbox-${Date.now()}-${randomUUID()}`);
    await fs.mkdir(file, { mode: 0o700 });
    await fs.writeFile(path.join(file, '.owner.json'), JSON.stringify({ kind: 'brc-sandbox-input', created: Date.now(), pid: process.pid }), { mode: 0o600 });
    active.add(file);
    return file;
}
export async function releaseScratch(file: string) {
    if (!active.has(file))
        throw new AgentError('UNOWNED_CACHE', 'Only this process\'s own scratch inputs can be released.');
    try {
        await fs.rm(file, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
    finally {
        active.delete(file);
    }
}
