/**
 * Text file editing via exact search/replace with bounded, safe indentation recovery.
 *
 * TECHNICAL DEBT / ARCHITECTURAL NOTE:
 * This file contains text editing logic that should ideally live in TextFileHandler.editRange()
 * to be consistent with how Excel editing works (ExcelFileHandler.editRange()).
 *
 * Current inconsistency:
 * - Excel: edit_block → ExcelFileHandler.editRange() ✓ uses file handler
 * - Text:  edit_block → performSearchReplace() here → bypasses TextFileHandler
 *
 * Future refactor should:
 * 1. Move performSearchReplace() + fuzzy logic into TextFileHandler.editRange()
 * 2. Make this file a thin dispatch layer that routes to appropriate FileHandler
 * 3. Unify the editRange() signature to handle both text search/replace and structured edits
 */

import { getDefaultEditorMetadata, readFile, writeFile, validatePath } from './filesystem.js';
import fs from 'fs/promises';
import { ServerResult } from '../types.js';
import { capture } from '../utils/capture.js';
// Edit failures use structured error codes instead of unclassified text.
import { EditBlockArgsSchema } from "./schemas.js";
import { atomicWrite, readBounded, sha256 } from "../../runtime/file-safety.js";
import path from 'path';
import { detectLineEnding, normalizeLineEndings } from '../utils/lineEndingHandler.js';
import { configManager } from '../config-manager.js';
import { resolvePreviewFileType } from '../ui/file-preview/shared/preview-file-types.js';
import { resolveAbsolutePath } from '../handlers/filesystem-handlers.js';

interface SearchReplace {
    search: string;
    replace: string;
}

/** Fail closed: an edit that did not apply is always an MCP error with
 * a precise, model-facing recovery plan. Never auto-apply fuzzy matches.
 */
function editBlockFailure(
    code: string, message: string, suggestion: string,
    details: Record<string, unknown> = {},
): ServerResult {
    const body = message.slice(0, 3500);
    return {
        isError: true,
        content: [{type:'text',text:code+': '+body+'\nNEXT ACTION: '+suggestion}],
        structuredContent: {
            error:{code,message:body,retryable:false},
            recovery:{automaticRetry:false,suggestion},
            changed:false,
            ...details,
        },
    };
}
const MISSING_EDIT_GUIDANCE =
    'Provide file_path and either old_string plus new_string, edits:[{old_string,new_string}], or range plus content for supported spreadsheet files. Read the current file first; do not retry unchanged.';
const NO_MATCH_GUIDANCE =
    'No text was changed. Re-read the latest file with read_file or read_code_file, copy an exact and unique old_string including indentation/whitespace, then retry. Approximate scanning is intentionally disabled to save CPU.';
const COUNT_GUIDANCE =
    'No text was changed. Add surrounding lines to make old_string unique, or set expected_replacements to the actual count ONLY if all occurrences should change. Read and verify the current file first.';

// A preview needs only a few surrounding lines, not an array containing every
// line of the edited file. This bounds temporary RAM on large source files.
function countNewlines(text: string, before = text.length): number {
    let count = 0;
    for (let pos = text.indexOf('\n'); pos !== -1 && pos < before; pos = text.indexOf('\n', pos + 1)) count++;
    return count;
}
/** Bounded, read-only repair hint. These are line numbers, not guessed edits.
 * Never return source content or the attempted search string in telemetry.
 */
function findCandidateLineNumbers(content:string,wanted:string):number[]{
    const first=wanted.split(/\r?\n/).map(line=>line.trim()).find(line=>line.length>=6);
    if(!first)return [];
    const probes=[first.slice(0,Math.min(first.length,48)),first.slice(0,Math.min(first.length,12))];
    for(const probe of probes){
        const found:number[]=[];
        let line=1,offset=0;
        while(offset<content.length && found.length<8){
            const end=content.indexOf('\n',offset);
            const limit=end<0?content.length:end;
            if(content.slice(offset,limit).includes(probe))found.push(line);
            if(end<0)break;
            offset=end+1;line++;
        }
        if(found.length)return found;
    }
    return [];
}
function repairHint(content:string,sourceSha256:string,wanted:string,readPath:string){
    const candidateLines=findCandidateLineNumbers(content,wanted);
    const line=candidateLines[0];
    return {sourceSha256,candidateLines,
      ...(line?{next:{tool:'read_code_file',args:{path:readPath,offset:Math.max(0,line-4),length:14}}}:{})};
}
export function boundedEditPreview(text: string, changeOffset: number, replacement: string): {statusLine:string; previewContent:string} {
    const totalLines = countNewlines(text) + 1;
    const changeStartLine = changeOffset < 0 ? 0 : countNewlines(text, changeOffset);
    const previewStart = Math.max(0, changeStartLine - 10);
    const previewEnd = Math.min(totalLines, changeStartLine + countNewlines(replacement) + 1 + 10);
    const lineStart = (line: number): number => {
        let pos = 0;
        for (let n = 0; n < line; n++) {
            const next = text.indexOf('\n', pos);
            if (next === -1) return text.length;
            pos = next + 1;
        }
        return pos;
    };
    const from = lineStart(previewStart);
    const to = previewEnd === totalLines ? text.length : Math.max(from, lineStart(previewEnd) - 1);
    const previewContent = text.slice(from, to);
    const statusLine = `[Reading ${previewEnd-previewStart} lines from ${previewStart === 0 ? 'start' : `line ${previewStart}`} (total: ${totalLines} lines, ${totalLines-previewEnd} remaining)]\n\n`;
    return {statusLine, previewContent};
}

export async function performSearchReplace(filePath: string, block: SearchReplace, expectedReplacements: number = 1, origin?: 'ui' | 'llm', replaceAll=false): Promise<ServerResult> {
    // Get file extension for telemetry using path module
    const fileExtension = path.extname(filePath).toLowerCase();
    
    // Capture file extension and string sizes in telemetry without capturing the file path
    capture('server_edit_block', {
        fileExtension: fileExtension,
        oldStringLength: block.search.length,
        oldStringLines: block.search.split('\n').length,
        newStringLength: block.replace.length,
        newStringLines: block.replace.split('\n').length,
        expectedReplacements: expectedReplacements
    });
    // Check for empty search string to prevent infinite loops
    if (block.search === "") {
    
        // Capture file extension in telemetry without capturing the file path
        capture('server_edit_block_empty_search', {fileExtension: fileExtension, expectedReplacements});
        return editBlockFailure('INVALID_ARGUMENT',
            'old_string must be non-empty. No changes were written.', MISSING_EDIT_GUIDANCE);
    }
    

    // Read file directly to preserve line endings - critical for edit operations
    const validPath = await validatePath(filePath);
    // One bounded file snapshot supplies both the contents and conflict hash.
    // Preserve existing UTF-8 text/line endings while avoiding duplicate reads.
    const snapshot = await readBounded(validPath, 32 * 1024 * 1024);
    const originalHash = sha256(snapshot);
    const content = snapshot.toString('utf8');
    
    // Make sure content is a string
    if (typeof content !== 'string') {
        capture('server_edit_block_content_not_string', {fileExtension: fileExtension, expectedReplacements});
        throw new Error('Wrong content for file ' + filePath);
    }
    
    // Get the line limit from configuration
    const config = await configManager.getConfig();
    const MAX_LINES = config.fileWriteLineLimit ?? 50; // Default to 50 if not set
    
    // Detect file's line ending style
    const fileLineEnding = detectLineEnding(content);
    
    // Normalize search string to match file's line endings
    const normalizedSearch = normalizeLineEndings(block.search, fileLineEnding);
    
    // First try exact match. replace_all is an explicit bulk-edit request;
    // never infer it from an ambiguous match count.
    const count = countNonOverlapping(content, normalizedSearch);
    if(replaceAll && count>10000)return editBlockFailure('EDIT_COUNT_MISMATCH',
      'replace_all found over 10000 occurrences; no changes were written.',COUNT_GUIDANCE,
      {actualReplacements:count,sourceSha256:originalHash});
    if(replaceAll && count>0)expectedReplacements=count;
    
    // If exact match found and count matches expected replacements, proceed with exact replacement
    if (count > 0 && count === expectedReplacements) {
        // Replace all occurrences
        let newContent = content;
        
        // If we're only replacing one occurrence, replace it directly
        if (expectedReplacements === 1) {
            const searchIndex = newContent.indexOf(normalizedSearch);
            newContent = 
                newContent.substring(0, searchIndex) + 
                normalizeLineEndings(block.replace, fileLineEnding) + 
                newContent.substring(searchIndex + normalizedSearch.length);
        } else {
            // Replace all occurrences using split and join for multiple replacements
            newContent = newContent.split(normalizedSearch).join(normalizeLineEndings(block.replace, fileLineEnding));
        }
        
        // Check if search or replace text has too many lines
        const searchLines = block.search.split('\n').length;
        const replaceLines = block.replace.split('\n').length;
        const maxLines = Math.max(searchLines, replaceLines);
        let warningMessage = "";
        
        if (maxLines > MAX_LINES) {
            const problemText = searchLines > replaceLines ? 'search text' : 'replacement text';
            warningMessage = `\n\nWARNING: The ${problemText} has ${maxLines} lines (maximum: ${MAX_LINES}).
            
RECOMMENDATION: For large search/replace operations, consider breaking them into smaller chunks with fewer lines.`;
        }
        
        await atomicWrite(validPath, newContent, originalHash);
        capture('server_edit_block_exact_success', {fileExtension: fileExtension, expectedReplacements, hasWarning: warningMessage !== ""});
        const resolvedEditPath = resolveAbsolutePath(filePath);

        // The preview is bounded: do not split large source files into a
        // million-element array simply to display 20 surrounding lines.
        const changePos = content.indexOf(normalizedSearch);
        const { statusLine, previewContent } = boundedEditPreview(
            newContent, changePos, block.replace
        );

        return {
            content: [{
                type: "text",
                text: `${statusLine}${previewContent}`
            }],
            // structuredContent only travels on widget-initiated calls: it is the
            // widget's save-success signal (assertSuccessfulEditBlockResult) and
            // metadata source. LLM-facing responses don't need it — nothing there
            // consumes it, and the widget re-reads by path instead.
            ...(origin === 'ui' ? {
                structuredContent: {
                    fileName: path.basename(resolvedEditPath),
                    filePath: resolvedEditPath,
                    fileType: resolvePreviewFileType(resolvedEditPath),
                    ...await getDefaultEditorMetadata(resolvedEditPath),
                },
            } : {}),
        };
    }
    
    // If exact match found but count doesn't match expected, inform the user
    if (count > 0 && count !== expectedReplacements) {
        capture('server_edit_block_unexpected_count', {fileExtension: fileExtension, expectedReplacements, expectedReplacementsCount: count});
        return editBlockFailure('EDIT_COUNT_MISMATCH',
            `Expected ${expectedReplacements} occurrences but found ${count} in ${filePath}. No changes were written.`,
            COUNT_GUIDANCE,{expectedReplacements,actualReplacements:count,
                ...repairHint(content,originalHash,normalizedSearch,validPath)});
    }
    
    // An exact multi-line block may have been reindented by a formatter.
    // Recover only when every line is identical except for leading spaces/tabs
    // AND exactly one whole-line block matches. Hash-aware atomicWrite still
    // rejects concurrent changes; ambiguous/semantic edits remain failures.
    const indentationMatch = count === 0 && expectedReplacements === 1
        ? findUniqueIndentationMatch(content, normalizedSearch) : null;
    if (indentationMatch) {
        const replacement = normalizeLineEndings(block.replace, fileLineEnding);
        const nextContent = content.slice(0,indentationMatch.start) + replacement +
            content.slice(indentationMatch.end);
        await atomicWrite(validPath,nextContent,originalHash);
        const resolvedEditPath = resolveAbsolutePath(filePath);
        return {
            content:[{type:'text',text:
                'Applied one unique, full-line indentation-only match to '+filePath+
                '. Verified with an atomic file hash check; no fuzzy replacement was used.'}],
            structuredContent:{changed:true,autoAlignedIndentation:true,
                ...(origin === 'ui' ? {
                    fileName:path.basename(resolvedEditPath),
                    filePath:resolvedEditPath,
                    fileType:resolvePreviewFileType(resolvedEditPath),
                    ...await getDefaultEditorMetadata(resolvedEditPath),
                }:{}),
            },
        };
    }

    // A miss must not consume a CPU core running Levenshtein over the file.
    // Fuzzy suggestions were advisory only: they never authorized a write.
    if (count === 0) {
        return editBlockFailure('EDIT_TEXT_NOT_FOUND',
            'old_string was not found exactly in the current file. No changes were written.',
            NO_MATCH_GUIDANCE, {actualReplacements:0,
                ...repairHint(content,originalHash,normalizedSearch,validPath)});
    }

    throw new Error("Unexpected error during search and replace operation.");
}

/**
 * Recover only from indentation-only differences on a UNIQUE multi-line,
 * full-line anchor. Never use fuzzy similarity to decide a write target.
 * Partial lines, blank lines and ambiguous repeated blocks remain errors.
 */
function findUniqueIndentationMatch(
    content: string, search: string
): {start:number;end:number}|null {
    if (search.length < 24 || search.length > 12000 || !search.includes('\n')) return null;
    const wanted = search.split('\n');
    if (wanted.length < 2 || wanted.length > 32 || wanted.some(line => !line.trim())) return null;
    const lines = content.split('\n');
    if (lines.length > 40000 || wanted.length > lines.length) return null;
    const plain = (line: string) => line.replace(/^[ \t]*/, '');
    const normalized = wanted.map(plain);
    const positions: number[] = [];
    let offset = 0;
    for (const line of lines) { positions.push(offset); offset += line.length + 1; }
    let found: {start:number;end:number}|null = null;
    for (let i=0; i<=lines.length-wanted.length; i++) {
        if (plain(lines[i])!==normalized[0]) continue;
        let matched = true;
        for (let j=1; j<wanted.length; j++) {
            if (plain(lines[i+j])!==normalized[j]) { matched=false; break; }
        }
        if (!matched) continue;
        if (found) return null; // ambiguous: fail closed
        found = {start:positions[i], end:positions[i+wanted.length-1]+lines[i+wanted.length-1].length};
    }
    return found;
}

function countNonOverlapping(haystack: string, needle: string): number {
    let count = 0;
    let pos = haystack.indexOf(needle);
    while (pos !== -1) {
        count++;
        pos = haystack.indexOf(needle, pos + needle.length);
    }
    return count;
}

/**
 * BRC: apply several find/replace edits to one text file in a single call.
 * Edits are applied in order against the in-memory result of the previous edit.
 * All edits are validated before anything is written: if any edit does not match
 * its expected_replacements count, the file is left untouched (all-or-nothing).
 */
export async function performMultiEdit(
    validPath: string,
    displayPath: string,
    edits: Array<{ old_string: string; new_string: string; expected_replacements?: number;replace_all?:boolean }>,
): Promise<ServerResult> {
    // One bounded file snapshot supplies both the contents and conflict hash.
    // Preserve existing UTF-8 text/line endings while avoiding duplicate reads.
    const snapshot = await readBounded(validPath, 32 * 1024 * 1024);
    const originalHash = sha256(snapshot);
    const content = snapshot.toString('utf8');
    if (typeof content !== 'string') {
        return editBlockFailure('EDIT_STRUCTURED_FAILED',
            'The target is not plain UTF-8 text: '+displayPath+'. No changes were written.',
            'Use the correct file-specific range/content schema, or read the file first to choose a supported editing method.');
    }
    const lineEnding = detectLineEnding(content);
    let next = content;

    for (let i = 0; i < edits.length; i++) {
        const e = edits[i];
        let expected = e.expected_replacements ?? 1;
        const label = `Edit #${i + 1} of ${edits.length}`;
        if (!e.old_string) {
            return editBlockFailure('INVALID_ARGUMENT',
                `${label}: old_string must be non-empty. No changes were written.`,MISSING_EDIT_GUIDANCE,
                {editIndex:i+1,editsApplied:0});
        }
        const search = normalizeLineEndings(e.old_string, lineEnding);
        const replace = normalizeLineEndings(e.new_string, lineEnding);
        const count = countNonOverlapping(next, search);
        if(e.replace_all && count>10000)return editBlockFailure('EDIT_COUNT_MISMATCH',
          'Edit #'+(i+1)+' would replace over 10000 occurrences; no changes were written.',COUNT_GUIDANCE,
          {editIndex:i+1,actualReplacements:count,editsApplied:0});
        if(e.replace_all && count>0)expected=count;

        if (count !== expected) {
            const hint = count > 0
                ? ' Use a unique old_string, or explicitly set expected_replacements if all occurrences should change.'
                : ' Re-read the file and use the exact old_string; fuzzy scanning is disabled to conserve CPU.';
            return editBlockFailure(count===0?'EDIT_TEXT_NOT_FOUND':'EDIT_COUNT_MISMATCH',
                `${label} failed: expected ${expected} occurrence(s) of old_string but found ${count}`+
                (i>0?' (after evaluating previous edits in memory)':'')+
                `. No changes were written.${hint.slice(0,1200)}`,
                count===0?NO_MATCH_GUIDANCE:COUNT_GUIDANCE,
                {editIndex:i+1,expectedReplacements:expected,actualReplacements:count,editsApplied:0,
                    ...repairHint(next,originalHash,search,validPath)});
        }

        if (expected === 1) {
            const idx = next.indexOf(search);
            next = next.substring(0, idx) + replace + next.substring(idx + search.length);
        } else {
            next = next.split(search).join(replace);
        }
    }

    if (next === content) {
        return { content: [{ type: "text", text: `No changes: the ${edits.length} edit(s) produced identical content in ${displayPath}.` }] };
    }

    await atomicWrite(validPath, next, originalHash);
    capture('server_edit_block_multi', { fileExtension: path.extname(validPath).toLowerCase(), editCount: edits.length });
    const totalLines = next.split('\n').length;
    return {
        content: [{
            type: "text",
            text: `Successfully applied ${edits.length} edit(s) to ${displayPath} (now ${totalLines} lines).`
        }],
    };
}

/**
 * Handle edit_block command
 *
 * 1. Text files: String replacement (old_string/new_string)
 *    - Supports a unique indentation-only full-line match; no expensive fuzzy scan
 *    - Handles expected_replacements parameter
 *
 * 2. Structured files (Excel): Range rewrite (range + content)
 *    - Bulk updates to cell ranges (e.g., "Sheet1!A1:C10")
 *    - Whole sheet replacement (e.g., "Sheet1")
 *    - More powerful and simpler than surgical location-based edits
 *    - Supports chunking for large datasets (e.g., 1000 rows at a time)

 */
export async function handleEditBlock(args: unknown): Promise<ServerResult> {
    const checked=EditBlockArgsSchema.safeParse(args);
    if(!checked.success){
        const missing=checked.error.issues.map(i=>i.path.join('.')||'arguments').slice(0,6).join(', ');
        return editBlockFailure('INVALID_ARGUMENT',
            'Invalid edit_block arguments ('+missing+'): '+checked.error.issues.map(i=>i.message).slice(0,4).join('; '),
            MISSING_EDIT_GUIDANCE);
    }
    const parsed=checked.data;

    // Note: Check for truthy range to handle empty strings from AI clients that send all optional params
    const hasRange = parsed.range !== undefined && parsed.range !== '';
    const hasContent = parsed.content !== undefined && parsed.content !== '';

    // Validate path and resolve handler once — used by both dispatch paths below
    let validatedPath: string;
    let handler: Awaited<ReturnType<typeof import('../utils/files/factory.js').getFileHandler>>;
    try {
        validatedPath = await validatePath(parsed.file_path);
        const { getFileHandler } = await import('../utils/files/factory.js');
        handler = await getFileHandler(validatedPath);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return editBlockFailure('EDIT_PATH_INVALID',
            'Unable to open edit target: '+errorMessage,
            'Verify file_path is an existing file inside an allowed directory; use read_file or get_file_info to confirm it. No changes were written.');
    }

    const hasEditRange = 'editRange' in handler && typeof handler.editRange === 'function';
    if(hasEditRange && (parsed.replace_all||parsed.edits?.some(edit=>edit.replace_all)))
      return editBlockFailure('EDIT_UNSUPPORTED_REPLACE_ALL',
        'replace_all applies only to plain UTF-8 text files; structured Office formats have different replacement semantics.',
        'Use exact expected_replacements with the appropriate structured document tool; no change was made.');

    // Path 1: Range rewrite (Excel, etc.) — range + content
    if (hasRange && hasContent) {
        // Parse content if it's a JSON string (AI often sends arrays as JSON strings)
        let content = parsed.content;
        if (typeof content === 'string') {
            try {
                content = JSON.parse(content);
            } catch {
                // Leave as-is if not valid JSON - let handler decide
            }
        }

        if (hasEditRange) {
            try {
                // parsed.range is guaranteed non-empty string by hasRange check above
                await handler.editRange!(validatedPath!, parsed.range!, content, parsed.options);
                const resolvedRangePath = resolveAbsolutePath(parsed.file_path);
                return {
                    content: [{
                        type: "text",
                        text: `Successfully updated range ${parsed.range} in ${parsed.file_path}`
                    }],
                    ...(parsed.origin === 'ui' ? {
                        structuredContent: {
                            fileName: path.basename(resolvedRangePath),
                            filePath: resolvedRangePath,
                            fileType: resolvePreviewFileType(resolvedRangePath),
                            ...await getDefaultEditorMetadata(resolvedRangePath),
                        },
                    } : {}),
                };
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                return editBlockFailure('EDIT_STRUCTURED_FAILED',
                    'Range edit failed: '+errorMessage,
                    'Inspect the current spreadsheet/file and supported range format before retrying. Some writes may have occurred.',
                    {changed:'unknown'});
            }
        }

        return editBlockFailure('EDIT_UNSUPPORTED_RANGE',
            `Range-based editing not supported for ${parsed.file_path}. No changes were written.`,
            'For plain text use old_string plus new_string, or edits:[{old_string,new_string}]. For spreadsheets use a supported range and 2D content.');
    }

    // Path 1b (BRC): multi-edit — edits[] applied in order
    if (parsed.edits && parsed.edits.length > 0) {
        if (hasEditRange) {
            // Structured handlers (e.g. DOCX) own find/replace; apply sequentially.
            let applied = 0;
            for (let i = 0; i < parsed.edits.length; i++) {
                const e = parsed.edits[i];
                try {
                    const result = await handler.editRange!(validatedPath!, '', {
                        old_string: e.old_string,
                        new_string: e.new_string,
                        expected_replacements: e.expected_replacements,
                    });
                    if (!result.success) {
                        const errorMsg = result.errors?.map(er => er.error).join('; ') || 'Unknown error';
                        return editBlockFailure('EDIT_STRUCTURED_FAILED',
                            `Edit #${i+1} of ${parsed.edits.length} failed: ${errorMsg}. ${applied} earlier edit(s) were already applied.`,
                            'Inspect the current structured document before retrying; some earlier edits may have completed.',
                            {changed:applied>0,editsApplied:applied,partialApplied:applied>0});

                    }
                    applied++;
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    return editBlockFailure('EDIT_STRUCTURED_FAILED',
                        `Edit #${i+1} of ${parsed.edits.length} failed: ${errorMessage}. ${applied} earlier edit(s) were already applied.`,
                        'Inspect the current structured document before retrying; the failing edit may also have partially changed the file.',
                        {changed:'unknown',editsApplied:applied,partialApplied:applied>0});

                }
            }
            return { content: [{ type: "text", text: `Successfully applied ${applied} edit(s) to ${parsed.file_path}` }] };
        }
        return performMultiEdit(validatedPath!, parsed.file_path, parsed.edits);
    }

    // Path 2: Text replacement — old_string + new_string
    if (parsed.old_string === undefined || parsed.new_string === undefined) {
        return editBlockFailure('INVALID_ARGUMENT',
            'Text replacement requires both old_string and new_string parameters. No changes were written.',
            MISSING_EDIT_GUIDANCE);
    }

    // If the handler implements editRange it owns text-replacement for its file type
    // (e.g. DocxFileHandler does find/replace on pretty-printed XML rather than raw bytes).
    // Plain text files fall through to performSearchReplace.
    if (hasEditRange) {
        try {
            const result = await handler.editRange!(validatedPath!, '', {
                old_string: parsed.old_string,
                new_string: parsed.new_string,
                expected_replacements: parsed.expected_replacements,
            });

            if (result.success) {
                const resolvedEditRangePath = resolveAbsolutePath(parsed.file_path);
                return {
                    content: [{
                        type: "text",
                        text: `Successfully applied ${result.editsApplied} edit(s) to ${parsed.file_path}`
                    }],
                    ...(parsed.origin === 'ui' ? {
                        structuredContent: {
                            fileName: path.basename(resolvedEditRangePath),
                            filePath: resolvedEditRangePath,
                            fileType: resolvePreviewFileType(resolvedEditRangePath),
                            ...await getDefaultEditorMetadata(resolvedEditRangePath),
                        },
                    } : {}),
                };
            }

            const errorMsg = result.errors?.map(e => e.error).join('; ') || 'Unknown error';
            return editBlockFailure('EDIT_STRUCTURED_FAILED',
                'Structured text replacement failed: '+errorMsg,
                'Read the latest document representation and verify the exact XML/text before retrying.',
                {changed:'unknown'});
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return editBlockFailure('EDIT_STRUCTURED_FAILED',
                'Structured replacement threw an error: '+errorMessage,
                'Inspect the current file before retrying; the handler may have partially changed the document.',
                {changed:'unknown'});
        }
    }

    return performSearchReplace(parsed.file_path, {
        search: parsed.old_string,
        replace: parsed.new_string
    }, parsed.expected_replacements, parsed.origin, parsed.replace_all);
}
