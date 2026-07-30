// apps/api/src/services/reports.service.js
// Dashboard Reports — full service with pagination, sharing, download, TTL, and soft-delete

import { query } from '../db/pool.js'
import { AppError } from '../utils/errors.js'
import { randomBytes } from 'crypto'

// ─── Plan-based TTL defaults (days until auto-archive) ──────────────────────
// ENTERPRISE/PRO reports never expire. TRIAL/FREE archived after 90 days.
const PLAN_TTL_DAYS = {
  TRIAL:      90,
  FREE:       90,
  PRO:        null,       // never expires
  ENTERPRISE: null,
}

async function getTenantPlan(tenantId) {
  try {
    const { rows: [row] } = await query('SELECT plan FROM tenants WHERE id = $1', [tenantId])
    return row?.plan || 'TRIAL'
  } catch { return 'TRIAL' }
}

function computeExpiresAt(plan) {
  const days = PLAN_TTL_DAYS[plan] ?? 90
  if (!days) return null
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Detect which download formats are available for a given report */
function resolveDownloadFormats(reportType, htmlContent) {
  const formats = ['html'] // always available
  if (reportType === 'svg' || (htmlContent && htmlContent.includes('<svg'))) formats.push('svg')
  if (reportType === 'data_model') formats.push('svg', 'png_hint')
  if (['chart', 'd3', 'mixed', 'data_model', 'svg'].includes(reportType)) formats.push('pdf')
  // Also offer PDF for any HTML report that contains an SVG (e.g., generic HTML reports with embedded diagrams)
  if (!formats.includes('pdf') && htmlContent && htmlContent.includes('<svg')) formats.push('pdf')
  return [...new Set(formats)]
}

/** Sanitise a filename component */
const safeFilename = (s) => (s || 'report').replace(/[^a-zA-Z0-9._\- ]/g, '_').slice(0, 80)

// ─── Core CRUD ───────────────────────────────────────────────────────────────

/**
 * Save a new report. Called by the agent's publish_dashboard_report tool.
 *
 * @param {string}  tenantId
 * @param {string}  agentId
 * @param {string}  title
 * @param {string}  htmlContent
 * @param {object}  opts
 * @param {string}  [opts.reportType='html']     - 'chart'|'svg'|'d3'|'data_model'|'mixed'|'html'
 * @param {string}  [opts.summary]               - Short text summary of the report
 * @param {object}  [opts.metadata={}]           - KPI count, chart count, row count etc.
 * @param {number}  [opts.expiresInDays]         - Override plan-default TTL
 */
export async function saveReport(tenantId, agentId, title, htmlContent, opts = {}) {
  if (!htmlContent) throw new AppError('VALIDATION_ERROR', 'htmlContent is required', 400)

  const reportTitle = title || 'Untitled Report'
  const reportType  = opts.reportType  || 'html'
  const summary     = opts.summary     || null
  const metadata    = opts.metadata    || {}

  const plan = await getTenantPlan(tenantId)
  const expiresAt = opts.expiresInDays != null
    ? (() => { const d = new Date(); d.setDate(d.getDate() + opts.expiresInDays); return d })()
    : computeExpiresAt(plan)

  const downloadFormats = resolveDownloadFormats(reportType, htmlContent)

  const { rows: [report] } = await query(
    `INSERT INTO dashboard_reports
       (tenant_id, agent_id, title, html_content, report_type, summary, metadata, expires_at, download_formats)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, tenant_id, agent_id, title, report_type, summary, metadata, download_formats, expires_at, created_at`,
    [tenantId, agentId || null, reportTitle, htmlContent, reportType, summary,
     JSON.stringify(metadata), expiresAt, downloadFormats]
  )
  return report
}

/**
 * List reports for a tenant with cursor-based pagination.
 *
 * @param {string} tenantId
 * @param {object} opts
 * @param {string} [opts.agentId]       - Filter to a specific agent
 * @param {string} [opts.reportType]    - Filter by type
 * @param {number} [opts.limit=20]      - Page size (max 100)
 * @param {string} [opts.cursor]        - Opaque cursor (base64 encoded created_at+id)
 * @param {string} [opts.search]        - Full-text search on title
 */
export async function listReports(tenantId, opts = {}) {
  const limit = Math.min(parseInt(opts.limit || 20), 100)
  const params = [tenantId]
  const conditions = ['r.tenant_id = $1', 'r.archived_at IS NULL']

  if (opts.agentId) {
    params.push(opts.agentId)
    conditions.push(`r.agent_id = $${params.length}`)
  }

  if (opts.reportType) {
    params.push(opts.reportType)
    conditions.push(`r.report_type = $${params.length}`)
  }

  if (opts.search) {
    params.push(`%${opts.search.slice(0, 200)}%`)
    conditions.push(`r.title ILIKE $${params.length}`)
  }

  // Cursor: decode to (created_at, id) pair
  if (opts.cursor) {
    try {
      const decoded = Buffer.from(opts.cursor, 'base64url').toString('utf-8')
      const { createdAt, id } = JSON.parse(decoded)
      params.push(createdAt, id)
      conditions.push(`(r.created_at, r.id) < ($${params.length - 1}::timestamptz, $${params.length})`)
    } catch { /* invalid cursor — ignore, start from beginning */ }
  }

  const where = conditions.join(' AND ')
  params.push(limit + 1) // fetch one extra to determine if there's a next page

  const { rows } = await query(
    `SELECT r.id, r.title, r.report_type, r.summary, r.metadata, r.download_formats,
            r.is_public, r.public_token, r.expires_at, r.archived_at, r.created_at,
            a.name as agent_name, a.archetype as agent_archetype
     FROM dashboard_reports r
     LEFT JOIN agents a ON r.agent_id = a.id
     WHERE ${where}
     ORDER BY r.created_at DESC, r.id DESC
     LIMIT $${params.length}`,
    params
  )

  const hasMore = rows.length > limit
  const page = rows.slice(0, limit)

  // Build next cursor from last row
  let nextCursor = null
  if (hasMore && page.length > 0) {
    const last = page[page.length - 1]
    nextCursor = Buffer.from(JSON.stringify({ createdAt: last.created_at, id: last.id })).toString('base64url')
  }

  return { reports: page, hasMore, nextCursor, limit }
}

/**
 * Get a single report (for authenticated users).
 * Returns html_content — use this for the in-app viewer.
 */
export async function getReport(tenantId, reportId) {
  const { rows: [report] } = await query(
    `SELECT r.*, a.name as agent_name, a.archetype as agent_archetype
     FROM dashboard_reports r
     LEFT JOIN agents a ON r.agent_id = a.id
     WHERE r.id = $1 AND r.tenant_id = $2 AND r.archived_at IS NULL`,
    [reportId, tenantId]
  )
  if (!report) throw new AppError('REPORT_NOT_FOUND', 'Report not found', 404)
  return report
}

/**
 * Get a report via its public share token — NO authentication required.
 * Returns only safe fields (no internal IDs beyond the report itself).
 */
export async function getPublicReport(publicToken) {
  if (!publicToken || publicToken.length < 16) {
    throw new AppError('INVALID_TOKEN', 'Invalid share token', 404)
  }

  const { rows: [report] } = await query(
    `SELECT r.id, r.title, r.report_type, r.summary, r.html_content, r.metadata,
            r.download_formats, r.expires_at, r.created_at,
            a.name as agent_name
     FROM dashboard_reports r
     LEFT JOIN agents a ON r.agent_id = a.id
     WHERE r.public_token = $1
       AND r.is_public = true
       AND r.archived_at IS NULL
       AND (r.expires_at IS NULL OR r.expires_at > NOW())`,
    [publicToken]
  )

  if (!report) throw new AppError('REPORT_NOT_FOUND', 'Report not found or link has expired', 404)
  return report
}

// ─── Sharing ─────────────────────────────────────────────────────────────────

/**
 * Generate or return an existing public share link for a report.
 * Returns { publicToken, shareUrl }.
 */
export async function generatePublicLink(tenantId, reportId) {
  const report = await getReport(tenantId, reportId)

  // Reuse existing token if already public
  if (report.is_public && report.public_token) {
    return { publicToken: report.public_token, shareUrl: buildShareUrl(report.public_token) }
  }

  const token = randomBytes(24).toString('base64url') // 32-char URL-safe token

  await query(
    `UPDATE dashboard_reports
     SET is_public = true, public_token = $1
     WHERE id = $2 AND tenant_id = $3`,
    [token, reportId, tenantId]
  )

  return { publicToken: token, shareUrl: buildShareUrl(token) }
}

/**
 * Revoke a report's public share link.
 */
export async function revokePublicLink(tenantId, reportId) {
  await getReport(tenantId, reportId) // verify ownership
  await query(
    `UPDATE dashboard_reports
     SET is_public = false, public_token = NULL
     WHERE id = $1 AND tenant_id = $2`,
    [reportId, tenantId]
  )
}

function buildShareUrl(token) {
  const base = process.env.FRONTEND_URL?.split(',')[0]?.trim() || process.env.API_BASE_URL || 'http://localhost:3000'
  return `${base}/reports/shared/${token}`
}

// ─── Download ─────────────────────────────────────────────────────────────────

/**
 * Prepare a report for download in the requested format.
 *
 * Supported formats:
 *   html  — the full report HTML (with inline styles, charts, etc.)
 *   svg   — extracted <svg> element (or generates a wrapper SVG if none)
 *   pdf   — returns an HTML page with a print-optimized CSS wrapper that
 *            triggers window.print() on load (client renders to PDF)
 *   csv   — extracts tabular data from metadata.df if available
 *
 * Returns { content: string, contentType: string, filename: string }
 */
export async function prepareDownload(tenantId, reportId, format) {
  const report = await getReport(tenantId, reportId)
  const safeName = safeFilename(report.title)

  switch ((format || 'html').toLowerCase()) {

    case 'html': {
      return {
        content: wrapDownloadHtml(report),
        contentType: 'text/html; charset=utf-8',
        filename: `${safeName}.html`,
      }
    }

    case 'svg': {
      const svg = extractSvg(report.html_content)
      if (!svg) throw new AppError('NO_SVG', 'This report does not contain an SVG element', 422)
      return {
        content: svg,
        contentType: 'image/svg+xml; charset=utf-8',
        filename: `${safeName}.svg`,
      }
    }

    case 'pdf': {
      // We return a self-printing HTML document.
      // The browser/client opens it and calls window.print() which opens the OS PDF dialog.
      // For server-side PDF, integrate Puppeteer/weasyprint in a future sprint.
      return {
        content: buildPrintHtml(report),
        contentType: 'text/html; charset=utf-8',
        filename: `${safeName}_print.html`,
      }
    }

    case 'csv': {
      const csv = extractCsv(report)
      if (!csv) throw new AppError('NO_CSV', 'This report does not contain tabular data', 422)
      return {
        content: csv,
        contentType: 'text/csv; charset=utf-8',
        filename: `${safeName}.csv`,
      }
    }

    default:
      throw new AppError('INVALID_FORMAT', `Unsupported format '${format}'. Allowed: html, svg, pdf, csv`, 400)
  }
}

// ─── Download helpers ─────────────────────────────────────────────────────────

/** Wrap the HTML content in a full standalone document with embedded meta */
function wrapDownloadHtml(report) {
  // If it's already a complete HTML document, return as-is
  if (/^\s*<!DOCTYPE/i.test(report.html_content) || /^\s*<html/i.test(report.html_content)) {
    return report.html_content
  }
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(report.title)}</title>
  <meta name="description" content="${escapeHtml(report.summary || '')}">
  <meta name="generated-by" content="Kuvalam AI">
  <meta name="agent" content="${escapeHtml(report.agent_name || '')}">
  <meta name="created" content="${report.created_at}">
  <style>
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; }
  </style>
</head>
<body>
${report.html_content}
</body>
</html>`
}

/** Build a print-optimized HTML that triggers window.print() */
function buildPrintHtml(report) {
  const inner = wrapDownloadHtml(report)
  // Inject a print trigger and print-specific styles
  return inner.replace('</head>', `
  <style>
    @media print {
      body { background: white !important; color: black !important; }
      .no-print, button, nav, header { display: none !important; }
      svg, canvas { max-width: 100% !important; page-break-inside: avoid; }
      table { border-collapse: collapse; width: 100%; }
      th, td { border: 1px solid #ccc; padding: 4px 8px; }
    }
    @page { size: A4 landscape; margin: 1cm; }
  </style>
  <script>window.addEventListener('load', () => setTimeout(() => window.print(), 300))<\/script>
</head>`)
}

/** Extract the first <svg> element from HTML content */
function extractSvg(html) {
  if (!html) return null
  const match = html.match(/<svg[\s\S]*?<\/svg>/i)
  return match ? match[0] : null
}

/** Extract CSV data from report metadata.df or by parsing HTML tables */
function extractCsv(report) {
  // 1. Use stored df in metadata if available
  const df = report.metadata?.df
  if (df && Array.isArray(df) && df.length > 0) {
    const headers = Object.keys(df[0])
    const rows = df.map(row =>
      headers.map(h => {
        const val = row[h]
        if (val === null || val === undefined) return ''
        const s = String(val)
        return s.includes(',') || s.includes('"') || s.includes('\n')
          ? `"${s.replace(/"/g, '""')}"` : s
      }).join(',')
    )
    return [headers.join(','), ...rows].join('\n')
  }

  // 2. Parse first HTML table in report
  const tableMatch = report.html_content?.match(/<table[\s\S]*?<\/table>/i)
  if (tableMatch) {
    const rows = []
    const rowMatches = tableMatch[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)
    for (const row of rowMatches) {
      const cells = [...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
        .map(c => c[1].replace(/<[^>]+>/g, '').trim())
      if (cells.length > 0) rows.push(cells.join(','))
    }
    if (rows.length > 0) return rows.join('\n')
  }

  return null
}

function escapeHtml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ─── Archive / Delete ─────────────────────────────────────────────────────────

/**
 * Soft-archive a report (sets archived_at). Does not hard-delete.
 */
export async function archiveReport(tenantId, reportId) {
  const { rowCount } = await query(
    `UPDATE dashboard_reports
     SET archived_at = NOW(), is_public = false, public_token = NULL
     WHERE id = $1 AND tenant_id = $2 AND archived_at IS NULL`,
    [reportId, tenantId]
  )
  if (rowCount === 0) throw new AppError('REPORT_NOT_FOUND', 'Report not found or already archived', 404)
}

/**
 * Hard-purge reports that are both archived AND past their expires_at.
 * Safe to call repeatedly (idempotent). Called by the scheduler nightly.
 * @returns {number} count of reports purged
 */
export async function purgeExpiredReports() {
  const { rowCount } = await query(
    `DELETE FROM dashboard_reports
     WHERE (
       archived_at IS NOT NULL                          -- soft-deleted
       OR (expires_at IS NOT NULL AND expires_at < NOW()) -- TTL expired
     )
     AND created_at < NOW() - INTERVAL '7 days'         -- safety: never purge very recent
    `
  )
  return rowCount || 0
}
