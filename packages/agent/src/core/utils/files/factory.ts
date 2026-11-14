/**
 * Factory pattern for creating appropriate file handlers
 * Routes file operations to the correct handler based on file type
 *
 * Each handler implements canHandle() which can be sync (extension-based)
 * or async (content-based like BinaryFileHandler using isBinaryFile)
 *
 * BRC: Excel/PDF/DOCX handlers pull in heavy libraries (exceljs, pdf-lib,
 * md-to-pdf/puppeteer, unpdf, pizzip). They are loaded with dynamic import()
 * only when a file of that type is actually touched, which keeps agent startup
 * fast and memory low. Type routing is done by extension here.
 */

import type { FileHandler } from './base.js';
import { TextFileHandler } from './text.js';
import { ImageFileHandler } from './image.js';
import { BinaryFileHandler } from './binary.js';

const EXCEL_EXTENSIONS = ['.xlsx', '.xls', '.xlsm'];
const PDF_EXTENSIONS = ['.pdf'];
const DOCX_EXTENSIONS = ['.docx'];

function hasExt(filePath: string, exts: string[]): boolean {
    const lower = filePath.toLowerCase();
    return exts.some(e => lower.endsWith(e));
}

// Singleton instances of each handler
let excelHandler: FileHandler | null = null;
let imageHandler: ImageFileHandler | null = null;
let textHandler: TextFileHandler | null = null;
let binaryHandler: BinaryFileHandler | null = null;
let pdfHandler: FileHandler | null = null;
let docxHandler: FileHandler | null = null;

async function getExcelHandler(): Promise<FileHandler> {
    if (!excelHandler) {
        const { ExcelFileHandler } = await import('./excel.js');
        excelHandler = new ExcelFileHandler();
    }
    return excelHandler;
}

async function getPdfHandler(): Promise<FileHandler> {
    if (!pdfHandler) {
        const { PdfFileHandler } = await import('./pdf.js');
        pdfHandler = new PdfFileHandler();
    }
    return pdfHandler;
}

async function getDocxHandler(): Promise<FileHandler> {
    if (!docxHandler) {
        const { DocxFileHandler } = await import('./docx.js');
        docxHandler = new DocxFileHandler();
    }
    return docxHandler;
}

function getImageHandler(): ImageFileHandler {
    if (!imageHandler) imageHandler = new ImageFileHandler();
    return imageHandler;
}

function getTextHandler(): TextFileHandler {
    if (!textHandler) textHandler = new TextFileHandler();
    return textHandler;
}

function getBinaryHandler(): BinaryFileHandler {
    if (!binaryHandler) binaryHandler = new BinaryFileHandler();
    return binaryHandler;
}

/**
 * Get the appropriate file handler for a given file path
 *
 * Priority order:
 * 1. DOCX files (extension based)
 * 2. PDF files (extension based)
 * 3. Excel files (xlsx, xls, xlsm) - extension based
 * 4. Image files (png, jpg, gif, webp) - extension based
 * 5. Binary files - content-based detection via isBinaryFile
 * 6. Text files (default)
 */
export async function getFileHandler(filePath: string): Promise<FileHandler> {
    if (hasExt(filePath, DOCX_EXTENSIONS)) return getDocxHandler();
    if (hasExt(filePath, PDF_EXTENSIONS)) return getPdfHandler();
    if (hasExt(filePath, EXCEL_EXTENSIONS)) return getExcelHandler();

    // Check Image (extension-based, sync - images are binary but handled specially)
    if (getImageHandler().canHandle(filePath)) {
        return getImageHandler();
    }

    // Check Binary (content-based, async via isBinaryFile)
    if (await getBinaryHandler().canHandle(filePath)) {
        return getBinaryHandler();
    }

    // Default to text handler
    return getTextHandler();
}

/** Check if a file path is an Excel file (extension based, no heavy import). */
export function isExcelFile(path: string): boolean {
    return hasExt(path, EXCEL_EXTENSIONS);
}

/** Check if a file path is an image file. */
export function isImageFile(path: string): boolean {
    return getImageHandler().canHandle(path);
}
