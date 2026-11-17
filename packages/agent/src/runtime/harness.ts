/** Verified project checks. Only explicitly selected, discovered recipes run; nothing is installed and no repository text is executed as instructions. */
import { createHash } from 'node:crypto';
import { rootPath, projectPath, listProjectFiles } from './workspace.js';
import { readBounded, sha256 } from './file-safety.js';
import { AgentError } from './errors.js';
import { checkCancelled } from '../context.js';
import { checkCatalog } from './toolchains.js';
import { runProgram } from './program-runner.js';
import { handleRunCommand } from '../tools/brc-tools.js';
import type { ToolResult } from 'brc-shared';

const BINARY = /\.(?:png|jpe?g|gif|webp|avif|tiff?|heic|ico|pdf|zip|gz|7z|tar|exe|dll|so|dylib|node|wasm|woff2?|ttf|otf|mp[34]|mov|avi|db|sqlite(?:3)?|pdb|bin|class|jar|pyc)$/i;
const TOTAL_TIMEOUT_MS = 110000, STEP_OUTPUT_CHARS = 8000;

/** Hash of the non-ignored, non-secret source tree; used to detect edits made while checks ran. */
export async function sourceFingerprint(root: string) {
    const listed = await listProjectFiles(root, 15000);
    if (listed.truncated)
        throw new AgentError('VERIFICATION_SCOPE_TOO_LARGE', 'Too many paths for reliable verification. Use a narrower project root.');
    const files = listed.files.filter(f => !BINARY.test(f));
    if (files.length > 2500)
        throw new AgentError('VERIFICATION_SCOPE_TOO_LARGE', 'Verification is limited to 2500 source/config files. Narrow the root.');
    const h = createHash('sha256');
    let bytes = 0;
    for (const name of files) {
        checkCancelled();
        let data: Buffer;
        try { data = await readBounded(await projectPath(root, name), 8 * 1024 * 1024); }
        catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT')
                throw new AgentError('VERIFICATION_CHANGED', 'A source file disappeared during verification. Re-run checks after file changes finish.');
            throw e;
        }
        bytes += data.length;
        if (bytes > 32 * 1024 * 1024)
            throw new AgentError('VERIFICATION_SCOPE_TOO_LARGE', 'Verification source snapshots exceed 32 MiB. Narrow the root.');
        h.update(name + '\0' + sha256(data) + '\n');
    }
    return { fingerprint: h.digest('hex'), files: files.length, bytes, coverage: 'Non-ignored source/config/documentation files. Excludes secrets, binary assets and generated/dependency directories; not a full filesystem snapshot.' };
}
export async function discoverChecks(root: string) { return checkCatalog(root); }

type Step = { name: string; program?: string; args?: string[]; command?: string };
async function runSteps(cwd: string, commands: Step[]) {
    const started = Date.now(), steps: { name: string; passed: boolean; exitCode: unknown; timedOut?: boolean; cancelled?: boolean; output: string; outputTruncated: boolean }[] = [];
    for (const step of commands) {
        checkCancelled();
        const remaining = TOTAL_TIMEOUT_MS - (Date.now() - started);
        if (remaining <= 0) { steps.push({ name: step.name, passed: false, exitCode: null, timedOut: true, output: '', outputTruncated: false }); break; }
        let out: ToolResult;
        try {
            out = step.program
                ? await runProgram(step.program, step.args ?? [], cwd, remaining)
                : await handleRunCommand({ cwd, command: step.command, timeout_ms: remaining, maxOutputChars: 20000 }) as unknown as ToolResult;
        } catch (e) {
            // Policy/validation failures are a failed check, not a transport failure.
            if (e instanceof AgentError) { steps.push({ name: step.name, passed: false, exitCode: null, output: `${e.code}: ${e.message}`, outputTruncated: false }); break; }
            throw e;
        }
        const data = (out.structuredContent ?? {}) as Record<string, unknown>;
        const full = (out.content ?? []).filter(c => c?.type === 'text').map(c => String((c as { text?: string }).text ?? '')).join('\n');
        const passed = !out.isError && data.exitCode === 0;
        steps.push({ name: step.name, passed, exitCode: data.exitCode ?? null, ...(data.timedOut ? { timedOut: true } : {}), ...(data.cancelled ? { cancelled: true } : {}), output: full.slice(-STEP_OUTPUT_CHARS), outputTruncated: full.length > STEP_OUTPUT_CHARS });
        if (!passed) break;
    }
    return { steps, durationMs: Date.now() - started };
}

/** Preview (execute=false) or run (execute=true) discovered checks by name. Never accepts free-form commands. */
export async function runProjectChecks(rootRaw: string, names: string[], execute: boolean) {
    const root = await rootPath(rootRaw);
    if (!names.length) throw new AgentError('NO_CHECKS', 'Select at least one actual project check.');
    if (new Set(names).size !== names.length) throw new AgentError('INVALID_ARGUMENT', 'Check names must be unique.');
    const catalog = await checkCatalog(root);
    const commands: Step[] = names.map(name => {
        const recipe = catalog.candidates.find(r => r.name === name);
        if (!recipe) throw new AgentError('UNKNOWN_CHECK', `No discovered check named ${name}. Discover checks first.`);
        return recipe.program ? { name, program: recipe.program, args: recipe.args ?? [] } : { name, command: recipe.command };
    });
    if (!execute)
        return { root, execute: false, commands, packageManager: catalog.packageManager, note: 'Preview only. Nothing was executed.' };
    const before = await sourceFingerprint(root);
    const { steps, durationMs } = await runSteps(root, commands);
    const after = await sourceFingerprint(root);
    const stable = before.fingerprint === after.fingerprint;
    const passed = steps.length === names.length && steps.every(s => s.passed) && stable;
    const failed = steps.find(s => !s.passed);
    const error = passed ? undefined : stable
        ? { code: 'CHECK_FAILED', message: `Project check ${failed?.name ?? '(unknown)'} failed (exit code ${String(failed?.exitCode ?? 'unknown')}). Inspect steps[].output; this is a real check failure, not an agent transport failure.` }
        : { code: 'VERIFICATION_CHANGED', message: 'Project files changed during verification; rerun on a stable tree.' };
    return { root, execute: true, executed: true, passed, steps, skipped: names.length - steps.length, durationMs, ...(error ? { error } : {}),
        sourceStableDuringChecks: stable, fingerprint: after.fingerprint, coverage: after.coverage,
        note: stable ? 'Checks returned real exit codes. Passing only establishes the selected checks, not full correctness.' : 'Source changed while checks ran; result cannot be accepted. Re-run on a stable tree.' };
}
