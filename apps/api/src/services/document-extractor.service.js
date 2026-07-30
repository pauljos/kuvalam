// apps/api/src/services/document-extractor.service.js
// Phase 3: PDF/DOCX/TXT/MD text extraction service
import { readFile } from 'fs/promises'

/**
 * Extract plain text from a document buffer based on mime type.
 * Supports: PDF, DOCX, plain text, markdown.
 */
export async function extractText(buffer, mimeType, filename = '') {
  const ext = filename.split('.').pop()?.toLowerCase() || ''

  // --- PDF ---
  if (mimeType === 'application/pdf' || ext === 'pdf') {
    return extractPDF(buffer)
  }

  // --- DOCX ---
  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    ext === 'docx'
  ) {
    return extractDOCX(buffer)
  }

  // --- DOC (legacy) ---
  if (mimeType === 'application/msword' || ext === 'doc') {
    // Best-effort: strip non-printable bytes from binary .doc files
    return extractLegacyDoc(buffer)
  }

  // --- Plain text / Markdown / CSV ---
  if (
    mimeType?.startsWith('text/') ||
    ['txt', 'md', 'csv', 'json', 'xml', 'html', 'htm', 'yaml', 'yml', 'log'].includes(ext)
  ) {
    return buffer.toString('utf8')
  }

  // --- XLSX / XLS (Excel spreadsheets) ---
  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mimeType === 'application/vnd.ms-excel' ||
    ext === 'xlsx' || ext === 'xls'
  ) {
    return extractXLSX(buffer)
  }

  // Fallback: attempt UTF-8 decode (unknown type)
  return buffer.toString('utf8')
}

// ─── PDF extraction ────────────────────────────────────────────────────────
async function extractPDF(buffer) {
  try {
    // pdf-parse is a CommonJS module, use dynamic import
    const pdfParse = (await import('pdf-parse')).default
    const data = await pdfParse(buffer, {
      // Limit to 500 pages for safety
      max: 500
    })
    return data.text || ''
  } catch (err) {
    throw new Error(`PDF_EXTRACTION_FAILED: ${err.message}`)
  }
}

// ─── DOCX extraction ──────────────────────────────────────────────────────
async function extractDOCX(buffer) {
  try {
    const mammoth = await import('mammoth')
    const result = await mammoth.default.extractRawText({ buffer })
    return result.value || ''
  } catch (err) {
    throw new Error(`DOCX_EXTRACTION_FAILED: ${err.message}`)
  }
}

// ─── Legacy .doc (best-effort) ─────────────────────────────────────────────
function extractLegacyDoc(buffer) {
  // Strip control characters and extract readable ASCII/UTF-8 runs
  const text = buffer.toString('utf8')
  // Remove null bytes and control chars except newlines/tabs
  const cleaned = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, ' ')
  // Collapse whitespace
  return cleaned.replace(/\s{3,}/g, '\n\n').trim()
}

// ─── XLSX / XLS extraction ────────────────────────────────────────────────
async function extractXLSX(buffer) {
  try {
    const XLSX = await import('xlsx')
    const workbook = XLSX.read(buffer, { type: 'buffer' })
    const parts = []
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName]
      const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false, strip: true })
      if (csv.trim()) {
        parts.push(`--- Sheet: ${sheetName} ---\n${csv}`)
      }
    }
    return parts.join('\n\n') || ''
  } catch (err) {
    throw new Error(`XLSX_EXTRACTION_FAILED: ${err.message}`)
  }
}
