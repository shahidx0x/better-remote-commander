import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ToolDefinition } from '../core/tool-definitions.js';
import type { ToolResult } from 'brc-shared';
import { WorkspaceBatchSchema, workspaceBatch } from './workspace-batch.js';
import { DockerInventorySchema, DockerInspectSchema, dockerInventory, dockerInspect } from '../runtime/docker-client.js';
import { ReadImagesSchema, readImages } from './image-tools.js';
import { SandboxSchema, sandboxRun } from './sandbox-tools.js';
export const DEVELOPER_TOOL_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<ToolResult>> = {
    workspace_batch: workspaceBatch, docker_inventory: dockerInventory, docker_inspect: dockerInspect,
    read_images: readImages, sandbox_run: sandboxRun,
};
export function buildDeveloperToolDefinitions(): ToolDefinition[] {
    const definitions = [
        { name: 'workspace_batch', schema: WorkspaceBatchSchema, readOnly: false, description: 'One-round-trip coding workflow: up to 64 hash-checked file changes, 64 conditional/ranged reads, then up to 5 discovered checks. path is project root; file paths may be relative. changes use expected_sha256 (null means create only) and content OR exact edits. Validate all first, commit atomically per file with best-effort rollback, return final hashes/readbacks. dryRun=true by default; checks run only with dryRun=false. No automatic decisions; generic UTF-8 languages.' },
        { name: 'docker_inventory', schema: DockerInventorySchema, readOnly: true, description: 'Observe existing Docker containers/images and ports BEFORE proposing another build/pull/container. Fresh bounded data from the current Docker context, including stopped containers by default. A failed daemon query returns unavailable/null, never an invented empty inventory. Read-only; no image/container changes.' },
        { name: 'docker_inspect', schema: DockerInspectSchema, readOnly: true, description: 'Inspect selected existing container/image IDs or tags in one call. Returns actual image IDs, state, health, ports and mounts; omits environment values and startup commands. No shell interpolation, logs, builds, pulls, exec or restart.' },
        { name: 'read_images', schema: ReadImagesSchema, readOnly: true, description: 'Discover images under path with mode=list, then choose up to 12 files for metadata, resized previews or a contact sheet. Actual MCP image blocks, not base64 JSON text. PNG/JPEG/WebP/GIF/AVIF/TIFF; first frame only; source images unchanged, no OCR/upload/disk thumbnails. Max 16 MiB/16 megapixels per input, 2 MiB preview budget. For SVG use text tools.' },
        { name: 'sandbox_run', schema: SandboxSchema, readOnly: false, description: 'Optional Linux-Docker isolation for an explicitly requested program/args. Preview by default; execute=true stages a sanitized <=64 MiB source copy and uses an existing local image ID. No auto pull/build, network, host credentials, Docker socket, privileges or host-shell fallback. Original project never mounted; source and root are read-only, /tmp writable/bounded. Resource limits and no saved container logs. This is not protection from a compromised daemon/kernel or a replacement for normal fast trusted execution.' },
    ];
    return definitions.map(d => ({ name: d.name, description: d.description, inputSchema: zodToJsonSchema(d.schema), annotations: { title: d.name, readOnlyHint: d.readOnly, ...(!d.readOnly ? { destructiveHint: true } : {}) } }));
}
