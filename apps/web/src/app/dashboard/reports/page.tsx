'use client'
import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { api, authedFetch, API } from '@/lib/api'
import { useApp } from '@/lib/context'
import { useConfirm } from '@/components/ConfirmModal'

type Report = {
  id: string
  title: string
  html_content: string
  report_type?: string
  download_formats?: string[]
  agent_name?: string
  created_at: string
  summary?: string
  is_public?: boolean
  public_token?: string
}

type TaskOutput = {
  id: string
  agentId: string
  agentName: string
  agentArchetype: string
  goal: string
  summary: string
  confidence: number | null
  status: string
  createdAt: string
  completedAt: string
}

type Tab = 'reports' | 'outputs'

/** Mirrors backend resolveDownloadFormats — client-side fallback for legacy reports */
function getAvailableFormats(
  reportType: string | undefined,
  htmlContent: string | undefined,
  storedFormats: string[] | undefined,
): string[] {
  // If backend provided formats, use them
  if (storedFormats && storedFormats.length > 0) return storedFormats
  // Fallback: compute from report type and content
  const formats = new Set<string>(['html']) // always available
  const type = (reportType || '').toLowerCase()
  const html = htmlContent || ''
  if (type === 'svg' || html.includes('<svg')) formats.add('svg')
  if (type === 'data_model') { formats.add('svg'); formats.add('pdf') }
  if (['chart', 'd3', 'mixed', 'data_model', 'svg'].includes(type)) formats.add('pdf')
  if (!formats.has('pdf') && html.includes('<svg')) formats.add('pdf')
  // CSV if there's tabular data
  if (html.includes('<table') && html.includes('<td')) formats.add('csv')
  return Array.from(formats)
}

export default function ReportsPage() {
  const router = useRouter()
  const { tenantId, toast, user } = useApp()
  const { confirm, ConfirmDialog } = useConfirm()

  // Redirect unauthenticated users — avoid perpetual skeleton loader
  const [authChecked, setAuthChecked] = useState(false)
  useEffect(() => {
    // Wait one tick so localStorage has been read by useApp
    const t = setTimeout(() => {
      if (!user) {
        router.replace('/')
      } else {
        setAuthChecked(true)
      }
    }, 50)
    return () => clearTimeout(t)
  }, [user, router])

  // Tab state
  const [tab, setTab] = useState<Tab>('reports')

  // Reports tab
  const [reports, setReports] = useState<Report[]>([])
  const [reportsLoading, setReportsLoading] = useState(true)
  const [selectedReport, setSelectedReport] = useState<Report | null>(null)
  const [reportDetail, setReportDetail] = useState<Report | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [downloading, setDownloading] = useState<string | null>(null)
  const [sharing, setSharing] = useState<string | null>(null)
  const [shareUrl, setShareUrl] = useState<string | null>(null)
  const [copiedShare, setCopiedShare] = useState(false)

  // Task Outputs tab
  const [outputs, setOutputs] = useState<TaskOutput[]>([])
  const [outputsLoading, setOutputsLoading] = useState(false)
  const [outputsPage, setOutputsPage] = useState(1)
  const [outputsTotal, setOutputsTotal] = useState(0)
  const [pinning, setPinning] = useState<string | null>(null)
  const [deletingOutput, setDeletingOutput] = useState<string | null>(null)
  const [agentFilter, setAgentFilter] = useState<string>('')
  const [agents, setAgents] = useState<{ id: string; name: string }[]>([])

  const PAGE_SIZE = 20

  const loadReports = useCallback(async (tid: string) => {
    setReportsLoading(true)
    try {
      const res = await api.getReports(tid)
      // api.getReports returns the array directly (reports list from API)
      const list = Array.isArray(res) ? res : (res?.reports || [])
      setReports(list)
      // Select first report if none selected
      if (list.length > 0 && !selectedReport) {
        setSelectedReport(list[0])
      } else if (list.length === 0) {
        setSelectedReport(null)
      }
    } catch {
      setReports([])
    } finally {
      setReportsLoading(false)
    }
  }, [selectedReport])

  const loadTaskOutputs = useCallback(async (tid: string, page: number, agentId?: string) => {
    setOutputsLoading(true)
    try {
      const params: any = { page, pageSize: PAGE_SIZE }
      if (agentId) params.agentId = agentId
      const res = await api.getTaskOutputs(tid, params)
      const data = res?.data || res || { outputs: [], total: 0 }
      setOutputs(data.outputs || [])
      setOutputsTotal(data.total || 0)
    } catch {
      setOutputs([])
      setOutputsTotal(0)
    } finally {
      setOutputsLoading(false)
    }
  }, [])

  const loadAgents = useCallback(async (tid: string) => {
    try {
      const res = await api.listAgents(tid)
      setAgents(res?.agents || res || [])
    } catch {
      setAgents([])
    }
  }, [])

  useEffect(() => {
    if (!tenantId) return
    loadReports(tenantId)
    loadAgents(tenantId)
  }, [tenantId])

  // Fetch full report detail (with html_content) when a report is selected
  useEffect(() => {
    if (!selectedReport || !tenantId) {
      setReportDetail(null)
      setShareUrl(null)
      return
    }
    setDetailLoading(true)
    setShareUrl(null) // reset share state on selection change
    api.getReport(tenantId, selectedReport.id)
      .then(detail => setReportDetail(detail))
      .catch(() => setReportDetail(null))
      .finally(() => setDetailLoading(false))
  }, [selectedReport?.id, tenantId])

  useEffect(() => {
    if (!tenantId || tab !== 'outputs') return
    loadTaskOutputs(tenantId, outputsPage, agentFilter || undefined)
  }, [tenantId, tab, outputsPage, agentFilter])

  async function handleDelete(reportId: string) {
    const ok = await confirm({ title: 'Delete this report?', description: 'This action cannot be undone.', variant: 'danger', confirmLabel: 'Delete report' })
    if (!ok) return
    setDeleting(reportId)
    try {
      await api.deleteReport(tenantId, reportId)
      const updated = reports.filter(r => r.id !== reportId)
      setReports(updated)
      if (selectedReport?.id === reportId) {
        setSelectedReport(updated[0] || null)
      }
      toast('success', 'Report deleted')
    } catch (err: any) {
      toast('error', 'Delete failed', err.message)
    } finally {
      setDeleting(null)
    }
  }

  async function handleDownload(reportId: string, format: string) {
    setDownloading(format)
    try {
      const url = `${API}/tenants/${tenantId}/reports/${reportId}/download?format=${format}`
      const res = await authedFetch(url)
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: { message: 'Download failed' } }))
        throw new Error(err.error?.message || `HTTP ${res.status}`)
      }
      const blob = await res.blob()
      const blobUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = blobUrl
      // Extract filename from Content-Disposition if available
      const disposition = res.headers.get('Content-Disposition')
      const filenameMatch = disposition?.match(/filename="?(.+?)"?$/i)
      a.download = filenameMatch?.[1] || `report.${format}`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(blobUrl)
    } catch (err: any) {
      toast('error', 'Download failed', err.message)
    } finally {
      setDownloading(null)
    }
  }

  async function handleShare(reportId: string) {
    setSharing(reportId)
    setCopiedShare(false)
    try {
      const res = await api.shareReport(tenantId, reportId)
      const data = res?.data || res
      const url = data?.shareUrl || data?.data?.shareUrl || ''
      setShareUrl(url)
      if (url) {
        await navigator.clipboard.writeText(url)
        setCopiedShare(true)
        toast('success', 'Share link copied!', 'Anyone with the link can view this report.')
        setTimeout(() => setCopiedShare(false), 3000)
      }
    } catch (err: any) {
      toast('error', 'Share failed', err.message)
    } finally {
      setSharing(null)
    }
  }

  async function handleRevokeShare(reportId: string) {
    try {
      await api.revokeShareLink(tenantId, reportId)
      setShareUrl(null)
      // Update the detail cache
      if (reportDetail) setReportDetail({ ...reportDetail, is_public: false, public_token: undefined })
      toast('success', 'Share link revoked')
    } catch (err: any) {
      toast('error', 'Revoke failed', err.message)
    }
  }

  async function handleDeleteOutput(taskId: string, goal: string) {
    const ok = await confirm({ title: 'Delete task output?', description: `"${goal.slice(0, 80)}"\n\nThis permanently removes the task and all its results.`, variant: 'danger', confirmLabel: 'Delete task' })
    if (!ok) return
    setDeletingOutput(taskId)
    try {
      await api.deleteTaskOutput(tenantId, taskId)
      setOutputs(prev => prev.filter(o => o.id !== taskId))
      setOutputsTotal(prev => prev - 1)
      toast('success', 'Task output deleted')
    } catch (err: any) {
      toast('error', 'Delete failed', err.message)
    } finally {
      setDeletingOutput(null)
    }
  }

  async function handlePin(taskId: string) {
    setPinning(taskId)
    try {
      const res = await api.pinTaskOutput(tenantId, taskId)
      toast('success', 'Pinned to reports', 'Task output has been saved as a dashboard report.')
      // Reload outputs to show updated state
      loadTaskOutputs(tenantId, outputsPage, agentFilter || undefined)
    } catch (err: any) {
      toast('error', 'Pin failed', err.message)
    } finally {
      setPinning(null)
    }
  }

  const totalPages = Math.ceil(outputsTotal / PAGE_SIZE)

  // While waiting for auth check, show a clean loading state
  if (!authChecked) {
    return (
      <div className="animate-in">
        <div className="page-header">
          <div>
            <h1 className="page-title">Reports</h1>
            <p className="page-sub">Loading…</p>
          </div>
        </div>
        <div className="page-body">
          <div className="skeleton-list">
            {[1,2,3,4].map(i => <div key={i} className="skeleton" style={{ height: 60, marginBottom: 8, borderRadius: 8 }} />)}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="animate-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Reports</h1>
          <p className="page-sub">Browse dashboard reports and view completed agent task outputs</p>
        </div>
      </div>

      {ConfirmDialog}

      {/* Tabs */}
      <div className="tabs" style={{ margin: '0 24px', borderBottom: '1px solid var(--border)' }}>
        <button
          className={`tab ${tab === 'reports' ? 'active' : ''}`}
          onClick={() => setTab('reports')}
        >
          Dashboard Reports {reports.length > 0 && <span className="tab-badge">{reports.length}</span>}
        </button>
        <button
          className={`tab ${tab === 'outputs' ? 'active' : ''}`}
          onClick={() => setTab('outputs')}
        >
          Task Outputs {outputsTotal > 0 && <span className="tab-badge">{outputsTotal}</span>}
        </button>
      </div>

      <div className="page-body">
        {/* ════════════════════════════════════════ */}
        {/* TAB 1 — Dashboard Reports               */}
        {/* ════════════════════════════════════════ */}
        {tab === 'reports' && (
          <div className="report-layout">
            {/* Sidebar: report list */}
            <aside className="report-sidebar">
              {reportsLoading ? (
                <div className="skeleton-list">
                  {[1,2,3,4].map(i => <div key={i} className="skeleton" style={{ height: 60, marginBottom: 8, borderRadius: 8 }} />)}
                </div>
              ) : reports.length === 0 ? (
                <div className="empty-state">
                  <ScrollTextIcon />
                  <p>No reports yet</p>
                  <span className="empty-hint">Reports appear here when an agent publishes them or when you pin a task output.</span>
                </div>
              ) : (
                <div className="report-list">
                  {reports.map(report => (
                    <button
                      key={report.id}
                      className={`report-list-item ${selectedReport?.id === report.id ? 'active' : ''}`}
                      onClick={() => setSelectedReport(report)}
                    >
                      <div className="report-list-item-title">{report.title}</div>
                      <div className="report-list-item-meta">
                        {report.agent_name && <span>{report.agent_name}</span>}
                        <span>{new Date(report.created_at).toLocaleDateString()}</span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </aside>

            {/* Main: report viewer */}
            <main className="report-viewer">
              {!selectedReport ? (
                <div className="empty-state" style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                  <ScrollTextIcon />
                  <p>Select a report to view</p>
                </div>
              ) : (
                <div className="report-card">
                  <div className="report-card-header">
                    <div>
                      <h2>{selectedReport.title}</h2>
                      <p>
                        {selectedReport.agent_name && <>{selectedReport.agent_name} &middot; </>}
                        {new Date(selectedReport.created_at).toLocaleString()}
                        {reportDetail?.report_type && <> &middot; <span className="report-type-badge">{reportDetail.report_type}</span></>}
                      </p>
                      {shareUrl && (
                        <div className="share-url-row">
                          <input className="input input-sm" value={shareUrl} readOnly onClick={e => (e.target as HTMLInputElement).select()} style={{ fontSize: 12, maxWidth: 360, marginTop: 4 }} />
                          <button className="btn btn-sm btn-secondary" onClick={() => { navigator.clipboard.writeText(shareUrl); setCopiedShare(true); setTimeout(() => setCopiedShare(false), 3000); }}>
                            {copiedShare ? '✓ Copied' : 'Copy'}
                          </button>
                          <button className="btn btn-sm btn-ghost" onClick={() => handleRevokeShare(selectedReport.id)}>Revoke</button>
                        </div>
                      )}
                    </div>
                    <div className="report-card-actions">
                      {/* Download format buttons */}
                      <div className="download-formats" style={{ display: 'flex', gap: 4 }}>
                        {getAvailableFormats(
                          reportDetail?.report_type,
                          reportDetail?.html_content,
                          reportDetail?.download_formats,
                        ).map(fmt => (
                          <button
                            key={fmt}
                            className="btn btn-secondary btn-sm"
                            onClick={() => handleDownload(selectedReport.id, fmt)}
                            disabled={downloading === fmt}
                            style={{ fontSize: 11, padding: '2px 10px' }}
                            title={`Download as ${fmt.toUpperCase()}`}
                          >
                            {downloading === fmt ? '⏳' : ''} .{fmt}
                          </button>
                        ))}
                      </div>
                      {/* Share button */}
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => handleShare(selectedReport.id)}
                        disabled={sharing === selectedReport.id}
                      >
                        {sharing === selectedReport.id ? '⏳' : '🔗'} Share
                      </button>
                      {/* Delete */}
                      <button
                        className="btn btn-danger-outline btn-sm"
                      onClick={() => handleDelete(selectedReport.id)}
                      disabled={deleting === selectedReport.id}
                    >
                      {deleting === selectedReport.id ? 'Deleting...' : 'Delete'}
                    </button>
                  </div>
                </div>
                <div className="report-card-body">
                    {detailLoading ? (
                      <div className="skeleton-list">
                        <div className="skeleton" style={{ height: '100%', minHeight: 400, borderRadius: 8 }} />
                      </div>
                    ) : reportDetail?.html_content ? (
                      <iframe
                        srcDoc={reportDetail.html_content}
                        sandbox="allow-scripts"
                        style={{ width: '100%', height: '100%', border: 'none', borderRadius: 8 }}
                        title={selectedReport.title}
                      />
                    ) : (
                      <div className="empty-state">
                        <p>Unable to load report content</p>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </main>
          </div>
        )}

        {/* ════════════════════════════════════════ */}
        {/* TAB 2 — Task Outputs                    */}
        {/* ════════════════════════════════════════ */}
        {tab === 'outputs' && (
          <div>
            {/* Filters */}
            <div className="filters-row">
              <div className="filter-group">
                <label>Agent</label>
                <select
                  value={agentFilter}
                  onChange={e => { setAgentFilter(e.target.value); setOutputsPage(1) }}
                  className="input"
                  style={{ minWidth: 180 }}
                >
                  <option value="">All Agents</option>
                  {agents.map(a => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              </div>
              <div className="filter-group">
                <label>&nbsp;</label>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => loadTaskOutputs(tenantId, outputsPage, agentFilter || undefined)}
                >
                  ↻ Refresh
                </button>
              </div>
            </div>

            {/* Outputs list */}
            {outputsLoading ? (
              <div className="skeleton-list">
                {[1,2,3,4,5].map(i => <div key={i} className="skeleton" style={{ height: 80, marginBottom: 8, borderRadius: 8 }} />)}
              </div>
            ) : outputs.length === 0 ? (
              <div className="empty-state">
                <TaskIcon />
                <p>No task outputs yet</p>
                <span className="empty-hint">Task outputs appear here when an agent completes a task. You can pin them to become dashboard reports.</span>
              </div>
            ) : (
              <>
                <div className="outputs-list">
                  {outputs.map(output => (
                    <div key={output.id} className="output-card">
                      <div className="output-card-main">
                        <div className="output-card-header">
                          <span className="output-agent-badge">{output.agentName || output.agentArchetype || 'Agent'}</span>
                          <span className="output-confidence">
                            {output.confidence != null
                              ? `${Math.round(output.confidence * 100)}% confidence`
                              : ''}
                          </span>
                        </div>
                        <div className="output-goal">{output.goal}</div>
                        {output.summary && (
                          <div className="output-summary">{output.summary}</div>
                        )}
                        <div className="output-meta">
                          <span>{new Date(output.createdAt).toLocaleString()}</span>
                          {output.completedAt && (
                            <span>Completed: {new Date(output.completedAt).toLocaleString()}</span>
                          )}
                        </div>
                      </div>
                      <div className="output-card-actions">
                        <button
                          className="btn btn-primary btn-sm"
                          onClick={() => handlePin(output.id)}
                          disabled={pinning === output.id}
                        >
                          {pinning === output.id ? 'Pinning...' : '📌 Pin to Reports'}
                        </button>
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => handleDeleteOutput(output.id, output.goal)}
                          disabled={deletingOutput === output.id}
                          style={{ color: 'var(--red, #dc2626)', marginLeft: 8 }}
                          title="Delete this task output"
                        >
                          {deletingOutput === output.id ? 'Deleting...' : '🗑'}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Pagination */}
                {totalPages > 1 && (
                  <div className="pagination">
                    <button
                      className="btn btn-secondary btn-sm"
                      disabled={outputsPage <= 1}
                      onClick={() => setOutputsPage(p => Math.max(1, p - 1))}
                    >
                      ← Previous
                    </button>
                    <span className="pagination-info">
                      Page {outputsPage} of {totalPages}
                    </span>
                    <button
                      className="btn btn-secondary btn-sm"
                      disabled={outputsPage >= totalPages}
                      onClick={() => setOutputsPage(p => p + 1)}
                    >
                      Next →
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      <style jsx>{`
        /* ── Report Layout (split view) ── */
        .report-layout {
          display: grid;
          grid-template-columns: 300px 1fr;
          gap: 0;
          min-height: calc(100vh - 200px);
          border: 1px solid var(--border);
          border-radius: 12px;
          overflow: hidden;
          background: #fff;
        }

        .report-sidebar {
          border-right: 1px solid var(--border);
          background: var(--bg-subtle, #f8fafc);
          overflow-y: auto;
          padding: 12px;
        }

        .report-list {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        .report-list-item {
          display: block;
          width: 100%;
          text-align: left;
          padding: 12px;
          border-radius: 8px;
          border: none;
          background: transparent;
          cursor: pointer;
          transition: background 0.15s;
        }
        .report-list-item:hover { background: var(--border); }
        .report-list-item.active { background: #e0f2fe; }

        .report-list-item-title {
          font-weight: 600;
          font-size: 13px;
          color: var(--text);
          margin-bottom: 4px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .report-list-item-meta {
          font-size: 11px;
          color: var(--text-sub);
          display: flex;
          gap: 8px;
        }

        .report-viewer {
          display: flex;
          flex-direction: column;
          min-height: 500px;
        }

        .report-card {
          display: flex;
          flex-direction: column;
          height: 100%;
          min-height: 500px;
        }

        .report-card-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          padding: 16px 20px;
          border-bottom: 1px solid var(--border);
        }
        .report-card-header h2 {
          font-size: 16px;
          font-weight: 700;
          margin: 0 0 2px;
          color: var(--text);
        }
        .report-card-header p {
          font-size: 12px;
          color: var(--text-sub);
          margin: 0;
        }

        .report-card-actions {
          display: flex;
          align-items: center;
          gap: 6px;
          flex-shrink: 0;
        }

        .download-formats {
          display: flex;
          gap: 4px;
        }

        .report-type-badge {
          font-size: 10px;
          font-weight: 600;
          text-transform: uppercase;
          background: #e0f2fe;
          color: #0369a1;
          padding: 1px 6px;
          border-radius: 4px;
          letter-spacing: 0.3px;
        }

        .share-url-row {
          display: flex;
          align-items: center;
          gap: 6px;
          flex-wrap: wrap;
        }

        .report-card-body {
          flex: 1;
          padding: 16px 20px;
          overflow: auto;
        }

        /* ── Task Outputs ── */
        .filters-row {
          display: flex;
          gap: 16px;
          align-items: flex-end;
          margin-bottom: 16px;
        }
        .filter-group {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .filter-group label {
          font-size: 12px;
          font-weight: 600;
          color: var(--text-sub);
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }

        .outputs-list {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .output-card {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          background: #fff;
          border: 1px solid var(--border);
          border-radius: 10px;
          padding: 16px;
          gap: 16px;
          transition: box-shadow 0.15s;
        }
        .output-card:hover {
          box-shadow: 0 2px 8px rgba(0,0,0,0.06);
        }

        .output-card-main {
          flex: 1;
          min-width: 0;
        }

        .output-card-header {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 6px;
        }

        .output-agent-badge {
          font-size: 11px;
          font-weight: 600;
          background: #e0f2fe;
          color: #0369a1;
          padding: 2px 8px;
          border-radius: 4px;
          text-transform: uppercase;
        }

        .output-confidence {
          font-size: 11px;
          color: var(--text-sub);
        }

        .output-goal {
          font-weight: 600;
          font-size: 14px;
          color: var(--text);
          margin-bottom: 4px;
          line-height: 1.4;
        }

        .output-summary {
          font-size: 13px;
          color: var(--text-sub);
          line-height: 1.5;
          margin-bottom: 6px;
          display: -webkit-box;
          -webkit-line-clamp: 3;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }

        .output-meta {
          font-size: 11px;
          color: var(--text-sub);
          display: flex;
          gap: 12px;
        }

        .output-card-actions {
          flex-shrink: 0;
        }

        /* ── Pagination ── */
        .pagination {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 12px;
          margin-top: 20px;
          padding: 12px 0;
        }
        .pagination-info {
          font-size: 13px;
          color: var(--text-sub);
        }

        /* ── Shared ── */
        .empty-state {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          padding: 60px 20px;
          color: var(--text-sub);
          gap: 8px;
        }
        .empty-state p {
          font-size: 15px;
          font-weight: 600;
          margin: 0;
        }
        .empty-hint {
          font-size: 13px;
          text-align: center;
          max-width: 360px;
          line-height: 1.4;
        }

        .skeleton-list {
          padding: 4px 0;
        }
      `}</style>
    </div>
  )
}

function ScrollTextIcon() {
  return (
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.4, marginBottom: 8 }}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  )
}

function TaskIcon() {
  return (
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.4, marginBottom: 8 }}>
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <line x1="9" y1="9" x2="15" y2="9" />
      <line x1="9" y1="13" x2="15" y2="13" />
      <line x1="9" y1="17" x2="13" y2="17" />
    </svg>
  )
}
