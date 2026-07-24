"use client"
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { useApp } from '@/lib/context'
import { Trash2, Bot, LayoutGrid, List } from 'lucide-react'

interface Report {
  id: string
  title: string
  html_content: string
  agent_name: string | null
  created_at: string
}

export default function ReportsPage() {
  const { tenantId, toast } = useApp()
  const [reports, setReports] = useState<Report[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedAgent, setSelectedAgent] = useState<string>('ALL')
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<'tabs' | 'feed'>('tabs')

  useEffect(() => {
    if (tenantId) loadReports()
  }, [tenantId])

  async function loadReports() {
    try {
      setLoading(true)
      const res = await api.getReports(tenantId)
      const list = res || []
      setReports(list)
      if (list.length > 0 && !selectedReportId) {
        setSelectedReportId(list[0].id)
      }
    } catch (err: any) {
      toast('error', 'Failed to load reports', err.message)
    } finally {
      setLoading(false)
    }
  }

  async function handleDelete(reportId: string, e?: React.MouseEvent) {
    if (e) {
      e.preventDefault()
      e.stopPropagation()
    }
    try {
      await api.deleteReport(tenantId, reportId)
      setReports(prev => {
        const updated = prev.filter(r => r.id !== reportId)
        if (selectedReportId === reportId) {
          setSelectedReportId(updated[0]?.id || null)
        }
        return updated
      })
      toast('success', 'Report deleted', 'The report was successfully removed.')
    } catch (err: any) {
      toast('error', 'Failed to delete report', err.message || 'Could not remove report.')
    }
  }

  // Group unique agents
  const agentNames = Array.from(new Set(reports.map(r => r.agent_name || 'System')))

  // Filtered reports by selected agent tab
  const filteredReports = selectedAgent === 'ALL' 
    ? reports 
    : reports.filter(r => (r.agent_name || 'System') === selectedAgent)

  const activeReport = filteredReports.find(r => r.id === selectedReportId) || filteredReports[0]

  return (
    <div className="animate-in">
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h1 className="page-title">Dashboard Reports</h1>
          <p className="page-sub">Dynamic HTML reports generated autonomously by your agents.</p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <div style={{ display: 'flex', background: 'var(--bg-hover)', borderRadius: 8, padding: 3, border: '1px solid var(--border)' }}>
            <button 
              className={`btn btn-sm ${viewMode === 'tabs' ? 'btn-primary' : ''}`}
              style={{ padding: '4px 10px', fontSize: 12, border: 'none' }}
              onClick={() => setViewMode('tabs')}
            >
              <LayoutGrid size={14} style={{ marginRight: 4 }} /> Tabbed
            </button>
            <button 
              className={`btn btn-sm ${viewMode === 'feed' ? 'btn-primary' : ''}`}
              style={{ padding: '4px 10px', fontSize: 12, border: 'none' }}
              onClick={() => setViewMode('feed')}
            >
              <List size={14} style={{ marginRight: 4 }} /> Feed
            </button>
          </div>
          <button className="btn btn-outline btn-sm" onClick={loadReports}>Refresh</button>
        </div>
      </div>

      <div className="page-body">
        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {[1, 2].map(i => <div key={i} className="skeleton" style={{ height: 400 }} />)}
          </div>
        ) : reports.length === 0 ? (
          <div className="card empty-state" style={{ padding: '60px 20px', textAlign: 'center' }}>
            <div style={{
              width: 50, height: 50, borderRadius: '50%', background: 'var(--bg-hover)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px'
            }}>
              <Bot size={24} style={{ color: 'var(--text-muted)' }} />
            </div>
            <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>No reports yet</h3>
            <p style={{ color: 'var(--text-muted)', fontSize: 13, maxWidth: 300, margin: '0 auto' }}>
              Ask any agent to push a report to the dashboard integration and it will appear here.
            </p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Agent Filter Tabs */}
            <div className="tab-bar" style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 4, borderBottom: '1px solid var(--border)' }}>
              <button 
                className={`tab-bar-item ${selectedAgent === 'ALL' ? 'active' : ''}`}
                onClick={() => setSelectedAgent('ALL')}
                style={{ padding: '8px 16px', fontSize: 13, borderRadius: '8px 8px 0 0', fontWeight: 600 }}
              >
                All Agents ({reports.length})
              </button>
              {agentNames.map(agent => (
                <button 
                  key={agent}
                  className={`tab-bar-item ${selectedAgent === agent ? 'active' : ''}`}
                  onClick={() => setSelectedAgent(agent)}
                  style={{ padding: '8px 16px', fontSize: 13, borderRadius: '8px 8px 0 0', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}
                >
                  <span>🤖 {agent}</span>
                  <span style={{ fontSize: 11, background: 'rgba(255,255,255,0.1)', padding: '1px 6px', borderRadius: 10 }}>
                    {reports.filter(r => (r.agent_name || 'System') === agent).length}
                  </span>
                </button>
              ))}
            </div>

            {/* View Mode 1: TABBED VIEW (Top Report Tabs) */}
            {viewMode === 'tabs' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                {/* Specific Dashboard Tabs */}
                <div style={{ display: 'flex', gap: 6, overflowX: 'auto', background: 'var(--bg-hover)', padding: '6px', borderRadius: 10, border: '1px solid var(--border)' }}>
                  {filteredReports.map(report => (
                    <button
                      key={report.id}
                      onClick={() => setSelectedReportId(report.id)}
                      style={{
                        padding: '8px 14px',
                        fontSize: 13,
                        fontWeight: activeReport?.id === report.id ? 700 : 500,
                        background: activeReport?.id === report.id ? 'var(--bg-card)' : 'transparent',
                        color: activeReport?.id === report.id ? 'var(--green-dark)' : 'var(--text-secondary)',
                        borderRadius: 6,
                        border: activeReport?.id === report.id ? '1px solid var(--border)' : '1px solid transparent',
                        cursor: 'pointer',
                        whiteSpace: 'nowrap',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        boxShadow: activeReport?.id === report.id ? '0 2px 6px rgba(0,0,0,0.05)' : 'none'
                      }}
                    >
                      <span>📊 {report.title}</span>
                      <span style={{ fontSize: 10, opacity: 0.7 }}>({report.agent_name || 'System'})</span>
                    </button>
                  ))}
                </div>

                {/* Active Selected Report Viewer */}
                {activeReport ? (
                  <div className="card" style={{ overflow: 'hidden' }}>
                    <div style={{ 
                      padding: '16px 20px', 
                      borderBottom: '1px solid var(--border)', 
                      display: 'flex', 
                      alignItems: 'center', 
                      justifyContent: 'space-between',
                      background: 'var(--bg-hover)' 
                    }}>
                      <div>
                        <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>{activeReport.title}</h3>
                        <div style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontWeight: 600, color: 'var(--green-dark)' }}>{activeReport.agent_name || 'System'}</span>
                          <span>•</span>
                          <span>{new Date(activeReport.created_at).toLocaleString()}</span>
                        </div>
                      </div>
                      <button 
                        className="btn btn-sm" 
                        onClick={(e) => handleDelete(activeReport.id, e)}
                        style={{ background: 'transparent', color: 'var(--text-muted)', border: 'none', cursor: 'pointer' }}
                        title="Delete Report"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                    <div style={{ padding: 0 }}>
                      <iframe
                        title={activeReport.title}
                        srcDoc={activeReport.html_content}
                        style={{ width: '100%', height: '700px', border: 'none', background: '#fff', display: 'block' }}
                        sandbox="allow-scripts allow-same-origin"
                      />
                    </div>
                  </div>
                ) : (
                  <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>No reports match this agent.</div>
                )}
              </div>
            ) : (
              /* View Mode 2: FEED VIEW (Vertical Stack) */
              <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                {filteredReports.map((report) => (
                  <div key={report.id} className="card" style={{ overflow: 'hidden' }}>
                    <div style={{ 
                      padding: '16px 20px', 
                      borderBottom: '1px solid var(--border)', 
                      display: 'flex', 
                      alignItems: 'center', 
                      justifyContent: 'space-between',
                      background: 'var(--bg-hover)' 
                    }}>
                      <div>
                        <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>{report.title}</h3>
                        <div style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontWeight: 600, color: 'var(--green-dark)' }}>{report.agent_name || 'System'}</span>
                          <span>•</span>
                          <span>{new Date(report.created_at).toLocaleString()}</span>
                        </div>
                      </div>
                      <button 
                        className="btn btn-sm" 
                        onClick={(e) => handleDelete(report.id, e)}
                        style={{ background: 'transparent', color: 'var(--text-muted)', border: 'none', cursor: 'pointer' }}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                    <div style={{ padding: 0 }}>
                      <iframe
                        title={report.title}
                        srcDoc={report.html_content}
                        style={{ width: '100%', height: '600px', border: 'none', background: '#fff', display: 'block' }}
                        sandbox="allow-scripts allow-same-origin"
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

