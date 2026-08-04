'use client'
import { useEffect, useState, useRef } from 'react'
import { createPortal } from 'react-dom'
import { api } from '@/lib/api'
import { useApp } from '@/lib/context'
import dynamic from 'next/dynamic'
import type { Step as CanvasStep, WorkflowMeta } from '@/components/WorkflowCanvas'

const WorkflowCanvas = dynamic(() => import('@/components/WorkflowCanvas'), { 
  ssr: false,
  loading: () => <div className="skeleton" style={{ height: 'calc(100vh - 120px)', width: '100%', borderRadius: 12 }}></div>
})

// Step-type → icon for the mini chips on workflow cards
const STEP_TYPE_ICONS: Record<string, string> = {
  AGENT: '🤖', CREW: '👥', HTTP: '🌐', APPROVAL: '✅', CONDITION: '🔀',
  TOOL: '🔧', TRANSFORM: '🔄', DELAY: '⏱️', SET: '⚙️', LOOP: '🔁',
  NOTIFY: '🔔', PARALLEL: '⧉', SCRIPT: '📜',
}

export default function WorkflowsPage() {
  const { tenantId, toast } = useApp()
  const [workflows, setWorkflows] = useState<any[]>([])
  const [executions, setExecutions] = useState<any[]>([])
  const [agents, setAgents] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<'workflows' | 'executions'>('workflows')

  // Canvas builder state
  const [showCanvas, setShowCanvas] = useState(false)
  const [canvasInitial, setCanvasInitial] = useState<{ steps: CanvasStep[]; meta: WorkflowMeta } | null>(null)
  const [editingWfId, setEditingWfId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  // Live Execution Trace Modal
  const [selectedExec, setSelectedExec] = useState<any>(null)
  const [deleteConfirmWf, setDeleteConfirmWf] = useState<any>(null)
  const [deleting, setDeleting] = useState(false)
  const pollRef = useRef<any>(null)

  useEffect(() => {
    if (tenantId) loadData(tenantId)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [tenantId])

  async function loadData(tid: string) {
    try {
      const [wRes, aRes] = await Promise.all([
        api.listWorkflows(tid),
        api.listAgents(tid).catch(() => ({ agents: [] }))
      ])
      setWorkflows(wRes.workflows || [])
      setAgents(aRes.agents || [])
    } catch (err) {
      console.error(err)
      toast('error', 'Failed to load workflows', (err as any)?.message || '')
    } finally {
      setLoading(false)
    }
  }

  function openCanvasNew() {
    setEditingWfId(null)
    setCanvasInitial({
      steps: [],
      meta: { name: '', description: '', trigger: { type: 'MANUAL' }, onFailure: 'STOP' }
    })
    setShowCanvas(true)
  }

  function openCanvasEdit(wf: any) {
    setEditingWfId(wf.id)
    setCanvasInitial({
      steps: (wf.steps || []) as CanvasStep[],
      meta: {
        name: wf.name || '',
        description: wf.description || '',
        trigger: wf.trigger || { type: 'MANUAL' },
        onFailure: wf.on_failure || 'STOP',
      }
    })
    setShowCanvas(true)
  }

  async function saveFromCanvas({ steps, meta }: { steps: CanvasStep[]; meta: WorkflowMeta }) {
    if (steps.length === 0) { toast('warning', 'No steps', 'Add at least one step to the canvas.'); return }
    if (!meta.name.trim()) { toast('warning', 'Name required', 'Give the workflow a name in the details panel.'); return }
    setCreating(true)
    try {
      const payload = {
        name: meta.name,
        description: meta.description,
        trigger: meta.trigger,
        steps,
        onFailure: meta.onFailure,
      }
      if (editingWfId) {
        await api.updateWorkflow(tenantId, editingWfId, { ...payload, status: 'ACTIVE' })
      } else {
        const created: any = await api.createWorkflow(tenantId, payload)
        await api.updateWorkflow(tenantId, created.id, { status: 'ACTIVE' })
      }
      setShowCanvas(false)
      setCanvasInitial(null)
      setEditingWfId(null)
      loadData(tenantId)
      toast('success', 'Workflow saved', editingWfId ? 'Workflow updated and active.' : 'New workflow is now active.')
    } catch (err: any) {
      toast('error', 'Save failed', err.message)
    } finally {
      setCreating(false)
    }
  }

  async function triggerWorkflow(wfId: string) {
    try {
      const exec = await api.startWorkflowExecution(tenantId, wfId, { context: {} })
      setActiveTab('executions')
      setExecutions(prev => [exec, ...prev])
      toast('success', 'Workflow started', 'Execution is now running.')
      viewExecution(exec.id)
    } catch (err: any) {
      if (err.status === 429) {
        toast('warning', 'Execution limit reached', err.message || 'Too many workflows running. Please wait.')
      } else if (err.status === 422) {
        toast('error', 'Workflow not active', 'This workflow must be active to execute.')
      } else {
        toast('error', 'Failed to start workflow', err.message)
      }
    }
  }

  async function duplicateWorkflow(wfId: string) {
    try {
      const clone = await api.duplicateWorkflow(tenantId, wfId)
      setWorkflows(prev => [clone, ...prev])
      toast('success', 'Workflow duplicated', `Created "${clone.name}".`)
    } catch (err: any) {
      toast('error', 'Duplicate failed', err.message)
    }
  }

  async function deleteWorkflow(wfId: string) {
    setDeleteConfirmWf(workflows.find(w => w.id === wfId) || null)
  }

  async function confirmDeleteWorkflow() {
    if (!deleteConfirmWf) return
    setDeleting(true)
    try {
      await api.deleteWorkflow(tenantId, deleteConfirmWf.id)
      setWorkflows(prev => prev.filter(w => w.id !== deleteConfirmWf.id))
      setDeleteConfirmWf(null)
      toast('success', 'Workflow deleted')
    } catch (err: any) {
      toast('error', 'Delete failed', err.message)
    } finally {
      setDeleting(false)
    }
  }

  async function viewExecution(execId: string) {
    if (pollRef.current) clearInterval(pollRef.current)
    try {
      const trace = await api.getWorkflowExecution(tenantId, execId)
      setSelectedExec(trace)
      pollExecution(execId)
    } catch (err: any) {
      toast('error', 'Could not load execution', err.message)
    }
  }

  function pollExecution(execId: string) {
    pollRef.current = setInterval(async () => {
      try {
        const trace = await api.getWorkflowExecution(tenantId, execId)
        setSelectedExec(trace)
        if (['COMPLETED', 'FAILED'].includes(trace.status)) {
          clearInterval(pollRef.current)
        }
      } catch {
        clearInterval(pollRef.current)
      }
    }, 1500)
  }

  async function resumeWorkflow(execId: string, approved: boolean) {
    try {
      await api.resumeWorkflowExecution(tenantId, execId, { approved, notes: 'Reviewed by admin via interface' })
      viewExecution(execId)
      toast('success', approved ? 'Execution resumed' : 'Execution rejected', '')
    } catch (err: any) {
      toast('error', 'Action failed', err.message)
    }
  }

  return (
    <div className="animate-in">
      <div className="page-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <a href="/dashboard" className="btn btn-secondary btn-sm" style={{ textDecoration: 'none', padding: '6px 12px' }}>
            ← Home
          </a>
          <div>
            <h1 className="page-title" style={{ marginBottom: 2 }}>Workflows</h1>
            <p className="page-sub">Chain agents, decision gates, and integrations into repeatable sequences</p>
          </div>
        </div>
        <button className="btn btn-primary" onClick={openCanvasNew}>+ Build Workflow</button>
      </div>

      <div className="page-body">
        {/* Navigation Tabs */}
        <div className="tabs" style={{ marginBottom: 24 }}>
          <button className={`tab ${activeTab === 'workflows' ? 'active' : ''}`} onClick={() => setActiveTab('workflows')}>
            Available Workflows ({workflows.length})
          </button>
          <button className={`tab ${activeTab === 'executions' ? 'active' : ''}`} onClick={() => {
            setActiveTab('executions')
            // Load the full run history for this tenant. Previously this code
            // iterated over workflows and called getWorkflowExecution(tenantId, wf.id)
            // — passing a WORKFLOW id where an EXECUTION id was expected, which
            // made every request 404 and left the log empty.
            api.listWorkflowExecutions(tenantId)
              .then((data: any) => {
                setExecutions(data?.executions || [])
              })
              .catch(() => setExecutions([]))
          }}>
            Executions Log
          </button>
        </div>

        {loading ? (
          <div className="skeleton" style={{ height: 300 }} />
        ) : activeTab === 'workflows' ? (
          workflows.length === 0 ? (
            <div className="card empty-state">
              <span className="empty-icon">⟳</span>
              <h2 className="empty-title">Automate a multi-step process</h2>
              <p className="empty-desc">
                Workflows chain agents, HTTP calls, decisions, and human approvals together.
                Perfect for onboarding checks, report generation, or compliance reviews.
              </p>
              <button className="btn btn-primary btn-lg" onClick={openCanvasNew}>+ Build your first workflow</button>
              <div style={{ marginTop: 32, fontSize: 12, color: 'var(--text-muted)', display: 'flex', gap: 20, justifyContent: 'center', flexWrap: 'wrap' }}>
                <span>💡 Start simple: 1 agent + 1 approval step</span>
                <span>·</span>
                <span>⚡ Add a trigger later to run it on schedule</span>
              </div>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 16 }}>
              {workflows.map(wf => {
                const isActive = wf.status === 'ACTIVE'
                const stepTypes = Array.from(new Set((wf.steps || []).map((s: any) => s.type).filter(Boolean))) as string[]
                const trigger = wf.trigger?.type || 'MANUAL'
                const triggerIcon = trigger === 'SCHEDULE' ? '🕒' : '▶️'
                const lastExec = (wf as any).last_execution_status as string | undefined
                const isExecRunning = lastExec === 'RUNNING' || lastExec === 'PENDING_APPROVAL'
                const isExecFailed = lastExec === 'FAILED'
                const topBarBg = isExecRunning
                  ? 'linear-gradient(90deg, #3b82f6, #818cf8)'
                  : isExecFailed
                  ? 'linear-gradient(90deg, #ef4444, #f87171)'
                  : isActive
                  ? 'linear-gradient(90deg, #10b981, #34d399)'
                  : 'linear-gradient(90deg, #f59e0b, #fbbf24)'
                const cardBorder = isExecRunning
                  ? '1px solid #93c5fd'
                  : isExecFailed
                  ? '1px solid #fca5a5'
                  : isActive
                  ? '1px solid var(--green-border)'
                  : '1px solid var(--border)'
                return (
                <div key={wf.id} className="card card-hover" style={{
                  padding: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden',
                  border: cardBorder,
                  boxShadow: '0 1px 2px rgba(0,0,0,0.05), 0 4px 12px rgba(0,0,0,0.04)',
                }}>
                  {/* Top accent gradient bar */}
                  <div className={isExecRunning ? 'bar-running' : undefined} style={{
                    height: 4, flexShrink: 0,
                    background: topBarBg,
                  }} />

                  <div style={{ padding: '16px 10px 20px 10px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {/* Top row: icon + name + status */}
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                      <div style={{
                        width: 40, height: 40, borderRadius: 12, flexShrink: 0,
                        background: isActive ? 'linear-gradient(135deg, #d1fae5, #a7f3d0)' : 'linear-gradient(135deg, #fef3c7, #fde68a)',
                        border: `1.5px solid ${isActive ? 'var(--green-border)' : 'var(--border)'}`,
                        display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20,
                        boxShadow: 'inset 0 1px 2px rgba(255,255,255,0.6)',
                      }}>⟳</div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, marginBottom: 2 }}>
                          <h3 title={wf.name} style={{ fontWeight: 800, fontSize: 14, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>{wf.name}</h3>
                          <button
                            className="btn btn-danger btn-sm"
                            onClick={() => deleteWorkflow(wf.id)}
                            title="Delete workflow"
                            style={{ padding: '2px 6px', color: 'var(--red)', fontSize: 11, lineHeight: '18px', background: 'transparent', border: 'none', borderRadius: 4, flexShrink: 0, cursor: 'pointer' }}
                          >🗑</button>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          <span style={{
                            fontSize: 10, fontWeight: 600, padding: '1px 7px', borderRadius: 10,
                            background: isActive ? '#d1fae5' : '#fef3c7',
                            color: isActive ? '#065f46' : '#92400e',
                            border: `1px solid ${isActive ? '#a7f3d0' : '#fde68a'}`,
                          }}>
                            {isActive ? '● Active' : wf.status}
                          </span>
                          <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 500 }}>
                            {triggerIcon} {trigger === 'SCHEDULE' ? 'Scheduled' : 'Manual'}
                            <span style={{ margin: '0 4px', opacity: 0.4 }}>·</span>
                            {wf.steps?.length || 0} steps
                            {wf.on_failure && (
                              <>
                                <span style={{ margin: '0 4px', opacity: 0.4 }}>·</span>
                                <span style={{ color: wf.on_failure === 'STOP' ? '#b45309' : 'var(--green-dark)' }}>
                                  {wf.on_failure === 'STOP' ? '⏹ stop' : '▶ continue'}
                                </span>
                              </>
                            )}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Description */}
                    {wf.description && (
                      <p style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5, margin: 0, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                        {wf.description}
                      </p>
                    )}

                    {/* Step type chips */}
                    {stepTypes.length > 0 && (
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {stepTypes.slice(0, 6).map(t => (
                          <span key={t} style={{
                            fontSize: 10, fontWeight: 600, padding: '3px 8px', borderRadius: 6,
                            background: '#f0fdf4', color: '#166534', border: '1px solid #bbf7d0',
                            display: 'flex', alignItems: 'center', gap: 4,
                          }}>
                            {STEP_TYPE_ICONS[t] || '•'} {t.charAt(0) + t.slice(1).toLowerCase()}
                          </span>
                        ))}
                        {stepTypes.length > 6 && (
                          <span style={{ fontSize: 10, fontWeight: 600, padding: '3px 8px', borderRadius: 6, background: '#f3f4f6', color: '#4b5563', border: '1px solid #e5e7eb' }}>
                            +{stepTypes.length - 6} more
                          </span>
                        )}
                      </div>
                    )}

                    {/* Action buttons */}
                    <div style={{ display: 'flex', gap: 8, paddingTop: 4 }}>
                      <button className="btn btn-primary btn-sm" style={{ flex: 1 }} onClick={() => triggerWorkflow(wf.id)}>🚀 Execute</button>
                      <button className="btn btn-secondary btn-sm" onClick={() => openCanvasEdit(wf)}>Edit</button>
                      <button className="btn btn-secondary btn-sm" onClick={() => duplicateWorkflow(wf.id)} title="Duplicate workflow" style={{ padding: '6px 12px' }}>⧉</button>
                    </div>
                  </div>
                </div>
              )})}
            </div>
          )
        ) : (
          /* Executions Log */
          <div className="card" style={{ padding: 24 }}>
            {executions.length === 0 ? (
              <p style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)' }}>No workflow execution traces found.</p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Workflow</th>
                    <th>Started</th>
                    <th>Status</th>
                    <th>Trace</th>
                  </tr>
                </thead>
                <tbody>
                  {executions.map(exec => (
                    <tr key={exec.id}>
                      <td style={{ fontWeight: 700 }}>
                        {exec.workflow_name || 'Workflow'}
                        <div style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-muted)' }}>ID: {exec.id.substring(0,8)}</div>
                      </td>
                      <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{new Date(exec.created_at).toLocaleString()}</td>
                      <td>
                        <span className={`badge badge-${exec.status.toLowerCase()}`}>{exec.status}</span>
                      </td>
                      <td>
                        <button className="btn btn-secondary btn-sm" onClick={() => viewExecution(exec.id)}>Inspect</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {/* Canvas Builder (fullscreen) — portalled to body to escape layout stacking context */}
      {showCanvas && canvasInitial && typeof document !== 'undefined' && createPortal(
        <WorkflowCanvas
          initialSteps={canvasInitial.steps}
          initialMeta={canvasInitial.meta}
          agents={agents.map(a => ({ id: a.id, name: a.name }))}
          onSave={saveFromCanvas}
          onCancel={() => { setShowCanvas(false); setCanvasInitial(null); setEditingWfId(null) }}
          saving={creating}
          title={editingWfId ? 'Edit Workflow' : 'New Workflow'}
          tenantId={tenantId || undefined}
        />,
        document.body
      )}

      {/* Trace / Execution Log Modal */}
      {selectedExec && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: 640 }}>
            <div className="modal-header">
              <div>
                <h2 className="modal-title">Orchestration Execution Trace</h2>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>ID: {selectedExec.id}</div>
              </div>
              <button onClick={() => { setSelectedExec(null); if (pollRef.current) clearInterval(pollRef.current) }} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 18 }}>✕</button>
            </div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontWeight: 700 }}>Execution Status</span>
                <span className={`badge badge-${selectedExec.status.toLowerCase()}`}>{selectedExec.status}</span>
              </div>

              {/* Steps Log */}
              <div style={{ background: 'var(--bg)', borderRadius: 8, padding: 16, display: 'flex', flexDirection: 'column', gap: 14, maxHeight: 350, overflowY: 'auto' }}>
                {selectedExec.steps?.map((step: any, idx: number) => (
                  <div key={idx} style={{ borderTop: idx > 0 ? '1px solid var(--border)' : 'none', paddingTop: idx > 0 ? 12 : 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13 }}>
                      <span><strong>Step: {step.step_id}</strong> <span style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--text-muted)' }}>({step.step_type})</span></span>
                      <span className={`badge badge-${step.status.toLowerCase()}`} style={{ fontSize: 9 }}>{step.status}</span>
                    </div>

                    {step.status === 'PENDING' && step.step_type === 'APPROVAL' && (
                      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                        <button type="button" className="btn btn-primary btn-sm" onClick={() => resumeWorkflow(selectedExec.id, true)}>✓ Approve Stage</button>
                        <button type="button" className="btn btn-danger btn-sm" onClick={() => resumeWorkflow(selectedExec.id, false)}>✕ Reject</button>
                      </div>
                    )}

                    {step.input && (
                      <pre style={{ fontSize: 11, background: 'var(--bg-white)', padding: 6, borderRadius: 4, marginTop: 6, overflowX: 'auto', border: '1px solid var(--border)' }}>
                        Input: {JSON.stringify(step.input, null, 2)}
                      </pre>
                    )}
                    {step.output && (
                      <pre style={{ fontSize: 11, background: 'var(--bg-white)', padding: 6, borderRadius: 4, marginTop: 6, overflowX: 'auto', border: '1px solid var(--border)' }}>
                        Output: {JSON.stringify(step.output, null, 2)}
                      </pre>
                    )}
                    {step.error && (
                      <pre style={{ fontSize: 11, background: '#FEF2F2', padding: 6, borderRadius: 4, marginTop: 6, overflowX: 'auto', color: 'var(--danger)', border: '1px solid #FECACA' }}>
                        Error: {JSON.stringify(step.error, null, 2)}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => { setSelectedExec(null); if (pollRef.current) clearInterval(pollRef.current) }}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteConfirmWf && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: 420 }}>
            <div className="modal-header">
              <h2 className="modal-title">Delete Workflow</h2>
              <button onClick={() => setDeleteConfirmWf(null)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 18 }}>✕</button>
            </div>
            <div className="modal-body">
              <p style={{ margin: 0, lineHeight: 1.6 }}>
                Are you sure you want to delete <strong>{deleteConfirmWf.name}</strong>?
              </p>
              <p style={{ margin: '12px 0 0', fontSize: 13, color: 'var(--text-muted)' }}>
                This will permanently remove the workflow and all its execution history. This action cannot be undone.
              </p>
            </div>
            <div className="modal-footer" style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => setDeleteConfirmWf(null)} disabled={deleting}>Cancel</button>
              <button className="btn btn-danger" onClick={confirmDeleteWorkflow} disabled={deleting}>
                {deleting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
