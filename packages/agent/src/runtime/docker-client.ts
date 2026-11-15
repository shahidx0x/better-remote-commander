/** Read-only Docker observation. No image builds, pulls, pruning, restarts or raw environment inspection. */
import { z } from 'zod';
import { runProgram } from './program-runner.js';
import { rootPath } from './workspace.js';
import { AgentError, result } from './errors.js';
export const DockerTarget = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,255}$/);
export const DockerInventorySchema = z.object({ path: z.string().min(1), includeStopped: z.boolean().default(true), includeImages: z.boolean().default(true), limit: z.number().int().min(1).max(200).default(80) });
export const DockerInspectSchema = z.object({ path: z.string().min(1), kind: z.enum(['container', 'image']), targets: z.array(DockerTarget).min(1).max(12) });
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
export async function dockerInventory(raw: unknown, query = dockerQuery) {
    const a = DockerInventorySchema.parse(raw), cwd = await rootPath(a.path);
    const calls = [query(['container', 'ls', ...(a.includeStopped ? ['--all'] : []), '--no-trunc', '--format', '{{json .}}'], cwd),
        a.includeImages ? query(['image', 'ls', '--no-trunc', '--digests', '--format', '{{json .}}'], cwd) : Promise.resolve(null)];
    const [containers, images] = await Promise.all(calls);
    const cs = containers!.rows.map(c => ({ id: c.ID, names: trim(c.Names), image: trim(c.Image), state: c.State, status: trim(c.Status), ports: trim(c.Ports, 1500) }));
    const ims = images?.rows.map(i => ({ id: i.ID, repository: trim(i.Repository), tag: trim(i.Tag), digest: i.Digest, size: i.Size, created: i.CreatedAt })) ?? [];
    const available = containers!.ok && (images?.ok ?? true);
    return result({ observedAt: new Date().toISOString(), available, complete: available && cs.length <= a.limit && ims.length <= a.limit,
        containers: containers!.ok ? cs.slice(0, a.limit) : null, images: images?.ok ? ims.slice(0, a.limit) : null,
        errors: [containers!.error, images?.error].filter(Boolean), counts: { containers: cs.length, images: ims.length },
        note: 'Fresh observation of the Docker CLI current context. null means unavailable/not requested, not empty. Check IDs/tags before proposing another image/container. No builds, pulls or changes were performed; do not infer filesystem image existence from a failed query.' }, !available);
}
export async function dockerInspect(raw: unknown) {
    const a = DockerInspectSchema.parse(raw), cwd = await rootPath(a.path);
    return result({ observedAt: new Date().toISOString(), kind: a.kind, items: await inspectDocker(a.kind, a.targets, cwd), environmentValuesOmitted: true });
}
