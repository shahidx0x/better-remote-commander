/** Local image discovery and small genuine MCP image blocks. No OCR, uploads, source modification or disk thumbnails. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ToolResult, ContentBlock } from 'brc-shared';
import { rootPath, projectPath, listProjectFiles, sensitive } from '../runtime/workspace.js';
import { readBounded, sha256 } from '../runtime/file-safety.js';
import { checkCancelled } from '../context.js';
import { AgentError, result } from '../runtime/errors.js';
const EXT = /\.(png|jpe?g|webp|gif|avif|tiff?)$/i;
const PIXELS = 16 * 1024 * 1024;
const OUTPUT_BYTES = 2 * 1024 * 1024;
let load: Promise<typeof import('sharp')> | undefined;
let tail: Promise<void> = Promise.resolve(), queued = 0;
export const ReadImagesSchema = z.object({
    path: z.string().min(1), mode: z.enum(['list', 'metadata', 'previews', 'sheet']).default('list'),
    files: z.array(z.string().min(1)).max(12).default([]), offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(200).default(60), maxDimension: z.number().int().min(128).max(1600).default(960),
});
async function sharpLib() {
    return load ??= import('sharp').then(m => { m.default.cache(false); m.default.concurrency(1); return m.default; });
}
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
    }
    finally {
        queued--;
        release();
    }
}
export async function readImages(raw: unknown): Promise<ToolResult> {
    const a = ReadImagesSchema.parse(raw), root = await rootPath(a.path);
    if (a.mode === 'list') {
        const listing = await listProjectFiles(root, 12000), found = listing.files.filter(f => EXT.test(f) && !sensitive(f));
        const files = [];
        for (const f of found.slice(a.offset, a.offset + a.limit)) {
            checkCancelled();
            try {
                const p = await projectPath(root, f), s = await fs.stat(p);
                if (s.isFile())
                    files.push({ file: f, bytes: s.size });
            }
            catch {
                files.push({ file: f, unavailable: true });
            }
        }
        return result({ root, files, total: found.length, nextOffset: a.offset + files.length < found.length ? a.offset + files.length : null,
            truncated: listing.truncated, previewGenerated: false, note: 'Choose up to 12 returned paths for metadata, previews or a contact sheet. File existence is not visual inspection.' });
    }
    if (!a.files.length)
        throw new AgentError('FILES_REQUIRED', 'Select files from read_images mode=list; previews never scan/decode an entire folder automatically.');
    return oneImageJob(async () => {
        const sharp = await sharpLib(), metadata: Record<string, unknown>[] = [], images: ContentBlock[] = [], tiles: Buffer[] = [];
        let outputBytes = 0;
        for (const name of a.files) {
            checkCancelled();
            try {
                if (!EXT.test(name) || sensitive(name))
                    throw new AgentError('UNSUPPORTED_IMAGE', 'Use PNG, JPEG, WebP, GIF, AVIF or TIFF. SVG is source code; read it as text.');
                const file = await projectPath(root, name), bytes = await readBounded(file, 16 * 1024 * 1024);
                // Do not pass XML/SVG/HTML with a misleading extension into an external-reference capable loader.
                const head = bytes.subarray(0, 512).toString('utf8').replace(/^\ufeff/, '').trimStart();
                if (head.startsWith('<'))
                    throw new AgentError('UNSUPPORTED_IMAGE', 'XML/SVG/HTML is not accepted as a raster preview.');
                const options = { limitInputPixels: PIXELS, pages: 1, animated: false, sequentialRead: true, failOn: 'error' as const };
                const m = await sharp(bytes, options).timeout({ seconds: 8 }).metadata();
                if (!['png', 'jpeg', 'webp', 'gif', 'avif', 'heif', 'tiff'].includes(m.format ?? ''))
                    throw new AgentError('UNSUPPORTED_IMAGE', 'Unsupported decoded image format.');
                if (!m.width || !m.height || m.width * (m.pageHeight ?? m.height) > PIXELS)
                    throw new AgentError('IMAGE_TOO_LARGE', 'Image exceeds the 16-megapixel decode budget.');
                const record: Record<string, unknown> = { file: name, sha256: sha256(bytes), inputBytes: bytes.length, width: m.width, height: m.pageHeight ?? m.height, format: m.format, pages: m.pages ?? 1, firstFrameOnly: (m.pages ?? 1) > 1 };
                if (a.mode !== 'metadata') {
                    const dimension = a.mode === 'sheet' ? 256 : a.maxDimension;
                    let buffer = await sharp(bytes, options).rotate().resize({ width: dimension, height: dimension, fit: a.mode === 'sheet' ? 'contain' : 'inside', withoutEnlargement: true, background: { r: 245, g: 245, b: 245, alpha: 1 } }).webp({ quality: 82, effort: 1 }).timeout({ seconds: 8 }).toBuffer();
                    if (buffer.length + outputBytes > OUTPUT_BYTES) {
                        buffer = await sharp(bytes, options).rotate().resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true }).webp({ quality: 65, effort: 0 }).timeout({ seconds: 8 }).toBuffer();
                    }
                    if (outputBytes + buffer.length > OUTPUT_BYTES) {
                        record.previewOmitted = 'Total encoded image budget reached.';
                        metadata.push(record);
                        break;
                    }
                    outputBytes += buffer.length;
                    record.previewIndex = a.mode === 'sheet' ? tiles.length : images.length;
                    record.previewBytes = buffer.length;
                    if (a.mode === 'sheet') {
                        // Pad independently so small inputs still occupy exactly one cell.
                        buffer = await sharp(buffer).resize(256, 256, { fit: 'contain', background: { r: 245, g: 245, b: 245, alpha: 1 } }).webp({ effort: 0 }).toBuffer();
                        tiles.push(buffer);
                    }
                    else
                        images.push({ type: 'image', mimeType: 'image/webp', data: buffer.toString('base64') });
                }
                metadata.push(record);
            }
            catch (error) {
                metadata.push({ file: name, error: error instanceof Error ? error.message.slice(0, 400) : 'Image read failed.' });
            }
        }
        if (a.mode === 'sheet' && tiles.length) {
            const columns = Math.min(3, tiles.length), rows = Math.ceil(tiles.length / columns);
            const sheet = await sharp({ create: { width: columns * 256, height: rows * 256, channels: 3, background: { r: 245, g: 245, b: 245 } } })
                .composite(tiles.map((input, i) => ({ input, left: (i % columns) * 256, top: Math.floor(i / columns) * 256 }))).webp({ quality: 85, effort: 1 }).timeout({ seconds: 8 }).toBuffer();
            images.push({ type: 'image', mimeType: 'image/webp', data: sheet.toString('base64') });
        }
        const summary = { root, mode: a.mode, files: metadata, returnedImages: images.length, filesSkipped: a.files.length - metadata.length,
            note: 'Actual image content follows as MCP image blocks. Preview indexes are zero-based; sheets read left-to-right, top-to-bottom. Previews are resized and metadata stripped; originals unchanged. No OCR or saved thumbnails.' };
        return { ...result(summary, metadata.every(m => !!m.error)), content: [{ type: 'text', text: JSON.stringify(summary) }, ...images] };
    });
}
export function imageRuntimeStatus() { return { loaded: !!load, processingOrQueued: queued, concurrency: 1, maxInputPixels: PIXELS, maxEncodedOutputBytes: OUTPUT_BYTES, persistentCacheBytes: 0 }; }
