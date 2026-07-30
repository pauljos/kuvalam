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
import { API_BASE } from '@/lib/api'
import {
  Bot, Users, Globe, ShieldCheck, GitBranch, Trash2, Plus, Save, X,
  Timer, Wand2, Repeat, MessageSquare, Wrench, Settings2,
  Sparkles, FileCode, HelpCircle, Copy, Play, Maximize2,
  Undo2, Redo2, LayoutGrid, Loader2, CheckCircle2, AlertTriangle, RefreshCw,
  Split, FlaskConical, Database, Layers,
  Mail, Bug, GitPullRequestArrow, Siren, Radio, FileCheck,
  Cpu, Cloud, Terminal, CreditCard, Headset, UserPlus, Container,
} from 'lucide-react'

// ── Types ───────────────────────────────────────────────────────────────────
export type StepType =
  | 'AGENT' | 'CREW' | 'HTTP' | 'APPROVAL' | 'CONDITION'
  | 'TOOL' | 'TRANSFORM' | 'DELAY' | 'SET' | 'LOOP' | 'NOTIFY' | 'PARALLEL' | 'SCRIPT'

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
  SCRIPT:    { label: 'Script',    color: '#6d28d9', bg: '#f5f3ff', icon: FileCode,     group: 'Data' },
  HTTP:      { label: 'HTTP',      color: '#5b7cd6', bg: '#e9eefc', icon: Globe,        group: 'Integration' },
  TOOL:      { label: 'Tool',      color: '#dc2626', bg: '#fee2e2', icon: Wrench,       group: 'Integration' },
  NOTIFY:    { label: 'Notify',    color: '#e11d48', bg: '#ffe4e6', icon: MessageSquare, group: 'Integration' },
}

const PALETTE_GROUPS: Array<{ title: string; hint: string; group: NodeMeta['group']; types: StepType[] }> = [
  { title: 'AI',          hint: 'Agents & crews',                group: 'AI',          types: ['AGENT', 'CREW', 'LOOP'] },
  { title: 'Flow',        hint: 'Branching · pauses · fan-out',  group: 'Flow',        types: ['CONDITION', 'APPROVAL', 'DELAY', 'PARALLEL'] },
  { title: 'Data',        hint: 'Transform / set / script',    group: 'Data',        types: ['TRANSFORM', 'SET', 'SCRIPT'] },
  { title: 'Integration', hint: 'External APIs & tools',         group: 'Integration', types: ['HTTP', 'TOOL', 'NOTIFY'] },
]

// Node dimensions for dagre auto-layout (must roughly match the rendered card)
const NODE_W = 220
const NODE_H = 84

// ── Templates (starter workflows) ──────────────────────────────────────────
type Template = { id: string; name: string; description: string; icon: any; domain?: string; build: () => Step[] }

// Domain colour resolver — gives each template card a distinctive accent colour
// instead of every icon being green.
const DOMAIN_COLORS: Record<string, { color: string; bg: string }> = {
  communication: { color: '#3f8a43', bg: '#edf7ee' },   // green — Slack, email, SMS
  devops:        { color: '#7c3aed', bg: '#f5f3ff' },   // purple — infra, CI/CD
  iot:           { color: '#0891b2', bg: '#ecfeff' },   // cyan — sensors, MQTT
  finance:       { color: '#d97706', bg: '#fffbeb' },   // amber — Stripe, QuickBooks
  crm:           { color: '#2563eb', bg: '#eff6ff' },   // blue — Salesforce, HubSpot
  itsm:          { color: '#dc2626', bg: '#fef2f2' },   // red — ServiceNow, Zendesk
  compliance:    { color: '#9333ea', bg: '#faf5ff' },   // violet — audit, approvals
  monitoring:    { color: '#ea580c', bg: '#fff7ed' },   // orange — Prometheus, Datadog
  default:       { color: '#3f8a43', bg: '#edf7ee' },
}
function domainStyle(d: string | undefined) {
  const dc = DOMAIN_COLORS[d || ''] || DOMAIN_COLORS.default
  return dc
}

const TEMPLATES: Template[] = [
  {
    id: 'blank', name: 'Blank canvas', description: 'Start with an empty board.',
    icon: FileCode, domain: 'default',
    build: () => [],
  },
  {
    id: 'agent-notify', name: 'Agent → Slack notification',
    description: 'Run an agent, then post the result to Slack.',
    icon: MessageSquare, domain: 'communication',
    build: () => [
      { id: 'research', type: 'AGENT', input: { goal: 'Summarise today’s top news in 3 bullets.' }, _ui: { position: { x: 100, y: 160 } } },
      { id: 'notify',   type: 'NOTIFY', input: { provider: 'slack', channel: '#general', message: '{{research}}' }, _ui: { position: { x: 420, y: 160 } } },
    ],
  },
  {
    id: 'agent-approval-tool', name: 'Agent → Approval → Tool',
    description: 'Human-in-the-loop guard between an agent decision and a tool action.',
    icon: ShieldCheck, domain: 'compliance',
    build: () => [
      { id: 'plan',     type: 'AGENT',    input: { goal: 'Draft an action plan.' }, _ui: { position: { x: 80,  y: 160 } } },
      { id: 'review',   type: 'APPROVAL', input: {},                                 _ui: { position: { x: 380, y: 160 } } },
      { id: 'execute',  type: 'TOOL',     input: { tool: 'slack__post_message', args: { channel: '#ops', text: '{{plan}}' } }, _ui: { position: { x: 700, y: 160 } } },
    ],
  },
  {
    id: 'lookup-branch', name: 'Fetch → Condition → Two paths',
    description: 'HTTP lookup, then branch on the response with a Condition node.',
    icon: GitBranch, domain: 'devops',
    build: () => [
      { id: 'lookup',   type: 'HTTP',      input: { method: 'GET', url: 'https://api.example.com/status' }, _ui: { position: { x: 80,  y: 160 } } },
      { id: 'check',    type: 'CONDITION', input: {}, routes: [
          { when: 'context.lookup.ok === true', goto: 'happy' },
          { goto: 'sad' },
        ], _ui: { position: { x: 380, y: 160 } } },
      { id: 'happy',    type: 'NOTIFY',    input: { provider: 'slack', channel: '#ops', message: 'All good' }, _ui: { position: { x: 700, y: 80  } } },
      { id: 'sad',      type: 'NOTIFY',    input: { provider: 'slack', channel: '#ops', message: '⚠️ Attention needed' }, _ui: { position: { x: 700, y: 260 } } },
    ],
  },
  {
    id: 'end-to-end', name: '🔁 End-to-End Pipeline (Agent → HTTP → Branch → Approve → Notify)',
    description: 'Complete pipeline: research agent, fetch external data, branch on status, human approval, then notify.',
    icon: Sparkles, domain: 'default',
    build: () => [
      { id: 'research',  type: 'AGENT',     input: { goal: 'Research the current status and draft a brief summary.' }, _ui: { position: { x: 40,  y: 120 } } },
      { id: 'fetch',     type: 'HTTP',      input: { method: 'GET', url: 'https://api.example.com/data' }, _ui: { position: { x: 300, y: 120 } } },
      { id: 'transform', type: 'TRANSFORM', input: { template: { summary: '{{research}}', ok: '{{fetch.ok}}', count: '{{fetch.data.length}}' } }, _ui: { position: { x: 560, y: 120 } } },
      { id: 'check',     type: 'CONDITION', input: {}, routes: [{ when: 'context.transform.ok === true', goto: 'approve' }, { goto: 'alert' }], _ui: { position: { x: 820, y: 120 } } },
      { id: 'approve',   type: 'APPROVAL',  input: {}, goto: 'execute', _ui: { position: { x: 1080, y: 50 } } },
      { id: 'execute',   type: 'TOOL',      input: { tool: 'slack__post_message', args: { channel: '#ops', text: '✅ Approved: {{transform.summary}}' } }, _ui: { position: { x: 1340, y: 50 } } },
      { id: 'alert',     type: 'NOTIFY',    input: { provider: 'slack', channel: '#alerts', message: '⚠️ Pipeline failed at transform step. Research: {{research}}' }, _ui: { position: { x: 1080, y: 200 } } },
    ],
  },
  {
    id: 'loop-summarise', name: 'Fetch list → Loop summarise → Notify',
    description: 'Fan an agent over every item in a fetched array, then notify.',
    icon: Repeat,
    build: () => [
      { id: 'fetch',    type: 'HTTP', input: { method: 'GET', url: 'https://api.example.com/tickets' }, _ui: { position: { x: 80, y: 160 } } },
      { id: 'each',     type: 'LOOP', input: { itemsFrom: 'fetch.results', agentId: '', goalTemplate: 'Summarise ticket {{item.title}}' }, _ui: { position: { x: 380, y: 160 } } },
      { id: 'notify',   type: 'NOTIFY', input: { provider: 'slack', channel: '#support', message: '{{each.results}}' }, _ui: { position: { x: 700, y: 160 } } },
    ],
  },
  {
    id: 'multi-agent-branch', name: '🔀 Multi-Agent Branch (Agent → Condition → Two Agents)',
    description: 'First agent analyses intent, then routes to one of two specialist agents based on the result, transforms and notifies.',
    icon: GitBranch,
    build: () => [
      { id: 'classify',    type: 'AGENT',     input: { goal: 'Classify the user request as either "urgent" or "normal". Reply with just the word.' }, _ui: { position: { x: 40,  y: 120 } } },
      { id: 'router',      type: 'CONDITION', input: {}, routes: [
        { when: 'context.classify.includes("urgent")', goto: 'urgent_agent' },
        { goto: 'normal_agent' },
      ], _ui: { position: { x: 320, y: 120 } } },
      { id: 'urgent_agent',  type: 'AGENT', input: { goal: 'Provide a high-priority response to: {{classify}}' }, _ui: { position: { x: 600, y: 40  } } },
      { id: 'normal_agent',  type: 'AGENT', input: { goal: 'Provide a standard response to: {{classify}}' }, _ui: { position: { x: 600, y: 210 } } },
      { id: 'merge',       type: 'TRANSFORM', input: { template: { urgent: '{{urgent_agent}}', normal: '{{normal_agent}}', decided: '{{classify}}' } }, _ui: { position: { x: 880, y: 120 } } },
      { id: 'notify',      type: 'NOTIFY',   input: { provider: 'slack', channel: '#ops', message: 'Agent decision: {{merge.decided}}. Response: {{merge.urgent}}{{merge.normal}}' }, _ui: { position: { x: 1160, y: 120 } } },
    ],
  },
  {
    id: 'data-etl', name: '📊 Data ETL Pipeline (HTTP → Transform → Set → Notify)',
    description: 'Fetch JSON from an API, reshape it, persist key values into context variables, then send a summary notification.',
    icon: Database,
    build: () => [
      { id: 'fetch',      type: 'HTTP',      input: { method: 'GET', url: 'https://api.example.com/metrics' }, _ui: { position: { x: 40,  y: 160 } } },
      { id: 'reshape',    type: 'TRANSFORM', input: { template: { total: '{{fetch.total}}', active: '{{fetch.active}}', pct: '{{fetch.active / fetch.total * 100}}' } }, _ui: { position: { x: 320, y: 160 } } },
      { id: 'persist',    type: 'SET',       input: { vars: { totalUsers: '{{reshape.total}}', activeUsers: '{{reshape.active}}', activePct: '{{reshape.pct}}' } }, _ui: { position: { x: 600, y: 160 } } },
      { id: 'notify',     type: 'NOTIFY',    input: { provider: 'slack', channel: '#analytics', message: '📈 {{activeUsers}}/{{totalUsers}} active ({{activePct}}%)' }, _ui: { position: { x: 880, y: 160 } } },
    ],
  },
  {
    id: 'fan-out-parallel', name: '⚡ Parallel Fan-Out (HTTP → 3 parallel tasks → Merge)',
    description: 'Fetch data, then simultaneously notify Slack, call a webhook, and run a tool. Merge all results.',
    icon: Layers,
    build: () => [
      { id: 'fetch',      type: 'HTTP',    input: { method: 'GET', url: 'https://api.example.com/events' }, _ui: { position: { x: 40,  y: 160 } } },
      { id: 'fanout',     type: 'PARALLEL', input: { tasks: [
        { id: 'alert',      type: 'NOTIFY', input: { provider: 'slack', channel: '#alerts', message: 'New event batch: {{fetch.count}} items' } },
        { id: 'webhook',    type: 'HTTP',   input: { method: 'POST', url: 'https://hooks.example.com/ingest', body: { events: '{{fetch}}' } } },
        { id: 'log',        type: 'TOOL',   input: { tool: 'slack__post_message', args: { channel: '#audit', text: 'ETL kickoff for {{fetch.count}} records' } } },
      ] }, _ui: { position: { x: 320, y: 160 } } },
      { id: 'merge',      type: 'TRANSFORM', input: { template: { alertOk: '{{fanout.tasks.alert.ok}}', webhookOk: '{{fanout.tasks.webhook.ok}}', logOk: '{{fanout.tasks.log.ok}}', hasErrors: '{{fanout.hasErrors}}' } }, _ui: { position: { x: 600, y: 160 } } },
      { id: 'summary',    type: 'NOTIFY',   input: { provider: 'slack', channel: '#ops', message: 'Fan-out done. Errors: {{merge.hasErrors}}. Slack:{{merge.alertOk}} Webhook:{{merge.webhookOk}} Log:{{merge.logOk}}' }, _ui: { position: { x: 880, y: 160 } } },
    ],
  },
  {
    id: 'approval-chain', name: '🛡️ Multi-Stage Approval Chain',
    description: 'Agent drafts content, then passes through two sequential human approvals before publishing via HTTP.',
    icon: ShieldCheck,
    build: () => [
      { id: 'draft',       type: 'AGENT',    input: { goal: 'Draft a company-wide announcement about the new policy.' }, _ui: { position: { x: 40,  y: 160 } } },
      { id: 'legal_review', type: 'APPROVAL', input: {}, goto: 'exec_review', _ui: { position: { x: 340, y: 160 } } },
      { id: 'exec_review',  type: 'APPROVAL', input: {}, goto: 'publish', _ui: { position: { x: 640, y: 160 } } },
      { id: 'publish',     type: 'HTTP',     input: { method: 'POST', url: 'https://api.example.com/announcements', body: { content: '{{draft}}' } }, _ui: { position: { x: 940, y: 160 } } },
      { id: 'confirm',     type: 'NOTIFY',   input: { provider: 'slack', channel: '#general', message: '📢 Announcement published: {{draft}}' }, _ui: { position: { x: 1240, y: 160 } } },
    ],
  },
  {
    id: 'error-recovery', name: '🔄 Error Handling with Recovery Path',
    description: 'Agent attempts a task. On failure, a recovery agent retries with a different strategy. Success or failure is always notified.',
    icon: AlertTriangle,
    build: () => [
      { id: 'attempt',     type: 'AGENT',     input: { goal: 'Extract structured data from the provided text. Return valid JSON.' }, retry: { attempts: 1, backoffMs: 0 }, _ui: { position: { x: 40,  y: 120 } } },
      { id: 'check',       type: 'CONDITION', input: {}, routes: [
        { when: 'context.attempt && context.attempt.length > 0', goto: 'success' },
        { goto: 'recovery' },
      ], _ui: { position: { x: 320, y: 120 } } },
      { id: 'success',     type: 'NOTIFY',    input: { provider: 'slack', channel: '#ops', message: '✅ Data extracted: {{attempt}}' }, _ui: { position: { x: 600, y: 40  } } },
      { id: 'recovery',    type: 'AGENT',     input: { goal: 'The extraction failed. Try a different parsing strategy: {{attempt}}' }, _ui: { position: { x: 600, y: 210 } } },
      { id: 'recovery_notify', type: 'NOTIFY', input: { provider: 'slack', channel: '#alerts', message: '⚠️ Recovery result: {{recovery}}' }, _ui: { position: { x: 900, y: 210 } } },
    ],
  },
  // ═══════════════════════════════════════════════════════════════════════
  // 🆕 Next-gen templates — multi-provider NOTIFY, connectors beyond Slack
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'email-approval', name: '📧 Email Approval Pipeline',
    description: 'Agent drafts → Human approval → Send via Gmail.',
    icon: Mail, domain: 'communication',
    build: () => [
      { id: 'draft',     type: 'AGENT',    input: { goal: 'Draft a professional response to the customer inquiry.' }, _ui: { position: { x: 80,  y: 160 } } },
      { id: 'approve',   type: 'APPROVAL', input: {}, goto: 'send', _ui: { position: { x: 380, y: 160 } } },
      { id: 'send',      type: 'NOTIFY',   input: { provider: 'gmail', channel: 'customer@example.com', subject: 'Re: Your inquiry', message: '{{draft}}' }, _ui: { position: { x: 680, y: 160 } } },
    ],
  },
  {
    id: 'jira-incident', name: '🐛 Jira Incident Response',
    description: 'Monitor alert → Agent diagnosis → Auto-create Jira ticket → Slack notify.',
    icon: Bug, domain: 'itsm',
    build: () => [
      { id: 'alert',     type: 'HTTP',     input: { method: 'GET', url: 'https://monitoring.example.com/latest-alert' }, _ui: { position: { x: 80,  y: 120 } } },
      { id: 'diagnose',  type: 'AGENT',    input: { goal: 'Diagnose this alert and suggest root cause: {{alert}}' }, _ui: { position: { x: 360, y: 120 } } },
      { id: 'create',    type: 'TOOL',     input: { tool: 'jira__create_issue', args: { projectKey: 'OPS', summary: 'Incident: {{alert.title}}', description: '{{diagnose}}', issueType: 'Bug' } }, _ui: { position: { x: 640, y: 120 } } },
      { id: 'notify',    type: 'NOTIFY',   input: { provider: 'slack', channel: '#incidents', message: '🚨 Jira {{create.key}} created: {{alert.title}}\\nDiagnosis: {{diagnose}}' }, _ui: { position: { x: 940, y: 120 } } },
    ],
  },
  {
    id: 'db-query-pipeline', name: '🗄️ Database Query → AI Analysis → Notify',
    description: 'HTTP trigger → Query DB → Agent analysis → Email summary.',
    icon: Database, domain: 'default',
    build: () => [
      { id: 'trigger',   type: 'HTTP',     input: { method: 'GET', url: 'https://api.example.com/trigger-report' }, _ui: { position: { x: 80,  y: 160 } } },
      { id: 'query',     type: 'TOOL',     input: { tool: 'db__query', args: { sql: 'SELECT date, revenue FROM daily_sales WHERE date >= CURRENT_DATE - 7' } }, _ui: { position: { x: 360, y: 160 } } },
      { id: 'analyze',   type: 'AGENT',    input: { goal: 'Analyze these sales figures and write a 3-bullet summary: {{query}}' }, _ui: { position: { x: 640, y: 160 } } },
      { id: 'notify',    type: 'NOTIFY',   input: { provider: 'gmail', channel: 'team@example.com', subject: 'Weekly Sales Report', message: '{{analyze}}' }, _ui: { position: { x: 940, y: 160 } } },
    ],
  },
  {
    id: 'github-pr-review', name: '🔎 GitHub PR Review Pipeline',
    description: 'Fetch PR → AI code review → Branch on issues → Auto-comment or merge.',
    icon: GitPullRequestArrow, domain: 'devops',
    build: () => [
      { id: 'fetch_pr',  type: 'TOOL',     input: { tool: 'github__get_repo', args: { owner: 'myorg', repo: 'backend' } }, _ui: { position: { x: 80,  y: 120 } } },
      { id: 'review',    type: 'AGENT',    input: { goal: 'Review the latest PR changes for security issues and code quality. Reply APPROVED or NEEDS_WORK with specifics.' }, _ui: { position: { x: 360, y: 120 } } },
      { id: 'check',     type: 'CONDITION', input: {}, routes: [
        { when: 'context.review.includes("APPROVED")', goto: 'comment' },
        { goto: 'alert' },
      ], _ui: { position: { x: 640, y: 120 } } },
      { id: 'comment',   type: 'TOOL',     input: { tool: 'github__create_issue', args: { repo: 'myorg/backend', title: '✅ PR Reviewed', body: '{{review}}' } }, _ui: { position: { x: 920, y: 40 } } },
      { id: 'alert',     type: 'NOTIFY',   input: { provider: 'discord', channel: '7890123456', message: '⚠️ PR review flagged issues: {{review}}' }, _ui: { position: { x: 920, y: 210 } } },
    ],
  },
  {
    id: 'incident-runbook', name: '🚨 Incident Runbook (Multi-Channel)',
    description: 'PagerDuty-style runbook: alert → diagnose → remediate → confirm via SMS + Slack.',
    icon: Siren, domain: 'monitoring',
    build: () => [
      { id: 'alert',     type: 'NOTIFY',   input: { provider: 'slack', channel: '#oncall', message: '🚨 Incident detected! Starting runbook…' }, _ui: { position: { x: 80,  y: 120 } } },
      { id: 'diagnose',  type: 'AGENT',    input: { goal: 'Run diagnostic checklist and identify root cause. Be thorough.' }, _ui: { position: { x: 380, y: 120 } } },
      { id: 'fix',       type: 'TOOL',     input: { tool: 'ssh__exec', args: { host: 'prod-server-1', command: 'sudo systemctl restart api && docker ps' } }, _ui: { position: { x: 680, y: 120 } } },
      { id: 'confirm',   type: 'NOTIFY',   input: { provider: 'twilio', channel: '+15551234567', message: '✅ Incident resolved. Root cause: {{diagnose}}. Fix output: {{fix}}' }, _ui: { position: { x: 960, y: 120 } } },
    ],
  },
  {
    id: 'scheduled-scrape-etl', name: '🌐 Scheduled Web Scrape → ETL → Notify',
    description: 'Fetch URL → Transform data → Insert into DB → Email report.',
    icon: Globe, domain: 'default',
    build: () => [
      { id: 'fetch',      type: 'HTTP',      input: { method: 'GET', url: 'https://news.example.com/top-stories' }, _ui: { position: { x: 80,  y: 120 } } },
      { id: 'transform',  type: 'TRANSFORM', input: { template: { titles: '{{fetch.articles.map(a => a.title)}}', count: '{{fetch.articles.length}}' } }, _ui: { position: { x: 360, y: 120 } } },
      { id: 'store',      type: 'TOOL',      input: { tool: 'db__query', args: { sql: `INSERT INTO news_headlines (titles, count, ingested_at) VALUES ('{{transform.titles}}', {{transform.count}}, NOW())` } }, _ui: { position: { x: 640, y: 120 } } },
      { id: 'report',     type: 'NOTIFY',    input: { provider: 'sendgrid', channel: 'analytics@example.com', subject: 'Daily News Ingest Report', message: 'Ingested {{transform.count}} articles. Titles: {{transform.titles}}' }, _ui: { position: { x: 940, y: 120 } } },
      { id: 'confirm',    type: 'NOTIFY',    input: { provider: 'slack', channel: '#data-ops', message: '✅ Daily scrape ETL complete: {{transform.count}} articles stored.' }, _ui: { position: { x: 1240, y: 120 } } },
    ],
  },
  {
    id: 'multi-channel-fanout', name: '📢 Multi-Channel Broadcast',
    description: 'Agent creates announcement → Fan out to Slack + Email + Discord simultaneously.',
    icon: Radio, domain: 'communication',
    build: () => [
      { id: 'draft',       type: 'AGENT',    input: { goal: 'Write a 2-sentence product launch announcement. Keep it short and punchy.' }, _ui: { position: { x: 80,  y: 160 } } },
      { id: 'fanout',      type: 'PARALLEL', input: { tasks: [
        { id: 'slack',      type: 'NOTIFY', input: { provider: 'slack',    channel: '#announcements', message: '{{draft}}' } },
        { id: 'email',      type: 'NOTIFY', input: { provider: 'gmail',    channel: 'all@company.com', subject: '🚀 Product Launch', message: '{{draft}}' } },
        { id: 'discord',    type: 'NOTIFY', input: { provider: 'discord',  channel: '1234567890', message: '{{draft}}' } },
      ] }, _ui: { position: { x: 380, y: 160 } } },
      { id: 'merge',       type: 'TRANSFORM', input: { template: { slackOk: '{{fanout.tasks.slack.ok}}', emailOk: '{{fanout.tasks.email.ok}}', discordOk: '{{fanout.tasks.discord.ok}}', errs: '{{fanout.hasErrors}}' } }, _ui: { position: { x: 660, y: 160 } } },
      { id: 'summary',     type: 'NOTIFY',   input: { provider: 'slack', channel: '#ops', message: '📢 Broadcast results — Slack:{{merge.slackOk}} Email:{{merge.emailOk}} Discord:{{merge.discordOk}} Errors:{{merge.errs}}' }, _ui: { position: { x: 940, y: 160 } } },
    ],
  },
  {
    id: 'compliance-audit', name: '📋 Compliance Audit Trail',
    description: 'Agent review → Dual approval → Log to Confluence → Confirm via email.',
    icon: FileCheck, domain: 'compliance',
    build: () => [
      { id: 'review',      type: 'AGENT',    input: { goal: 'Audit the change request for SOX compliance. Flag any violations.' }, _ui: { position: { x: 80,  y: 120 } } },
      { id: 'security',    type: 'APPROVAL', input: {}, goto: 'compliance_officer', _ui: { position: { x: 360, y: 120 } } },
      { id: 'compliance_officer', type: 'APPROVAL', input: {}, goto: 'log', _ui: { position: { x: 640, y: 120 } } },
      { id: 'log',         type: 'TOOL',     input: { tool: 'confluence__create_page', args: { space: 'AUDIT', title: 'Audit {{DATE}}', body: '{{review}}' } }, _ui: { position: { x: 920, y: 120 } } },
      { id: 'confirm',     type: 'NOTIFY',   input: { provider: 'gmail', channel: 'compliance@company.com', subject: 'Audit Completed', message: 'Audit trail logged to Confluence.\\n\\nFindings:\\n{{review}}' }, _ui: { position: { x: 1220, y: 120 } } },
    ],
  },
  // ═══════════════════════════════════════════════════════════════════════
  // 🏭 Industry-specific templates — IoT, infra, CRM, finance, ITSM
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'iot-sensor-pipeline', name: '🏭 IoT Sensor → Analysis → Alert',
    description: 'MQTT sensor data → Agent anomaly detection → ThingsBoard telemetry → Slack alert.',
    icon: Cpu, domain: 'iot',
    build: () => [
      { id: 'subscribe',  type: 'TOOL',     input: { tool: 'mqtt__subscribe', args: { topic: 'factory/sensors/+/temperature' } }, _ui: { position: { x: 80,  y: 120 } } },
      { id: 'analyze',    type: 'AGENT',    input: { goal: 'Analyze this sensor data for anomalies. If any reading exceeds safe thresholds, flag it with severity and sensor ID: {{subscribe}}' }, _ui: { position: { x: 380, y: 120 } } },
      { id: 'check',      type: 'CONDITION', input: {}, routes: [
        { when: 'context.analyze.includes("CRITICAL")', goto: 'alert' },
        { goto: 'log' },
      ], _ui: { position: { x: 680, y: 120 } } },
      { id: 'alert',      type: 'NOTIFY',   input: { provider: 'slack', channel: '#iot-alerts', message: '🚨 Sensor anomaly detected!\\n{{analyze}}' }, _ui: { position: { x: 960, y: 40 } } },
      { id: 'log',        type: 'TOOL',     input: { tool: 'thingsboard__telemetry', args: { deviceId: 'factory-sensors', keys: 'temperature,humidity,pressure' } }, _ui: { position: { x: 960, y: 210 } } },
    ],
  },
  {
    id: 'aws-cost-governance', name: '☁️ AWS Cost Governance',
    description: 'CloudWatch cost metrics → Agent analysis → Human approval → Slack report.',
    icon: Cloud, domain: 'devops',
    build: () => [
      { id: 'metrics',    type: 'TOOL',     input: { tool: 'aws__cloudwatch_metrics', args: { namespace: 'AWS/Billing', metricName: 'EstimatedCharges' } }, _ui: { position: { x: 80,  y: 160 } } },
      { id: 'analyze',    type: 'AGENT',    input: { goal: 'Analyze these AWS cost metrics. Identify the top 3 cost drivers and suggest optimizations: {{metrics}}' }, _ui: { position: { x: 380, y: 160 } } },
      { id: 'approve',    type: 'APPROVAL', input: {}, goto: 'notify', _ui: { position: { x: 680, y: 160 } } },
      { id: 'notify',     type: 'NOTIFY',   input: { provider: 'slack', channel: '#finops', message: '📊 Monthly AWS cost report:\\n{{analyze}}' }, _ui: { position: { x: 960, y: 160 } } },
    ],
  },
  {
    id: 'prometheus-incident', name: '📡 Prometheus Alert → Jira → SMS',
    description: 'Prometheus alert fires → Agent root cause → Auto-create Jira ticket → SMS on-call.',
    icon: Terminal, domain: 'monitoring',
    build: () => [
      { id: 'alert',      type: 'TOOL',     input: { tool: 'prometheus__query_range', args: { query: 'up == 0', duration: '5m' } }, _ui: { position: { x: 80,  y: 120 } } },
      { id: 'diagnose',   type: 'AGENT',    input: { goal: 'Diagnose the root cause from this Prometheus alert. Be specific about affected services: {{alert}}' }, _ui: { position: { x: 380, y: 120 } } },
      { id: 'ticket',     type: 'TOOL',     input: { tool: 'jira__create_issue', args: { projectKey: 'OPS', summary: 'Incident: {{alert.metric}}', description: '{{diagnose}}', issueType: 'Bug' } }, _ui: { position: { x: 680, y: 120 } } },
      { id: 'sms',        type: 'NOTIFY',   input: { provider: 'twilio', channel: '+15551234567', message: '🚨 On-call: {{diagnose}}. Jira {{ticket.key}}' }, _ui: { position: { x: 960, y: 120 } } },
    ],
  },
  {
    id: 'k8s-autoremediation', name: '⚙️ K8s Auto-Remediation',
    description: 'Prometheus CPU threshold → Agent remediation plan → K8s scale or restart → Slack confirm.',
    icon: Container, domain: 'devops',
    build: () => [
      { id: 'check',      type: 'TOOL',     input: { tool: 'prometheus__query_range', args: { query: 'cpu_usage > 90', duration: '5m' } }, _ui: { position: { x: 80,  y: 120 } } },
      { id: 'plan',       type: 'AGENT',    input: { goal: 'High CPU detected. Decide: should we scale up replicas or restart? Reply SCALE or RESTART with reasoning. Data: {{check}}' }, _ui: { position: { x: 380, y: 120 } } },
      { id: 'decide',     type: 'CONDITION', input: {}, routes: [
        { when: 'context.plan.includes("SCALE")', goto: 'scale' },
        { goto: 'restart' },
      ], _ui: { position: { x: 680, y: 120 } } },
      { id: 'scale',      type: 'TOOL',     input: { tool: 'k8s__get', args: { resource: 'deployments', name: 'backend', namespace: 'prod' } }, _ui: { position: { x: 960, y: 40 } } },
      { id: 'restart',    type: 'TOOL',     input: { tool: 'ssh__exec', args: { host: 'prod-node-1', command: 'kubectl rollout restart deployment/backend -n prod' } }, _ui: { position: { x: 960, y: 210 } } },
      { id: 'done',       type: 'NOTIFY',   input: { provider: 'slack', channel: '#devops', message: '✅ K8s remediation applied. Plan: {{plan}}' }, _ui: { position: { x: 1260, y: 120 } } },
    ],
  },
  {
    id: 'stripe-fraud-monitor', name: '💰 Stripe Payment → Fraud Check',
    description: 'Stripe charge event → Agent fraud analysis → Flag or approve → Discord/Slack alert.',
    icon: CreditCard, domain: 'finance',
    build: () => [
      { id: 'charge',     type: 'HTTP',     input: { method: 'POST', url: 'https://api.example.com/stripe-webhook' }, _ui: { position: { x: 80,  y: 120 } } },
      { id: 'analyze',    type: 'AGENT',    input: { goal: 'Analyze this payment for fraud indicators. Consider amount, location, and patterns. Reply CLEAN or FRAUD with reasoning: {{charge}}' }, _ui: { position: { x: 380, y: 120 } } },
      { id: 'check',      type: 'CONDITION', input: {}, routes: [
        { when: 'context.analyze.includes("FRAUD")', goto: 'fraud_alert' },
        { goto: 'log' },
      ], _ui: { position: { x: 680, y: 120 } } },
      { id: 'fraud_alert',type: 'NOTIFY',   input: { provider: 'discord', channel: 'moderation-channel', message: '🚨 Fraud flagged! Payment: {{charge}}. Analysis: {{analyze}}' }, _ui: { position: { x: 960, y: 40 } } },
      { id: 'log',        type: 'NOTIFY',   input: { provider: 'slack', channel: '#payments', message: '✅ Payment processed: {{charge.amount}} {{charge.currency}}' }, _ui: { position: { x: 960, y: 210 } } },
    ],
  },
  {
    id: 'servicenow-triage', name: '🎫 ServiceNow Ticket Triage',
    description: 'ServiceNow incident → Agent classify priority → Route to Jira or Slack based on urgency.',
    icon: Headset, domain: 'itsm',
    build: () => [
      { id: 'incident',   type: 'TOOL',     input: { tool: 'zendesk__list_tickets', args: { status: 'open' } }, _ui: { position: { x: 80,  y: 120 } } },
      { id: 'classify',   type: 'AGENT',    input: { goal: 'Classify this ticket by urgency (P1-critical, P2-high, P3-normal). Reply with priority and 1-line summary: {{incident}}' }, _ui: { position: { x: 380, y: 120 } } },
      { id: 'router',     type: 'CONDITION', input: {}, routes: [
        { when: 'context.classify.includes("P1")', goto: 'jira' },
        { goto: 'notify' },
      ], _ui: { position: { x: 680, y: 120 } } },
      { id: 'jira',       type: 'TOOL',     input: { tool: 'jira__create_issue', args: { projectKey: 'IT', summary: 'P1: ServiceNow incident', description: '{{classify}}', issueType: 'Bug' } }, _ui: { position: { x: 960, y: 40 } } },
      { id: 'notify',     type: 'NOTIFY',   input: { provider: 'slack', channel: '#it-helpdesk', message: '📋 Ticket classified: {{classify}}' }, _ui: { position: { x: 960, y: 210 } } },
    ],
  },
  {
    id: 'salesforce-lead-engagement', name: '💼 Salesforce Lead → Outreach',
    description: 'Query Salesforce leads → Agent enrichment → Gmail personalised outreach.',
    icon: UserPlus, domain: 'crm',
    build: () => [
      { id: 'leads',      type: 'TOOL',     input: { tool: 'salesforce__query', args: { query: `SELECT Name, Email, Company FROM Lead WHERE Status = 'New'` } }, _ui: { position: { x: 80,  y: 160 } } },
      { id: 'enrich',     type: 'AGENT',    input: { goal: 'Research these leads and write a personalised 2-sentence outreach for each. Mention their company specifically: {{leads}}' }, _ui: { position: { x: 380, y: 160 } } },
      { id: 'email',      type: 'NOTIFY',   input: { provider: 'gmail', channel: '{{leads.records[0].Email}}', subject: 'Quick question about {{leads.records[0].Company}}', message: '{{enrich}}' }, _ui: { position: { x: 680, y: 160 } } },
      { id: 'confirm',    type: 'NOTIFY',   input: { provider: 'slack', channel: '#sales', message: '📨 Outreach sent to {{leads.totalSize}} new leads.' }, _ui: { position: { x: 960, y: 160 } } },
    ],
  },
  {
    id: 'docker-orchestration', name: '🐳 Docker Health Check → Repair',
    description: 'Docker ps → Agent health analysis → Exec restart unhealthy containers → Slack report.',
    icon: Container, domain: 'devops',
    build: () => [
      { id: 'ps',         type: 'TOOL',     input: { tool: 'docker__ps', args: { all: true } }, _ui: { position: { x: 80,  y: 120 } } },
      { id: 'health',     type: 'AGENT',    input: { goal: 'Check container health from this docker ps output. Identify any stopped or unhealthy containers. Reply with container names to restart or ALL_CLEAN: {{ps}}' }, _ui: { position: { x: 380, y: 120 } } },
      { id: 'check',      type: 'CONDITION', input: {}, routes: [
        { when: 'context.health.includes("ALL_CLEAN")', goto: 'report' },
        { goto: 'restart' },
      ], _ui: { position: { x: 680, y: 120 } } },
      { id: 'restart',    type: 'TOOL',     input: { tool: 'docker__run', args: { image: 'alpine', command: 'echo "restarting..."' } }, _ui: { position: { x: 960, y: 40 } } },
      { id: 'report',     type: 'NOTIFY',   input: { provider: 'slack', channel: '#infra', message: '🐳 Docker health report: {{health}}' }, _ui: { position: { x: 960, y: 210 } } },
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

  // Gather step IDs that are reachable ONLY via conditional routes.
  // Those steps sit on branches and should NOT get a default
  // "next sequential" edge — they only link via the route edges.
  const conditionalTargets = new Set<string>()
  for (const s of steps) {
    if (Array.isArray(s.routes) && s.routes.length > 0) {
      for (const r of s.routes) {
        const target = typeof r.goto === 'number' ? steps[r.goto]?.id : r.goto
        if (target && target !== 'END' && stepIds.has(target)) {
          conditionalTargets.add(target)
        }
      }
    }
  }

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
    } else if (!conditionalTargets.has(s.id)) {
      // Only default to the next sequential step when this step is NOT a
      // conditional branch target.  Branch targets only connect via the
      // route edges defined by the parent CONDITION step.
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
    case 'SCRIPT':    return i.code ? `script · ${String(i.code).slice(0, 40)}…` : 'no code'
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
    case 'SCRIPT':    return i.code ? null : 'Provide JavaScript code'
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
    const wsUrl = `${API_BASE.replace(/^http/, 'ws')}/ws/tenants/${tenantId}/telemetry`
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
        <a
          href="/dashboard"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            padding: '5px 10px', borderRadius: 6, fontSize: 12,
            border: '1px solid var(--border)', background: 'var(--bg-white)',
            color: 'var(--text)', textDecoration: 'none', cursor: 'pointer',
            fontWeight: 600,
          }}
          title="Back to dashboard"
        >
          ← Home
        </a>

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
        <TemplateGallery onPick={loadTemplate} onClose={() => setShowTemplates(false)} tenantId={tenantId} />
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
          agentCount={agents.length}
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
            tenantId={tenantId}
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
  open, onToggle, onAdd, onDragStart, agentCount = 0,
}: {
  open: boolean
  onToggle: () => void
  onAdd: (t: StepType) => void
  onDragStart: (e: React.DragEvent, t: StepType) => void
  agentCount?: number
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
                const badge =
                  t === 'AGENT' && agentCount > 0 ? `${agentCount}` :
                  undefined
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
                    {badge && (
                      <span style={{
                        marginLeft: 'auto', fontSize: 10, fontWeight: 700,
                        background: meta.color + '18', color: meta.color,
                        padding: '1px 6px', borderRadius: 4, minWidth: 18, textAlign: 'center',
                      }}>{badge}</span>
                    )}
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
function TemplateGallery({ onPick, onClose, tenantId }: { onPick: (t: Template) => void; onClose: () => void; tenantId?: string }) {
  const [prompt, setPrompt] = useState('')
  const [generating, setGenerating] = useState(false)
  const [genError, setGenError] = useState('')

  async function handleGenerateFromPrompt() {
    if (!prompt.trim() || generating) return
    setGenerating(true)
    setGenError('')
    try {
      // Dynamic import to keep the bundle light
      const { api } = await import('@/lib/api')
      const result = await api.generateWorkflowFromPrompt(tenantId || '', prompt.trim())
      const t: Template = {
        id: `gen-${Date.now()}`,
        name: result.name || 'AI Generated',
        description: result.description || 'Generated from your prompt.',
        icon: Sparkles,
        domain: 'default',
        build: () => result.steps || [],
      }
      onPick(t)
    } catch (e: any) {
      setGenError(e?.message || 'Failed to generate workflow. Try rephrasing your prompt.')
    } finally {
      setGenerating(false)
    }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 1100,
      display: 'flex', alignItems: 'center', justifyContent: 'center'
    }}>
      <div style={{ background: 'var(--bg-white)', borderRadius: 12, padding: 22, width: 720, maxHeight: '80vh', overflowY: 'auto', boxShadow: '0 24px 64px rgba(0,0,0,0.24)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <div>
            <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 2 }}>Start from a template</h3>
            <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>Common workflow patterns or describe one with AI.</p>
          </div>
          <button onClick={onClose} type="button" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}>
            <X size={18} />
          </button>
        </div>

        {/* ── Generate from prompt (AI) ── */}
        <div style={{ marginBottom: 14, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <textarea
            value={prompt}
            onChange={e => { setPrompt(e.target.value); setGenError('') }}
            onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleGenerateFromPrompt() }}
            placeholder={'Describe what the workflow should do… e.g. "Poll MQTT sensors every 5 minutes, have an AI agent detect anomalies, and SMS the on-call engineer if something is wrong."'}
            rows={2}
            disabled={generating}
            style={{
              flex: 1, padding: '8px 12px', borderRadius: 8, fontSize: 12,
              border: '1px solid var(--border)', background: 'var(--bg)',
              resize: 'none', outline: 'none', fontFamily: 'inherit',
              lineHeight: 1.4,
            }}
          />
          <button
            type="button"
            onClick={handleGenerateFromPrompt}
            disabled={generating || !prompt.trim()}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5, padding: '8px 14px',
              borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer',
              background: prompt.trim() ? 'var(--green, #3f8a43)' : 'var(--border)',
              color: prompt.trim() ? '#fff' : 'var(--text-muted)',
              border: 'none', whiteSpace: 'nowrap', transition: 'background 150ms',
            }}
          >
            {generating ? (
              <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} />
            ) : (
              <Sparkles size={13} />
            )}
            Generate
          </button>
        </div>
        {genError && (
          <p style={{ fontSize: 11, color: '#dc2626', marginTop: -8, marginBottom: 10 }}>{genError}</p>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
          {TEMPLATES.map(t => {
            const Icon = t.icon
            const ds = domainStyle(t.domain)
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
                onMouseEnter={(e) => {
                  const el = e.currentTarget as HTMLButtonElement
                  el.style.borderColor = ds.color
                  el.style.boxShadow = `0 4px 12px ${ds.color}22`
                  el.style.transform = 'translateY(-1px)'
                }}
                onMouseLeave={(e) => {
                  const el = e.currentTarget as HTMLButtonElement
                  el.style.borderColor = 'var(--border)'
                  el.style.boxShadow = 'none'
                  el.style.transform = 'none'
                }}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ display: 'inline-flex', width: 28, height: 28, borderRadius: 6, background: ds.bg, alignItems: 'center', justifyContent: 'center' }}>
                    <Icon size={15} color={ds.color} />
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
function NodeInspector({ node, agents, allStepIds, onChange, onDelete, onDuplicate, onTest, tenantId }: {
  node: Node
  agents: Agent[]
  allStepIds: string[]
  onChange: (patch: Partial<{ id: string; input: any; retry: RetryPolicy | null }>) => void
  onDelete: () => void
  onDuplicate: () => void
  onTest?: () => void
  tenantId?: string
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

  // ── Fetch available connector tools for TOOL step autocomplete ─────────
  const [toolDefs, setToolDefs] = useState<any[]>([])
  const [toolDefsLoaded, setToolDefsLoaded] = useState(false)
  useEffect(() => {
    if (type !== 'TOOL' || !tenantId) { setToolDefs([]); setToolDefsLoaded(false); return }
    let cancelled = false
    ;(async () => {
      try {
        const mod = await import('@/lib/api')
        const r = await mod.api.request(`/tenants/${tenantId}/connectors/tool-definitions`)
        if (!cancelled && r?.data?.tools) { setToolDefs(r.data.tools); setToolDefsLoaded(true) }
      } catch { /* keep static fallback */ }
    })()
    return () => { cancelled = true }
  }, [type, tenantId])

  // Group tool definitions by provider prefix for the picker
  const toolGroups = useMemo(() => {
    const map = new Map<string, { label: string; color: string; tools: any[] }>()
    for (const t of toolDefs || []) {
      const prefix = String(t.name || '').split('__')[0] || 'other'
      if (!map.has(prefix)) {
        const providerMeta = NODE_META.TOOL
        map.set(prefix, { label: prefix, color: providerMeta?.color || '#8b5cf6', tools: [] })
      }
      map.get(prefix)!.tools.push(t)
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [toolDefs])

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
              <input
                className="input"
                placeholder={toolDefs.length > 0 ? 'Type or pick a tool below…' : 'slack__post_message, jira__create_issue…'}
                value={input.tool || ''}
                onChange={e => set({ tool: e.target.value })}
                list="tool-defs-datalist"
              />
              {toolDefs.length > 0 && (
                <datalist id="tool-defs-datalist">
                  {toolDefs.map((t: any) => (
                    <option key={t.name} value={t.name}>{t.description || t.name}</option>
                  ))}
                </datalist>
              )}
              <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>
                Format: <code>&lt;provider&gt;__&lt;operation&gt;</code>. Must match an <strong>active</strong> connector.
                {toolDefsLoaded && toolDefs.length === 0 && ' (No active connectors found — configure one first.)'}
              </p>
              {toolGroups.length > 0 ? (
                <div style={{ marginTop: 8, padding: '6px 10px', background: 'var(--bg)', borderRadius: 6, fontSize: 11, lineHeight: 1.8, maxHeight: 220, overflowY: 'auto' }}>
                  {toolGroups.map(([prefix, grp]) => (
                    <div key={prefix}>
                      <strong style={{ color: 'var(--text)', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>{prefix}</strong>
                      {grp.tools.map((t: any) => (
                        <button
                          key={t.name}
                          type="button"
                          title={t.description || t.name}
                          onClick={() => set({ tool: t.name })}
                          style={{
                            display: 'block', width: '100%', textAlign: 'left',
                            background: input.tool === t.name ? 'var(--brand-light)' : 'transparent',
                            border: 'none', borderRadius: 3, padding: '2px 6px',
                            fontSize: 10, fontFamily: 'monospace', cursor: 'pointer',
                            color: input.tool === t.name ? 'var(--brand)' : 'var(--text-muted)',
                          }}
                        >
                          {t.name}
                          {t.description ? <span style={{ color: 'var(--text-muted)', marginLeft: 6, fontFamily: 'inherit' }}>— {t.description}</span> : null}
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              ) : toolDefsLoaded ? null : (
                <div style={{ marginTop: 8, padding: 10, background: 'var(--bg)', borderRadius: 6, fontSize: 11, lineHeight: 1.7 }}>
                  <strong style={{ color: 'var(--text)' }}>Available prefixes:</strong><br />
                  <code>slack__post_message</code> · <code>slack__list_channels</code><br />
                  <code>jira__create_issue</code> · <code>jira__search_issues</code> · <code>jira__get_issue</code><br />
                  <code>github__search_repos</code> · <code>github__create_issue</code><br />
                  <code>gmail__send</code> · <code>notion__create_page</code> · <code>linear__create_issue</code><br />
                  <code>db__&lt;slug&gt;__query</code> · <code>rest__&lt;slug&gt;__&lt;method&gt;</code><br />
                  <code>local_shell__execute</code> · <code>local_dir__list</code> · <code>webhook__send</code>
                </div>
              )}
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
              <label className="form-label">Provider</label>
              <select
                className="input"
                value={input.provider || 'slack'}
                onChange={e => set({ provider: e.target.value })}
              >
                <option value="slack">Slack</option>
                <option value="gmail">Gmail</option>
                <option value="discord">Discord</option>
                <option value="sendgrid">SendGrid</option>
                <option value="twilio">Twilio (SMS)</option>
              </select>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                Uses the tenant&apos;s active connector for the chosen provider.
              </p>
            </div>
            {(input.provider === 'gmail' || input.provider === 'sendgrid') && (
              <>
                <div className="form-group">
                  <label className="form-label">To</label>
                  <input className="input" placeholder="user@example.com" value={input.channel || ''} onChange={e => set({ channel: e.target.value })} />
                </div>
                <div className="form-group">
                  <label className="form-label">Subject</label>
                  <input className="input" placeholder="Your subject line" value={input.subject || ''} onChange={e => set({ subject: e.target.value })} />
                </div>
              </>
            )}
            {input.provider !== 'gmail' && input.provider !== 'sendgrid' && (
              <div className="form-group">
                <label className="form-label">{input.provider === 'twilio' ? 'Phone number' : input.provider === 'discord' ? 'Channel ID' : 'Slack channel'}</label>
                <input className="input" placeholder={input.provider === 'twilio' ? '+15551234567' : input.provider === 'discord' ? '1234567890' : '#ops or C0123ABC'} value={input.channel || ''} onChange={e => set({ channel: e.target.value })} />
              </div>
            )}
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
          </>
        )}

        {type === 'SCRIPT' && (
          <>
            <div className="form-group">
              <label className="form-label">JavaScript code</label>
              <textarea
                className="input"
                rows={10}
                style={{ fontFamily: 'monospace', fontSize: 12 }}
                placeholder={`// Access context vars directly:\n// const { research, fetch } = context;\n// Return the step output:\nreturn { processed: true, count: items.length };`}
                value={input.code || ''}
                onChange={e => set({ code: e.target.value })}
              />
              <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>
                Sandboxed Node.js. Use <code>context</code> to read prior step outputs. <code>return</code> sets this step&apos;s output. Max 30s execution.
              </p>
            </div>
            <div className="form-group">
              <label className="form-label">Arguments (JSON, optional)</label>
              <textarea
                className="input"
                rows={4}
                style={{ fontFamily: 'monospace', fontSize: 12 }}
                placeholder='{ "threshold": 0.8 }'
                value={typeof input.args === 'string' ? input.args : (input.args ? JSON.stringify(input.args, null, 2) : '')}
                onChange={e => {
                  const raw = e.target.value
                  try { set({ args: raw.trim() ? JSON.parse(raw) : undefined }) }
                  catch { set({ args: raw }) }
                }}
              />
            </div>
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
