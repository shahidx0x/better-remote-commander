/** Native (sharp/libvips) image previews with bounded parallel decoding, not raw image dumps.
 * Encoded output is capped at 256 KiB (about 342 KiB as base64) so a result stays under the relay's 512 KiB frame limit; inputs are capped at 16 MP / 16 MiB.
 * No OCR, remote image fetch, source writes, saved thumbnails or metadata leakage.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ToolResult, ContentBlock } from 'brc-shared';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ServerResult } from '../core/types.js';
import type { ToolDefinition } from '../core/tool-definitions.js';
import { rootPath, projectPath } from '../runtime/workspace.js';
import { readBounded, sha256 } from '../runtime/file-safety.js';
import { checkCancelled } from '../context.js';
import { AgentError, result } from '../runtime/errors.js';

const EXT = /\.(png|jpe?g|webp|gif|avif|tiff?)$/i;
const PIXELS = 16 * 1024 * 1024;
const INPUT_BYTES = 16 * 1024 * 1024;
const OUTPUT_BYTES = 256 * 1024;
const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'target', '.next', '.cache', '__pycache__']);
const LIST_SCAN_LIMIT = 20000;
function sensitive(file: string): boolean {
    const b = path.basename(file).toLowerCase();
    return /^\.env(?:\.|$)/.test(b) || /^(?:id_rsa|id_ed25519|credentials|secrets?)(?:\.|$)/.test(b) || /\.(?:pem|p12|pfx|key)$/.test(b);
}
/** Bounded, cancel-aware image enumeration. Symlinks are never followed; output is sorted. */
async function listImages(root: string): Promise<{ files: string[]; truncated: boolean }> {
    const files: string[] = [];
    let scanned = 0, truncated = false;
    const walk = async (dir: string, rel: string): Promise<void> => {
        checkCancelled();
        const entries = await fs.readdir(dir, { withFileTypes: true });
        entries.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
        for (const e of entries) {
            if (truncated) return;
            if (++scanned > LIST_SCAN_LIMIT) { truncated = true; return; }
            const r = rel ? rel + '/' + e.name : e.name;
            if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) await walk(path.join(dir, e.name), r); }
            else if (e.isFile() && EXT.test(e.name) && !sensitive(e.name)) files.push(r);
        }
    };
    await walk(root, '');
    return { files, truncated };
}
const CELL = 256;
const BG = { r: 245, g: 245, b: 245, alpha: 1 };
const IMAGE_WORKERS = (() => {
    const n = Number(process.env.BRC_IMAGE_WORKERS ?? 2);
    return Number.isInteger(n) ? Math.max(1, Math.min(3, n)) : 2;
})();
const SHARP_INPUT = { limitInputPixels: PIXELS, pages: 1, animated: false, sequentialRead: true, failOn: 'error' as const };
let load: Promise<typeof import('sharp')> | undefined;
let tail: Promise<void> = Promise.resolve(), queued = 0;

export const ReadImagesSchema = z.object({
    path: z.string().min(1), mode: z.enum(['list', 'metadata', 'previews', 'sheet']).default('list'),
    files: z.array(z.string().min(1)).max(12).default([]), offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(200).default(60), maxDimension: z.number().int().min(128).max(1600).default(960),
});

async function sharpLib() {
    return load ??= import('sharp').then(m => {
        // libvips is already native. Two bounded workers avoid CPU oversubscription and
        // prevent 12 large images from being decoded simultaneously.
        m.default.cache(false);
        m.default.concurrency(IMAGE_WORKERS);
        return m.default;
    }).catch(error => { load = undefined; throw error; });
}

/** Across requests: preserve the existing one-request-at-a-time, max-eight queue. */
async function oneImageJob<T>(fn: () => Promise<T>): Promise<T> {
    if (queued >= 8)
        throw new AgentError('IMAGE_BUSY', 'Image processing queue is full; request fewer previews.', true);
    queued++;
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>(r => { release = r; });
    try {
        await previous;
        checkCancelled();
        return await fn();
    } finally {
        queued--;
        release();
    }
}

/** Inside a request, allow up to 2 native decoders (1..3 via BRC_IMAGE_WORKERS). */
async function mapLimited<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
    const out = new Array<R>(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(IMAGE_WORKERS, items.length) }, async () => {
        for (;;) {
            const i = next++;
            if (i >= items.length) return;
            checkCancelled();
            out[i] = await fn(items[i]);
        }
    }));
    return out;
}
type Prepared = { record: Record<string, unknown>; preview?: Buffer; tile?: Buffer };

/** Validate each input independently; errors stay in the corresponding input position. */
async function prepareImage(root: string, name: string, mode: string, maxDimension: number): Promise<Prepared> {
    try {
        checkCancelled();
        if (!EXT.test(name) || sensitive(name))
            throw new AgentError('UNSUPPORTED_IMAGE', 'Use PNG, JPEG, WebP, GIF, AVIF or TIFF. SVG is source code; read it as text.');
        const file = await projectPath(root, name), bytes = await readBounded(file, INPUT_BYTES);
        // Reject disguised XML/SVG/HTML before passing data to libvips.
        const head = bytes.subarray(0, 512).toString('utf8').replace(/^\ufeff/, '').trimStart();
        if (head.startsWith('<'))
            throw new AgentError('UNSUPPORTED_IMAGE', 'XML/SVG/HTML is not accepted as a raster preview.');
        const sharp = await sharpLib();
        const m = await sharp(bytes, SHARP_INPUT).timeout({ seconds: 8 }).metadata();
        if (!['png', 'jpeg', 'webp', 'gif', 'avif', 'heif', 'tiff'].includes(m.format ?? ''))
            throw new AgentError('UNSUPPORTED_IMAGE', 'Unsupported decoded image format.');
        if (!m.width || !m.height || m.width * (m.pageHeight ?? m.height) > PIXELS)
            throw new AgentError('IMAGE_TOO_LARGE', 'Image exceeds the 16-megapixel decode budget.');
        const record: Record<string, unknown> = {
            file: name, sha256: sha256(bytes), inputBytes: bytes.length, width: m.width,
            height: m.pageHeight ?? m.height, format: m.format, pages: m.pages ?? 1,
            firstFrameOnly: (m.pages ?? 1) > 1,
        };
        if (mode === 'metadata') return { record };
        if (mode === 'sheet') {
            // Produce raw RGB cells directly in libvips. The old implementation encoded
            // WebP, decoded it again, encoded it again, then encoded the final sheet.
            // Keeping a 256 x 256 raw tile avoids both intermediate WebP encodes.
            const tile = await sharp(bytes, SHARP_INPUT).rotate()
                .resize(CELL, CELL, { fit: 'contain', background: BG })
                .flatten({ background: BG }).toColourspace('srgb').removeAlpha()
                .raw().timeout({ seconds: 8 }).toBuffer({ resolveWithObject: true });
            if (tile.info.width !== CELL || tile.info.height !== CELL || tile.info.channels !== 3)
                throw new AgentError('IMAGE_CONVERSION_FAILED', 'Sheet cell must be 256x256 RGB.');
            return { record, tile: tile.data };
        }
        // Fastest libvips WebP effort. The image has no EXIF/metadata, preserves
        // orientation and is bounded before base64 transport over the relay.
        const preview = await sharp(bytes, SHARP_INPUT).rotate()
            .resize({ width: maxDimension, height: maxDimension, fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 82, effort: 0 }).timeout({ seconds: 8 }).toBuffer();
        return { record, preview };
    } catch (error) {
        return { record: { file: name, error: error instanceof Error ? error.message.slice(0, 400) : 'Image read failed.' } };
    }
}

async function smallerPreview(root: string, name: string): Promise<Buffer> {
    const file = await projectPath(root, name);
    const bytes = await readBounded(file, INPUT_BYTES);
    const sharp = await sharpLib();
    let out: Buffer = Buffer.alloc(0);
    for (const [dim, quality] of [[480, 65], [320, 55], [192, 45]] as const) {
        checkCancelled();
        out = await sharp(bytes, SHARP_INPUT).rotate()
            .resize({ width: dim, height: dim, fit: 'inside', withoutEnlargement: true })
            .webp({ quality, effort: 0 }).timeout({ seconds: 8 }).toBuffer();
        if (out.length <= OUTPUT_BYTES / 4) break;
    }
    return out;
}

export async function readImages(raw: unknown): Promise<ToolResult> {
    const a = ReadImagesSchema.parse(raw), root = await rootPath(a.path);
    if (a.mode === 'list') {
        const listing = await listImages(root);
        const found = listing.files.filter(f => EXT.test(f) && !sensitive(f));
        const files = [];
        // Stats are independent and cheap: overlap them without affecting ordered output.
        const selected = found.slice(a.offset, a.offset + a.limit);
        const entries = await mapLimited(selected, async f => {
            try {
                const p = await projectPath(root, f), s = await fs.stat(p);
                return s.isFile() ? { file: f, bytes: s.size } : { file: f, unavailable: true };
            } catch { return { file: f, unavailable: true }; }
        });
        files.push(...entries);
        return result({
            root, files, total: found.length,
            nextOffset: a.offset + files.length < found.length ? a.offset + files.length : null,
            truncated: listing.truncated, previewGenerated: false,
            note: 'Choose up to 12 returned paths for metadata, previews or a contact sheet. File existence is not visual inspection.',
        });
    }
    if (!a.files.length)
        throw new AgentError('FILES_REQUIRED', 'Select files from read_images mode=list; previews never scan/decode an entire folder automatically.');
    return oneImageJob(async () => {
        // Preparing images concurrently eliminates idle decoder time, while ordered
        // assembly below keeps indexes, errors and the shared 256 KiB budget stable.
        const works = await mapLimited(a.files, name => prepareImage(root, name, a.mode, a.maxDimension));
        const sharp = await sharpLib();
        const metadata: Record<string, unknown>[] = [], images: ContentBlock[] = [], tiles: Buffer[] = [];
        let outputBytes = 0, sheetOmitted = false;
        for (const prepared of works) {
            checkCancelled();
            const record = prepared.record;
            if (prepared.preview) {
                let buffer = prepared.preview;
                if (outputBytes + buffer.length > OUTPUT_BYTES) {
                    try { buffer = await smallerPreview(root, String(record.file)); }
                    catch (error) {
                        record.error = error instanceof Error ? error.message.slice(0, 400) : 'Image reduction failed.';
                        metadata.push(record);
                        continue;
                    }
                }
                if (outputBytes + buffer.length > OUTPUT_BYTES) {
                    record.previewOmitted = 'Total encoded image budget (256 KiB) reached.';
                    metadata.push(record);
                    break;
                }
                record.previewIndex = images.length;
                record.previewBytes = buffer.length;
                outputBytes += buffer.length;
                images.push({ type: 'image', mimeType: 'image/webp', data: buffer.toString('base64') });
            } else if (prepared.tile) {
                record.previewIndex = tiles.length;
                tiles.push(prepared.tile);
            }
            metadata.push(record);
        }
        if (a.mode === 'sheet' && tiles.length) {
            const columns = Math.min(3, tiles.length), rows = Math.ceil(tiles.length / columns);
            const composite = sharp({
                create: { width: columns * CELL, height: rows * CELL, channels: 3, background: { r: 245, g: 245, b: 245 } },
            }).composite(tiles.map((input, i) => ({
                input, raw: { width: CELL, height: CELL, channels: 3 as const },
                left: (i % columns) * CELL, top: Math.floor(i / columns) * CELL,
            })));
            let sheet: Buffer = Buffer.alloc(0);
            for (const quality of [85, 60, 40]) {
                checkCancelled();
                sheet = await composite.clone().webp({ quality, effort: 0 }).timeout({ seconds: 8 }).toBuffer();
                if (sheet.length <= OUTPUT_BYTES) break;
            }
            if (sheet.length <= OUTPUT_BYTES) {
                outputBytes = sheet.length;
                images.push({ type: 'image', mimeType: 'image/webp', data: sheet.toString('base64') });
            } else {
                sheetOmitted = true;
                for (const m of metadata) if (!m.error) m.previewOmitted = 'Encoded sheet exceeded the 256 KiB budget.';
            }
        }
        const summary = {
            root, mode: a.mode, files: metadata, returnedImages: images.length,
            filesSkipped: a.files.length - metadata.length, encodedOutputBytes: outputBytes,
            ...(sheetOmitted ? { sheetOmitted } : {}),
            note: 'Actual image content follows as MCP image blocks. Preview indexes are zero-based; sheets read left-to-right, top-to-bottom. Native sharp/libvips previews are resized and metadata stripped; originals unchanged. No OCR or saved thumbnails.',
        };
        const allFailed = metadata.every(m => !!m.error) || (a.mode === 'sheet' && sheetOmitted);
        return { ...result(summary, allFailed), content: [{ type: 'text', text: JSON.stringify(summary) }, ...images] };
    });
}
export function imageRuntimeStatus() {
    return {
        loaded: !!load, processingOrQueued: queued, concurrency: IMAGE_WORKERS,
        maxInputPixels: PIXELS, maxEncodedOutputBytes: OUTPUT_BYTES, persistentCacheBytes: 0,
    };
}

export const IMAGE_TOOL_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<ServerResult>> = {
    read_images: (a) => readImages(a) as Promise<ServerResult>,
};

export function buildImageToolDefinitions(): ToolDefinition[] {
    return [{
        name: 'read_images',
        description: [
            'Look at raster images (PNG, JPEG, WebP, GIF, AVIF, TIFF) as bounded previews. Give the project folder as path.',
            'mode=list enumerates image files (offset/limit pages, skips node_modules/.git/dist, nothing decoded).',
            'mode=metadata returns size/format/sha256 for up to 12 files; mode=previews returns each file as a resized WebP image (maxDimension 128-1600);',
            'mode=sheet returns ONE contact sheet (3 columns, 256px cells) for quick visual comparison.',
            'Total encoded image output is capped at 256 KiB per call; originals are never returned. Animated images show the first frame only. SVG is text: read it with read_file.',
            'For exact original bytes use the file transfer tools. Inputs over 16 MiB or 16 megapixels are rejected per file; paths must stay inside the project folder.',
        ].join('\n'),
        inputSchema: zodToJsonSchema(ReadImagesSchema) as ToolDefinition['inputSchema'],
        annotations: { title: 'Read Images', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    }];
}