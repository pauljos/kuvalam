'use client'
import { useEffect, useState, useCallback, useRef } from 'react'
import { api, API_BASE } from '@/lib/api'
import { useApp } from '@/lib/context'
import { FeedbackModal } from '@/components/FeedbackModal'

const RISK_COLORS: Record<string, string> = {
  LOW: '#16a34a', MEDIUM: '#d97706', HIGH: '#dc2626', CRITICAL: '#7c3aed'
}

const AUTONOMY_BADGES: Record<string, { label: string; color: string }> = {
  SUPERVISED: { label: '👁 SUPERVISED', color: '#d97706' },
  GUARDED: { label: '🛡 GUARDED', color: '#16a34a' },
  AUTONOMOUS: { label: '🤖 AUTONOMOUS', color: '#7c3aed' },
}

export default function ApprovalsPage() {
  const { tenantId, toast } = useApp()
  const [approvals, setApprovals] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'PENDING' | 'APPROVED' | 'REJECTED' | 'ALL'>('PENDING')
  const [deciding, setDeciding] = useState<string | null>(null)
  const [selectedApproval, setSelectedApproval] = useState<any>(null)
  const [decisionNote, setDecisionNote] = useState('')
  const [modifiedInput, setModifiedInput] = useState<string>('')
  const [isBatchMode, setIsBatchMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [feedbackFor, setFeedbackFor] = useState<{ approvalId: string; agentId?: string } | null>(null)
  const [now, setNow] = useState<number>(Date.now())
  const wsRef = useRef<WebSocket | null>(null)

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

  // ── Real-time WebSocket subscription for approval updates ────────────────
  useEffect(() => {
    if (!tenantId) return

    let cancelled = false
    const wsRefLocal = { current: null as WebSocket | null }

    // Fetch a short-lived WS token (httpOnly cookie can't be read by JS
    // and won't be sent cross-origin by the WebSocket constructor).
    api.fetchWSToken().then(token => {
      if (cancelled) return
      const url = new URL(API_BASE)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      url.pathname = `/ws/tenants/${tenantId}/telemetry`
      url.searchParams.set('token', token)
      const ws = new WebSocket(url.toString())
      wsRef.current = ws
      wsRefLocal.current = ws

    ws.onmessage = (event) => {
      let msg: any
      try { msg = JSON.parse(event.data) } catch { return }
      const { eventType, payload } = msg

      // Refresh list on approval-related events
      if (['agent.approval_required', 'agent.approval_granted', 'agent.approval_rejected',
           'agent.approval_timeout', 'agent.task_resuming'].includes(eventType)) {
        load(tenantId, filter)
      }
    }

      ws.onerror = () => {} // Silently handle WS errors
      ws.onclose = () => {}
    }).catch(() => {})

    return () => {
      cancelled = true
      wsRefLocal.current?.close()
    }
  }, [tenantId, load, filter])

  // ── Countdown timer (refreshes every second for pending deadlines) ────────
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  // ── Decide on an approval request ────────────────────────────────────────
  async function decide(approvalId: string, decision: 'APPROVED' | 'REJECTED') {
    setDeciding(approvalId)
    // Parse modified input if provided
    let parsedModifiedInput = undefined
    if (decision === 'APPROVED' && modifiedInput.trim()) {
      try {
        parsedModifiedInput = JSON.parse(modifiedInput)
      } catch {
        toast('error', 'Invalid JSON', 'Modified input must be valid JSON')
        setDeciding(null)
        return
      }
    }

    try {
      await api.decideApproval(tenantId, approvalId, {
        decision,
        decisionNote: decisionNote || (decision === 'APPROVED' ? 'Approved via dashboard' : 'Rejected via dashboard'),
        modifiedInput: parsedModifiedInput,
      })
      toast('success', `Request ${decision.toLowerCase()}`, decision === 'APPROVED'
        ? 'The AI action has been approved and will proceed.'
        : 'The AI action has been blocked.')
      const approvedItem = selectedApproval || approvals.find(a => a.id === approvalId)
      setSelectedApproval(null)
      setDecisionNote('')
      setModifiedInput('')
      load(tenantId, filter)
      // Prompt for feedback after every decision
      setTimeout(() => setFeedbackFor({ approvalId, agentId: approvedItem?.agent_id }), 500)
    } catch (err: any) {
      toast('error', 'Decision failed', err.message)
    } finally {
      setDeciding(null)
    }
  }

  // ── Revert an approval back to PENDING ──────────────────────────────────
  async function revertApproval(approvalId: string) {
    try {
      await api.request(`/tenants/${tenantId}/approvals/${approvalId}/revert`, { method: 'POST' })
      toast('success', 'Reverted to pending', 'You can now approve or reject this request.')
      load(tenantId, filter)
    } catch (err: any) {
      toast('error', 'Revert failed', err.message)
    }
  }

  // ── Batch approve/reject ─────────────────────────────────────────────────
  async function batchDecide(decision: 'APPROVED' | 'REJECTED') {
    if (selectedIds.size === 0) {
      toast('info', 'No selections', 'Select at least one approval to process.')
      return
    }
    setDeciding('batch')
    try {
      const approvalIds = Array.from(selectedIds)
      await api.request(`/tenants/${tenantId}/approvals/batch`, {
        method: 'POST',
        body: JSON.stringify({ approvalIds, decision, decisionNote: `${decision} via batch action` }),
      })
      toast('success', `Batch ${decision.toLowerCase()}`, `${approvalIds.length} requests ${decision.toLowerCase()}.`)
      setSelectedIds(new Set())
      setIsBatchMode(false)
      load(tenantId, filter)
    } catch (err: any) {
      toast('error', 'Batch decision failed', err.message)
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
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className={`btn btn-sm ${isBatchMode ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => { setIsBatchMode(!isBatchMode); setSelectedIds(new Set()) }}
          >
            {isBatchMode ? 'Exit Batch' : '📦 Batch'}
          </button>
          <button className="btn btn-secondary" onClick={() => load(tenantId, filter)}>↻ Refresh</button>
        </div>
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

        {/* Batch Actions Bar */}
        {isBatchMode && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px',
            background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 8, marginBottom: 16,
          }}>
            <span style={{ fontWeight: 600, fontSize: 14 }}>
              {selectedIds.size > 0 ? `${selectedIds.size} selected` : 'Select items to batch'}
            </span>
            <button className="btn btn-secondary btn-sm" onClick={() => {
              if (selectedIds.size === approvals.length) setSelectedIds(new Set())
              else setSelectedIds(new Set(approvals.map(a => a.id)))
            }}>
              {selectedIds.size === approvals.length ? 'Deselect All' : 'Select All'}
            </button>
            {selectedIds.size > 0 && (
              <>
                <button className="btn btn-primary btn-sm" disabled={deciding === 'batch'}
                  onClick={() => batchDecide('APPROVED')}>✓ Approve All</button>
                <button className="btn btn-danger btn-sm" disabled={deciding === 'batch'}
                  onClick={() => batchDecide('REJECTED')}
                  style={{ background: '#dc2626', color: '#fff' }}>✕ Reject All</button>
                <button className="btn btn-secondary btn-sm" onClick={() => setSelectedIds(new Set())}>Clear</button>
              </>
            )}
          </div>
        )}

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
              const deadline = a.deadline ? new Date(a.deadline) : null
              const isOverdue = deadline && deadline.getTime() < now && a.status === 'PENDING'
              const riskColor = RISK_COLORS[a.risk_level] || RISK_COLORS.MEDIUM
              const autonomyBadge = AUTONOMY_BADGES[a.autonomy_level] || AUTONOMY_BADGES.SUPERVISED
              const isChecked = selectedIds.has(a.id)
              const timeLeft = deadline && a.status === 'PENDING'
                ? Math.max(0, Math.floor((deadline.getTime() - now) / 1000))
                : 0
              const timeLeftMins = Math.floor(timeLeft / 60)
              const timeLeftSecs = timeLeft % 60

              return (
                <div key={a.id} className="card card-hover" style={{
                  padding: 20,
                  borderLeft: `4px solid ${riskColor}`,
                  display: 'grid',
                  gridTemplateColumns: isBatchMode ? 'auto 1fr auto' : '1fr auto',
                  gap: 16,
                  alignItems: 'center',
                  opacity: a.status !== 'PENDING' ? 0.75 : 1,
                }}>
                  {/* Batch checkbox */}
                  {isBatchMode && (
                    <input type="checkbox" checked={isChecked}
                      onChange={() => {
                        const next = new Set(selectedIds)
                        isChecked ? next.delete(a.id) : next.add(a.id)
                        setSelectedIds(next)
                      }}
                      style={{ width: 18, height: 18, accentColor: 'var(--green)', cursor: 'pointer' }}
                    />
                  )}

                  <div>
                    {/* Badges row */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                      <span style={{
                        fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.8px',
                        color: riskColor, border: `1px solid ${riskColor}`, borderRadius: 4, padding: '2px 7px'
                      }}>
                        {a.risk_level || 'MEDIUM'} RISK
                      </span>
                      <span className={`badge badge-${a.status.toLowerCase()}`}>{a.status}</span>
                      {a.autonomy_level && (
                        <span style={{
                          fontSize: 10, fontWeight: 700,
                          color: autonomyBadge.color, border: `1px solid ${autonomyBadge.color}`,
                          borderRadius: 4, padding: '2px 7px',
                        }}>
                          {autonomyBadge.label}
                        </span>
                      )}
                      {isOverdue && (
                        <span style={{ fontSize: 10, fontWeight: 700, color: '#dc2626', background: '#FEF2F2', padding: '2px 7px', borderRadius: 4 }}>⏰ OVERDUE</span>
                      )}
                      {a.agent_name && (
                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                          🤖 {a.agent_name}
                        </span>
                      )}
                    </div>

                    {/* Title */}
                    <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>
                      {a.tool_name ? (
                        <>🔧 <span style={{ color: 'var(--green-dark)', fontFamily: 'monospace' }}>{a.tool_name}</span></>
                      ) : a.agent_name ? (
                        <>Action requested by: <span style={{ color: 'var(--green-dark)' }}>{a.agent_name}</span></>
                      ) : (
                        <>Action requested by: <span style={{ color: 'var(--green-dark)' }}>{a.requested_by}</span></>
                      )}
                    </h3>

                    {/* Task goal */}
                    {a.task_goal && (
                      <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 6, fontStyle: 'italic' }}>
                        "{a.task_goal.substring(0, 120)}{a.task_goal.length > 120 ? '...' : ''}"
                      </div>
                    )}

                    {/* Tool input parameters */}
                    {a.tool_input && a.status === 'PENDING' && (
                      <div style={{ marginTop: 8, fontSize: 12, background: 'var(--bg)', padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border)' }}>
                        <strong>Parameters:</strong>
                        <pre style={{ margin: '4px 0 0', fontSize: 11, fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 120, overflowY: 'auto' }}>
                          {JSON.stringify(a.tool_input, null, 2)}
                        </pre>
                      </div>
                    )}

                    {/* Metadata row */}
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 8 }}>
                      {a.status === 'PENDING' && timeLeft > 0 && (
                        <span style={{
                          fontWeight: timeLeft < 60 ? 700 : 400,
                          color: timeLeft < 60 ? '#dc2626' : timeLeft < 300 ? '#d97706' : 'var(--text-muted)',
                        }}>
                          ⏱ {timeLeftMins}:{String(timeLeftSecs).padStart(2, '0')} remaining
                        </span>
                      )}
                      {a.deadline && <span>🕐 {deadline?.toLocaleString()}</span>}
                      {a.task_id && <span>📋 Task: {a.task_id.substring(0, 8)}</span>}
                      {a.execution_id && <span>🔗 Workflow: {a.execution_id.substring(0, 8)}</span>}
                      <span>📅 {new Date(a.created_at).toLocaleString()}</span>
                    </div>

                    {/* Workflow step context */}
                    {a.context?.step && (
                      <div style={{ marginTop: 8, fontSize: 12, background: 'var(--bg)', padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border)' }}>
                        <strong>Step:</strong> {a.context.step.id} ({a.context.step.type})
                      </div>
                    )}
                  </div>

                  {/* Action buttons */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 140 }}>
                    {a.status === 'PENDING' ? (
                      <>
                        <button
                          className="btn btn-primary btn-sm"
                          disabled={deciding === a.id}
                          onClick={() => { setSelectedApproval(a); setModifiedInput(JSON.stringify(a.tool_input || {}, null, 2)) }}
                        >
                          Review & Decide
                        </button>
                        {isOverdue && (
                          <span style={{ fontSize: 11, color: '#dc2626', textAlign: 'center' }}>
                            Will auto-reject
                          </span>
                        )}
                      </>
                    ) : (
                      <div style={{ textAlign: 'center', fontSize: 12 }}>
                        <div style={{
                          fontWeight: 700,
                          color: a.status === 'APPROVED' ? 'var(--green)' : a.status === 'REJECTED' ? '#dc2626' : '#64748b',
                        }}>
                          {a.status === 'APPROVED' ? '✓ Approved' : a.status === 'REJECTED' ? '✕ Rejected' : a.status === 'EXPIRED' ? '⏰ Expired' : a.status}
                        </div>
                        {a.decided_at && (
                          <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>
                            {new Date(a.decided_at).toLocaleDateString()}
                          </div>
                        )}
                        {a.decision_note && (
                          <div style={{ color: 'var(--text-muted)', marginTop: 4, fontStyle: 'italic', fontSize: 11 }}>
                            "{a.decision_note.substring(0, 80)}{a.decision_note.length > 80 ? '...' : ''}"
                          </div>
                        )}
                        {a.auto_rejected_at && (
                          <div style={{ color: '#dc2626', marginTop: 4, fontSize: 11 }}>
                            Auto-rejected: Timeout
                          </div>
                        )}
                        {(a.status === 'APPROVED' || a.status === 'REJECTED') && (
                          <button
                            className="btn btn-secondary btn-sm"
                            style={{ marginTop: 8, fontSize: 11 }}
                            onClick={() => revertApproval(a.id)}
                          >
                            ↩ Re-open
                          </button>
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
          <div className="modal" style={{ maxWidth: 640 }}>
            <div className="modal-header">
              <h2 className="modal-title">Review Approval Request</h2>
              <button onClick={() => { setSelectedApproval(null); setDecisionNote(''); setModifiedInput('') }}
                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 18 }}>✕</button>
            </div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {/* Summary */}
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                {selectedApproval.agent_name && (
                  <span style={{ fontSize: 13, background: '#f0fdf4', color: '#166534', padding: '4px 10px', borderRadius: 6, fontWeight: 600 }}>
                    🤖 {selectedApproval.agent_name}
                  </span>
                )}
                {selectedApproval.autonomy_level && (
                  <span style={{ fontSize: 13, background: '#fffbeb', color: '#92400e', padding: '4px 10px', borderRadius: 6, fontWeight: 600 }}>
                    {AUTONOMY_BADGES[selectedApproval.autonomy_level]?.label || selectedApproval.autonomy_level}
                  </span>
                )}
                {selectedApproval.risk_level && (
                  <span style={{
                    fontSize: 12, fontWeight: 700, textTransform: 'uppercase',
                    color: RISK_COLORS[selectedApproval.risk_level],
                    border: `1px solid ${RISK_COLORS[selectedApproval.risk_level]}`,
                    borderRadius: 4, padding: '2px 8px',
                  }}>
                    {selectedApproval.risk_level} RISK
                  </span>
                )}
              </div>

              {/* Task Goal */}
              {selectedApproval.task_goal && (
                <div style={{ background: 'var(--bg)', padding: 16, borderRadius: 8, border: '1px solid var(--border)' }}>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>📋 Task Goal</div>
                  <div style={{ fontSize: 14 }}>{selectedApproval.task_goal}</div>
                </div>
              )}

              {/* Tool Info + Editable Parameters */}
              {selectedApproval.tool_name && (
                <div style={{ background: 'var(--bg)', padding: 16, borderRadius: 8, border: '1px solid var(--border)' }}>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>🔧 Tool Requested</div>
                  <div style={{ fontWeight: 700, fontSize: 16, fontFamily: 'monospace', marginBottom: 12, color: 'var(--green-dark)' }}>
                    {selectedApproval.tool_name}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
                    Input Parameters <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>(you can modify before approving)</span>
                  </div>
                  <div style={{
                    border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden',
                  }}>
                    <textarea
                      className="input"
                      style={{
                        fontFamily: 'monospace', fontSize: 12, minHeight: 160, resize: 'vertical',
                        background: '#0f1117', color: '#e2e8f0', border: 'none', borderRadius: 0,
                      }}
                      value={modifiedInput}
                      onChange={e => setModifiedInput(e.target.value)}
                    />
                  </div>
                </div>
              )}

              {/* Request Context */}
              <details>
                <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600, color: 'var(--text-muted)' }}>
                  📄 Full Context (click to expand)
                </summary>
                <div style={{ marginTop: 8, background: 'var(--bg)', padding: 12, borderRadius: 8, border: '1px solid var(--border)' }}>
                  <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, maxHeight: 200, overflowY: 'auto' }}>
                    {JSON.stringify(selectedApproval.context || {}, null, 2)}
                  </pre>
                </div>
              </details>

              {/* Decision Note */}
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
              <button className="btn btn-secondary" onClick={() => { setSelectedApproval(null); setDecisionNote(''); setModifiedInput('') }}>Cancel</button>
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
