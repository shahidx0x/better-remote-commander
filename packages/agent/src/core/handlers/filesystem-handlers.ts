import {
    readFile,
    readMultipleFiles,
    validatePath,
    writeFile,
    createDirectory,
    listDirectory,
    moveFile,
    getFileInfo,
    writePdf,
    getDefaultEditorMetadata,
    type FileResult,
    type MultiFileResult
} from '../tools/filesystem.js';
import type { ReadOptions } from '../utils/files/base.js';

import { ServerResult } from '../types.js';
import { withTimeout } from '../utils/withTimeout.js';
import { createErrorResponse } from '../error-handlers.js';
import { configManager } from '../config-manager.js';
import { AgentError, failure, errorCode } from '../../runtime/errors.js';
import {idempotentAppend} from '../../runtime/idempotent-append.js';
import {listDirectoryPage} from '../../runtime/directory-page.js';
import {missingFileResponse} from '../../runtime/path-diagnostics.js';
import {moveFileSafely} from '../../runtime/safe-move.js';

import {
    ReadFileArgsSchema,
    ReadMultipleFilesArgsSchema,
    WriteFileArgsSchema,
    CreateDirectoryArgsSchema,
    ListDirectoryArgsSchema,
    MoveFileArgsSchema,
    GetFileInfoArgsSchema,
    WritePdfArgsSchema
} from '../tools/schemas.js';
import path from 'path';
import fs from 'node:fs/promises';
import os from 'os';
import { resolvePreviewFileType } from '../ui/file-preview/shared/preview-file-types.js';

/**
 * Expand home directory (~) in a file path
 */
function expandHome(filePath: string): string {
    if (filePath === '~' || filePath.startsWith('~/') || filePath.startsWith(`~${path.sep}`)) {
        return path.join(os.homedir(), filePath.slice(1));
    }
    return filePath;
}

/**
 * Resolve a file path to an absolute path for use in structured content.
 * This ensures "Open in folder" always has a valid absolute path.
 */
export function resolveAbsolutePath(filePath: string): string {
    const expanded = expandHome(filePath);
    return path.isAbsolute(expanded)
        ? path.resolve(expanded)
        : path.resolve(process.cwd(), expanded);
}

/**
 * Helper function to check if path contains an error
 */
function isErrorPath(filePath: string): boolean {
    return filePath.startsWith('__ERROR__:');
}

/**
 * Extract error message from error path
 */
function getErrorFromPath(path: string): string {
    return path.substring('__ERROR__:'.length).trim();
}

/**
 * Handle read_file command
 */
export async function handleReadFile(args: unknown): Promise<ServerResult> {
    // Backstop for the whole handler operation. The real control is the
    // 3-minute cancellable read timeout inside readFileFromDisk; this sits just
    // above it (so that one fires first, with cleanup + a useful error) but
    // still below the MCP client's ~4-minute hard cap, so we never leave the
    // client hanging on an opaque timeout.
    const HANDLER_TIMEOUT = 3.5 * 60 * 1000; // 3m30s
    // Add input validation
    if (args === null || args === undefined) {
        return createErrorResponse('No arguments provided for read_file command');
    }
    const readFileOperation = async () => {
        const parsed = ReadFileArgsSchema.parse(args);

        // Get the configuration for file read limits
        const config = await configManager.getConfig();
        if (!config) {
            return createErrorResponse('Configuration not available');
        }

        const defaultLimit = Math.min(2000, Math.max(1, Math.trunc(config.fileReadLineLimit ?? 300)));

        // Convert sheet parameter: numeric strings become numbers for Excel index access
        let sheetParam: string | number | undefined = parsed.sheet;
        if (parsed.sheet !== undefined && /^\d+$/.test(parsed.sheet)) {
            sheetParam = parseInt(parsed.sheet, 10);
        }

        const pdfRequested=!parsed.isUrl && /\.pdf$/i.test(parsed.path);
        const options: ReadOptions = {
            isUrl: parsed.isUrl,
            offset: parsed.offset ?? 0,
            // PDF offsets/lengths count PAGES, not text lines. Never default to
            // 300-page extraction in one MCP call.
            length: pdfRequested?Math.min(parsed.length??3,5):(parsed.length??defaultLimit),
            sheet: sheetParam,range:parsed.range
        };
        if(!parsed.isUrl && /\.(?:png|jpe?g|webp|gif|avif|tiff?)$/i.test(parsed.path)) {
            const stat=await fs.stat(await validatePath(parsed.path));
            if(stat.isFile() && stat.size>4*1024*1024)
                return failure(new AgentError('IMAGE_TOO_LARGE',
                    'Original image exceeds 4 MiB for a single MCP message. Use read_images on desktop for a bounded preview or the file transfer tools for exact original bytes. No bytes were returned.'));
        }

        // Resolve to absolute path for local files (not URLs) so "Open in folder" works
        const resolvedFilePath = parsed.isUrl
            ? parsed.path
            : resolveAbsolutePath(parsed.path);

        const fileResult = await readFile(parsed.path, options);

        if (fileResult.metadata?.error)
            return failure(new AgentError('FILE_READ_FAILED',
                String(fileResult.metadata.errorMessage??'Document extraction failed').slice(0,1200)));
        // Handle PDF files
        if (fileResult.metadata?.isPdf) {
            const meta = fileResult.metadata;
            const author = meta?.author ? `, Author: ${meta?.author}` : "";
            const title = meta?.title ? `, Title: ${meta?.title}` : "";

            const pdfContent: Array<{type:string;text?:string;data?:string;mimeType?:string}>=[];
            let textBudget=120_000, encodedImageBudget=3*1024*1024, omittedImages=0, textTruncated=false;
            const pages=(meta.pages??[]).slice(0,5);
            for(const page of pages) {
                const body=String(page.text??''),take=Math.min(body.length,textBudget);
                pdfContent.push({type:'text',text:'<!-- Page: '+page.pageNumber+' -->\n'+body.slice(0,take)+
                    (take<body.length?'\n[PAGE TEXT TRUNCATED: request narrower pages]':'')});
                textBudget-=take;
                if(take<body.length)textTruncated=true;
                for(const img of page.images??[]) {
                    const encoded=String(img.data??'');
                    if(encoded.length>encodedImageBudget) {omittedImages++;continue;}
                    encodedImageBudget-=encoded.length;
                    pdfContent.push({type:'image',data:encoded,mimeType:img.mimeType});
                }
            }
            if(omittedImages)pdfContent.push({type:'text',text:
                '[PDF IMAGES OMITTED: 3 MiB encoded image budget reached. Request fewer pages or use a dedicated image tool.]'});
            const pagesReturned=pages.length;
            const nextPage=(parsed.offset??0)+pagesReturned;
            const hasMorePages=nextPage<(meta.totalPages??nextPage);
            if(hasMorePages)pdfContent.push({type:'text',text:
                '[MORE PDF PAGES: call read_file with offset='+nextPage+', length='+options.length+' to continue.]'});

            return {
                content: [
                    {
                        type: "text",
                        text: `PDF file: ${parsed.path}${author}${title} (${meta?.totalPages} pages) \n`
                    },
                    ...pdfContent
                ],
                structuredContent: parsed.origin === 'ui' ? {
                    fileName: path.basename(resolvedFilePath),
                    filePath: resolvedFilePath,
                    fileType: 'unsupported' as const,
                    ...await getDefaultEditorMetadata(resolvedFilePath),
                } : {read:{kind:'pdf',path:parsed.path,totalPages:meta.totalPages,
                    pagesReturned,hasMorePages,textTruncated,omittedImages,
                    truncated:hasMorePages||textTruncated||omittedImages>0,
                    next:hasMorePages?{tool:'read_file',args:{path:parsed.path,offset:nextPage,length:options.length}}:null}},
            };
        }

        // Handle image files
        if (fileResult.metadata?.isImage) {
            // Return the image bytes in the MCP content array so the host model can
            // actually see the image. The preview widget gets its copy from its own
            // origin:'ui' read — structuredContent stays metadata-only.
            const imageData = typeof fileResult.content === 'string'
                ? fileResult.content
                : fileResult.content.toString('base64');
            const imageSummary = `Image file: ${parsed.path} (${fileResult.mimeType})\n`;
            const imageStructuredContent = {
                fileName: path.basename(resolvedFilePath),
                filePath: resolvedFilePath,
                fileType: 'image' as const,
                ...await getDefaultEditorMetadata(resolvedFilePath),
                mimeType: fileResult.mimeType,
            };
            // Widget pull (origin: 'ui'): return the base64 in a TEXT block, never
            // an image block. An image content block makes the host inline-vision-
            // render the result, which preempts delivery of this RPC response to
            // the widget — leaving the preview stuck on "Preparing preview…" for
            // exactly the host-rendered types (png/jpeg/gif/webp). Text-only lets
            // the RPC response through so the widget can draw the <img>.
            if (parsed.origin === 'ui') {
                return {
                    content: [{ type: "text", text: imageData }],
                    structuredContent: imageStructuredContent,
                };
            }
            // Model-facing read: keep the image block so the host/model sees it.
            // No structuredContent — the widget renders from its own origin:'ui'
            // read, and nothing else consumes it.
            return {
                content: [
                    {
                        type: "text",
                        text: imageSummary
                    },
                    {
                        type: "image",
                        data: imageData,
                        mimeType: fileResult.mimeType
                    }
                ],
            };
        } else {
            // For all other files, return as text.
            // structuredContent carries only file metadata (no content duplication);
            // the widget reads text from the MCP content array (over the RPC read).
            let textContent = typeof fileResult.content === 'string'
                ? fileResult.content
                : fileResult.content.toString('utf8');
            const fileType = fileResult.metadata?.isDirectory ? 'directory' as const : resolvePreviewFileType(resolvedFilePath);
            // The directory fallback prefixes a "use list_directory instead" hint
            // for the LLM. The widget's own read (a list_directory preview pulls
            // read_file on the dir path) would render that hint as a notice — strip it.
            if (parsed.origin === 'ui' && fileType === 'directory') {
                textContent = textContent.replace(/^This is a directory, not a file\.[^\n]*\n+/, '');
            }
            // A single enormous line can bypass a line-count limit and exhaust
            // a remote AI host's message stream. Bound the returned text too.
            const maxChars = parsed.origin === 'ui' ? 256_000 : 128_000;
            const status = /^\[Reading (\d+) lines from[^\n]*\(total: (\d+) lines, (\d+) remaining\)\]/.exec(textContent);
            const characterTruncated = textContent.length > maxChars;
            if (characterTruncated)
                textContent = textContent.slice(0, maxChars) +
                    '\n\n[OUTPUT TRUNCATED: response exceeded ' + maxChars +
                    ' characters. For giant lines use read_code_file charOffset/charLength and nextCharOffset to continue. Do not treat this as the complete file.]';
            const hasMoreLines = !!status && Number(status[3]) > 0;
            const returnedLines = status ? Number(status[1]) : 0;
            const next = characterTruncated
                ? {tool:'read_code_file',args:{path:parsed.path,charOffset:0,charLength:50000},
                   note:'The text budget cut a line. Retrieve character windows with nextCharOffset; do not skip to the next line.'}
                : hasMoreLines && (parsed.offset??0)>=0
                ? {tool:'read_file',args:{path:parsed.path,offset:(parsed.offset??0)+returnedLines,length:options.length},
                   note:'More lines exist. Request next offset to continue, or stop if the requested context is sufficient.'}
                : null;
            return {
                content: [{ type: "text", text: textContent }],
                structuredContent: parsed.origin === 'ui' ? {
                    fileName: path.basename(resolvedFilePath), filePath: resolvedFilePath,
                    fileType, ...await getDefaultEditorMetadata(resolvedFilePath),
                } : {
                    read: {path:parsed.path,returnedLines,hasMoreLines,characterTruncated,
                      truncated:characterTruncated||hasMoreLines,next,complete:!characterTruncated && !hasMoreLines && !!status},
                },
            };
        }
    };

    // Execute with timeout at the handler level
    let result:ServerResult|null;
    try{result = await withTimeout(
        readFileOperation(),
        HANDLER_TIMEOUT,
        'Read file handler operation',
        null
    );}catch(e){
      const code=(e as NodeJS.ErrnoException)?.code;
      const input=(args as {path?:unknown})?.path;
      if(code==='ENOENT'&&typeof input==='string')return missingFileResponse(input);
      throw e;
    }
    if (result == null) {
        // Handles the impossible case where withTimeout resolves to null instead of throwing
        throw new Error('Failed to read the file');
    }
    return result;
}

/**
 * Handle read_multiple_files command
 */
export async function handleReadMultipleFiles(args: unknown): Promise<ServerResult> {
    const parsed = ReadMultipleFilesArgsSchema.parse(args);
    const config = await configManager.getConfig();
    // 200-line default in a batch prevents 64 medium files from becoming one
    // huge MCP response. Callers may request up to 2000 lines per file.
    const defaultLines = Math.min(200, Math.max(1, Math.trunc(config.fileReadLineLimit ?? 300)));
    const requested = [
        ...parsed.paths.map(p => ({ path:p, offset:0, length:defaultLines })),
        ...parsed.files.map(f => ({ ...f, offset:f.offset??0, length:f.length ?? defaultLines })),
    ].map(f => ({...f,length:/\.pdf$/i.test(f.path)?Math.min(f.length,2):f.length}));
    // Reserve media bytes BEFORE reading/decoding. Otherwise 64 simultaneous
    // images/PDFs can inflate into hundreds of MB even if reply truncates them.
    let mediaReserved=0;
    const omissions=new Map<number,string>();
    for(let i=0;i<requested.length;i++) {
        const f=requested[i];
        if(!/\.(?:pdf|png|jpe?g|gif|webp|avif|tiff?)$/i.test(f.path))continue;
        try {
            const stat=await fs.stat(await validatePath(f.path));
            if(stat.isFile()) {
                if(stat.size>2*1024*1024 || mediaReserved+stat.size>2*1024*1024) {
                    omissions.set(i,'Media omitted before decoding: 2 MiB total batch input budget. Use a smaller batch, read_images (desktop), or a dedicated file transfer.');
                } else mediaReserved+=stat.size;
            }
        }catch{ /* Existing file handler returns the real access/not-found error. */ }
    }
    const selected=requested.filter((_,i)=>!omissions.has(i));
    const results=await readMultipleFiles(selected);
    let position=0;
    const fileResults: MultiFileResult[]=requested.map((f,i)=>
        omissions.has(i)?{path:f.path,error:omissions.get(i)!}:results[position++]);
    const summary = fileResults.map(r => r.error ? r.path + ': Error - ' + r.error :
        r.path + ': ' + (r.mimeType ?? 'unknown') +
        (r.isPdf ? ' (PDF)' : r.isImage ? ' (image)' : ' (text)')).join('\n');
    // A bounded response is critical for large generated source (and image/PDF)
    // results. Never silently return incomplete content as a complete file.
    let charsRemaining = 160_000, mediaBytesRemaining = 2 * 1024 * 1024;
    let truncated = omissions.size>0;
    const continuations: {path:string;next:unknown;reason:string}[] = [];
    const items: Array<{type:string;text?:string;data?:string;mimeType?:string}> = [];
    const addText = (s:string) => {
        if (charsRemaining <= 0) {truncated=true;return;}
        const cap = Math.min(48_000,charsRemaining);
        const cropped = s.length > cap;
        if(cropped)truncated=true;
        const text = cropped ? s.slice(0,cap) +
            '\n[TRUNCATED: shared/per-file output budget reached; use read_file with offset/length or read_code_ranges. Do not treat as complete content.]' : s;
        items.push({type:'text',text});
        charsRemaining -= Math.min(cap,s.length);
    };
    addText(summary.slice(0,12000));
    for (let i=0;i<fileResults.length;i++) {
        const r=fileResults[i],entry=requested[i];
        if (r.error || r.content === undefined) continue;
        if(!r.isPdf&&!r.isImage) {
            const info=/^\[Reading (\d+) lines from[^\n]*\(total: (\d+) lines, (\d+) remaining\)\]/.exec(r.content);
            if(info&&Number(info[3])>0&&entry.offset>=0) {
                truncated=true;
                continuations.push({path:r.path,reason:'Additional lines exist',
                    next:{tool:'read_file',args:{path:r.path,offset:entry.offset+Number(info[1]),length:entry.length}}});
            }
            if(r.content.length>48_000) {
                truncated=true;
                continuations.push({path:r.path,reason:'Character budget reached: a long line may have been cut',
                    next:{tool:'read_code_file',args:{path:r.path,charOffset:0,charLength:50000}}});
            }
        }
        if (r.isPdf) {
            // In a batch, PDF extraction is limited to two pages per file.
            const returned=r.payload?.pages.length??0,total=r.payload?.metadata.totalPages??returned;
            const nextOffset=entry.offset+returned;
            if(nextOffset<total) {
                truncated=true;
                continuations.push({path:r.path,reason:'Additional PDF pages exist',
                    next:{tool:'read_file',args:{path:r.path,offset:nextOffset,length:2}}});
            }
            // For large PDF image sets use the dedicated PDF/image tools.
            for (const page of r.payload?.pages ?? []) {
                addText('PDF ' + r.path + ', page ' + page.pageNumber + ':\n' + page.text);
                for (const img of page.images ?? []) {
                    const bytes = Math.floor(img.data.length * 3 / 4);
                    if (bytes > mediaBytesRemaining) {
                        truncated=true;
                        addText('[PDF image omitted: media budget exhausted. Use read_file with an explicit page range.]');
                        continue;
                    }
                    mediaBytesRemaining -= bytes;
                    items.push({type:'image',data:img.data,mimeType:img.mimeType});
                }
            }
        } else if (r.isImage && r.mimeType) {
            const bytes = Math.floor(r.content.length * 3 / 4);
            if (bytes > mediaBytesRemaining) {
                truncated=true;
                addText('[Image omitted due to the 2 MiB batch media budget: ' + r.path +
                    '. Use read_images or read_file for the image alone.]');
                continue;
            }
            mediaBytesRemaining -= bytes;
            items.push({type:'image',data:r.content,mimeType:r.mimeType});
        } else {
            addText('\n--- ' + r.path + ' contents: ---\n' + r.content);
        }
    }
    if (charsRemaining <= 0) {
        items.push({type:'text',text:'[BATCH OUTPUT LIMIT REACHED: some files/pages were omitted. Read remaining files in a smaller batch or narrow line ranges.]'});
    }
    return { content: items, structuredContent:{
        batch:{truncated,more:continuations.length>0,continuations,
            omitted: [...omissions.entries()].map(([i,reason])=>({path:requested[i].path,reason})),
            next:truncated?'Read each returned continuation or retry with narrower files/ranges; do not treat cut content as complete.':null}
    } };
}

/**
 * Handle write_file command
 */
export async function handleWriteFile(args: unknown): Promise<ServerResult> {
    try {
        const modeProvided = !!(args && typeof args === 'object' && 'mode' in args);
        const parsed = WriteFileArgsSchema.parse(args);
        const config = await configManager.getConfig();
        if(parsed.append_id&&parsed.mode!=='append')throw new AgentError('INVALID_ARGUMENT',
            'append_id requires mode=append. Nothing was written.');
        // Configurable per-call line limit, with a universal hard ceiling. A
        // trailing newline is not another line. Nothing is written on failure.
        const maxLines = Math.min(2000, Math.max(1, Math.trunc(config.fileWriteLineLimit ?? 1000)));
        const maxBytes = 1024 * 1024;
        const bytes = Buffer.byteLength(parsed.content, 'utf8');
        if (bytes > maxBytes)
            throw new AgentError('WRITE_SIZE_LIMIT',
                'No file changed: ' + bytes + ' bytes exceeds the 1 MiB write_file limit. ' +
                'Split new files into mode=rewrite then mode=append chunks, or use workspace_batch for hash-checked edits.');
        const lineCount = parsed.content === '' ? 0 :
            parsed.content.split(/\r\n|\r|\n/).length - (/[\r\n]$/.test(parsed.content) ? 1 : 0);
        if (lineCount > maxLines)
            throw new AgentError('WRITE_LINE_LIMIT',
                'No file changed: ' + lineCount + ' lines exceeds your ' + maxLines +
                '-line fileWriteLineLimit (hard max: 2000). Use smaller mode=append chunks, ' +
                'or raise fileWriteLineLimit with set_config_value. Existing files require explicit mode.');

        // Prevent silent accidental overwrites. A caller intending to append
        // must not destroy a nonempty file by forgetting the mode parameter.
        if (!modeProvided) {
            const existing = await getFileInfo(parsed.path).catch(() => null);
            if (existing?.isFile && existing.size > 0)
                throw new AgentError('WRITE_MODE_REQUIRED',
                    'No file changed: existing file has ' + existing.size +
                    ' bytes. Explicitly set mode=append or mode=rewrite. For precise edits, use edit_block or workspace_batch.');
        }

        const receipt=parsed.mode==='append'&&parsed.append_id
            ?await idempotentAppend(parsed.path,parsed.content,parsed.append_id,parsed.expected_sha256)
            :null;
        if(!receipt)await writeFile(parsed.path, parsed.content, parsed.mode);
        const modeMessage = receipt?.alreadyApplied?'previously appended to':
            parsed.mode === 'append' ? 'appended to' : 'wrote to';
        // No duplicated file-content preview. The UI retrieves it separately.
        return { content: [{type:'text',
            text:'Successfully ' + modeMessage + ' ' + parsed.path + ' (' +
                lineCount + ' lines, ' + bytes + ' bytes).'}],
            structuredContent:{write:{
                path:parsed.path,mode:parsed.mode,linesWritten:receipt?.alreadyApplied?0:lineCount,
                bytesWritten:receipt?.bytesWritten??bytes,
                ...(receipt?{appendReceipt:receipt,appendId:receipt.appendId,
                  alreadyApplied:receipt.alreadyApplied,writeCommitted:true}:{writeCommitted:true}),
                thisChunkComplete:true,moreChunksUnknown:true,
                continueOnlyIfNeeded:'If more intended content remains, use mode=append with ONLY the next chunk. Do not replay this successful chunk. For existing code, verify hash/readback and use hash-checked changes. The caller decides when the complete file is finished.'
            }}
        };
    } catch (error) {
        return failure(error);
    }
}

/**
 * Handle create_directory command
 */
export async function handleCreateDirectory(args: unknown): Promise<ServerResult> {
    try {
        const parsed = CreateDirectoryArgsSchema.parse(args);
        await createDirectory(parsed.path);
        return {
            content: [{ type: "text", text: `Successfully created directory ${parsed.path}` }],
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return createErrorResponse(errorMessage);
    }
}

/**
 * Handle list_directory command
 */
export async function handleListDirectory(args: unknown): Promise<ServerResult> {
    try {
        const startTime = Date.now();
        const parsed = ListDirectoryArgsSchema.parse(args);
        const page = await listDirectoryPage(parsed);
        const duration = Date.now() - startTime;

        const resultText = page.entries.join('\n')+(page.hasMore?
           '\n[MORE DIRECTORY ENTRIES: call list_directory({path:'+JSON.stringify(parsed.path)+
           ',depth:'+page.depth+',offset:'+page.nextOffset+',limit:'+page.limit+'}). Directory pages are live filesystem views, not snapshots.]':'');
        const resolvedPath = resolveAbsolutePath(parsed.path);

        return {
            content: [{ type: "text", text: resultText }],
            structuredContent:{
                ...(parsed.origin==='ui'?{
                   fileName:path.basename(resolvedPath),filePath:resolvedPath,fileType:'directory' as const
                }:{}),
                directory:{...page,durationMs:duration,
                   next:page.hasMore?{tool:'list_directory',args:{path:parsed.path,
                      depth:page.depth,offset:page.nextOffset,limit:page.limit}}:null}
            },
        };
    } catch (error) {
        // Preserve specific policy/OS/validation errors; only wrap a truly
        // unknown directory-enumeration failure with an actionable code.
        if(errorCode(error)==='TOOL_FAILED'){
            const detail=error instanceof Error?error.message.slice(0,350):'unknown filesystem error';
            return failure(new AgentError('DIRECTORY_LIST_FAILED',
                'Unable to enumerate directory: '+detail+'. Verify the folder with get_file_info or narrow the list_directory depth.'));
        }
        return failure(error);
    }
}

/**
 * Handle move_file command
 */
export async function handleMoveFile(args: unknown): Promise<ServerResult> {
    try {
        const parsed = MoveFileArgsSchema.parse(args);
        const moved=await moveFileSafely(parsed.source,parsed.destination);
        return {
            content:[{type:'text',text:'Successfully moved '+moved.source+' to '+moved.destination+
              ' ('+moved.method+', destination verified, source removed).'}],
            structuredContent:{move:moved,existingDestinationOverwritten:false,
              automaticRetry:false}
        };
    } catch (error) {
        return failure(error);
    }
}

/**
 * Format a value for display, handling objects and arrays
 */
function formatValue(value: unknown, indent: string = ''): string {
    if (value === null || value === undefined) {
        return String(value);
    }
    if (Array.isArray(value)) {
        if (value.length === 0) return '[]';
        // For arrays of objects (like sheets), format each item
        const items = value.map((item, i) => {
            if (typeof item === 'object' && item !== null) {
                const props = Object.entries(item)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join(', ');
                return `${indent}  [${i}] { ${props} }`;
            }
            return `${indent}  [${i}] ${item}`;
        });
        return `\n${items.join('\n')}`;
    }
    if (typeof value === 'object') {
        return JSON.stringify(value);
    }
    return String(value);
}

/**
 * Handle get_file_info command
 */
export async function handleGetFileInfo(args: unknown): Promise<ServerResult> {
    try {
        const parsed = GetFileInfoArgsSchema.parse(args);
        const info = await getFileInfo(parsed.path);

        // Generic formatting for any file type
        const formattedText = Object.entries(info)
            .map(([key, value]) => `${key}: ${formatValue(value)}`)
            .join('\n');

        return {
            content: [{
                type: "text",
                text: formattedText
            }],
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return createErrorResponse(errorMessage);
    }
}

// Use get_config to retrieve the allowedDirectories configuration

/**
 * Handle write_pdf command
 */
export async function handleWritePdf(args: unknown): Promise<ServerResult> {
    try {
        const parsed = WritePdfArgsSchema.parse(args);
        await writePdf(parsed.path, parsed.content, parsed.outputPath, parsed.options);
        const targetPath = parsed.outputPath || parsed.path;
        return {
            content: [{ type: "text", text: `Successfully wrote PDF to ${targetPath}${parsed.outputPath ? `\nOriginal file: ${parsed.path}` : ''}` }],
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return createErrorResponse(errorMessage);
    }
}
