/** Read-only Docker observation. No image builds, pulls, pruning, restarts or raw environment inspection. */
import { z } from 'zod';
import { runProgram } from './program-runner.js';
import { AgentError } from './errors.js';
export const DockerTarget = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,255}$/);
export interface DockerReply {
    ok: boolean;
    rows: Record<string, any>[];
    error?: string;
    truncated: boolean;
}
const trim = (v: unknown, max = 300) => typeof v === 'string' ? v.slice(0, max) : v;
export async function dockerQuery(args: string[], cwd: string, timeoutMs = 6000, run = runProgram): Promise<DockerReply> {
    const r = await run('docker', args, cwd, timeoutMs, { maxOutputChars: 400000 });
    const s = r.structuredContent!;
    if (r.isError)
        return { ok: false, rows: [], truncated: !!s.truncated, error: String((s.error as any)?.message ?? s.stderr ?? 'Docker command failed.').slice(0, 1200) };
    if (s.truncated)
        return { ok: false, rows: [], truncated: true, error: 'Docker output exceeds its cap. Narrow the query; an incomplete inventory is not empty.' };
    const rows: Record<string, any>[] = [];
    try {
        for (const line of String(s.stdout ?? '').split('\n').filter(s => s.trim())) {
            const value = JSON.parse(line);
            if (value && typeof value === 'object')
                rows.push(...(Array.isArray(value) ? value : [value]));
        }
    }
    catch {
        return { ok: false, rows: [], truncated: true, error: 'Docker returned an unsupported JSON response.' };
    }
    return { ok: true, rows, truncated: false };
}
export const IMAGE_FORMAT = '{"id":{{json .Id}},"tags":{{json .RepoTags}},"digests":{{json .RepoDigests}},"os":{{json .Os}},"architecture":{{json .Architecture}},"sizeBytes":{{json .Size}},"volumes":{{json .Config.Volumes}}}';
const CONTAINER_FORMAT = '{"id":{{json .Id}},"name":{{json .Name}},"imageId":{{json .Image}},"imageName":{{json .Config.Image}},"state":{{json .State.Status}},"running":{{json .State.Running}},"exitCode":{{json .State.ExitCode}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}},"ports":{{json .NetworkSettings.Ports}},"mounts":{{json .Mounts}}}';
export async function inspectDocker(kind: 'image' | 'container', targets: string[], cwd: string, query = dockerQuery) {
    targets.forEach(t => DockerTarget.parse(t));
    const q = await query([kind, 'inspect', '--format', kind === 'image' ? IMAGE_FORMAT : CONTAINER_FORMAT, '--', ...targets], cwd);
    if (!q.ok)
        throw new AgentError('DOCKER_UNAVAILABLE_OR_NOT_FOUND', q.error ?? 'Docker inspection failed.');
    return q.rows.map(v => kind === 'image' ? {
        id: v.id, tags: (v.tags ?? []).slice(0, 30), digests: (v.digests ?? []).slice(0, 20), os: v.os, architecture: v.architecture, sizeBytes: v.sizeBytes,
        volumes: Object.keys(v.volumes ?? {}).slice(0, 20),
    } : { id: v.id, name: trim(v.name), imageId: v.imageId, imageName: trim(v.imageName), state: v.state, running: v.running, exitCode: v.exitCode, health: v.health,
        ports: v.ports, mounts: (v.mounts ?? []).slice(0, 30).map((m: any) => ({ type: m.Type, source: trim(m.Source, 500), destination: trim(m.Destination, 500), writable: m.RW })) });
}

