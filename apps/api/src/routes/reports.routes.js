// apps/api/src/routes/reports.routes.js
// Dashboard Reports — full REST API
//
// Authenticated endpoints:
//   GET    /tenants/:tenantId/reports                        — list (paginated, filterable)
//   GET    /tenants/:tenantId/reports/:reportId              — single report with html_content
//   DELETE /tenants/:tenantId/reports/:reportId              — soft-archive
//   POST   /tenants/:tenantId/reports/:reportId/share        — generate public share link
//   DELETE /tenants/:tenantId/reports/:reportId/share        — revoke public share link
//   GET    /tenants/:tenantId/reports/:reportId/download     — download in requested format
//
// Public (no auth):
//   GET    /reports/public/:token                            — view shared report
//   GET    /reports/public/:token/download                   — download shared report

import {
  listReports,
  getReport,
  getPublicReport,
  generatePublicLink,
  revokePublicLink,
  archiveReport,
  prepareDownload,
} from '../services/reports.service.js'
import { errorResponse, AppError } from '../utils/errors.js'
import { auditLog } from '../utils/audit.js'
import { query } from '../db/pool.js'


export default async function reportsRoutes(fastify) {
  const auth = { preHandler: [fastify.authenticate] }

  // ── LIST reports ──────────────────────────────────────────────────────────
  // GET /api/v1/tenants/:tenantId/reports
  // Query params:
  //   agentId     — filter by agent
  //   reportType  — filter by type (chart|svg|d3|data_model|mixed|html)
  //   search      — text search on title
  //   limit       — page size (default 20, max 100)
  //   cursor      — opaque pagination cursor from previous response
  fastify.get('/tenants/:tenantId/reports', auth, async (request, reply) => {
    try {
      const { tenantId } = request.params
      const { agentId, reportType, search, limit, cursor } = request.query

      const result = await listReports(tenantId, { agentId, reportType, search, limit, cursor })

      return reply.send({
        success: true,
        data: result.reports,
        meta: {
          hasMore: result.hasMore,
          nextCursor: result.nextCursor,
          limit: result.limit,
          timestamp: new Date().toISOString(),
        }
      })
    } catch (err) {
      return errorResponse(reply, err)
    }
  })

  // ── GET single report ─────────────────────────────────────────────────────
  // GET /api/v1/tenants/:tenantId/reports/:reportId
  fastify.get('/tenants/:tenantId/reports/:reportId', auth, async (request, reply) => {
    try {
      const { tenantId, reportId } = request.params
      const report = await getReport(tenantId, reportId)
      return reply.send({ success: true, data: report })
    } catch (err) {
      return errorResponse(reply, err)
    }
  })

  // ── SOFT DELETE / ARCHIVE ─────────────────────────────────────────────────
  // DELETE /api/v1/tenants/:tenantId/reports/:reportId
  fastify.delete('/tenants/:tenantId/reports/:reportId', auth, async (request, reply) => {
    try {
      const { tenantId, reportId } = request.params
      await archiveReport(tenantId, reportId)

      await auditLog({
        tenantId, eventType: 'report.archived',
        actorId: request.user.sub, actorType: 'USER',
        resourceType: 'Report', resourceId: reportId, action: 'ARCHIVE',
      })

      return reply.send({ success: true, message: 'Report archived successfully' })
    } catch (err) {
      return errorResponse(reply, err)
    }
  })

  // ── DOWNLOAD ──────────────────────────────────────────────────────────────
  // GET /api/v1/tenants/:tenantId/reports/:reportId/download?format=html|svg|pdf|csv
  //
  // Format matrix:
  //   html — standalone self-contained HTML file (all charts embedded)
  //   svg  — extracted SVG element (for SVG/data-model reports)
  //   pdf  — print-ready HTML that auto-triggers window.print() → browser PDF dialog
  //   csv  — tabular data extracted from df metadata or HTML table
  fastify.get('/tenants/:tenantId/reports/:reportId/download', auth, async (request, reply) => {
    try {
      const { tenantId, reportId } = request.params
      const format = request.query.format || 'html'

      const { content, contentType, filename } = await prepareDownload(tenantId, reportId, format)
      const encodedFilename = encodeURIComponent(filename)

      return reply
        .header('Content-Type', contentType)
        .header('Content-Disposition',
          `attachment; filename="${filename}"; filename*=UTF-8''${encodedFilename}`)
        .header('X-Report-Format', format)
        .send(content)
    } catch (err) {
      return errorResponse(reply, err)
    }
  })

  // ── SHARE — generate public link ─────────────────────────────────────────
  // POST /api/v1/tenants/:tenantId/reports/:reportId/share
  // Returns: { publicToken, shareUrl }
  fastify.post('/tenants/:tenantId/reports/:reportId/share', auth, async (request, reply) => {
    try {
      const { tenantId, reportId } = request.params
      const result = await generatePublicLink(tenantId, reportId)

      await auditLog({
        tenantId, eventType: 'report.shared',
        actorId: request.user.sub, actorType: 'USER',
        resourceType: 'Report', resourceId: reportId, action: 'SHARE',
        metadata: { shareUrl: result.shareUrl },
      })

      return reply.status(201).send({ success: true, data: result })
    } catch (err) {
      return errorResponse(reply, err)
    }
  })

  // ── SHARE — revoke public link ────────────────────────────────────────────
  // DELETE /api/v1/tenants/:tenantId/reports/:reportId/share
  fastify.delete('/tenants/:tenantId/reports/:reportId/share', auth, async (request, reply) => {
    try {
      const { tenantId, reportId } = request.params
      await revokePublicLink(tenantId, reportId)

      await auditLog({
        tenantId, eventType: 'report.share_revoked',
        actorId: request.user.sub, actorType: 'USER',
        resourceType: 'Report', resourceId: reportId, action: 'REVOKE_SHARE',
      })

      return reply.send({ success: true, message: 'Public link revoked' })
    } catch (err) {
      return errorResponse(reply, err)
    }
  })

  // ── PUBLIC VIEWER (no auth required) ────────────────────────────────────
  // GET /api/v1/reports/public/:token
  // Returns the full report for anonymous viewers.
  // Rate-limited to 60 req/min per IP to prevent token enumeration.
  fastify.get('/reports/public/:token', {
    config: {
      rateLimit: { max: 60, timeWindow: '1 minute' }
    }
  }, async (request, reply) => {
    try {
      const { token } = request.params
      const report = await getPublicReport(token)

      // Add cache hints for CDN (short TTL — report content can change if author updates it)
      return reply
        .header('Cache-Control', 'public, max-age=60, stale-while-revalidate=300')
        .send({ success: true, data: report })
    } catch (err) {
      return errorResponse(reply, err)
    }
  })

  // ── PUBLIC DOWNLOAD (no auth required) ──────────────────────────────────
  // GET /api/v1/reports/public/:token/download?format=html|svg|pdf|csv
  fastify.get('/reports/public/:token/download', {
    config: {
      rateLimit: { max: 30, timeWindow: '1 minute' }
    }
  }, async (request, reply) => {
    try {
      const { token } = request.params
      const format = request.query.format || 'html'

      // Fetch the public report first (validates token + expiry)
      const report = await getPublicReport(token)

      // prepareDownload expects tenantId and reportId — use the authenticated version
      // We need to pass the real tenantId since getPublicReport strips it
      const { rows: [full] } = await query(
        `SELECT tenant_id FROM dashboard_reports WHERE public_token = $1 AND is_public = true`,
        [token]
      )


      if (!full) throw new AppError('REPORT_NOT_FOUND', 'Report not found', 404)

      const { content, contentType, filename } = await prepareDownload(full.tenant_id, report.id, format)
      const encodedFilename = encodeURIComponent(filename)

      return reply
        .header('Content-Type', contentType)
        .header('Content-Disposition',
          `attachment; filename="${filename}"; filename*=UTF-8''${encodedFilename}`)
        .header('X-Report-Format', format)
        .send(content)
    } catch (err) {
      return errorResponse(reply, err)
    }
  })
}
