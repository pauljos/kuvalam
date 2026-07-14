'use client'
import { useEffect, useState, useCallback } from 'react'
import { api } from '@/lib/api'
import { useApp } from '@/lib/context'
import { FeedbackModal } from '@/components/FeedbackModal'

const RISK_COLORS: Record<string, string> = {
  LOW: '#16a34a', MEDIUM: '#d97706', HIGH: '#dc2626', CRITICAL: '#7c3aed'
}

export default function ApprovalsPage() {
  const { tenantId, toast } = useApp()
  const [approvals, setApprovals] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'PENDING' | 'APPROVED' | 'REJECTED' | 'ALL'>('PENDING')
  const [deciding, setDeciding] = useState<string | null>(null)
  const [selectedApproval, setSelectedApproval] = useState<any>(null)
  const [decisionNote, setDecisionNote] = useState('')
  const [feedbackFor, setFeedbackFor] = useState<{ approvalId: string; agentId?: string } | null>(null)

  const load = useCallback(async (tid: string, status: string) => {
    try {
      setLoading(true)
      const statusParam = status === 'ALL' ? undefined : status
      const res = await api.listApprovals(tid, statusParam)
      setApprovals(res?.approvals || res || [])
    } catch {
      setApprovals([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (tenantId) load(tenantId, filter)
  }, [tenantId, load, filter])

  async function decide(approvalId: string, decision: 'APPROVED' | 'REJECTED') {
    setDeciding(approvalId)
    try {
      await api.decideApproval(tenantId, approvalId, {
        decision,
        decisionNote: decisionNote || (decision === 'APPROVED' ? 'Approved via dashboard' : 'Rejected via dashboard'),
      })
      toast('success', `Request ${decision.toLowerCase()}`, decision === 'APPROVED' ? 'The AI action has been approved and will proceed.' : 'The AI action has been blocked.')
      const approvedItem = selectedApproval || approvals.find(a => a.id === approvalId)
      setSelectedApproval(null)
      setDecisionNote('')
      load(tenantId, filter)
      // Prompt for feedback after every decision
      setFeedbackFor({ approvalId, agentId: approvedItem?.agent_id })
    } catch (err: any) {
      toast('error', 'Decision failed', err.message)
    } finally {
      setDeciding(null)
    }
  }

  const pending = approvals.filter(a => a.status === 'PENDING').length
  const approved = approvals.filter(a => a.status === 'APPROVED').length
  const rejected = approvals.filter(a => a.status === 'REJECTED').length

  return (
    <div className="animate-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Approvals</h1>
          <p className="page-sub">Review and decide on agent-proposed actions that need human sign-off</p>
        </div>
        <button className="btn btn-secondary" onClick={() => load(tenantId, filter)}>↻ Refresh</button>
      </div>

      <div className="page-body">
        {/* Stats Row */}
        <div className="stats-grid" style={{ marginBottom: 24 }}>
          {[
            { label: 'Pending Review', value: pending, color: '#d97706', icon: '⏳' },
            { label: 'Approved Today', value: approved, color: 'var(--green)', icon: '✓' },
            { label: 'Rejected Today', value: rejected, color: '#dc2626', icon: '✕' },
            { label: 'Total Requests', value: approvals.length, color: 'var(--text-sub)', icon: '📋' },
          ].map(s => (
            <div key={s.label} className="stat-card">
              <div style={{ fontSize: 28, fontWeight: 900, color: s.color }}>{s.icon} {s.value}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>{s.label}</div>
            </div>
          ))}
        </div>

        {/* Filter Tabs */}
        <div className="tabs" style={{ marginBottom: 20 }}>
          {(['PENDING', 'APPROVED', 'REJECTED', 'ALL'] as const).map(s => (
            <button key={s} className={`tab ${filter === s ? 'active' : ''}`} onClick={() => setFilter(s)}>
              {s === 'PENDING' ? `⏳ Pending (${pending})` : s === 'APPROVED' ? `✓ Approved` : s === 'REJECTED' ? `✕ Rejected` : 'All Requests'}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="skeleton" style={{ height: 300 }} />
        ) : approvals.length === 0 ? (
          <div className="card empty-state">
            <span className="empty-icon">{filter === 'PENDING' ? '🎉' : '📭'}</span>
            <h2 className="empty-title">
              {filter === 'PENDING' ? 'Inbox zero!' : 'No matching requests'}
            </h2>
            <p className="empty-desc">
              {filter === 'PENDING'
                ? 'All caught up — no AI actions are waiting for your review. Enjoy the moment.'
                : `No ${filter.toLowerCase()} requests found. Try a different filter above.`}
            </p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {approvals.map(a => {
              const deadline = new Date(a.deadline)
              const isOverdue = deadline < new Date() && a.status === 'PENDING'
              const riskColor = RISK_COLORS[a.risk_level] || RISK_COLORS.MEDIUM

              return (
                <div key={a.id} className="card card-hover" style={{
                  padding: 20,
                  borderLeft: `4px solid ${riskColor}`,
                  display: 'grid',
                  gridTemplateColumns: '1fr auto',
                  gap: 16,
                  alignItems: 'center'
                }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                      <span style={{
                        fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.8px',
                        color: riskColor, border: `1px solid ${riskColor}`, borderRadius: 4, padding: '2px 7px'
                      }}>
                        {a.risk_level || 'MEDIUM'} RISK
                      </span>
                      <span className={`badge badge-${a.status.toLowerCase()}`}>{a.status}</span>
                      {isOverdue && (
                        <span style={{ fontSize: 10, fontWeight: 700, color: '#dc2626', background: '#FEF2F2', padding: '2px 7px', borderRadius: 4 }}>OVERDUE</span>
                      )}
                    </div>

                    <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>
                      Action requested by: <span style={{ color: 'var(--green-dark)' }}>{a.requested_by}</span>
                    </h3>

                    <div style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', gap: 20, flexWrap: 'wrap' }}>
                      <span>🕐 Deadline: {deadline.toLocaleString()}</span>
                      {a.task_id && <span>Task: {a.task_id.substring(0, 8)}</span>}
                      {a.execution_id && <span>Workflow: {a.execution_id.substring(0, 8)}</span>}
                      <span>Created: {new Date(a.created_at).toLocaleString()}</span>
                    </div>

                    {a.context?.step && (
                      <div style={{ marginTop: 8, fontSize: 12, background: 'var(--bg)', padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border)' }}>
                        <strong>Step:</strong> {a.context.step.id} ({a.context.step.type})
                      </div>
                    )}
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 140 }}>
                    {a.status === 'PENDING' ? (
                      <>
                        <button
                          className="btn btn-primary btn-sm"
                          disabled={deciding === a.id}
                          onClick={() => setSelectedApproval(a)}
                        >
                          Review & Decide
                        </button>
                      </>
                    ) : (
                      <div style={{ textAlign: 'center', fontSize: 12 }}>
                        <div style={{ fontWeight: 700, color: a.status === 'APPROVED' ? 'var(--green)' : '#dc2626' }}>
                          {a.status === 'APPROVED' ? '✓ Approved' : '✕ Rejected'}
                        </div>
                        {a.decided_at && (
                          <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>
                            {new Date(a.decided_at).toLocaleDateString()}
                          </div>
                        )}
                        {a.decision_note && (
                          <div style={{ color: 'var(--text-muted)', marginTop: 4, fontStyle: 'italic' }}>
                            "{a.decision_note}"
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Decision Modal */}
      {selectedApproval && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: 520 }}>
            <div className="modal-header">
              <h2 className="modal-title">Review Approval Request</h2>
              <button onClick={() => { setSelectedApproval(null); setDecisionNote('') }}
                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 18 }}>✕</button>
            </div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ background: 'var(--bg)', padding: 16, borderRadius: 8, border: '1px solid var(--border)' }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>Request Context</div>
                <pre style={{ fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0 }}>
                  {JSON.stringify(selectedApproval.context || {}, null, 2)}
                </pre>
              </div>
              <div className="form-group">
                <label className="form-label">Decision Note (optional)</label>
                <textarea
                  className="input" rows={3}
                  placeholder="Add a note explaining your decision — helps train better agents..."
                  value={decisionNote}
                  onChange={e => setDecisionNote(e.target.value.slice(0, 500))}
                  maxLength={500}
                />
                <div className={`char-counter ${decisionNote.length >= 500 ? 'over' : ''}`}>
                  {decisionNote.length}/500
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => { setSelectedApproval(null); setDecisionNote('') }}>Cancel</button>
              <button
                className="btn btn-danger"
                disabled={deciding === selectedApproval.id}
                onClick={() => decide(selectedApproval.id, 'REJECTED')}
                style={{ background: '#dc2626', color: '#fff' }}
              >
                ✕ Reject Action
              </button>
              <button
                className="btn btn-primary"
                disabled={deciding === selectedApproval.id}
                onClick={() => decide(selectedApproval.id, 'APPROVED')}
              >
                ✓ Approve & Continue
              </button>
            </div>
          </div>
        </div>
      )}

      <FeedbackModal
        open={feedbackFor !== null}
        onClose={() => setFeedbackFor(null)}
        approvalId={feedbackFor?.approvalId}
        agentId={feedbackFor?.agentId}
        title="Rate this decision"
        subtitle="Was the AI's proposed action reasonable? Your feedback trains better agents."
      />
    </div>
  )
}
