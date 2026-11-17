/** Optional restricted Linux-container execution; never silently falls back to the host. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ServerResult } from '../core/types.js';
import type { ToolDefinition } from '../core/tool-definitions.js';
import { rootPath, projectPath, listProjectFiles, sensitive } from '../runtime/workspace.js';
import { readBounded } from '../runtime/file-safety.js';
import { runProgram } from '../runtime/program-runner.js';
import { DockerTarget, inspectDocker } from '../runtime/docker-client.js';
import { createScratch, releaseScratch, pruneScratch, STAGE_LIMIT } from '../runtime/scratch-budget.js';
import { AgentError, result } from '../runtime/errors.js';
import { checkCancelled, getCallContext, withCallContext } from '../context.js';
export const SandboxSchema = z.object({
    path: z.string().min(1), image: DockerTarget,
    program: z.string().regex(/^(?:\/[A-Za-z0-9_.-]+)*\/?[A-Za-z0-9_][A-Za-z0-9_.-]*$/),
    args: z.array(z.string().max(8000).refine(s => !s.includes('\0'))).max(80).default([]),
    execute: z.boolean().default(false), timeout_ms: z.number().int().min(1000).max(100000).default(30000),
});
let running = false;
export function sandboxExcluded(file: string) {
    return file.split(/[\\/]/).some(part => sensitive(part) || ['.git', '.ssh', '.aws', '.azure', '.kube', '.docker', '.gnupg', '.npmrc', '.pypirc', '.netrc', '.git-credentials', '.htpasswd', '.terraform'].includes(part.toLowerCase()));
}
export function sandboxArgs(name: string, input: string, imageId: string, program: string, args: string[]) {
    if (/[\r\n,]/.test(input))
        throw new AgentError('UNSUPPORTED_PATH', 'Docker mount path contains an unsupported separator.');
    return ['run', '--rm', '--pull=never', '--name', name, '--label', 'brc.disposable=true',
        '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
        '--user', '65534:65534', '--pids-limit', '64', '--memory', '256m', '--memory-swap', '256m', '--cpus', '1',
        '--ulimit', 'nofile=1024:1024', '--log-driver=none', '--no-healthcheck',
        '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m,mode=1777',
        '--mount', `type=bind,source=${input},target=/workspace,readonly,bind-recursive=disabled`,
        '--workdir', '/workspace', '--env', 'HOME=/tmp', '--env', 'PYTHONDONTWRITEBYTECODE=1',
        '--env', 'DOTNET_CLI_TELEMETRY_OPTOUT=1', '--env', 'CARGO_NET_OFFLINE=true',
        '--entrypoint', program, imageId, ...args];
}
async function confirmLocalContext(cwd: string, run = runProgram) {
    // DOCKER_HOST overrides any context, so it must itself be a local endpoint even when DOCKER_CONTEXT is also set.
    if (process.env.DOCKER_HOST) {
        if (!/^(?:unix|npipe):\/\//.test(process.env.DOCKER_HOST))
            throw new AgentError('REMOTE_DOCKER_DENIED', 'Sandbox staging requires a local Unix socket or Windows named-pipe Docker endpoint.');
        return;
    }
    const q = await run('docker', ['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'], cwd, 5000);
    if (q.isError)
        throw new AgentError('DOCKER_UNAVAILABLE', 'Cannot inspect the Docker context; no execution occurred.');
    let endpoint: unknown;
    try {
        endpoint = JSON.parse(String(q.structuredContent?.stdout).trim());
    }
    catch { }
    if (typeof endpoint !== 'string' || !/^(?:unix|npipe):\/\//.test(endpoint))
        throw new AgentError('REMOTE_DOCKER_DENIED', 'Sandbox staging only supports a verified local Docker endpoint.');
}
export async function sandboxRun(raw: unknown, deps: {
    run?: typeof runProgram;
    inspect?: typeof inspectDocker;
} = {}) {
    const run = deps.run ?? runProgram, inspect = deps.inspect ?? inspectDocker;
    const a = SandboxSchema.parse(raw);
    if (process.env.DOCKER_HOST && !/^(?:unix|npipe):\/\//.test(process.env.DOCKER_HOST))
        throw new AgentError('REMOTE_DOCKER_DENIED', 'Sandbox requires a local Unix socket or Windows named-pipe Docker endpoint.');
    const root = await rootPath(a.path);
    await confirmLocalContext(root, run); // verify a local daemon before any daemon query
    const [image] = await inspect('image', [a.image], root);
    if (!image || image.os !== 'linux' || !/^sha256:[a-f0-9]{64}$/.test(image.id))
        throw new AgentError('SANDBOX_IMAGE_UNSUPPORTED', 'An existing local Linux image with an immutable ID is required. No image will be pulled.');
    if (image.volumes?.length)
        throw new AgentError('SANDBOX_IMAGE_VOLUMES', 'This image declares automatic writable volumes. Choose an image without VOLUME declarations.');
    const preview = { imageId: image.id, program: a.program, args: a.args, input: 'Sanitized disposable copy of non-ignored project files, at most 64 MiB; original files are never mounted.',
        restrictions: { network: 'none', originalWorkspaceWritable: false, rootFilesystem: 'read-only', user: '65534:65534', capabilities: 'none', memoryMiB: 256, tmpMiB: 64, cpu: 1, pids: 64, logDriver: 'none', pull: 'never' },
        warning: 'Container isolation reduces risk but is not a VM-grade guarantee. A trusted Docker daemon and trusted image are required. Only /tmp is writable; tests needing dependencies or writable project outputs may fail. Source may itself contain secrets despite filename exclusions.' };
    if (!a.execute)
        return result({ execute: false, ...preview, staged: false });
    if (running)
        throw new AgentError('SANDBOX_BUSY', 'One sandbox at a time keeps memory and staging bounded.', true);
    running = true;
    let scratch: string | undefined, name: string | undefined, cleanupConfirmed = true;
    const context = getCallContext();
    try {
        checkCancelled();
        const listing = await listProjectFiles(root, 2000);
        if (listing.truncated)
            throw new AgentError('SANDBOX_INPUT_LIMIT', 'Project is too large for bounded staging; narrow the root.');
        scratch = await createScratch();
        const input = path.join(scratch, 'input');
        await fs.mkdir(input, { mode: 0o755 });
        let bytes = 0, copied = 0, excluded = 0;
        for (const rel of listing.files) {
            checkCancelled();
            if (sandboxExcluded(rel)) {
                excluded++;
                continue;
            }
            const original = path.resolve(root, rel), st = await fs.lstat(original);
            if (!st.isFile() || st.isSymbolicLink()) {
                excluded++;
                continue;
            }
            const source = await projectPath(root, rel), data = await readBounded(source, 4 * 1024 * 1024);
            bytes += data.length;
            if (bytes > STAGE_LIMIT)
                throw new AgentError('SANDBOX_INPUT_LIMIT', 'Staged input exceeds 64 MiB. Narrow the root.');
            const target = path.join(input, rel);
            await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
            await fs.writeFile(target, data, { mode: 0o444, flag: 'wx' });
            copied++;
        }
        name = `brc-sandbox-${randomUUID()}`;
        cleanupConfirmed = false;
        const execution = await run('docker', sandboxArgs(name, input, image.id, a.program, a.args), root, a.timeout_ms, { maxOutputChars: 40000 });
        // Killing the CLI does not prove the container stopped. Remove exactly our UUID-named container, even on cancellation.
        const cleanup = await withCallContext({ ...context, id: `${context?.id ?? 'sandbox'}:cleanup`, client: context?.client ?? null, remote: context?.remote ?? false, signal: undefined, deadline: undefined }, () => run('docker', ['container', 'rm', '--force', name!], root, 5000));
        const cleanupText = String(cleanup.structuredContent?.stderr ?? '');
        cleanupConfirmed = !cleanup.isError || /No such container/i.test(cleanupText);
        return result({ ...preview, executed: true, stagedFiles: copied, stagedBytes: bytes, excludedFiles: excluded,
            execution: execution.structuredContent, cleanupConfirmed, ...(cleanupConfirmed ? {} : { leftoverContainer: name }),
            note: 'Execution output is live response data, not a saved transcript. No host-shell fallback, image pull/build, production-container change, or automatic code copy-back.' }, !!execution.isError || !cleanupConfirmed);
    }
    finally {
        // If cancellation arrived before normal cleanup, still attempt removal. Never target an existing user container.
        if (name && !cleanupConfirmed) {
            await withCallContext({ ...context, id: 'sandbox-cleanup', client: null, remote: false, signal: undefined }, () => run('docker', ['container', 'rm', '--force', name!], root, 3000)).catch(() => { });
        }
        if (scratch) {
            await releaseScratch(scratch).catch(() => { });
            await pruneScratch(0).catch(() => { });
        }
        running = false;
    }
}
export function sandboxStatus() { return { running, concurrency: 1, stageLimitBytes: STAGE_LIMIT, automaticExecution: false }; }
export const SANDBOX_TOOL_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<ServerResult>> = {
    sandbox_run: (a) => sandboxRun(a) as Promise<ServerResult>,
};
export function buildSandboxToolDefinitions(): ToolDefinition[] {
    return [{
        name: 'sandbox_run',
        description: [
            'Optional Linux-Docker isolation for an explicitly requested program and args. path is the project root, image an EXISTING local Linux image (tag or ID), program an absolute or bare executable name inside the image.',
            'Preview by default (execute=false stages nothing); execute=true stages a sanitized copy (<=64 MiB; secrets files, .git and symlinks excluded) and runs it with no network, read-only root, all capabilities dropped, non-root user, 256 MiB memory, 1 CPU, 64 pids.',
            'Never pulls or builds images, never mounts the original project, Docker socket or host credentials, never falls back to the host shell. Only /tmp is writable; nothing is copied back. One sandbox at a time; only local Docker endpoints are accepted.',
            'Not a VM-grade boundary: it does not protect against a compromised daemon/kernel. Prefer normal commands for trusted work.',
        ].join('\n'),
        inputSchema: zodToJsonSchema(SandboxSchema) as ToolDefinition['inputSchema'],
        annotations: { title: 'Sandbox Run', readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    }];
}
