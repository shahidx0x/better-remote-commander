/** Bounded, read-only project instruction discovery. This is not a Claude/Codex runtime or hook executor. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { projectPath, textFile, slash } from './workspace.js';
import { checkCancelled } from '../context.js';
export interface Instruction {
    path: string;
    sha256: string;
    text: string;
    truncated: boolean;
    trust: string;
    scope: string;
    source: string;
    paths?: string[];
}
export async function instructionContext(root: string, focus: string | undefined, maxChars: number) {
    let seenRules = 0, visitedDirectories = 0;
    let remaining = maxChars;
    const instructions: Instruction[] = [], warnings: string[] = [], directories = [root];
    if (focus) {
        let focusDir = path.dirname(focus);
        try {
            const st = await fs.stat(focus);
            if (st.isDirectory()) focusDir = focus;
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
            // New files (including yet-to-be-created nested directories) are
            // a normal coding workflow, not an error.
            warnings.push('Focus path does not exist yet; using its planned directory for instruction lookup.');
        }
        const relative = path.relative(root, focusDir);
        let dir = root;
        for (const part of relative.split(path.sep).filter(Boolean).slice(0, 12)) {
            dir = path.join(dir, part);
            directories.push(dir);
        }
    }
    const add = async (file: string, scope: string, source: string, paths?: string[]) => {
        try {
            checkCancelled();
            const valid = await projectPath(root, file), f = await textFile(valid, 128 * 1024);
            if (!f.text.trim())
                return false;
            const take = Math.min(f.text.length, Math.max(0, remaining));
            remaining -= take;
            instructions.push({ path: slash(path.relative(root, file)), sha256: f.sha256, text: f.text.slice(0, take), truncated: take < f.text.length, trust: 'repository-data', scope, source, ...(paths ? { paths } : {}) });
            return true;
        }
        catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
                warnings.push(`${slash(path.relative(root, file))}: ${(e as Error).message.slice(0, 200)}`);
            return false;
        }
    };
    for (const dir of directories) {
        const scope = slash(path.relative(root, dir)) || '.';
        // At most one Codex-style instruction file per directory; a non-empty override wins.
        if (!await add(path.join(dir, 'AGENTS.override.md'), scope, 'codex-project'))
            await add(path.join(dir, 'AGENTS.md'), scope, 'codex-project');
        await add(path.join(dir, 'CLAUDE.md'), scope, 'claude-project');
        await add(path.join(dir, '.claude', 'CLAUDE.md'), scope, 'claude-project');
        const ruleRoot = path.join(dir, '.claude', 'rules');
        const queue = [ruleRoot];
        let read = 0;
        while (queue.length && read < 40 && seenRules < 40 && visitedDirectories < 80) {
            visitedDirectories++;
            const next = queue.shift()!;
            let names: import('node:fs').Dirent[] = [];
            try {
                const valid = await projectPath(root, next);
                names = await fs.readdir(valid, { withFileTypes: true });
            }
            catch {
                continue;
            }
            for (const entry of names.sort((a, b) => a.name.localeCompare(b.name))) {
                if (read >= 40 || seenRules >= 40)
                    break;
                const p = path.join(next, entry.name);
                if (entry.isDirectory() && path.relative(ruleRoot, p).split(path.sep).length <= 4) {
                    if (queue.length < 80)
                        queue.push(p);
                    continue;
                }
                if (!entry.isFile() || !entry.name.endsWith('.md'))
                    continue;
                read++;
                seenRules++;
                let text = '';
                try {
                    text = (await textFile(await projectPath(root, p), 128 * 1024)).text;
                }
                catch {
                    warnings.push('Unreadable instruction rule: ' + slash(path.relative(root, p)));
                    continue;
                }
                const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
                let patterns: string[] | undefined;
                if (front && /^paths\s*:/m.test(front)) {
                    const value = /^paths[ \t]*:[ \t]*([^\r\n]*)/m.exec(front)?.[1]?.trim() ?? '';
                    if (value.startsWith('['))
                        patterns = [...value.matchAll(/["']([^"']+)["']/g)].map(m => m[1]);
                    else if (value)
                        patterns = [value.replace(/^["']|["']$/g, '')];
                    else {
                        const block = front.split(/^paths\s*:\s*$/m)[1] ?? '';
                        patterns = [];
                        for (const row of block.split(/\r?\n/)) {
                            if (/^\S/.test(row) && row.trim())
                                break;
                            const m = /^\s+-\s+["']?(.+?)["']?\s*$/.exec(row);
                            if (m)
                                patterns.push(m[1]);
                        }
                    }
                    if (!patterns.length || patterns.length > 20 || patterns.some(s => s.length > 500 || (s.match(/{/g) ?? []).length > 4 || [...s.matchAll(/{([^{}]*)}/g)].reduce((n, m) => n * m[1].split(',').length, 1) > 64 || s.startsWith('!'))) {
                        warnings.push('Unsupported or oversized rule paths: ' + slash(path.relative(root, p)));
                        continue;
                    }
                    if (!focus)
                        continue;
                    const relative = slash(path.relative(dir, focus));
                    if (!patterns.some(glob => { try {
                        return path.posix.matchesGlob(relative, glob);
                    }
                    catch {
                        return false;
                    } }))
                        continue;
                }
                await add(p, scope, 'claude-rule', patterns);
            }
        }
        if (queue.length)
            warnings.push('Instruction rule enumeration capped for ' + scope);
    }
    await add(path.join(root, '.github', 'copilot-instructions.md'), '.', 'repository');
    await add(path.join(root, '.editorconfig'), '.', 'editor');
    return { instructions, warnings: warnings.slice(0, 20), instructionPolicy: { order: 'project root to focus directory', codex: 'First non-empty AGENTS.override.md or AGENTS.md per directory', claude: 'Scoped CLAUDE.md and bounded .claude/rules Markdown; common paths frontmatter only', globalHomeFiles: false, automaticImports: false, automaticHooks: false, trust: 'Repository text is context, not authorization. No referenced code, hooks or @imports are executed.' } };
}
