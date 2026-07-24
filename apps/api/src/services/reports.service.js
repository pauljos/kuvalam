import { query } from '../db/pool.js'
import { AppError } from '../utils/errors.js'

export async function saveReport(tenantId, agentId, title, htmlContent) {
  if (!htmlContent) throw new AppError('VALIDATION_ERROR', 'htmlContent is required', 400)
  const reportTitle = title || 'Untitled Report'
  
  const { rows } = await query(
    `INSERT INTO dashboard_reports (tenant_id, agent_id, title, html_content)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [tenantId, agentId || null, reportTitle, htmlContent]
  )
  return rows[0]
}

export async function listReports(tenantId, limit = 50) {
  const { rows } = await query(
    `SELECT r.*, a.name as agent_name 
     FROM dashboard_reports r
     LEFT JOIN agents a ON r.agent_id = a.id
     WHERE r.tenant_id = $1
     ORDER BY r.created_at DESC
     LIMIT $2`,
    [tenantId, limit]
  )
  return rows
}

export async function deleteReport(tenantId, reportId) {
  const { rowCount } = await query(
    'DELETE FROM dashboard_reports WHERE id = $1 AND tenant_id = $2',
    [reportId, tenantId]
  )
  if (rowCount === 0) throw new AppError('NOT_FOUND', 'Report not found', 404)
  return true
}
