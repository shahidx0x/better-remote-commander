/**
 * Text file editing via search/replace with fuzzy matching support.
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

import { getDefaultEditorMetadata, readFile, writeFile, readFileInternal, validatePath } from './filesystem.js';
import fs from 'fs/promises';
import { ServerResult } from '../types.js';
import { runFuzzySearchInWorker, getSimilarityRatio } from './fuzzySearch.js';
import { capture } from '../utils/capture.js';
// Edit failures use structured error codes instead of unclassified text.
import { EditBlockArgsSchema } from "./schemas.js";
import { atomicWrite, readBounded, sha256 } from "../../runtime/file-safety.js";
import path from 'path';
import { detectLineEnding, normalizeLineEndings } from '../utils/lineEndingHandler.js';
import { configManager } from '../config-manager.js';
import { fuzzySearchLogger, type FuzzySearchLogEntry } from '../utils/fuzzySearchLogger.js';
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
    'No text was changed. Re-read the latest file with read_file, copy an exact and unique old_string including indentation/whitespace, then retry. Fuzzy matches are hints only.';
const COUNT_GUIDANCE =
    'No text was changed. Add surrounding lines to make old_string unique, or set expected_replacements to the actual count ONLY if all occurrences should change. Read and verify the current file first.';

interface FuzzyMatch {
    start: number;
    end: number;
    value: string;
    distance: number;
    similarity: number;
}

/**
 * Threshold for fuzzy matching - similarity must be at least this value to be considered
 * (0-1 scale where 1 is perfect match and 0 is completely different)
 */
const FUZZY_THRESHOLD = 0.7;

/**
 * Extract character code data from diff
 * @param expected The string that was searched for
 * @param actual The string that was found
 * @returns Character code statistics
 */
function getCharacterCodeData(expected: string, actual: string): {
    report: string;
    uniqueCount: number;
    diffLength: number;
} {
    // Find common prefix and suffix
    let prefixLength = 0;
    const minLength = Math.min(expected.length, actual.length);

    // Determine common prefix length
    while (prefixLength < minLength &&
           expected[prefixLength] === actual[prefixLength]) {
        prefixLength++;
    }

    // Determine common suffix length
    let suffixLength = 0;
    while (suffixLength < minLength - prefixLength &&
           expected[expected.length - 1 - suffixLength] === actual[actual.length - 1 - suffixLength]) {
        suffixLength++;
    }
    
    // Extract the different parts
    const expectedDiff = expected.substring(prefixLength, expected.length - suffixLength);
    const actualDiff = actual.substring(prefixLength, actual.length - suffixLength);
    
    // Count unique character codes in the diff
    const characterCodes = new Map<number, number>();
    const fullDiff = expectedDiff + actualDiff;
    
    for (let i = 0; i < fullDiff.length; i++) {
        const charCode = fullDiff.charCodeAt(i);
        characterCodes.set(charCode, (characterCodes.get(charCode) || 0) + 1);
    }
    
    // Create character codes string report
    const charCodeReport: string[] = [];
    characterCodes.forEach((count, code) => {
        // Include character representation for better readability
        const char = String.fromCharCode(code);
        // Make special characters more readable
        const charDisplay = code < 32 || code > 126 ? `\\x${code.toString(16).padStart(2, '0')}` : char;
        charCodeReport.push(`${code}:${count}[${charDisplay}]`);
    });
    
    // Sort by character code for consistency
    charCodeReport.sort((a, b) => {
        const codeA = parseInt(a.split(':')[0]);
        const codeB = parseInt(b.split(':')[0]);
        return codeA - codeB;
    });
    
    return {
        report: charCodeReport.join(','),
        uniqueCount: characterCodes.size,
        diffLength: fullDiff.length
    };
}

export async function performSearchReplace(filePath: string, block: SearchReplace, expectedReplacements: number = 1, origin?: 'ui' | 'llm'): Promise<ServerResult> {
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
    const originalHash = sha256(await readBounded(validPath, 32 * 1024 * 1024));
    const content = await readFileInternal(validPath, 0, Number.MAX_SAFE_INTEGER);
    
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
    
    // First try exact match
    const count = countNonOverlapping(content, normalizedSearch);
    
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

        // Show a partial preview centered on the edited area
        const newLines = newContent.split('\n');
        const totalLines = newLines.length;
        const changePos = content.indexOf(normalizedSearch);
        const changeStartLine = changePos >= 0 ? newContent.substring(0, changePos).split('\n').length - 1 : 0;
        const changeLineCount = block.replace.split('\n').length;
        const contextLines = 10;
        const previewStart = Math.max(0, changeStartLine - contextLines);
        const previewEnd = Math.min(totalLines, changeStartLine + changeLineCount + contextLines);
        const previewContent = newLines.slice(previewStart, previewEnd).join('\n');
        const previewLineCount = previewEnd - previewStart;
        const remaining = totalLines - previewEnd;
        const statusLine = `[Reading ${previewLineCount} lines from ${previewStart === 0 ? 'start' : `line ${previewStart}`} (total: ${totalLines} lines, ${remaining} remaining)]\n\n`;

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
            COUNT_GUIDANCE,{expectedReplacements,actualReplacements:count});
    }
    
    // If exact match not found, try fuzzy search
    if (count === 0) {
        // Track fuzzy search time
        const startTime = performance.now();

        // Perform fuzzy search in a worker thread so the main event loop stays
        // responsive to pings and parallel tool calls during the scan
        const fuzzyResult = await runFuzzySearchInWorker(content, block.search);
        const similarity = getSimilarityRatio(block.search, fuzzyResult.value);
        
        // Calculate execution time in milliseconds
        const executionTime = performance.now() - startTime;
        
        // Generate diff and gather character code data
        const diff = highlightDifferences(block.search, fuzzyResult.value);
        
        // Count character codes in diff
        const characterCodeData = getCharacterCodeData(block.search, fuzzyResult.value);
        
        // Create comprehensive log entry
        const logEntry: FuzzySearchLogEntry = {
            timestamp: new Date(),
            searchText: block.search,
            foundText: fuzzyResult.value,
            similarity: similarity,
            executionTime: executionTime,
            exactMatchCount: count,
            expectedReplacements: expectedReplacements,
            fuzzyThreshold: FUZZY_THRESHOLD,
            belowThreshold: similarity < FUZZY_THRESHOLD,
            diff: diff,
            searchLength: block.search.length,
            foundLength: fuzzyResult.value.length,
            fileExtension: fileExtension,
            characterCodes: characterCodeData.report,
            uniqueCharacterCount: characterCodeData.uniqueCount,
            diffLength: characterCodeData.diffLength
        };
        
        // Log to file
        await fuzzySearchLogger.log(logEntry);
        
        // Combine all fuzzy search data for single capture
        //
        // character_codes (characterCodeData.report) is deliberately NOT sent.
        // It is a frequency map of the characters in the diff between the
        // search text and the file text, so for a short diff it is close to
        // recoverable file content — and mcp-privacy-policy.md states that
        // file contents are not collected. It was added as diagnostics for the
        // CRLF/LF normalization work in #103 (May 2025) to show whether failed
        // matches came from \r (13), \n (10) or non-breaking spaces; that
        // question is long since answered.
        //
        // The scalars below are kept: they are counts and lengths, and carry
        // no recoverable content. The full report still goes to the local
        // fuzzy-search.log for anyone debugging on their own machine.
        const fuzzySearchData = {
            similarity: similarity,
            execution_time_ms: executionTime,
            search_length: block.search.length,
            file_size: content.length,
            threshold: FUZZY_THRESHOLD,
            found_text_length: fuzzyResult.value.length,
            unique_character_count: characterCodeData.uniqueCount,
            total_diff_length: characterCodeData.diffLength
        };
        
        // Check if the fuzzy match is "close enough"
        if (similarity >= FUZZY_THRESHOLD) {
            // Capture the fuzzy search event with all data
            capture('server_fuzzy_search_performed', fuzzySearchData);
            
            // If we allow fuzzy matches, we would make the replacement here
            // For now, we'll return a detailed message about the fuzzy match
            return editBlockFailure('EDIT_TEXT_NOT_FOUND',
                `Exact match not found, but found a similar text with ${Math.round(similarity*100)}% similarity (found in ${executionTime.toFixed(2)}ms):\n\nDifferences:\n${diff.slice(0,1600)}\n\nNo changes were written.`,
                NO_MATCH_GUIDANCE,{actualReplacements:0,closestSimilarity:Math.round(similarity*100)});
        } else {
            // If the fuzzy match isn't close enough
            // Still capture the fuzzy search event with all data
            capture('server_fuzzy_search_performed', {
                ...fuzzySearchData,
                below_threshold: true
            });
            
            return editBlockFailure('EDIT_TEXT_NOT_FOUND',
                `Search content not found in ${filePath}. The closest match was "${fuzzyResult.value.slice(0,1500)}" `+
                `with only ${Math.round(similarity*100)}% similarity, below the ${Math.round(FUZZY_THRESHOLD*100)}% threshold. `+
                `(Fuzzy search completed in ${executionTime.toFixed(2)}ms). No changes were written.`,
                NO_MATCH_GUIDANCE,{actualReplacements:0,closestSimilarity:Math.round(similarity*100)});
        }
    }
    
    throw new Error("Unexpected error during search and replace operation.");
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
    edits: Array<{ old_string: string; new_string: string; expected_replacements?: number }>,
): Promise<ServerResult> {
    const originalHash = sha256(await readBounded(validPath, 32 * 1024 * 1024));
    const content = await readFileInternal(validPath, 0, Number.MAX_SAFE_INTEGER);
    if (typeof content !== 'string') {
        return editBlockFailure('EDIT_STRUCTURED_FAILED',
            'The target is not plain UTF-8 text: '+displayPath+'. No changes were written.',
            'Use the correct file-specific range/content schema, or read the file first to choose a supported editing method.');
    }
    const lineEnding = detectLineEnding(content);
    let next = content;

    for (let i = 0; i < edits.length; i++) {
        const e = edits[i];
        const expected = e.expected_replacements ?? 1;
        const label = `Edit #${i + 1} of ${edits.length}`;
        if (!e.old_string) {
            return editBlockFailure('INVALID_ARGUMENT',
                `${label}: old_string must be non-empty. No changes were written.`,MISSING_EDIT_GUIDANCE,
                {editIndex:i+1,editsApplied:0});
        }
        const search = normalizeLineEndings(e.old_string, lineEnding);
        const replace = normalizeLineEndings(e.new_string, lineEnding);
        const count = countNonOverlapping(next, search);

        if (count !== expected) {
            let hint = '';
            if (count === 0) {
                try {
                    const fuzzy = await runFuzzySearchInWorker(next, e.old_string);
                    const similarity = getSimilarityRatio(e.old_string, fuzzy.value);
                    if (similarity >= FUZZY_THRESHOLD) {
                        hint = `\nClosest match (${Math.round(similarity * 100)}% similar):\n${highlightDifferences(e.old_string, fuzzy.value)}`;
                    }
                } catch { /* fuzzy hint is best-effort */ }
            } else {
                hint = ` Set expected_replacements to ${count} to replace all, or add surrounding context to make old_string unique.`;
            }
            return editBlockFailure(count===0?'EDIT_TEXT_NOT_FOUND':'EDIT_COUNT_MISMATCH',
                `${label} failed: expected ${expected} occurrence(s) of old_string but found ${count}`+
                (i>0?' (after evaluating previous edits in memory)':'')+
                `. No changes were written.${hint.slice(0,1200)}`,
                count===0?NO_MATCH_GUIDANCE:COUNT_GUIDANCE,
                {editIndex:i+1,expectedReplacements:expected,actualReplacements:count,editsApplied:0});
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
 * Generates a character-level diff using standard {-removed-}{+added+} format
 * @param expected The string that was searched for
 * @param actual The string that was found
 * @returns A formatted string showing character-level differences
 */
function highlightDifferences(expected: string, actual: string): string {
    // Implementation of a simplified character-level diff
    
    // Find common prefix and suffix
    let prefixLength = 0;
    const minLength = Math.min(expected.length, actual.length);

    // Determine common prefix length
    while (prefixLength < minLength &&
           expected[prefixLength] === actual[prefixLength]) {
        prefixLength++;
    }

    // Determine common suffix length
    let suffixLength = 0;
    while (suffixLength < minLength - prefixLength &&
           expected[expected.length - 1 - suffixLength] === actual[actual.length - 1 - suffixLength]) {
        suffixLength++;
    }
    
    // Extract the common and different parts
    const commonPrefix = expected.substring(0, prefixLength);
    const commonSuffix = expected.substring(expected.length - suffixLength);

    const expectedDiff = expected.substring(prefixLength, expected.length - suffixLength);
    const actualDiff = actual.substring(prefixLength, actual.length - suffixLength);

    // Format the output as a character-level diff
    return `${commonPrefix}{-${expectedDiff}-}{+${actualDiff}+}${commonSuffix}`;
}

/**
 * Handle edit_block command
 *
 * 1. Text files: String replacement (old_string/new_string)
 *    - Uses fuzzy matching for resilience
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
    }, parsed.expected_replacements, parsed.origin);
}
