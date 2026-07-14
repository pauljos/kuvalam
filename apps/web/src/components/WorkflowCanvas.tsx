'use client'
/**
 * WorkflowCanvas — DataStage-style drag-and-drop workflow builder.
 *
 * Data model bridge:
 *   Canvas node  →  workflow step { id, type, input, _ui: { position } }
 *   Canvas edge  →  either step.goto (single default edge) or step.routes[]
 *                   (one or more edges labelled with a `when` condition).
 *
 * The first step in the persisted `steps[]` array is the workflow entry point;
 * we pick it as the node with no incoming edges (the "start" node).
 *
 * UX layout (2026-07 refresh):
 *   ┌────────────────────────────────────────────────────────────────────┐
 *   │  Toolbar: name · trigger · templates · save                        │
 *   ├───────────┬────────────────────────────────────────┬───────────────┤
 *   │  PALETTE  │           REACT-FLOW CANVAS            │   INSPECTOR    │
 *   │ (drag &   │  (grid background, animated edges,     │  (context-     │
 *   │  drop or  │   node hover, minimap, controls)       │   sensitive    │
 *   │  click)   │                                        │   per type)    │
 *   └───────────┴────────────────────────────────────────┴───────────────┘
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow, ReactFlowProvider, Background, Controls, MiniMap,
  addEdge, applyEdgeChanges, applyNodeChanges,
  Handle, Position, MarkerType, BackgroundVariant,
  useReactFlow,
  type Node, type Edge, type Connection, type NodeChange, type EdgeChange, type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import dagre from 'dagre'
import {
  Bot, Users, Globe, ShieldCheck, GitBranch, Trash2, Plus, Save, X,
  Timer, Wand2, Repeat, MessageSquare, Wrench, Settings2,
  Sparkles, FileCode, HelpCircle, Copy, Play, Maximize2,
  Undo2, Redo2, LayoutGrid, Loader2, CheckCircle2, AlertTriangle, RefreshCw,
  Split, FlaskConical,
} from 'lucide-react'

// ── Types ───────────────────────────────────────────────────────────────────
export type StepType =
  | 'AGENT' | 'CREW' | 'HTTP' | 'APPROVAL' | 'CONDITION'
  | 'TOOL' | 'TRANSFORM' | 'DELAY' | 'SET' | 'LOOP' | 'NOTIFY' | 'PARALLEL'

// Retry policy: bounded to prevent runaway backoffs on the server side.
// Mirrors the backend normaliser in workflow.service.js.
export interface RetryPolicy {
  attempts?: number   // 1..5 (1 = no retry, default 1)
  backoffMs?: number  // 0..30000 base delay (linear per attempt)
  jitter?: number     // 0..1 randomness multiplier
}

export interface Step {
  id: string
  type: StepType
  input?: any
  goto?: string | number
  routes?: Array<{ when?: string; goto: string | number }>
  retry?: RetryPolicy
  _ui?: { position: { x: number; y: number } }
}

export interface Agent { id: string; name: string }

export interface WorkflowMeta {
  name: string
  description: string
  trigger: { type: 'MANUAL' | 'SCHEDULE'; cron?: string; enabled?: boolean }
  onFailure: 'STOP' | 'CONTINUE'
}

// Live per-node execution status pulled from WS telemetry
export type NodeStatus = 'idle' | 'running' | 'completed' | 'failed' | 'retrying' | 'awaiting_approval'

interface WorkflowCanvasProps {
  initialSteps: Step[]
  initialMeta: WorkflowMeta
  agents: Agent[]
  onSave: (payload: { steps: Step[]; meta: WorkflowMeta }) => void
  onCancel: () => void
  saving?: boolean
  title?: string
  // Enables the "Test step" button in the inspector (dry-run endpoint).
  tenantId?: string
  // When set, the canvas subscribes to workflow telemetry and colours nodes
  // by live status. Set by the parent right after startWorkflowExecution().
  liveExecId?: string | null
  // If provided, a "Run" button appears in the toolbar. Parent is responsible
  // for starting the execution and (optionally) setting liveExecId.
  onRun?: () => void
}

// ── Visual metadata per step type ──────────────────────────────────────────
// Colours match the sidebar palette (soft green base + accent per category).
// Grouped so the palette can render them under section headings.
type NodeMeta = { label: string; color: string; bg: string; icon: any; group: 'AI' | 'Flow' | 'Data' | 'Integration' | 'Control' }

const NODE_META: Record<StepType, NodeMeta> = {
  AGENT:     { label: 'Agent',     color: '#3f8a43', bg: '#edf7ee', icon: Bot,          group: 'AI' },
  CREW:      { label: 'Crew',      color: '#256329', bg: '#dcefdd', icon: Users,        group: 'AI' },
  LOOP:      { label: 'Loop',      color: '#0f766e', bg: '#ccfbf1', icon: Repeat,       group: 'AI' },
  CONDITION: { label: 'Condition', color: '#9333ea', bg: '#f3e8ff', icon: GitBranch,    group: 'Flow' },
  APPROVAL:  { label: 'Approval',  color: '#c89000', bg: '#fef3c7', icon: ShieldCheck,  group: 'Flow' },
  DELAY:     { label: 'Delay',     color: '#7c3aed', bg: '#ede9fe', icon: Timer,        group: 'Flow' },
  PARALLEL:  { label: 'Parallel',  color: '#db2777', bg: '#fce7f3', icon: Split,        group: 'Flow' },
  TRANSFORM: { label: 'Transform', color: '#0369a1', bg: '#e0f2fe', icon: Wand2,        group: 'Data' },
  SET:       { label: 'Set Vars',  color: '#0891b2', bg: '#cffafe', icon: Settings2,    group: 'Data' },
  HTTP:      { label: 'HTTP',      color: '#5b7cd6', bg: '#e9eefc', icon: Globe,        group: 'Integration' },
  TOOL:      { label: 'Tool',      color: '#dc2626', bg: '#fee2e2', icon: Wrench,       group: 'Integration' },
  NOTIFY:    { label: 'Notify',    color: '#e11d48', bg: '#ffe4e6', icon: MessageSquare, group: 'Integration' },
}

const PALETTE_GROUPS: Array<{ title: string; hint: string; group: NodeMeta['group']; types: StepType[] }> = [
  { title: 'AI',          hint: 'Agents & crews',                group: 'AI',          types: ['AGENT', 'CREW', 'LOOP'] },
  { title: 'Flow',        hint: 'Branching · pauses · fan-out',  group: 'Flow',        types: ['CONDITION', 'APPROVAL', 'DELAY', 'PARALLEL'] },
  { title: 'Data',        hint: 'Transform / set variables',     group: 'Data',        types: ['TRANSFORM', 'SET'] },
  { title: 'Integration', hint: 'External APIs & tools',         group: 'Integration', types: ['HTTP', 'TOOL', 'NOTIFY'] },
]

// Node dimensions for dagre auto-layout (must roughly match the rendered card)
const NODE_W = 220
const NODE_H = 84

// ── Templates (starter workflows) ──────────────────────────────────────────
type Template = { id: string; name: string; description: string; icon: any; build: () => Step[] }

const TEMPLATES: Template[] = [
  {
    id: 'blank', name: 'Blank canvas', description: 'Start with an empty board.',
    icon: FileCode,
    build: () => [],
  },
  {
    id: 'agent-notify', name: 'Agent → Slack notification',
    description: 'Run an agent, then post the result to Slack.',
    icon: MessageSquare,
    build: () => [
      { id: 'research', type: 'AGENT', input: { goal: 'Summarise today’s top news in 3 bullets.' }, _ui: { position: { x: 100, y: 160 } } },
      { id: 'notify',   type: 'NOTIFY', input: { channel: '#general', message: '{{research}}' }, _ui: { position: { x: 420, y: 160 } } },
    ],
  },
  {
    id: 'agent-approval-tool', name: 'Agent → Approval → Tool',
    description: 'Human-in-the-loop guard between an agent decision and a tool action.',
    icon: ShieldCheck,
    build: () => [
      { id: 'plan',     type: 'AGENT',    input: { goal: 'Draft an action plan.' }, _ui: { position: { x: 80,  y: 160 } } },
      { id: 'review',   type: 'APPROVAL', input: {},                                 _ui: { position: { x: 380, y: 160 } } },
      { id: 'execute',  type: 'TOOL',     input: { tool: 'slack__post_message', args: { channel: '#ops', text: '{{plan}}' } }, _ui: { position: { x: 700, y: 160 } } },
    ],
  },
  {
    id: 'lookup-branch', name: 'Fetch → Condition → Two paths',
    description: 'HTTP lookup, then branch on the response with a Condition node.',
    icon: GitBranch,
    build: () => [
      { id: 'lookup',   type: 'HTTP',      input: { method: 'GET', url: 'https://api.example.com/status' }, _ui: { position: { x: 80,  y: 160 } } },
      { id: 'check',    type: 'CONDITION', input: {}, routes: [
          { when: 'context.lookup.ok === true', goto: 'happy' },
          { goto: 'sad' },
        ], _ui: { position: { x: 380, y: 160 } } },
      { id: 'happy',    type: 'NOTIFY',    input: { channel: '#ops', message: 'All good' }, _ui: { position: { x: 700, y: 80  } } },
      { id: 'sad',      type: 'NOTIFY',    input: { channel: '#ops', message: '⚠️ Attention needed' }, _ui: { position: { x: 700, y: 260 } } },
    ],
  },
  {
    id: 'loop-summarise', name: 'Fetch list → Loop summarise → Notify',
    description: 'Fan an agent over every item in a fetched array, then notify.',
    icon: Repeat,
    build: () => [
      { id: 'fetch',    type: 'HTTP', input: { method: 'GET', url: 'https://api.example.com/tickets' }, _ui: { position: { x: 80, y: 160 } } },
      { id: 'each',     type: 'LOOP', input: { itemsFrom: 'fetch.results', agentId: '', goalTemplate: 'Summarise ticket {{item.title}}' }, _ui: { position: { x: 380, y: 160 } } },
      { id: 'notify',   type: 'NOTIFY', input: { channel: '#support', message: '{{each.results}}' }, _ui: { position: { x: 700, y: 160 } } },
    ],
  },
]

// ── Custom node renderer ────────────────────────────────────────────────────
function StepNode({ data, selected }: NodeProps) {
  const type = (data.type as StepType) || 'AGENT'
  const meta = NODE_META[type] || NODE_META.AGENT
  const Icon = meta.icon
  const invalid = Boolean(data.invalid)
  const status: NodeStatus = (data.status as NodeStatus) || 'idle'

  // Live status ring colours (Camunda-cockpit style)
  const statusRingColor =
    status === 'running' ? '#3b82f6' :
    status === 'retrying' ? '#f97316' :
    status === 'completed' ? '#16a34a' :
    status === 'failed' ? '#dc2626' :
    status === 'awaiting_approval' ? '#c89000' :
    null
  const statusPulse = status === 'running' || status === 'retrying' || status === 'awaiting_approval'
  const StatusIcon =
    status === 'running' ? Loader2 :
    status === 'retrying' ? RefreshCw :
    status === 'completed' ? CheckCircle2 :
    status === 'failed' ? AlertTriangle :
    status === 'awaiting_approval' ? ShieldCheck :
    null

  return (
    <div
      style={{
        background: '#ffffff',
        // Split the border into non-shorthand sides so `borderLeft` (the
        // coloured type stripe below) doesn't collide with a `border`
        // shorthand — React 19 warns about that combo.
        borderTopWidth: 1.5,
        borderRightWidth: 1.5,
        borderBottomWidth: 1.5,
        borderTopStyle: 'solid',
        borderRightStyle: 'solid',
        borderBottomStyle: 'solid',
        borderTopColor: invalid ? '#dc2626' : selected ? meta.color : '#e5e7eb',
        borderRightColor: invalid ? '#dc2626' : selected ? meta.color : '#e5e7eb',
        borderBottomColor: invalid ? '#dc2626' : selected ? meta.color : '#e5e7eb',
        borderLeft: `4px solid ${meta.color}`,
        borderRadius: 10,
        padding: '10px 14px',
        minWidth: 200,
        maxWidth: 240,
        boxShadow: statusRingColor
          ? `0 0 0 3px ${statusRingColor}55, 0 4px 12px rgba(0,0,0,0.10)`
          : selected
            ? `0 0 0 3px ${meta.color}22, 0 4px 12px rgba(0,0,0,0.08)`
            : '0 1px 3px rgba(0,0,0,0.06)',
        fontFamily: 'inherit',
        transition: 'box-shadow 120ms ease, border-color 120ms ease, transform 120ms ease',
        transform: selected ? 'translateY(-1px)' : undefined,
        cursor: 'pointer',
        position: 'relative',
      }}
      title={invalid ? String(data.invalidReason || 'Missing configuration') : String(data.subtitle || '')}
    >
      <Handle
        type="target"
        position={Position.Left}
        style={{ background: meta.color, width: 10, height: 10, border: '2px solid #fff', boxShadow: '0 0 0 1px ' + meta.color }}
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <span
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 22, height: 22, borderRadius: 6, background: meta.bg
          }}
        >
          <Icon size={13} color={meta.color} />
        </span>
        <span
          style={{
            fontSize: 10, fontWeight: 700, letterSpacing: 0.5, color: meta.color, textTransform: 'uppercase'
          }}
        >
          {meta.label}
        </span>
        {Boolean(data.isStart) && (
          <span
            style={{
              marginLeft: 'auto', fontSize: 9, background: '#111827', color: '#fff',
              padding: '2px 6px', borderRadius: 3, fontWeight: 700, letterSpacing: 0.5
            }}
          >
            START
          </span>
        )}
        {StatusIcon && (
          <span
            style={{
              marginLeft: data.isStart ? 4 : 'auto',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 18, height: 18, borderRadius: 999,
              background: (statusRingColor || '#9ca3af') + '22',
              color: statusRingColor || '#6b7280',
            }}
            title={String(status).replace('_', ' ')}
          >
            <StatusIcon size={11} style={statusPulse ? { animation: 'kv-spin 1.4s linear infinite' } : undefined} />
          </span>
        )}
        {invalid && !StatusIcon && (
          <span
            style={{
              marginLeft: data.isStart ? 4 : 'auto', fontSize: 10, color: '#dc2626', fontWeight: 700
            }}
            title={String((data.invalidReason as string | undefined) || '')}
          >
            !
          </span>
        )}
      </div>

      <div
        style={{
          fontSize: 13, fontWeight: 600, color: '#111827', wordBreak: 'break-word', lineHeight: 1.35
        }}
      >
        {String((data.label as string | undefined) || (data.id as string | undefined) || '')}
      </div>

      {Boolean(data.subtitle) && (
        <div
          style={{
            fontSize: 11, color: '#6b7280', marginTop: 4, lineHeight: 1.4,
            overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical'
          }}
        >
          {String(data.subtitle)}
        </div>
      )}

      {Boolean(data.retryBadge) && (
        <span
          style={{
            position: 'absolute', bottom: 6, right: 8, fontSize: 9, fontWeight: 700,
            color: '#7c2d12', background: '#fed7aa', padding: '1px 5px', borderRadius: 3,
            letterSpacing: 0.3, textTransform: 'uppercase',
          }}
          title="Retry policy configured"
        >
          x{String(data.retryBadge)}
        </span>
      )}

      <Handle
        type="source"
        position={Position.Right}
        style={{ background: meta.color, width: 10, height: 10, border: '2px solid #fff', boxShadow: '0 0 0 1px ' + meta.color }}
      />
    </div>
  )
}

const nodeTypes = { step: StepNode }

// ── Conversion: canvas ↔ persisted steps ────────────────────────────────────
function stepsToGraph(steps: Step[]): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = steps.map((s, i) => ({
    id: s.id,
    type: 'step',
    position: s._ui?.position || { x: 80 + i * 260, y: 120 },
    data: {
      id: s.id,
      type: s.type,
      label: s.id,
      subtitle: subtitleFor(s),
      input: s.input || {},
      isStart: i === 0,
      invalid: !isStepValid(s),
      invalidReason: invalidReason(s),
    },
  }))

  const edges: Edge[] = []
  const stepIds = new Set(steps.map(s => s.id))

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]
    const meta = NODE_META[s.type] || NODE_META.AGENT

    if (Array.isArray(s.routes) && s.routes.length > 0) {
      s.routes.forEach((r, ri) => {
        const target = typeof r.goto === 'number' ? steps[r.goto]?.id : r.goto
        if (!target || target === 'END' || !stepIds.has(target)) return
        edges.push(makeEdge({ id: `${s.id}-r${ri}-${target}`, source: s.id, target, when: r.when || null, color: meta.color }))
      })
      continue
    }

    let target: string | undefined
    if (s.goto !== undefined) {
      target = typeof s.goto === 'number' ? steps[s.goto]?.id : (s.goto === 'END' ? undefined : s.goto)
    } else {
      target = steps[i + 1]?.id
    }
    if (!target || !stepIds.has(target)) continue
    edges.push(makeEdge({ id: `${s.id}-${target}`, source: s.id, target, when: null, color: meta.color }))
  }

  return { nodes, edges }
}

function makeEdge({ id, source, target, when, color }: { id: string; source: string; target: string; when: string | null; color: string }): Edge {
  return {
    id, source, target,
    type: 'smoothstep',
    animated: true,
    label: when || undefined,
    labelBgPadding: [6, 3] as [number, number],
    labelBgStyle: { fill: '#fff', fillOpacity: 0.95 },
    labelBgBorderRadius: 4,
    labelStyle: { fontSize: 10, fontWeight: 700, fill: when ? color : '#6b7280' },
    style: { stroke: when ? color : '#9ca3af', strokeWidth: 1.75, strokeDasharray: when ? undefined : '5 4' },
    markerEnd: { type: MarkerType.ArrowClosed, color: when ? color : '#9ca3af', width: 18, height: 18 },
    data: { when },
  }
}

function graphToSteps(nodes: Node[], edges: Edge[]): Step[] {
  const incoming = new Set(edges.map(e => e.target))
  const startCandidates = nodes.filter(n => !incoming.has(n.id))
  const startNode = startCandidates[0] || nodes[0]
  if (!startNode) return []

  const visited = new Set<string>()
  const ordered: Node[] = []
  const outEdges = new Map<string, Edge[]>()
  for (const e of edges) {
    if (!outEdges.has(e.source)) outEdges.set(e.source, [])
    outEdges.get(e.source)!.push(e)
  }
  function dfs(id: string) {
    if (visited.has(id)) return
    visited.add(id)
    const node = nodes.find(n => n.id === id)
    if (node) ordered.push(node)
    for (const e of outEdges.get(id) || []) dfs(e.target)
  }
  dfs(startNode.id)
  for (const n of nodes) if (!visited.has(n.id)) ordered.push(n)

  return ordered.map(n => {
    const outs = edges.filter(e => e.source === n.id)
    const conditional = outs.filter(e => (e.data as any)?.when)
    const defaults = outs.filter(e => !(e.data as any)?.when)

    const step: Step = {
      id: n.id,
      type: n.data.type as StepType,
      input: (n.data as any).input || {},
      _ui: { position: n.position },
    }
    const retry = (n.data as any).retry as RetryPolicy | null | undefined
    if (retry && (retry.attempts || retry.backoffMs || retry.jitter)) step.retry = retry

    if (conditional.length > 0) {
      step.routes = [
        ...conditional.map(e => ({ when: (e.data as any).when, goto: e.target })),
        ...(defaults[0] ? [{ goto: defaults[0].target }] : [{ goto: 'END' as const }]),
      ]
    } else if (defaults.length === 1) {
      step.goto = defaults[0].target
    } else if (defaults.length === 0) {
      step.goto = 'END'
    } else {
      step.goto = defaults[0].target
    }
    return step
  })
}

function subtitleFor(step: Step): string {
  const i = step.input || {}
  switch (step.type) {
    case 'AGENT':     return i.goal ? (String(i.goal).length > 60 ? String(i.goal).slice(0, 60) + '…' : String(i.goal)) : (i.agentId ? 'agent set · no goal' : 'no agent selected')
    case 'CREW':      return `${i.mode || 'sequential'} · ${(i.agents || []).length} member${(i.agents || []).length === 1 ? '' : 's'}`
    case 'HTTP':      return `${i.method || 'POST'} ${i.url || 'no url'}`
    case 'APPROVAL':  return 'human gate (24h deadline)'
    case 'CONDITION': return 'routing decision'
    case 'TOOL':      return i.tool ? String(i.tool) : 'pick a connector tool'
    case 'TRANSFORM': return 'shape context data'
    case 'DELAY':     return `wait ${i.seconds ? i.seconds + 's' : ((i.ms || 1000) + 'ms')}`
    case 'SET':       { const keys = Object.keys(i.vars || {}); return keys.length ? keys.join(', ') : 'no vars set' }
    case 'LOOP':      return `foreach ${i.itemsFrom || '?'}${i.agentId ? ' · agent set' : ' · no agent'}`
    case 'NOTIFY':    return `${i.channel || '#no-channel'} · ${(i.message || '').slice(0, 40)}`
    case 'PARALLEL':  return `fan-out · ${(i.tasks || []).length} task${(i.tasks || []).length === 1 ? '' : 's'}`
    default:          return ''
  }
}

function isStepValid(step: Step): boolean {
  return invalidReason(step) === null
}

function invalidReason(step: Step): string | null {
  const i = step.input || {}
  switch (step.type) {
    case 'AGENT':     return i.agentId ? null : 'Select an agent'
    case 'CREW':      return (i.agents || []).length > 0 ? null : 'Add crew members'
    case 'HTTP':      return i.url ? null : 'Enter a URL'
    case 'TOOL':      return i.tool ? null : 'Pick a tool name'
    case 'LOOP':      return i.agentId && i.itemsFrom ? null : 'Set itemsFrom + agent'
    case 'NOTIFY':    return i.channel && i.message ? null : 'Set channel + message'
    case 'SET':       return Object.keys(i.vars || {}).length > 0 ? null : 'Define at least one var'
    case 'TRANSFORM': return i.template ? null : 'Provide a template'
    case 'PARALLEL': {
      const tasks = i.tasks
      if (!Array.isArray(tasks) || tasks.length === 0) return 'Add at least one sub-task'
      if (tasks.length > 10) return 'Max 10 sub-tasks'
      if (tasks.some((t: any) => t?.type === 'PARALLEL')) return 'Nested PARALLEL not allowed'
      if (tasks.some((t: any) => t?.type === 'APPROVAL')) return 'APPROVAL not allowed in PARALLEL'
      return null
    }
    case 'APPROVAL':
    case 'CONDITION':
    case 'DELAY':
    default:          return null
  }
}

// ── Auto-layout with dagre ──────────────────────────────────────────────────
// Produces a tidy left-to-right layout like DataStage / Airflow Gantt. Nodes
// keep their identity; only positions are mutated. Edge routing is left to
// React Flow's smoothstep type.
function autoLayout(nodes: Node[], edges: Edge[]): Node[] {
  if (nodes.length === 0) return nodes
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 80, marginx: 20, marginy: 20 })
  g.setDefaultEdgeLabel(() => ({}))
  for (const n of nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H })
  for (const e of edges) g.setEdge(e.source, e.target)
  dagre.layout(g)
  return nodes.map(n => {
    const pos = g.node(n.id)
    if (!pos) return n
    // dagre gives centre coordinates; React Flow expects top-left.
    return { ...n, position: { x: Math.round(pos.x - NODE_W / 2), y: Math.round(pos.y - NODE_H / 2) } }
  })
}

// ── Live execution telemetry hook ───────────────────────────────────────────
// Subscribes to the tenant-scoped WebSocket, filters to workflow.* events for
// the current execId, and returns a map of stepId -> NodeStatus. Falls back to
// polling `getWorkflowExecution` if WS is unavailable (dev without proxy, etc).
function useLiveExecStatus(
  tenantId: string | undefined,
  execId: string | null | undefined,
): Record<string, NodeStatus> {
  const [statusMap, setStatusMap] = useState<Record<string, NodeStatus>>({})
  const pollRef = useRef<any>(null)

  useEffect(() => {
    setStatusMap({})
    if (!execId || !tenantId) return
    const apiBase = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1').replace('/api/v1', '')
    const wsUrl = `${apiBase.replace(/^http/, 'ws')}/ws/tenants/${tenantId}/telemetry`
    let ws: WebSocket | null = null
    let cancelled = false

    const startPolling = () => {
      if (pollRef.current) clearInterval(pollRef.current)
      pollRef.current = setInterval(async () => {
        try {
          const trace: any = await import('@/lib/api').then(m => m.api.getWorkflowExecution(tenantId, execId))
          if (cancelled) return
          const map: Record<string, NodeStatus> = {}
          for (const s of trace?.steps || []) {
            const key = s.step_id
            const st = String(s.status || '').toUpperCase()
            map[key] =
              st === 'RUNNING' ? 'running' :
              st === 'COMPLETED' ? 'completed' :
              st === 'FAILED' ? 'failed' :
              st === 'PENDING' ? 'awaiting_approval' :
              'idle'
          }
          setStatusMap(map)
          if (['COMPLETED', 'FAILED'].includes(String(trace?.status).toUpperCase())) {
            clearInterval(pollRef.current)
            pollRef.current = null
          }
        } catch {
          /* ignore */
        }
      }, 1500)
    }

    try {
      ws = new WebSocket(wsUrl)
      ws.onmessage = (ev) => {
        let msg: any
        try { msg = JSON.parse(ev.data) } catch { return }
        const { eventType, payload } = msg
        if (!payload || payload.execId !== execId) return
        const stepId = payload.stepId
        if (!stepId) return
        setStatusMap(prev => {
          if (eventType === 'workflow.step_started') return { ...prev, [stepId]: 'running' }
          if (eventType === 'workflow.step_retrying') return { ...prev, [stepId]: 'retrying' }
          if (eventType === 'workflow.step_completed') return { ...prev, [stepId]: 'completed' }
          if (eventType === 'workflow.step_failed') return { ...prev, [stepId]: 'failed' }
          if (eventType === 'workflow.awaiting_approval') return { ...prev, [stepId]: 'awaiting_approval' }
          return prev
        })
      }
      ws.onerror = () => { startPolling() }
    } catch {
      startPolling()
    }

    return () => {
      cancelled = true
      if (ws && ws.readyState !== WebSocket.CLOSED) ws.close()
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    }
  }, [tenantId, execId])

  return statusMap
}

// ── Main component ──────────────────────────────────────────────────────────
export default function WorkflowCanvas(props: WorkflowCanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  )
}

function CanvasInner({ initialSteps, initialMeta, agents, onSave, onCancel, saving, title, tenantId, liveExecId, onRun }: WorkflowCanvasProps) {
  const initial = useMemo(() => stepsToGraph(initialSteps), [initialSteps])
  const [nodes, setNodes] = useState<Node[]>(initial.nodes)
  const [edges, setEdges] = useState<Edge[]>(initial.edges)
  const [meta, setMeta] = useState<WorkflowMeta>(initialMeta)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [pendingEdge, setPendingEdge] = useState<{ id: string; source: string; target: string } | null>(null)
  const [showDetails, setShowDetails] = useState(false)
  const [showTemplates, setShowTemplates] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(true)
  const [testStepFor, setTestStepFor] = useState<string | null>(null) // node id to dry-run
  const idCounter = useRef(Math.max(initialSteps.length, 0) + 1)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const reactFlow = useReactFlow()

  // ── History (undo/redo) ────────────────────────────────────────────────
  // Snapshot { nodes, edges } on structural changes. Position drags coalesce
  // so a drag doesn't create dozens of history entries.
  const historyRef = useRef<Array<{ nodes: Node[]; edges: Edge[] }>>([{ nodes: initial.nodes, edges: initial.edges }])
  const historyIdxRef = useRef(0)
  const suppressPushRef = useRef(false)
  const pushHistory = useCallback((ns: Node[], es: Edge[]) => {
    if (suppressPushRef.current) return
    const trimmed = historyRef.current.slice(0, historyIdxRef.current + 1)
    trimmed.push({ nodes: ns, edges: es })
    // Cap to last 50 to avoid unbounded memory growth on long editing sessions.
    if (trimmed.length > 50) trimmed.shift()
    historyRef.current = trimmed
    historyIdxRef.current = trimmed.length - 1
  }, [])
  const canUndo = historyIdxRef.current > 0
  const canRedo = historyIdxRef.current < historyRef.current.length - 1
  const undo = useCallback(() => {
    if (historyIdxRef.current === 0) return
    historyIdxRef.current -= 1
    const snap = historyRef.current[historyIdxRef.current]
    suppressPushRef.current = true
    setNodes(snap.nodes); setEdges(snap.edges)
    setTimeout(() => { suppressPushRef.current = false }, 0)
  }, [])
  const redo = useCallback(() => {
    if (historyIdxRef.current >= historyRef.current.length - 1) return
    historyIdxRef.current += 1
    const snap = historyRef.current[historyIdxRef.current]
    suppressPushRef.current = true
    setNodes(snap.nodes); setEdges(snap.edges)
    setTimeout(() => { suppressPushRef.current = false }, 0)
  }, [])

  // ── Live execution status overlay ──────────────────────────────────────
  const statusMap = useLiveExecStatus(tenantId, liveExecId)

  // Merge status into node data so StepNode can render the halo/icon.
  useEffect(() => {
    setNodes(ns => ns.map(n => {
      const status = statusMap[n.id] || 'idle'
      if ((n.data as any).status === status) return n
      return { ...n, data: { ...(n.data as any), status } }
    }))
    // Never push status-only changes to history.
  }, [statusMap])

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes(ns => {
      const next = applyNodeChanges(changes, ns)
      // Push to history when a drag *ends* (position change with dragging: false)
      // or when nodes are added/removed. Skip 'select' and mid-drag updates.
      const structural = changes.some(c =>
        c.type === 'remove' ||
        c.type === 'add' ||
        (c.type === 'position' && (c as any).dragging === false)
      )
      if (structural) pushHistory(next, edges)
      return next
    })
  }, [edges, pushHistory])

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges(es => {
      const next = applyEdgeChanges(changes, es)
      const structural = changes.some(c => c.type === 'remove' || c.type === 'add')
      if (structural) pushHistory(nodes, next)
      return next
    })
  }, [nodes, pushHistory])

  const onConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target || c.source === c.target) return
    const existing = edges.filter(e => e.source === c.source)
    const srcType = (nodes.find(n => n.id === c.source)?.data as any)?.type as StepType
    const color = (NODE_META[srcType] || NODE_META.AGENT).color
    const newEdge = makeEdge({
      id: `${c.source}-${c.target}-${Date.now()}`,
      source: c.source, target: c.target, when: null, color
    })
    setEdges(es => {
      const next = addEdge(newEdge, es)
      pushHistory(nodes, next)
      return next
    })
    if (existing.length > 0) setPendingEdge({ id: newEdge.id, source: c.source, target: c.target })
  }, [edges, nodes, pushHistory])

  // Compute the next unique id for a given step type (agent_1, agent_2, …)
  function nextIdFor(type: StepType): string {
    const base = type.toLowerCase()
    const existing = new Set(nodes.map(n => n.id))
    let n = 1
    while (existing.has(`${base}_${n}`)) n++
    idCounter.current = Math.max(idCounter.current, n + 1)
    return `${base}_${n}`
  }

  function addStep(type: StepType, position?: { x: number; y: number }) {
    const id = nextIdFor(type)
    const pos = position || { x: 120 + Math.random() * 260, y: 120 + Math.random() * 180 }
    const newNode: Node = {
      id,
      type: 'step',
      position: pos,
      data: {
        id, type, label: id,
        subtitle: subtitleFor({ id, type, input: {} }),
        input: {},
        retry: null,
        retryBadge: null,
        isStart: nodes.length === 0,
        invalid: !isStepValid({ id, type, input: {} }),
        invalidReason: invalidReason({ id, type, input: {} }),
        status: 'idle',
      },
    }
    setNodes(ns => {
      const next = [...ns, newNode]
      pushHistory(next, edges)
      return next
    })
    setSelectedId(id)
  }

  function loadTemplate(t: Template) {
    const steps = t.build()
    const graph = stepsToGraph(steps)
    setNodes(graph.nodes)
    setEdges(graph.edges)
    pushHistory(graph.nodes, graph.edges)
    setSelectedId(null)
    setShowTemplates(false)
    // Fit view after DOM update
    setTimeout(() => reactFlow.fitView({ padding: 0.25 }), 60)
  }

  function deleteSelected() {
    if (!selectedId) return
    setNodes(ns => {
      const next = ns.filter(n => n.id !== selectedId)
      const nextEdges = edges.filter(e => e.source !== selectedId && e.target !== selectedId)
      setEdges(nextEdges)
      pushHistory(next, nextEdges)
      return next
    })
    setSelectedId(null)
  }

  function duplicateSelected() {
    if (!selectedId) return
    const src = nodes.find(n => n.id === selectedId)
    if (!src) return
    const type = (src.data as any).type as StepType
    const id = nextIdFor(type)
    const copy: Node = {
      ...src,
      id,
      position: { x: src.position.x + 40, y: src.position.y + 40 },
      data: { ...src.data, id, label: id, isStart: false, status: 'idle' },
      selected: false,
    }
    setNodes(ns => {
      const next = [...ns, copy]
      pushHistory(next, edges)
      return next
    })
    setSelectedId(id)
  }

  function updateNodeData(id: string, patch: Partial<{ id: string; input: any; retry: RetryPolicy | null }>) {
    let didStructuralChange = false
    setNodes(ns => ns.map(n => {
      if (n.id !== id) return n
      const nextInput = patch.input !== undefined ? patch.input : (n.data as any).input
      const nextId = patch.id ?? n.id
      const nextRetry: RetryPolicy | null = patch.retry !== undefined ? patch.retry : ((n.data as any).retry ?? null)
      const stepForSub: Step = { id: nextId, type: (n.data as any).type, input: nextInput, retry: nextRetry || undefined }
      const nextData = {
        ...(n.data as any),
        input: nextInput,
        subtitle: subtitleFor(stepForSub),
        id: nextId,
        label: nextId,
        retry: nextRetry,
        retryBadge: nextRetry?.attempts && nextRetry.attempts > 1 ? nextRetry.attempts : null,
        invalid: !isStepValid(stepForSub),
        invalidReason: invalidReason(stepForSub),
      }
      didStructuralChange = true
      return { ...n, id: nextId, data: nextData }
    }))
    if (patch.id && patch.id !== id) {
      setEdges(es => es.map(e => ({
        ...e,
        source: e.source === id ? patch.id! : e.source,
        target: e.target === id ? patch.id! : e.target,
      })))
      setSelectedId(patch.id)
    }
    // Push history after all state updates settle (avoid capturing stale nodes)
    if (didStructuralChange) {
      setTimeout(() => pushHistory(nodesRef.current, edgesRef.current), 0)
    }
  }

  function applyPendingCondition(when: string) {
    if (!pendingEdge) return
    setEdges(es => es.map(e => {
      if (e.id !== pendingEdge.id) return e
      const srcType = (nodes.find(n => n.id === e.source)?.data as any)?.type as StepType
      const color = (NODE_META[srcType] || NODE_META.AGENT).color
      return makeEdge({ id: e.id, source: e.source, target: e.target, when: when || null, color })
    }))
    setPendingEdge(null)
  }

  // Keep `isStart` badge in sync with the current graph topology
  useEffect(() => {
    const incoming = new Set(edges.map(e => e.target))
    setNodes(ns => {
      const first = ns.find(m => !incoming.has(m.id))
      let changed = false
      const next = ns.map(n => {
        const shouldBeStart = first?.id === n.id
        const isStart = (n.data as any).isStart
        if (isStart === shouldBeStart) return n
        changed = true
        return { ...n, data: { ...(n.data as any), isStart: shouldBeStart } }
      })
      return changed ? next : ns
    })
  }, [edges])

  // Keyboard shortcuts
  // Live refs to always give useEffect / setTimeout callbacks the LATEST arrays
  // (React state closures capture stale values in async paths like history push).
  const nodesRef = useRef(nodes)
  const edgesRef = useRef(edges)
  useEffect(() => { nodesRef.current = nodes }, [nodes])
  useEffect(() => { edgesRef.current = edges }, [edges])

  // Auto-layout the current graph with dagre.
  const handleAutoLayout = useCallback(() => {
    const laid = autoLayout(nodes, edges)
    setNodes(laid)
    pushHistory(laid, edges)
    setTimeout(() => reactFlow.fitView({ padding: 0.2, duration: 300 }), 60)
  }, [nodes, edges, reactFlow, pushHistory])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      const inField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target as HTMLElement)?.isContentEditable
      if (inField) return
      const mod = e.metaKey || e.ctrlKey
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        deleteSelected(); e.preventDefault()
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === 'z') {
        undo(); e.preventDefault()
      } else if (mod && (e.key === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
        redo(); e.preventDefault()
      } else if (mod && e.key.toLowerCase() === 'd' && selectedId) {
        duplicateSelected(); e.preventDefault()
      } else if (mod && e.key.toLowerCase() === 's') {
        handleSave(); e.preventDefault()
      } else if (mod && e.key.toLowerCase() === 'l') {
        handleAutoLayout(); e.preventDefault()
      } else if (e.key === 'Escape' && selectedId) {
        setSelectedId(null)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, nodes, edges, meta, handleAutoLayout, undo, redo])

  // Drag-and-drop from the palette
  function onPaletteDragStart(e: React.DragEvent, type: StepType) {
    e.dataTransfer.setData('application/kuvalam-step', type)
    e.dataTransfer.effectAllowed = 'move'
  }
  function onCanvasDragOver(e: React.DragEvent) {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }
  function onCanvasDrop(e: React.DragEvent) {
    e.preventDefault()
    const type = e.dataTransfer.getData('application/kuvalam-step') as StepType
    if (!type || !NODE_META[type]) return
    const bounds = wrapperRef.current?.getBoundingClientRect()
    if (!bounds) return
    const position = reactFlow.screenToFlowPosition({
      x: e.clientX,
      y: e.clientY,
    })
    addStep(type, position)
  }

  const selectedNode = nodes.find(n => n.id === selectedId) || null
  const invalidCount = nodes.filter(n => (n.data as any).invalid).length

  function handleSave() {
    if (nodes.length === 0) return
    if (!meta.name.trim()) { setShowDetails(true); return }
    const steps = graphToSteps(nodes, edges)
    onSave({ steps, meta })
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#f5f9f6', display: 'flex', flexDirection: 'column', zIndex: 1000 }}>
      {/* ── Toolbar ─────────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px',
        borderBottom: '1px solid var(--border)', background: 'var(--bg-white)',
        boxShadow: '0 1px 3px rgba(0,0,0,0.03)'
      }}>
        <strong style={{ fontSize: 15, color: 'var(--text)' }}>{title || 'Workflow Canvas'}</strong>

        <button
          type="button"
          onClick={() => setShowDetails(v => !v)}
          style={{
            marginLeft: 12, padding: '5px 12px', borderRadius: 6,
            border: '1px solid var(--border)',
            background: meta.name ? 'var(--bg-white)' : '#fef3c7',
            fontSize: 12, cursor: 'pointer', color: 'var(--text)',
            display: 'inline-flex', alignItems: 'center', gap: 6,
          }}
          title="Workflow name, description, trigger"
        >
          {meta.name || 'Untitled workflow'} · {meta.trigger?.type === 'SCHEDULE' ? `cron ${meta.trigger.cron || ''}` : 'manual'} ▾
        </button>

        <button
          type="button"
          onClick={() => setShowTemplates(true)}
          style={{
            padding: '5px 10px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
            border: '1px solid var(--border)', background: 'var(--bg-white)', color: 'var(--text)',
            display: 'inline-flex', alignItems: 'center', gap: 6,
          }}
          title="Start from a template"
        >
          <Sparkles size={13} /> Templates
        </button>

        <button
          type="button"
          onClick={() => setShowHelp(v => !v)}
          style={{
            padding: '5px 10px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
            border: '1px solid var(--border)', background: 'var(--bg-white)', color: 'var(--text)',
            display: 'inline-flex', alignItems: 'center', gap: 6,
          }}
        >
          <HelpCircle size={13} /> Shortcuts
        </button>

        {/* Undo / Redo / Auto-layout */}
        <div style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden', background: 'var(--bg-white)' }}>
          <IconToolbarButton onClick={undo} disabled={!canUndo} title="Undo (⌘Z)"><Undo2 size={13} /></IconToolbarButton>
          <IconToolbarButton onClick={redo} disabled={!canRedo} title="Redo (⌘⇧Z)"><Redo2 size={13} /></IconToolbarButton>
          <IconToolbarButton onClick={handleAutoLayout} disabled={nodes.length === 0} title="Auto-layout (⌘L)"><LayoutGrid size={13} /></IconToolbarButton>
        </div>

        {invalidCount > 0 && (
          <span
            style={{
              marginLeft: 8, fontSize: 11, color: '#b45309', background: '#fef3c7',
              padding: '3px 8px', borderRadius: 999, fontWeight: 600
            }}
            title="Some steps still need configuration"
          >
            {invalidCount} step{invalidCount === 1 ? '' : 's'} need configuration
          </span>
        )}

        {liveExecId && (
          <span
            style={{
              marginLeft: 8, fontSize: 11, color: '#1e40af', background: '#dbeafe',
              padding: '3px 8px', borderRadius: 999, fontWeight: 600,
              display: 'inline-flex', alignItems: 'center', gap: 4,
            }}
            title={`Live-tracking execution ${liveExecId}`}
          >
            <span style={{ width: 6, height: 6, borderRadius: 999, background: '#2563eb', animation: 'kv-pulse 1.4s ease-in-out infinite' }} />
            Live
          </span>
        )}

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {nodes.length} step{nodes.length === 1 ? '' : 's'} · {edges.length} edge{edges.length === 1 ? '' : 's'}
          </span>
          <button className="btn btn-secondary btn-sm" onClick={onCancel} type="button">
            <X size={13} style={{ marginRight: 4, verticalAlign: 'middle' }} /> Cancel
          </button>
          {onRun && (
            <button
              className="btn btn-secondary btn-sm"
              type="button"
              onClick={onRun}
              disabled={nodes.length === 0 || invalidCount > 0}
              title={invalidCount > 0 ? 'Fix invalid steps first' : 'Run this workflow'}
            >
              <Play size={13} style={{ marginRight: 4, verticalAlign: 'middle' }} /> Run
            </button>
          )}
          <button
            className="btn btn-primary btn-sm"
            onClick={handleSave}
            type="button"
            disabled={saving || nodes.length === 0}
            title={nodes.length === 0 ? 'Add a step first' : 'Save (⌘S)'}
          >
            <Save size={13} style={{ marginRight: 4, verticalAlign: 'middle' }} /> {saving ? 'Saving…' : 'Save & Publish'}
          </button>
        </div>
      </div>

      {/* Global CSS keyframes for spinner + pulse */}
      <style dangerouslySetInnerHTML={{ __html: `@keyframes kv-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } } @keyframes kv-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }` }} />

      {/* Details popover */}
      {showDetails && (
        <MetaEditor meta={meta} setMeta={setMeta} onClose={() => setShowDetails(false)} />
      )}
      {showTemplates && (
        <TemplateGallery onPick={loadTemplate} onClose={() => setShowTemplates(false)} />
      )}
      {showHelp && (
        <ShortcutsHelp onClose={() => setShowHelp(false)} />
      )}

      {/* ── Body: palette + canvas + inspector ──────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Left palette */}
        <Palette
          open={paletteOpen}
          onToggle={() => setPaletteOpen(v => !v)}
          onAdd={(t) => addStep(t)}
          onDragStart={onPaletteDragStart}
        />

        {/* Canvas */}
        <div
          ref={wrapperRef}
          style={{ flex: 1, position: 'relative', background: '#f5f9f6' }}
          onDragOver={onCanvasDragOver}
          onDrop={onCanvasDrop}
        >
          {nodes.length === 0 && (
            <EmptyState onPickTemplate={() => setShowTemplates(true)} onAdd={(t) => addStep(t)} />
          )}
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, n) => setSelectedId(n.id)}
            onPaneClick={() => setSelectedId(null)}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.25 }}
            defaultEdgeOptions={{ type: 'smoothstep', animated: true }}
            proOptions={{ hideAttribution: true }}
            connectionLineStyle={{ stroke: '#6b7280', strokeWidth: 2, strokeDasharray: '5 3' }}
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1.2} color="#c9ddc9" />
            <Controls
              showInteractive={false}
              style={{ background: '#fff', border: '1px solid var(--border)', borderRadius: 6, boxShadow: '0 2px 6px rgba(0,0,0,0.08)' }}
            />
            <MiniMap
              nodeColor={n => NODE_META[(n.data as any)?.type as StepType]?.color || '#94a3b8'}
              nodeStrokeWidth={2}
              maskColor="rgba(245,249,246,0.75)"
              pannable zoomable
              style={{ background: '#fff', border: '1px solid var(--border)', borderRadius: 6 }}
            />
          </ReactFlow>
        </div>

        {/* Inspector panel */}
        {selectedNode ? (
          <NodeInspector
            key={selectedNode.id}
            node={selectedNode}
            agents={agents}
            allStepIds={nodes.map(n => n.id).filter(id => id !== selectedNode.id)}
            onChange={(patch) => updateNodeData(selectedNode.id, patch)}
            onDelete={deleteSelected}
            onDuplicate={duplicateSelected}
            onTest={tenantId ? () => setTestStepFor(selectedNode.id) : undefined}
          />
        ) : (
          <InspectorHelp />
        )}
      </div>

      {/* Condition prompt modal */}
      {pendingEdge && (
        <ConditionPrompt
          onSave={applyPendingCondition}
          onSkip={() => setPendingEdge(null)}
        />
      )}

      {/* Test single-step modal */}
      {testStepFor && tenantId && (() => {
        const n = nodes.find(nn => nn.id === testStepFor)
        if (!n) return null
        const d = n.data as any
        const step: Step = { id: d.id, type: d.type, input: d.input, retry: d.retry }
        return (
          <TestStepModal
            tenantId={tenantId}
            step={step}
            onClose={() => setTestStepFor(null)}
          />
        )
      })()}
    </div>
  )
}

// ── Palette ────────────────────────────────────────────────────────────────

// Small icon-only button used inside the toolbar's Undo/Redo/Layout group.
function IconToolbarButton({ onClick, disabled, title, children }: {
  onClick: () => void; disabled?: boolean; title: string; children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        padding: '5px 8px', background: 'transparent', border: 'none',
        cursor: disabled ? 'not-allowed' : 'pointer',
        color: disabled ? '#cbd5e1' : 'var(--text)',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        borderRight: '1px solid var(--border)',
      }}
    >
      {children}
    </button>
  )
}

function Palette({
  open, onToggle, onAdd, onDragStart,
}: {
  open: boolean
  onToggle: () => void
  onAdd: (t: StepType) => void
  onDragStart: (e: React.DragEvent, t: StepType) => void
}) {
  if (!open) {
    return (
      <button
        onClick={onToggle}
        type="button"
        title="Show palette"
        style={{
          width: 32, background: 'var(--bg-white)', borderRight: '1px solid var(--border)',
          border: 'none', borderTop: 'none', borderBottom: 'none',
          display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: 12,
          cursor: 'pointer', color: 'var(--text-muted)'
        }}
      >
        <Maximize2 size={14} />
      </button>
    )
  }
  return (
    <div
      style={{
        width: 220, borderRight: '1px solid var(--border)', background: 'var(--bg-white)',
        display: 'flex', flexDirection: 'column', overflowY: 'auto'
      }}
    >
      <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <strong style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.6, color: 'var(--text-muted)' }}>Palette</strong>
        <button
          onClick={onToggle}
          type="button"
          title="Collapse palette"
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 2 }}
        >
          <X size={14} />
        </button>
      </div>

      <div style={{ padding: '10px 12px 14px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {PALETTE_GROUPS.map(g => (
          <div key={g.group}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.5, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 6 }}>
              {g.title}
              <span style={{ marginLeft: 6, fontWeight: 500, textTransform: 'none', letterSpacing: 0, opacity: 0.7 }}>· {g.hint}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {g.types.map(t => {
                const meta = NODE_META[t]
                const Icon = meta.icon
                return (
                  <div
                    key={t}
                    draggable
                    onDragStart={(e) => onDragStart(e, t)}
                    onClick={() => onAdd(t)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter') onAdd(t) }}
                    title={`${meta.label} — click to add, or drag onto canvas`}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '7px 9px', borderRadius: 6, cursor: 'grab',
                      border: '1px solid transparent',
                      background: 'transparent',
                      transition: 'background 120ms ease, border-color 120ms ease',
                    }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = meta.bg; (e.currentTarget as HTMLDivElement).style.borderColor = meta.color + '44' }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent'; (e.currentTarget as HTMLDivElement).style.borderColor = 'transparent' }}
                  >
                    <span
                      style={{
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        width: 26, height: 26, borderRadius: 6,
                        background: meta.bg, color: meta.color,
                        borderLeft: `3px solid ${meta.color}`,
                      }}
                    >
                      <Icon size={14} />
                    </span>
                    <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{meta.label}</span>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 'auto', padding: 12, fontSize: 10.5, color: 'var(--text-muted)', borderTop: '1px solid var(--border)', lineHeight: 1.5 }}>
        Drag onto the canvas or click to add. Drag between node handles to connect. First node with no incoming edge is the START.
      </div>
    </div>
  )
}

// ── Empty state ────────────────────────────────────────────────────────────
function EmptyState({ onPickTemplate, onAdd }: { onPickTemplate: () => void; onAdd: (t: StepType) => void }) {
  return (
    <div
      style={{
        position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', pointerEvents: 'none', color: 'var(--text-muted)',
      }}
    >
      <div
        style={{
          pointerEvents: 'auto', textAlign: 'center', padding: 32,
          background: 'rgba(255,255,255,0.85)', border: '1px dashed var(--border-dark, #94a3b8)',
          borderRadius: 12, maxWidth: 480
        }}
      >
        <Sparkles size={28} style={{ color: 'var(--green, #3f8a43)' }} />
        <h3 style={{ marginTop: 12, marginBottom: 4, fontSize: 15, color: 'var(--text)' }}>Build a workflow</h3>
        <p style={{ fontSize: 12, lineHeight: 1.5, marginBottom: 16 }}>
          Drag a block from the palette on the left, or start from a template.
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-primary btn-sm" onClick={onPickTemplate}>
            <Sparkles size={13} style={{ marginRight: 6, verticalAlign: 'middle' }} /> Browse templates
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => onAdd('AGENT')}>
            <Bot size={13} style={{ marginRight: 6, verticalAlign: 'middle' }} /> Add an Agent step
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Inspector default view ─────────────────────────────────────────────────
function InspectorHelp() {
  return (
    <div style={{ width: 320, borderLeft: '1px solid var(--border)', background: 'var(--bg-white)', padding: 22, color: 'var(--text-muted)', fontSize: 13, overflowY: 'auto' }}>
      <p><strong style={{ color: 'var(--text)' }}>Tip</strong></p>
      <p style={{ marginTop: 8, lineHeight: 1.6 }}>
        Click a node to edit it. Drag from a node&apos;s <em>right</em> handle to another node&apos;s <em>left</em> handle to connect them.
      </p>
      <p style={{ marginTop: 10, lineHeight: 1.6 }}>
        Drawing a <strong>second</strong> outgoing edge from a step turns it into a <strong>branch</strong> — you&apos;ll be asked for a routing condition. Leave the condition blank to make it the fallback edge.
      </p>
      <p style={{ marginTop: 10, lineHeight: 1.6 }}>
        Reference earlier outputs anywhere with <code>{'{{step_id.field}}'}</code>.
      </p>
      <hr style={{ margin: '16px 0', border: 'none', borderTop: '1px solid var(--border)' }} />
      <p style={{ fontSize: 12, lineHeight: 1.55 }}>
        <strong style={{ color: 'var(--text)' }}>Try:</strong> add an <em>Agent</em> → <em>Approval</em> → <em>Notify</em> to build a human-in-the-loop broadcast in 3 clicks.
      </p>
    </div>
  )
}

// ── Meta editor (workflow name / trigger) ──────────────────────────────────
function MetaEditor({ meta, setMeta, onClose }: { meta: WorkflowMeta; setMeta: (m: WorkflowMeta) => void; onClose: () => void }) {
  return (
    <div style={{
      position: 'absolute', top: 52, left: 16, zIndex: 1050,
      background: 'var(--bg-white)', border: '1px solid var(--border)', borderRadius: 10,
      padding: 16, width: 440, boxShadow: '0 12px 36px rgba(0,0,0,0.14)',
      display: 'flex', flexDirection: 'column', gap: 10
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <strong style={{ fontSize: 13 }}>Workflow details</strong>
        <button onClick={onClose} type="button" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}>
          <X size={14} />
        </button>
      </div>
      <div className="form-group">
        <label className="form-label">Workflow name *</label>
        <input className="input" value={meta.name} onChange={e => setMeta({ ...meta, name: e.target.value })} placeholder="e.g. Weekly report pipeline" autoFocus />
      </div>
      <div className="form-group">
        <label className="form-label">Description</label>
        <input className="input" value={meta.description} onChange={e => setMeta({ ...meta, description: e.target.value })} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div className="form-group">
          <label className="form-label">Trigger</label>
          <select className="select input" value={meta.trigger.type} onChange={e => {
            const type = e.target.value as 'MANUAL' | 'SCHEDULE'
            setMeta({ ...meta, trigger: type === 'SCHEDULE' ? { type, cron: '*/10 * * * *', enabled: true } : { type } })
          }}>
            <option value="MANUAL">Manual</option>
            <option value="SCHEDULE">Scheduled (cron)</option>
          </select>
        </div>
        {meta.trigger.type === 'SCHEDULE' && (
          <div className="form-group">
            <label className="form-label">Cron</label>
            <input className="input" value={meta.trigger.cron || ''} onChange={e => setMeta({ ...meta, trigger: { ...meta.trigger, cron: e.target.value } })} />
          </div>
        )}
      </div>
      <div className="form-group">
        <label className="form-label">On step failure</label>
        <select className="select input" value={meta.onFailure} onChange={e => setMeta({ ...meta, onFailure: e.target.value as any })}>
          <option value="STOP">Stop execution</option>
          <option value="CONTINUE">Continue with next step</option>
        </select>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button type="button" className="btn btn-primary btn-sm" onClick={onClose}>Done</button>
      </div>
    </div>
  )
}

// ── Template gallery ───────────────────────────────────────────────────────
function TemplateGallery({ onPick, onClose }: { onPick: (t: Template) => void; onClose: () => void }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 1100,
      display: 'flex', alignItems: 'center', justifyContent: 'center'
    }}>
      <div style={{ background: 'var(--bg-white)', borderRadius: 12, padding: 22, width: 720, maxHeight: '80vh', overflowY: 'auto', boxShadow: '0 24px 64px rgba(0,0,0,0.24)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <div>
            <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 2 }}>Start from a template</h3>
            <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>Common workflow patterns you can customise.</p>
          </div>
          <button onClick={onClose} type="button" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}>
            <X size={18} />
          </button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12, marginTop: 14 }}>
          {TEMPLATES.map(t => {
            const Icon = t.icon
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => onPick(t)}
                style={{
                  textAlign: 'left', padding: 14, borderRadius: 10, cursor: 'pointer',
                  border: '1px solid var(--border)', background: 'var(--bg)',
                  display: 'flex', flexDirection: 'column', gap: 6,
                  transition: 'transform 120ms ease, box-shadow 120ms ease, border-color 120ms ease',
                }}
                onMouseEnter={(e) => { const el = e.currentTarget as HTMLButtonElement; el.style.borderColor = 'var(--green, #3f8a43)'; el.style.boxShadow = '0 4px 12px rgba(63,138,67,0.14)'; el.style.transform = 'translateY(-1px)' }}
                onMouseLeave={(e) => { const el = e.currentTarget as HTMLButtonElement; el.style.borderColor = 'var(--border)'; el.style.boxShadow = 'none'; el.style.transform = 'none' }}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ display: 'inline-flex', width: 28, height: 28, borderRadius: 6, background: '#edf7ee', alignItems: 'center', justifyContent: 'center' }}>
                    <Icon size={15} color="#3f8a43" />
                  </span>
                  <strong style={{ fontSize: 13 }}>{t.name}</strong>
                </span>
                <span style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>{t.description}</span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ── Shortcuts help ─────────────────────────────────────────────────────────
function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  const rows: Array<[string, string]> = [
    ['Add step', 'Drag from palette OR click a palette item'],
    ['Connect steps', 'Drag between the coloured handles on nodes'],
    ['Branch (Condition)', 'Draw a 2nd outgoing edge — you\'ll be asked for a rule'],
    ['Delete step', 'Select, then Delete / Backspace'],
    ['Duplicate step', '⌘/Ctrl + D'],
    ['Undo / Redo', '⌘/Ctrl + Z  ·  ⌘/Ctrl + ⇧ + Z (or Ctrl+Y)'],
    ['Auto-layout', '⌘/Ctrl + L'],
    ['Save', '⌘/Ctrl + S'],
    ['Deselect', 'Esc or click empty canvas'],
    ['Reference outputs', '{{step_id.field}} — see chips in the inspector'],
  ]
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: 'var(--bg-white)', borderRadius: 12, padding: 22, width: 480, boxShadow: '0 24px 64px rgba(0,0,0,0.24)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <h3 style={{ fontSize: 15, fontWeight: 700 }}>Canvas shortcuts</h3>
          <button onClick={onClose} type="button" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}>
            <X size={16} />
          </button>
        </div>
        <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k}>
                <td style={{ padding: '6px 0', fontWeight: 600, verticalAlign: 'top', width: 140 }}>{k}</td>
                <td style={{ padding: '6px 0', color: 'var(--text-muted)' }}>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Node inspector (per-type) ──────────────────────────────────────────────
function NodeInspector({ node, agents, allStepIds, onChange, onDelete, onDuplicate, onTest }: {
  node: Node
  agents: Agent[]
  allStepIds: string[]
  onChange: (patch: Partial<{ id: string; input: any; retry: RetryPolicy | null }>) => void
  onDelete: () => void
  onDuplicate: () => void
  onTest?: () => void
}) {
  const data = node.data as any
  const type: StepType = data.type
  const input = data.input || {}
  const retry: RetryPolicy | null = data.retry || null
  const meta = NODE_META[type]
  const Icon = meta.icon
  const invalidMsg = data.invalidReason as string | null
  const status: NodeStatus = (data.status as NodeStatus) || 'idle'

  const set = (patch: any) => onChange({ input: { ...input, ...patch } })
  const setRetry = (patch: Partial<RetryPolicy> | null) => {
    if (patch === null) { onChange({ retry: null }); return }
    onChange({ retry: { ...(retry || {}), ...patch } })
  }
  const canTest = !!onTest && !['AGENT', 'CREW', 'LOOP', 'APPROVAL'].includes(type)

  return (
    <div style={{ width: 360, borderLeft: '1px solid var(--border)', background: 'var(--bg-white)', overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8, background: meta.bg }}>
        <span style={{ display: 'inline-flex', width: 26, height: 26, borderRadius: 6, background: '#fff', alignItems: 'center', justifyContent: 'center' }}>
          <Icon size={14} color={meta.color} />
        </span>
        <strong style={{ fontSize: 12, color: meta.color, textTransform: 'uppercase', letterSpacing: 0.5 }}>{meta.label}</strong>
        {status !== 'idle' && (
          <span
            title={`Live status: ${status.replace('_', ' ')}`}
            style={{
              fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase',
              padding: '2px 6px', borderRadius: 3,
              color:
                status === 'completed' ? '#16a34a' :
                status === 'failed' ? '#dc2626' :
                status === 'retrying' ? '#c2410c' :
                status === 'awaiting_approval' ? '#92400e' :
                '#1d4ed8',
              background:
                status === 'completed' ? '#dcfce7' :
                status === 'failed' ? '#fee2e2' :
                status === 'retrying' ? '#ffedd5' :
                status === 'awaiting_approval' ? '#fef3c7' :
                '#dbeafe',
            }}
          >
            {status.replace('_', ' ')}
          </span>
        )}
        {canTest && (
          <button onClick={onTest} title="Test this step (dry-run)" style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 4 }}>
            <FlaskConical size={14} />
          </button>
        )}
        <button onClick={onDuplicate} title="Duplicate step (⌘D)" style={{ marginLeft: canTest ? 0 : 'auto', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 4 }}>
          <Copy size={14} />
        </button>
        <button onClick={onDelete} title="Delete step" style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer', padding: 4 }}>
          <Trash2 size={15} />
        </button>
      </div>

      {invalidMsg && (
        <div style={{ background: '#fef3c7', color: '#92400e', fontSize: 12, padding: '8px 16px', borderBottom: '1px solid #fde68a' }}>
          ⚠ {invalidMsg}
        </div>
      )}

      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="form-group">
          <label className="form-label">Step ID *</label>
          <input
            className="input"
            value={data.id}
            onChange={e => {
              const raw = e.target.value.toLowerCase().replace(/[^a-z0-9_]+/g, '')
              if (raw && !allStepIds.includes(raw)) onChange({ id: raw })
              else if (!raw) onChange({ id: '' })
            }}
          />
          <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>Used as a variable name in <code>{'{{}}'}</code> templates.</p>
        </div>

        {type === 'AGENT' && (
          <>
            <div className="form-group">
              <label className="form-label">Agent</label>
              <select className="select input" value={input.agentId || ''} onChange={e => set({ agentId: e.target.value })}>
                <option value="">Select agent…</option>
                {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Goal template</label>
              <textarea
                className="input"
                rows={5}
                placeholder="Ask the agent to do something. Use {{step_id}} or {{step_id.field}} to reference earlier outputs."
                value={input.goal || ''}
                onChange={e => set({ goal: e.target.value })}
              />
              <VarChips ids={allStepIds} onInsert={(tok) => set({ goal: (input.goal || '') + tok })} />
            </div>
          </>
        )}

        {type === 'CREW' && (
          <CrewEditor input={input} agents={agents} onChange={set} />
        )}

        {type === 'HTTP' && (
          <>
            <div className="form-group">
              <label className="form-label">Method</label>
              <select className="select input" value={input.method || 'POST'} onChange={e => set({ method: e.target.value })}>
                {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">URL</label>
              <input className="input" placeholder="https://api.example.com/path (supports {{vars}})" value={input.url || ''} onChange={e => set({ url: e.target.value })} />
            </div>
            <div className="form-group">
              <label className="form-label">Body (JSON, optional)</label>
              <textarea
                className="input"
                rows={5}
                value={typeof input.body === 'string' ? input.body : (input.body ? JSON.stringify(input.body, null, 2) : '')}
                onChange={e => {
                  const raw = e.target.value
                  try { set({ body: raw.trim() ? JSON.parse(raw) : undefined }) }
                  catch { set({ body: raw }) }
                }}
                placeholder='{ "userId": "{{lookup.id}}" }'
              />
              <VarChips ids={allStepIds} onInsert={(tok) => set({ body: (typeof input.body === 'string' ? input.body : JSON.stringify(input.body || {}, null, 2)) + tok })} />
            </div>
          </>
        )}

        {type === 'APPROVAL' && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: 12, background: 'var(--bg)', borderRadius: 6, lineHeight: 1.55 }}>
            Pauses execution until a human approves via the <strong>Approvals</strong> page. Prior step outputs are shown to the reviewer. Auto-expires after 24 hours.
          </div>
        )}

        {type === 'CONDITION' && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: 12, background: 'var(--bg)', borderRadius: 6, lineHeight: 1.55 }}>
            Routing-only node. Draw multiple outgoing edges — each edge&apos;s rule is what gets evaluated. First matching edge wins; an edge with no rule is the fallback.
            <div style={{ marginTop: 8, fontSize: 11 }}>
              Syntax: <code>context.step_id.field &gt; 0.8</code>, <code>output.answer includes &quot;error&quot;</code>
            </div>
          </div>
        )}

        {type === 'TOOL' && (
          <>
            <div className="form-group">
              <label className="form-label">Tool name</label>
              <input className="input" placeholder="slack__post_message, jira__create_issue, db__<slug>__query, rest__<slug>__<op>…" value={input.tool || ''} onChange={e => set({ tool: e.target.value })} />
              <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>
                Any active connector tool. Format: <code>&lt;provider&gt;__&lt;op&gt;</code>.
              </p>
            </div>
            <div className="form-group">
              <label className="form-label">Arguments (JSON)</label>
              <textarea
                className="input"
                rows={6}
                value={typeof input.args === 'string' ? input.args : (input.args ? JSON.stringify(input.args, null, 2) : '')}
                onChange={e => {
                  const raw = e.target.value
                  try { set({ args: raw.trim() ? JSON.parse(raw) : undefined }) }
                  catch { set({ args: raw }) }
                }}
                placeholder='{ "channel": "#ops", "text": "{{plan}}" }'
              />
              <VarChips ids={allStepIds} onInsert={(tok) => set({ args: (typeof input.args === 'string' ? input.args : JSON.stringify(input.args || {}, null, 2)) + tok })} />
            </div>
          </>
        )}

        {type === 'TRANSFORM' && (
          <div className="form-group">
            <label className="form-label">Output template (JSON)</label>
            <textarea
              className="input"
              rows={8}
              value={typeof input.template === 'string' ? input.template : (input.template ? JSON.stringify(input.template, null, 2) : '')}
              onChange={e => {
                const raw = e.target.value
                try { set({ template: raw.trim() ? JSON.parse(raw) : undefined }) }
                catch { set({ template: raw }) }
              }}
              placeholder='{ "name": "{{lookup.name}}", "tags": ["vip", "{{tier}}"] }'
            />
            <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>The template is deep-interpolated with current context. The result becomes this step&apos;s output.</p>
            <VarChips ids={allStepIds} onInsert={(tok) => set({ template: (typeof input.template === 'string' ? input.template : JSON.stringify(input.template || {}, null, 2)) + tok })} />
          </div>
        )}

        {type === 'DELAY' && (
          <div className="form-group">
            <label className="form-label">Wait (seconds)</label>
            <input
              className="input"
              type="number"
              min={0}
              max={900}
              value={input.seconds ?? (input.ms ? Math.round(input.ms / 1000) : 1)}
              onChange={e => set({ seconds: Math.max(0, Math.min(Number(e.target.value) || 0, 900)) })}
            />
            <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>Capped at 15 minutes. For longer waits, use a scheduled trigger instead.</p>
          </div>
        )}

        {type === 'SET' && (
          <SetVarsEditor vars={input.vars || {}} onChange={(v) => set({ vars: v })} allStepIds={allStepIds} />
        )}

        {type === 'LOOP' && (
          <>
            <div className="form-group">
              <label className="form-label">Items path</label>
              <input className="input" placeholder="fetch.results" value={input.itemsFrom || ''} onChange={e => set({ itemsFrom: e.target.value })} />
              <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>Dotted path into context (max 25 iterations).</p>
            </div>
            <div className="form-group">
              <label className="form-label">Agent</label>
              <select className="select input" value={input.agentId || ''} onChange={e => set({ agentId: e.target.value })}>
                <option value="">Select agent…</option>
                {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Goal template (per item)</label>
              <textarea
                className="input"
                rows={4}
                placeholder="Summarise {{item.title}} in one line"
                value={input.goalTemplate || ''}
                onChange={e => set({ goalTemplate: e.target.value })}
              />
              <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>Inside the goal you can use <code>{'{{item}}'}</code> and <code>{'{{index}}'}</code>.</p>
            </div>
          </>
        )}

        {type === 'NOTIFY' && (
          <>
            <div className="form-group">
              <label className="form-label">Slack channel</label>
              <input className="input" placeholder="#ops or C0123ABC" value={input.channel || ''} onChange={e => set({ channel: e.target.value })} />
            </div>
            <div className="form-group">
              <label className="form-label">Message</label>
              <textarea
                className="input"
                rows={4}
                placeholder="✅ Deployment succeeded for {{deploy.name}}"
                value={input.message || ''}
                onChange={e => set({ message: e.target.value })}
              />
              <VarChips ids={allStepIds} onInsert={(tok) => set({ message: (input.message || '') + tok })} />
            </div>
            <p style={{ fontSize: 11, color: 'var(--text-muted)' }}>Uses the tenant&apos;s active Slack connector. For other providers use a <strong>Tool</strong> step.</p>
          </>
        )}

        {type === 'PARALLEL' && (
          <ParallelEditor input={input} onChange={set} />
        )}

        {/* Retry policy — shown for every type except APPROVAL (retrying human
            approvals doesn't make sense — a rejection is a semantic outcome). */}
        {type !== 'APPROVAL' && (
          <RetrySection retry={retry} onChange={setRetry} />
        )}
      </div>
    </div>
  )
}

// ── Retry policy section ───────────────────────────────────────────────────
function RetrySection({ retry, onChange }: { retry: RetryPolicy | null; onChange: (patch: Partial<RetryPolicy> | null) => void }) {
  const [open, setOpen] = useState(Boolean(retry?.attempts && retry.attempts > 1))
  const attempts = retry?.attempts ?? 1
  const backoffMs = retry?.backoffMs ?? 0
  const jitter = retry?.jitter ?? 0
  const enabled = attempts > 1
  return (
    <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 8,
          background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0',
          fontSize: 12, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase',
          color: 'var(--text-muted)',
        }}
      >
        <RefreshCw size={12} />
        <span>Retry policy</span>
        {enabled && (
          <span style={{ marginLeft: 4, fontSize: 10, fontWeight: 700, color: '#7c2d12', background: '#fed7aa', padding: '1px 6px', borderRadius: 3, letterSpacing: 0.3 }}>
            x{attempts}
          </span>
        )}
        <span style={{ marginLeft: 'auto', fontSize: 11 }}>{open ? '−' : '+'}</span>
      </button>
      {open && (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div className="form-group">
              <label className="form-label">Attempts (1–5)</label>
              <input
                className="input" type="number" min={1} max={5}
                value={attempts}
                onChange={e => {
                  const v = Math.max(1, Math.min(Number(e.target.value) || 1, 5))
                  if (v === 1 && !backoffMs && !jitter) onChange(null)
                  else onChange({ attempts: v })
                }}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Backoff (ms)</label>
              <input
                className="input" type="number" min={0} max={30000} step={100}
                value={backoffMs}
                disabled={!enabled}
                onChange={e => onChange({ backoffMs: Math.max(0, Math.min(Number(e.target.value) || 0, 30000)) })}
              />
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Jitter (0–1)</label>
            <input
              className="input" type="number" min={0} max={1} step={0.05}
              value={jitter}
              disabled={!enabled}
              onChange={e => onChange({ jitter: Math.max(0, Math.min(Number(e.target.value) || 0, 1)) })}
            />
            <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
              Randomness applied to backoff (e.g. <code>0.2</code> = ±20%). Prevents thundering-herd on transient failures.
            </p>
          </div>
          <p style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
            Linear backoff: attempt <em>n</em> waits <code>n × backoff</code>. Max 30s per wait, 5 attempts total.
          </p>
        </div>
      )}
    </div>
  )
}

// ── PARALLEL editor ────────────────────────────────────────────────────────
// Free-form JSON editor for the tasks[] array. Kept simple because PARALLEL
// is an advanced feature — users who need it are comfortable with JSON.
function ParallelEditor({ input, onChange }: { input: any; onChange: (patch: any) => void }) {
  const [raw, setRaw] = useState<string>(
    typeof input.tasks === 'string' ? input.tasks : JSON.stringify(input.tasks || [], null, 2)
  )
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    // Keep local state in sync when the source of truth changes (e.g. undo)
    const next = typeof input.tasks === 'string' ? input.tasks : JSON.stringify(input.tasks || [], null, 2)
    if (next !== raw) setRaw(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input.tasks])
  return (
    <div className="form-group">
      <label className="form-label">Sub-tasks (JSON, max 10)</label>
      <textarea
        className="input"
        rows={10}
        value={raw}
        onChange={e => {
          const v = e.target.value
          setRaw(v)
          try {
            const parsed = JSON.parse(v || '[]')
            if (!Array.isArray(parsed)) { setErr('Must be a JSON array'); return }
            setErr(null)
            onChange({ tasks: parsed })
          } catch (parseErr: any) {
            setErr(parseErr.message)
          }
        }}
        style={{ fontFamily: 'monospace', fontSize: 12 }}
        placeholder={'[\n  { "id": "notify", "type": "NOTIFY", "input": { "channel": "#ops", "message": "starting" } },\n  { "id": "log",    "type": "HTTP",   "input": { "method": "POST", "url": "https://…", "body": {} } }\n]'}
      />
      {err && <p style={{ fontSize: 11, color: '#dc2626', marginTop: 4 }}>Invalid JSON: {err}</p>}
      <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>
        Each task is a step with <code>id</code>, <code>type</code>, and <code>input</code>. Runs in parallel; output shape is
        <code style={{ marginLeft: 4 }}>{'{ tasks: { <id>: <out> }, errors: {…} }'}</code>. Nested PARALLEL and APPROVAL not allowed.
      </p>
    </div>
  )
}

// ── SET vars editor ────────────────────────────────────────────────────────
function SetVarsEditor({
  vars, onChange, allStepIds,
}: {
  vars: Record<string, any>
  onChange: (next: Record<string, any>) => void
  allStepIds: string[]
}) {
  const rows = Object.entries(vars)
  const [draftKey, setDraftKey] = useState('')
  const [draftVal, setDraftVal] = useState('')

  const remove = (k: string) => {
    const next = { ...vars }; delete next[k]; onChange(next)
  }
  const update = (k: string, v: any) => onChange({ ...vars, [k]: v })
  const add = () => {
    const key = draftKey.trim()
    if (!key) return
    onChange({ ...vars, [key]: draftVal })
    setDraftKey(''); setDraftVal('')
  }

  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {rows.length === 0 && (
          <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>No variables yet. Add one below.</p>
        )}
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input className="input" style={{ width: 120 }} value={k} readOnly />
            <input className="input" style={{ flex: 1 }} value={String(v ?? '')} onChange={e => update(k, e.target.value)} />
            <button type="button" onClick={() => remove(k)} style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer' }}>
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
      <div style={{ padding: 10, border: '1px dashed var(--border)', borderRadius: 6, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <input className="input" placeholder="Variable name" value={draftKey} onChange={e => setDraftKey(e.target.value)} />
        <input className="input" placeholder='Value (e.g. "{{lookup.name}}")' value={draftVal} onChange={e => setDraftVal(e.target.value)} />
        <VarChips ids={allStepIds} onInsert={(tok) => setDraftVal(prev => prev + tok)} />
        <button type="button" className="btn btn-secondary btn-sm" onClick={add} disabled={!draftKey.trim()} style={{ alignSelf: 'flex-end' }}>
          <Plus size={12} style={{ marginRight: 4, verticalAlign: 'middle' }} /> Add variable
        </button>
      </div>
    </>
  )
}

// ── Variable chips ─────────────────────────────────────────────────────────
function VarChips({ ids, onInsert }: { ids: string[]; onInsert: (token: string) => void }) {
  if (ids.length === 0) return null
  return (
    <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
      <span style={{ fontSize: 10, color: 'var(--text-muted)', alignSelf: 'center', marginRight: 4 }}>Insert:</span>
      {ids.map(id => (
        <button
          key={id}
          type="button"
          onClick={() => onInsert(`{{${id}}}`)}
          style={{
            fontSize: 10, fontFamily: 'monospace', cursor: 'pointer',
            padding: '2px 6px', border: '1px solid var(--border)', borderRadius: 3,
            background: 'var(--bg)'
          }}
        >
          {`{{${id}}}`}
        </button>
      ))}
    </div>
  )
}

// ── Crew editor ────────────────────────────────────────────────────────────
function CrewEditor({ input, agents, onChange }: { input: any; agents: Agent[]; onChange: (patch: any) => void }) {
  const members: any[] = input.agents || []
  const [draft, setDraft] = useState({ agentId: '', role: '', goal: '' })

  const addMember = () => {
    if (!draft.agentId || !draft.role.trim()) return
    onChange({ agents: [...members, draft] })
    setDraft({ agentId: '', role: '', goal: '' })
  }
  const removeMember = (i: number) => onChange({ agents: members.filter((_, ix) => ix !== i) })

  return (
    <>
      <div className="form-group">
        <label className="form-label">Coordination mode</label>
        <select className="select input" value={input.mode || 'sequential'} onChange={e => onChange({ mode: e.target.value })}>
          <option value="sequential">Sequential (later members see earlier outputs)</option>
          <option value="parallel">Parallel (all run simultaneously)</option>
          <option value="supervisor">Supervisor (parallel + synthesiser)</option>
        </select>
      </div>

      {members.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {members.map((m, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: 10, background: 'var(--bg)', borderRadius: 6, gap: 8 }}>
              <div style={{ fontSize: 12, flex: 1 }}>
                <strong>{m.role}</strong> · <span style={{ color: 'var(--text-muted)' }}>{agents.find(a => a.id === m.agentId)?.name || m.agentId}</span>
                {m.goal && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{m.goal}</div>}
              </div>
              <button type="button" onClick={() => removeMember(i)} style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer', fontSize: 11 }}>Remove</button>
            </div>
          ))}
        </div>
      )}

      <div style={{ padding: 10, border: '1px dashed var(--border)', borderRadius: 6, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <input className="input" placeholder="Role (e.g. researcher)" value={draft.role} onChange={e => setDraft({ ...draft, role: e.target.value })} />
        <select className="select input" value={draft.agentId} onChange={e => setDraft({ ...draft, agentId: e.target.value })}>
          <option value="">Agent…</option>
          {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <textarea className="input" rows={2} placeholder="Member goal (may reference {{other_role}})" value={draft.goal} onChange={e => setDraft({ ...draft, goal: e.target.value })} />
        <button type="button" className="btn btn-secondary btn-sm" onClick={addMember} style={{ alignSelf: 'flex-end' }}>+ Add member</button>
      </div>

      {(input.mode === 'supervisor') && (
        <>
          <div className="form-group">
            <label className="form-label">Supervisor agent</label>
            <select className="select input" value={input.supervisorAgentId || ''} onChange={e => onChange({ supervisorAgentId: e.target.value })}>
              <option value="">Select supervisor…</option>
              {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">Supervisor goal (optional)</label>
            <textarea className="input" rows={3} value={input.supervisorGoal || ''} onChange={e => onChange({ supervisorGoal: e.target.value })} placeholder="Leave blank to auto-generate a synthesis prompt." />
          </div>
        </>
      )}
    </>
  )
}

// ── Condition prompt (when creating a branching edge) ──────────────────────
function ConditionPrompt({ onSave, onSkip }: { onSave: (when: string) => void; onSkip: () => void }) {
  const [when, setWhen] = useState('')
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 1100,
      display: 'flex', alignItems: 'center', justifyContent: 'center'
    }}>
      <div style={{ background: 'var(--bg-white)', borderRadius: 10, padding: 20, width: 460, boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>Route condition</h3>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14 }}>
          Leave empty to make this the fallback (unconditional) edge. Otherwise write a rule.
        </p>
        <input
          className="input"
          autoFocus
          value={when}
          onChange={e => setWhen(e.target.value)}
          placeholder='context.step_id.confidence > 0.8'
          onKeyDown={e => { if (e.key === 'Enter') onSave(when) }}
        />
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.5 }}>
          Operators: <code>=== !== &gt; &lt; &gt;= &lt;= includes</code>. LHS must start with <code>context.</code> or <code>output.</code>.
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onSkip}>Skip</button>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => onSave(when)}>Save edge</button>
        </div>
      </div>
    </div>
  )
}

// Retain export of Play (used elsewhere via lucide-react) — silence unused import in strict lint
void Play

// ── TestStepModal ──────────────────────────────────────────────────────────
// Modal for dry-running a single step against the /workflows/dry-run-step
// endpoint. Lets the user paste a JSON context, sends the current step config,
// and displays the outcome (output OR error, plus duration).
function TestStepModal({ tenantId, step, onClose }: { tenantId: string; step: Step; onClose: () => void }) {
  const [ctxJson, setCtxJson] = useState('{}')
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; output?: unknown; error?: string; durationMs?: number } | null>(null)
  const [ctxErr, setCtxErr] = useState<string | null>(null)
  const unsupported = ['AGENT', 'CREW', 'LOOP', 'APPROVAL'].includes(step.type)

  async function run() {
    if (unsupported) return
    let context: any = {}
    try { context = ctxJson.trim() ? JSON.parse(ctxJson) : {} }
    catch (e: any) { setCtxErr(e.message); return }
    setCtxErr(null)
    setRunning(true)
    setResult(null)
    try {
      const mod = await import('@/lib/api')
      const r = await mod.api.dryRunWorkflowStep(tenantId, { step, context })
      setResult((r?.data ?? r) as any)
    } catch (e: any) {
      setResult({ ok: false, error: e?.message || 'Request failed' })
    } finally {
      setRunning(false)
    }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1200,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
    }}>
      <div style={{ background: 'var(--bg-white)', borderRadius: 10, width: 640, maxHeight: '85vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.25)' }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <FlaskConical size={16} color="#0ea5e9" />
          <strong style={{ fontSize: 14 }}>Test step</strong>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', background: '#f1f5f9', padding: '2px 6px', borderRadius: 3 }}>
            {step.type} · {step.id}
          </span>
          <button onClick={onClose} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 4 }}>
            <X size={16} />
          </button>
        </div>

        <div style={{ padding: 18, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {unsupported ? (
            <div style={{ background: '#fef3c7', color: '#92400e', padding: '10px 12px', borderRadius: 6, fontSize: 12, lineHeight: 1.5 }}>
              <strong>Not supported for {step.type}.</strong> Steps that depend on the workflow engine (agents, crews, loops, approvals) can only be exercised via a full workflow run.
            </div>
          ) : (
            <>
              <div className="form-group">
                <label className="form-label">Context (JSON)</label>
                <textarea
                  className="input"
                  rows={7}
                  value={ctxJson}
                  onChange={e => { setCtxJson(e.target.value); setCtxErr(null) }}
                  style={{ fontFamily: 'monospace', fontSize: 12 }}
                  placeholder='{ "vars": { "email": "alice@example.com" }, "prev_step": { "count": 3 } }'
                />
                {ctxErr && <p style={{ fontSize: 11, color: '#dc2626', marginTop: 4 }}>Invalid JSON: {ctxErr}</p>}
                <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                  Simulated <code>context</code> for template substitution. Use <code>{'{{step_id.field}}'}</code> in step inputs.
                </p>
              </div>

              {result && (
                <div style={{
                  border: '1px solid ' + (result.ok ? '#bbf7d0' : '#fecaca'),
                  background: result.ok ? '#f0fdf4' : '#fef2f2',
                  borderRadius: 6, padding: 12, display: 'flex', flexDirection: 'column', gap: 6,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700 }}>
                    {result.ok
                      ? <><CheckCircle2 size={14} color="#16a34a" /> <span style={{ color: '#166534' }}>Success</span></>
                      : <><AlertTriangle size={14} color="#dc2626" /> <span style={{ color: '#991b1b' }}>Failed</span></>}
                    {typeof result.durationMs === 'number' && (
                      <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)', fontWeight: 500 }}>
                        {result.durationMs} ms
                      </span>
                    )}
                  </div>
                  {result.ok ? (
                    <pre style={{ margin: 0, fontSize: 11, background: '#fff', padding: 10, borderRadius: 4, maxHeight: 240, overflow: 'auto' }}>
                      {(() => { try { return JSON.stringify(result.output, null, 2) } catch { return String(result.output) } })()}
                    </pre>
                  ) : (
                    <div style={{ fontSize: 12, color: '#7f1d1d', whiteSpace: 'pre-wrap', fontFamily: 'monospace' }}>{result.error}</div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        <div style={{ padding: '12px 18px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>Close</button>
          {!unsupported && (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={run}
              disabled={running}
            >
              {running ? <><Loader2 size={13} style={{ marginRight: 4, verticalAlign: 'middle', animation: 'kv-spin 1s linear infinite' }} /> Running…</> : <><Play size={13} style={{ marginRight: 4, verticalAlign: 'middle' }} /> Run test</>}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
