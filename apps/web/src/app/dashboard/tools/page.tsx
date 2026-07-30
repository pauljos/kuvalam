'use client'
import { useEffect, useState } from 'react'
import { useApp } from '@/lib/context'
import { api } from '@/lib/api'
import Link from 'next/link'
import { useConfirm } from '@/components/ConfirmModal'

// Tools that are ALWAYS available to every agent on every task (wired directly
// into apps/api/src/services/task.service.js executeTool). These require no
// per-tenant configuration.
// deploymentType: local (runs on user's machine), cloud (SaaS), generic (both)
const BUILTIN_TOOLS = [
  { id: 'http_request',          name: 'HTTP Request',          icon: '🌐', category: 'Core',            description: 'Make GET/POST/PUT/PATCH/DELETE calls to any public HTTP(S) endpoint.',                                                                   enabled: true, deploymentType: 'generic' },
  { id: 'http_download',         name: 'HTTP Download',         icon: '⬇️', category: 'Core',            description: 'Download a file from a URL (max 5 MB).',                                                                                              enabled: true, deploymentType: 'generic' },
  { id: 'a2a_call',              name: 'A2A Agent Call',        icon: '🤝', category: 'Orchestration',   description: 'Delegate a sub-goal to another A2A-compatible agent (internal or external).',                                                              enabled: true, badge: 'A2A', deploymentType: 'generic' },
  { id: 'delegate_task',         name: 'Delegate Task',         icon: '📨', category: 'Orchestration',   description: 'Hand off a sub-goal to another internal agent on this tenant.',                                                                          enabled: true, deploymentType: 'generic' },
  { id: 'browser_use',           name: 'Browser Use',           icon: '🖥️', category: 'Automation',      description: 'Drive a real browser to navigate, click, type, extract and screenshot.',                                                                   enabled: !!process.env.NEXT_PUBLIC_BROWSER_AGENT_URL, requires: 'BROWSER_AGENT_URL env var', deploymentType: 'local' },
  { id: 'file_search',           name: 'File Search',           icon: '🔍', category: 'Automation',      description: 'Search file contents on the filesystem via grep / ripgrep.',                                                                               enabled: true, deploymentType: 'local' },
  { id: 'docker_run',            name: 'Docker Run',            icon: '🐳', category: 'Infrastructure',  description: 'Run commands inside a Docker container on the host.',                                                                                         enabled: true, badge: 'High Risk', deploymentType: 'local' },
  { id: 'ssh_exec',              name: 'SSH Exec',              icon: '🔑', category: 'Infrastructure',  description: 'Execute commands on remote machines via SSH.',                                                                                                enabled: true, badge: 'High Risk', deploymentType: 'generic' },
  { id: 'publish_dashboard_report', name: 'Publish Report',     icon: '📊', category: 'Output',          description: 'Publish a dynamic HTML report to the agent dashboard.',                                                                                       enabled: true, deploymentType: 'generic' },
]

// Tools that appear ONLY when the matching connector on the Connectors page is
// ACTIVE. Displayed here so users can see what actions a given connector unlocks.
const CONNECTOR_BACKED_TOOLS = [
  { id: 'slack__post_message',    name: 'Slack: Post Message',      icon: '💬', connectorId: 'slack',     description: 'Post a message to a Slack channel or thread.', deploymentType: 'cloud' },
  { id: 'slack__update_message',  name: 'Slack: Update Message',    icon: '💬', connectorId: 'slack',     description: 'Edit or update an existing Slack message.', deploymentType: 'cloud' },
  { id: 'slack__list_channels',   name: 'Slack: List Channels',     icon: '💬', connectorId: 'slack',     description: 'List public Slack channels the bot has joined.', deploymentType: 'cloud' },
  { id: 'slack__get_history',     name: 'Slack: Get History',       icon: '💬', connectorId: 'slack',     description: 'Retrieve recent messages from a Slack channel.', deploymentType: 'cloud' },
  { id: 'jira__create_issue',     name: 'Jira: Create Issue',       icon: '📋', connectorId: 'jira',      description: 'Create a Jira issue in the specified project.', deploymentType: 'cloud' },
  { id: 'jira__search_issues',    name: 'Jira: Search Issues',      icon: '📋', connectorId: 'jira',      description: 'Run a JQL search against Jira.', deploymentType: 'cloud' },
  { id: 'github__create_issue',   name: 'GitHub: Create Issue',     icon: '🐙', connectorId: 'github',    description: 'Open a new issue on a GitHub repository.', deploymentType: 'cloud' },
  { id: 'github__search_repos',   name: 'GitHub: Search Repos',     icon: '🐙', connectorId: 'github',    description: 'Search public GitHub repositories.', deploymentType: 'cloud' },
  { id: 'github__get_repo',       name: 'GitHub: Get Repo',         icon: '🐙', connectorId: 'github',    description: 'Fetch metadata for a specific repository.', deploymentType: 'cloud' },
  { id: 'gmail__send_email',      name: 'Gmail: Send Email',        icon: '📧', connectorId: 'gmail',     description: 'Send an email as the connected Gmail user (supports CC, BCC, HTML).', deploymentType: 'cloud' },
  { id: 'gmail__list_messages',   name: 'Gmail: List Messages',     icon: '📧', connectorId: 'gmail',     description: 'List recent emails matching a query.', deploymentType: 'cloud' },
  { id: 'gmail__get_message',     name: 'Gmail: Get Message',       icon: '📧', connectorId: 'gmail',     description: 'Fetch a single email by its Gmail ID.', deploymentType: 'cloud' },
  { id: 'notion__search',         name: 'Notion: Search',           icon: '📝', connectorId: 'notion',    description: 'Search Notion pages and databases.', deploymentType: 'cloud' },
  { id: 'notion__create_page',    name: 'Notion: Create Page',      icon: '📝', connectorId: 'notion',    description: 'Create a new page in Notion.', deploymentType: 'cloud' },
  { id: 'notion__query_database', name: 'Notion: Query Database',   icon: '📝', connectorId: 'notion',    description: 'Query a Notion database with filters.', deploymentType: 'cloud' },
  { id: 'linear__create_issue',   name: 'Linear: Create Issue',     icon: '🔷', connectorId: 'linear',    description: 'Create a new issue in Linear.', deploymentType: 'cloud' },
  { id: 'linear__search_issues',  name: 'Linear: Search Issues',    icon: '🔷', connectorId: 'linear',    description: 'Search Linear issues by query.', deploymentType: 'cloud' },
  { id: 'linear__list_teams',     name: 'Linear: List Teams',       icon: '🔷', connectorId: 'linear',    description: 'List all teams in the Linear workspace.', deploymentType: 'cloud' },
  { id: 'salesforce__query',      name: 'Salesforce: SOQL Query',   icon: '☁️', connectorId: 'salesforce', description: 'Execute a read-only SOQL query against Salesforce.', deploymentType: 'cloud' },
  { id: 'salesforce__create_record', name: 'Salesforce: Create Record', icon: '☁️', connectorId: 'salesforce', description: 'Create a new record in any Salesforce object.', deploymentType: 'cloud' },
  { id: 'webhook__post',          name: 'Webhook: POST',            icon: '🔗', connectorId: 'webhook',   description: 'POST a JSON payload (HMAC-signed if a secret is set) to the configured URL.', deploymentType: 'generic' },
  // Database tools are per-connector (one set per configured DB) and named
  // db__<connIdSlug>__{list_tables|describe_table|sample|query}.
  { id: 'db__…__list_tables',    name: 'DB: List Tables',          icon: '🐘', connectorId: 'database',  description: 'Enumerate schemas + tables with row-count estimates. One tool per configured database.', deploymentType: 'generic' },
  { id: 'db__…__describe_table', name: 'DB: Describe Table',       icon: '🐘', connectorId: 'database',  description: 'Columns, types, primary key, and indexes for a single table.', deploymentType: 'generic' },
  { id: 'db__…__sample',         name: 'DB: Sample Rows',          icon: '🐘', connectorId: 'database',  description: 'Return the first N rows from a table (safe preview, max 50).', deploymentType: 'generic' },
  { id: 'db__…__query',          name: 'DB: Run Query',            icon: '🐘', connectorId: 'database',  description: 'Read-only SELECT with parameter binding. Multi-statement + DDL/DML rejected; result capped at 200 rows.', deploymentType: 'generic' },
  { id: 'rest__<slug>__<op>',    name: 'REST: Custom Operations',  icon: '🌐', connectorId: 'rest',      description: 'Call any custom REST operation defined in a Generic REST API connector.', deploymentType: 'generic' },
  { id: 'docker__run',           name: 'Docker: Run Container',    icon: '🐳', connectorId: 'docker',    description: 'Run a command in a new Docker container (docker run --rm).', deploymentType: 'local' },
  { id: 'docker__exec',          name: 'Docker: Exec in Container',icon: '🐳', connectorId: 'docker',    description: 'Execute a command in an existing running container.', deploymentType: 'local' },
  { id: 'docker__logs',          name: 'Docker: Container Logs',   icon: '🐳', connectorId: 'docker',    description: 'Fetch logs from a container.', deploymentType: 'local' },
  { id: 'docker__ps',            name: 'Docker: List Containers',  icon: '🐳', connectorId: 'docker',    description: 'List running Docker containers.', deploymentType: 'local' },
  { id: 'ssh__exec',             name: 'SSH: Remote Exec',         icon: '🔑', connectorId: 'ssh',       description: 'Execute a command on a remote machine via SSH.', deploymentType: 'generic' },
  { id: 'ssh__upload',           name: 'SSH: Upload File',         icon: '🔑', connectorId: 'ssh',       description: 'Upload a file to a remote machine via SCP.', deploymentType: 'generic' },
  // Cloud Infrastructure
  { id: 'aws__s3_list',          name: 'AWS: List S3 Buckets',     icon: '☁️', connectorId: 'aws',       description: 'List S3 buckets in the account.', deploymentType: 'cloud' },
  { id: 'aws__s3_objects',       name: 'AWS: List S3 Objects',     icon: '☁️', connectorId: 'aws',       description: 'List objects in an S3 bucket with optional prefix filter.', deploymentType: 'cloud' },
  { id: 'aws__ec2_list',         name: 'AWS: List EC2 Instances',  icon: '☁️', connectorId: 'aws',       description: 'List EC2 instances with status and tags.', deploymentType: 'cloud' },
  { id: 'aws__cloudwatch_metrics', name: 'AWS: CloudWatch Metrics',icon: '☁️', connectorId: 'aws',       description: 'Query CloudWatch metric statistics.', deploymentType: 'cloud' },
  { id: 'aws__lambda_invoke',    name: 'AWS: Invoke Lambda',       icon: '☁️', connectorId: 'aws',       description: 'Invoke an AWS Lambda function with a JSON payload.', deploymentType: 'cloud' },
  { id: 'k8s__get',              name: 'K8s: Get Resource',        icon: '☸️', connectorId: 'kubernetes',description: 'Fetch any Kubernetes resource (pods, deployments, services, etc.).', deploymentType: 'generic' },
  { id: 'k8s__logs',             name: 'K8s: Pod Logs',            icon: '☸️', connectorId: 'kubernetes',description: 'Fetch logs from a Kubernetes pod/container.', deploymentType: 'generic' },
  { id: 'k8s__describe',         name: 'K8s: Describe Resource',   icon: '☸️', connectorId: 'kubernetes',description: 'Detailed describe output for a Kubernetes resource.', deploymentType: 'generic' },
  { id: 'terraform__plan',       name: 'Terraform: Plan',          icon: '🏗️', connectorId: 'terraform', description: 'Trigger a speculative plan in Terraform Cloud workspace.', deploymentType: 'cloud' },
  { id: 'terraform__apply',      name: 'Terraform: Apply',         icon: '🏗️', connectorId: 'terraform', description: 'Apply a Terraform run (requires approval).', deploymentType: 'cloud' },
  // IoT & Edge
  { id: 'mqtt__publish',         name: 'MQTT: Publish',            icon: '📡', connectorId: 'mqtt',      description: 'Publish a message to an MQTT topic.', deploymentType: 'generic' },
  { id: 'mqtt__subscribe',       name: 'MQTT: Subscribe',          icon: '📡', connectorId: 'mqtt',      description: 'Subscribe to an MQTT topic and receive messages.', deploymentType: 'generic' },
  { id: 'thingsboard__telemetry',name: 'ThingsBoard: Get Telemetry',icon:'📊', connectorId: 'thingsboard',description: 'Fetch device telemetry by device ID and time range.', deploymentType: 'generic' },
  { id: 'thingsboard__devices',  name: 'ThingsBoard: List Devices',icon: '📊', connectorId: 'thingsboard',description: 'List IoT devices with status and attributes.', deploymentType: 'generic' },
  // Communication
  { id: 'twilio__send_sms',      name: 'Twilio: Send SMS',         icon: '📱', connectorId: 'twilio',    description: 'Send an SMS message to a phone number.', deploymentType: 'cloud' },
  { id: 'twilio__make_call',     name: 'Twilio: Make Call',        icon: '📱', connectorId: 'twilio',    description: 'Initiate a voice call with TwiML instructions.', deploymentType: 'cloud' },
  { id: 'sendgrid__send',        name: 'SendGrid: Send Email',     icon: '✉️', connectorId: 'sendgrid',  description: 'Send a transactional email via SendGrid Mail Send API.', deploymentType: 'cloud' },
  { id: 'sendgrid__stats',       name: 'SendGrid: Email Stats',    icon: '✉️', connectorId: 'sendgrid',  description: 'Query email delivery statistics (opens, clicks, bounces).', deploymentType: 'cloud' },
  { id: 'discord__send',         name: 'Discord: Send Message',    icon: '🎮', connectorId: 'discord',   description: 'Send a message to a Discord channel.', deploymentType: 'cloud' },
  { id: 'discord__list_channels',name: 'Discord: List Channels',   icon: '🎮', connectorId: 'discord',   description: 'List channels in a Discord server.', deploymentType: 'cloud' },
  // Payments & Finance
  { id: 'stripe__customers',     name: 'Stripe: List Customers',   icon: '💳', connectorId: 'stripe',    description: 'Search and list Stripe customers.', deploymentType: 'cloud' },
  { id: 'stripe__payments',      name: 'Stripe: List Payments',    icon: '💳', connectorId: 'stripe',    description: 'List payment intents with status and amount filters.', deploymentType: 'cloud' },
  { id: 'stripe__subscriptions', name: 'Stripe: Subscriptions',    icon: '💳', connectorId: 'stripe',    description: 'List and filter subscriptions.', deploymentType: 'cloud' },
  { id: 'stripe__refund',        name: 'Stripe: Create Refund',    icon: '💳', connectorId: 'stripe',    description: 'Refund a payment intent (requires approval).', deploymentType: 'cloud' },
  // Support & ITSM
  { id: 'zendesk__tickets',      name: 'Zendesk: List Tickets',    icon: '🎧', connectorId: 'zendesk',   description: 'Search and list support tickets with filters.', deploymentType: 'cloud' },
  { id: 'zendesk__create_ticket',name: 'Zendesk: Create Ticket',   icon: '🎧', connectorId: 'zendesk',   description: 'Create a new support ticket.', deploymentType: 'cloud' },
  { id: 'zendesk__update_ticket',name: 'Zendesk: Update Ticket',   icon: '🎧', connectorId: 'zendesk',   description: 'Update ticket status, assignee, or add a comment.', deploymentType: 'cloud' },
  { id: 'servicenow__incidents', name: 'ServiceNow: Incidents',    icon: '🔄', connectorId: 'servicenow',description: 'Query incidents from the incident table.', deploymentType: 'cloud' },
  { id: 'servicenow__changes',   name: 'ServiceNow: Changes',      icon: '🔄', connectorId: 'servicenow',description: 'Query change requests with status filters.', deploymentType: 'cloud' },
  // CRM
  { id: 'hubspot__contacts',     name: 'HubSpot: Contacts',        icon: '🧲', connectorId: 'hubspot',   description: 'Search and list contacts in HubSpot CRM.', deploymentType: 'cloud' },
  { id: 'hubspot__deals',        name: 'HubSpot: Deals',           icon: '🧲', connectorId: 'hubspot',   description: 'List deals with stage and amount filters.', deploymentType: 'cloud' },
  { id: 'hubspot__companies',    name: 'HubSpot: Companies',       icon: '🧲', connectorId: 'hubspot',   description: 'Search companies in HubSpot CRM.', deploymentType: 'cloud' },
  // Data & Analytics
  { id: 'snowflake__query',      name: 'Snowflake: Run Query',     icon: '❄️', connectorId: 'snowflake', description: 'Execute a read-only SQL query on Snowflake.', deploymentType: 'cloud' },
  { id: 'snowflake__tables',     name: 'Snowflake: List Tables',   icon: '❄️', connectorId: 'snowflake', description: 'List tables and views in a schema.', deploymentType: 'cloud' },
  { id: 'elastic__search',       name: 'Elasticsearch: Search',    icon: '🔎', connectorId: 'elasticsearch',description:'Full-text search across indices with query DSL.', deploymentType: 'generic' },
  { id: 'elastic__cluster_health',name:'Elasticsearch: Cluster Health',icon:'🔎',connectorId:'elasticsearch',description:'Check cluster health, node status, and shard allocation.', deploymentType: 'generic' },
  { id: 'redis__get',            name: 'Redis: Get Key',           icon: '🔴', connectorId: 'redis',     description: 'Get the value of a key.', deploymentType: 'generic' },
  { id: 'redis__set',            name: 'Redis: Set Key',           icon: '🔴', connectorId: 'redis',     description: 'Set a key with optional TTL.', deploymentType: 'generic' },
  { id: 'redis__keys',           name: 'Redis: List Keys',         icon: '🔴', connectorId: 'redis',     description: 'List keys matching a pattern (e.g., user:*).', deploymentType: 'generic' },
  // Monitoring
  { id: 'prometheus__query',     name: 'Prometheus: Query',        icon: '🔥', connectorId: 'prometheus',description: 'Run an instant PromQL query.', deploymentType: 'generic' },
  { id: 'prometheus__range',     name: 'Prometheus: Range Query',  icon: '🔥', connectorId: 'prometheus',description: 'Run a range PromQL query over a time window.', deploymentType: 'generic' },
  { id: 'prometheus__alerts',    name: 'Prometheus: Alerts',       icon: '🔥', connectorId: 'prometheus',description: 'List current firing alerts from Alertmanager.', deploymentType: 'generic' },
  { id: 'datadog__metrics',      name: 'Datadog: Query Metrics',   icon: '🐶', connectorId: 'datadog',   description: 'Query timeseries metrics from Datadog.', deploymentType: 'cloud' },
  { id: 'datadog__logs',         name: 'Datadog: Search Logs',     icon: '🐶', connectorId: 'datadog',   description: 'Search and filter logs with Datadog query syntax.', deploymentType: 'cloud' },
  { id: 'datadog__monitors',     name: 'Datadog: List Monitors',   icon: '🐶', connectorId: 'datadog',   description: 'List all monitors with status.', deploymentType: 'cloud' },
  // Documentation
  { id: 'confluence__search',    name: 'Confluence: Search',       icon: '📖', connectorId: 'confluence',description: 'Search Confluence pages by CQL query.', deploymentType: 'cloud' },
  { id: 'confluence__get_page',  name: 'Confluence: Get Page',     icon: '📖', connectorId: 'confluence',description: 'Fetch a Confluence page by ID or title.', deploymentType: 'cloud' },
  { id: 'confluence__create_page',name:'Confluence: Create Page',  icon: '📖', connectorId: 'confluence',description: 'Create a new page in a Confluence space.', deploymentType: 'cloud' },
]

interface McpServer { id: string; name: string; url: string; status: string; tool_count?: number; tools?: string[] }

export default function ToolsPage() {
  const { tenantId, toast } = useApp()
  const { confirm, ConfirmDialog } = useConfirm()
  const [mcpServers, setMcpServers] = useState<McpServer[]>([])
  const [connectors, setConnectors] = useState<Array<{ id: string; tool_id: string; name: string; status: string; config?: any }>>([])
  const [disabledBuiltins, setDisabledBuiltins] = useState<Set<string>>(new Set())
  const [togglingTools, setTogglingTools] = useState<Set<string>>(new Set())
  const [showAddMcp, setShowAddMcp] = useState(false)
  const [mcpForm, setMcpForm] = useState({ name: '', url: '', authToken: '' })
  const [adding, setAdding] = useState(false)
  const [categoryFilter, setCategoryFilter] = useState('All')
  const [search, setSearch] = useState('')

  // Map connector types to their icons
  const CONNECTOR_ICONS: Record<string, string> = {}
  for (const t of CONNECTOR_BACKED_TOOLS) {
    if (!CONNECTOR_ICONS[t.connectorId]) CONNECTOR_ICONS[t.connectorId] = t.icon
  }

  useEffect(() => {
    if (tenantId) { loadMcpServers(); loadConnectors(); loadToolOverrides() }
  }, [tenantId])

  async function loadMcpServers() {
    try {
      const data = await api.listMcpServers(tenantId)
      setMcpServers(data?.servers || [])
    } catch { /* MCP endpoint optional */ }
  }

  async function loadConnectors() {
    try {
      const data = await api.listConnectors(tenantId)
      setConnectors(data?.connectors || data || [])
    } catch { /* silent */ }
  }

  async function loadToolOverrides() {
    try {
      const data = await api.getBuiltinToolOverrides(tenantId)
      const disabled = new Set<string>()
      for (const override of (data?.overrides || [])) {
        if (override.status === 'INACTIVE') disabled.add(override.tool_name)
      }
      setDisabledBuiltins(disabled)
    } catch { /* silent */ }
  }

  function isToolEnabled(toolId: string, hardcodedEnabled: boolean) {
    // A tool is enabled if hardcoded says enabled AND tenant hasn't disabled it
    return hardcodedEnabled && !disabledBuiltins.has(toolId)
  }

  async function toggleBuiltinTool(toolId: string) {
    setTogglingTools(prev => { const next = new Set(prev); next.add(toolId); return next })
    try {
      const data = await api.toggleBuiltinTool(tenantId, toolId)
      const newStatus = data?.status
      setDisabledBuiltins(prev => {
        const next = new Set(prev)
        if (newStatus === 'INACTIVE') next.add(toolId)
        else next.delete(toolId)
        return next
      })
      toast('success', newStatus === 'INACTIVE' ? 'Tool disabled' : 'Tool enabled',
        newStatus === 'INACTIVE' ? `"${toolId}" is now hidden from agents.` : `"${toolId}" is now available to agents.`)
    } catch (err: any) {
      toast('error', 'Toggle failed', err.message)
    } finally {
      setTogglingTools(prev => { const next = new Set(prev); next.delete(toolId); return next })
    }
  }

  function connectorActive(toolId: string) {
    return connectors.some(c => c.tool_id === toolId && c.status === 'ACTIVE')
  }

  async function addMcpServer(e: React.FormEvent) {
    e.preventDefault(); setAdding(true)
    try {
      await api.addMcpServer(tenantId, mcpForm)
      toast('success', 'MCP server added', `"${mcpForm.name}" is now connected.`)
      setMcpForm({ name: '', url: '', authToken: '' }); setShowAddMcp(false); loadMcpServers()
    } catch (err: any) { toast('error', 'Failed to add server', err.message)
    } finally { setAdding(false) }
  }

  async function removeMcpServer(id: string, name: string) {
    const ok = await confirm({
      title: `Remove "${name}"?`,
      description: 'Agents that use this MCP server will lose access to its tools. This action cannot be undone.',
      confirmLabel: 'Remove server',
      variant: 'danger',
    })
    if (!ok) return
    try {
      await api.removeMcpServer(tenantId, id)
      setMcpServers(prev => prev.filter(s => s.id !== id)); toast('info', 'Server removed', '')
    } catch (err: any) { toast('error', 'Remove failed', err.message) }
  }

  async function toggleMcpServer(id: string, name: string, currentStatus: string) {
    try {
      const data = await api.toggleConnector(tenantId, id)
      const newStatus = data?.status
      setMcpServers(prev => prev.map(s => s.id === id ? { ...s, status: newStatus } : s))
      toast('success', newStatus === 'ACTIVE' ? 'MCP server enabled' : 'MCP server disabled',
        `"${name}" is now ${newStatus === 'ACTIVE' ? 'available' : 'hidden'} from agents.`)
    } catch (err: any) {
      toast('error', 'Toggle failed', err.message)
    }
  }

  const CATEGORY_COLORS: Record<string, { bg: string; fg: string; border: string }> = {
    Core:           { bg: '#f0fdf4', fg: '#166534', border: '#bbf7d0' },
    Orchestration:  { bg: '#f5f3ff', fg: '#5b21b6', border: '#ddd6fe' },
    Automation:     { bg: '#fff7ed', fg: '#9a3412', border: '#fed7aa' },
    Infrastructure: { bg: '#fef2f2', fg: '#991b1b', border: '#fecaca' },
    Output:         { bg: '#ecfeff', fg: '#0e7490', border: '#a5f3fc' },
  }

  const DEPLOYMENT_COLORS: Record<string, { bg: string; fg: string; border: string; label: string; icon: string }> = {
    local:   { bg: '#fff7ed', fg: '#9a3412', border: '#fed7aa', label: 'Local',   icon: '🖥️' },
    cloud:   { bg: '#eff6ff', fg: '#1d4ed8', border: '#bfdbfe', label: 'Cloud',   icon: '☁️' },
    generic: { bg: '#f0fdf4', fg: '#166534', border: '#bbf7d0', label: 'Generic', icon: '🌐' },
  }
  const [deploymentFilter, setDeploymentFilter] = useState<'all' | 'local' | 'cloud' | 'generic'>('all')
  const deploymentTypes = ['all', 'local', 'cloud', 'generic'] as const

  const categories = ['All', ...new Set(BUILTIN_TOOLS.map(t => t.category))]
  const filtered = BUILTIN_TOOLS.filter(t =>
    (categoryFilter === 'All' || t.category === categoryFilter) &&
    (deploymentFilter === 'all' || (t as any).deploymentType === deploymentFilter) &&
    (t.name.toLowerCase().includes(search.toLowerCase()) || t.description.toLowerCase().includes(search.toLowerCase()))
  )
  const unlockedConnectorTools = CONNECTOR_BACKED_TOOLS.filter(t => connectorActive(t.connectorId))

  // Per-instance active connections
  const activeInstances = connectors.filter(c => c.status === 'ACTIVE')

  return (
    <div className="animate-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Integrations</h1>
          <p className="page-sub">Every tool available to your agents during task execution</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <span className="badge badge-active" style={{ fontSize: 11 }}>
            {BUILTIN_TOOLS.filter(t => isToolEnabled(t.id, t.enabled)).length + unlockedConnectorTools.length + mcpServers.reduce((n, s) => n + (s.tool_count || 0), 0)} tools available
          </span>
        </div>
      </div>

      <div className="tab-bar" style={{ marginTop: 20 }}>
        <a href="/dashboard/connectors" className="tab-bar-item">Providers</a>
        <a href="/dashboard/tools" className="tab-bar-item active">Tools & MCP</a>
      </div>

      <div className="page-body">
        <div className="card" style={{ padding: 14, marginBottom: 20, display: 'flex', gap: 12, alignItems: 'flex-start', background: 'linear-gradient(135deg, #f0fdf4 0%, #ecfdf5 100%)', border: '1px solid var(--green-border)' }}>
          <span style={{ fontSize: 18, lineHeight: 1.4 }}>🧠</span>
          <div style={{ fontSize: 13, color: 'var(--text-sub)', lineHeight: 1.6 }}>
            <strong>What the LLM sees at planning time</strong> &mdash; tools listed here are injected into every agent's system prompt.
            <br />• <strong>Built-in tools</strong> — always available, zero configuration needed.
            <br />• <strong>Connector-backed tools</strong> — appear automatically when the matching provider is <em>Active</em> in <Link href="/dashboard/connectors" style={{ color: 'var(--green-dark)' }}>Providers</Link>.
            <br />• <strong>MCP tools</strong> — exposed by any Model Context Protocol server registered below.
          </div>
        </div>

        <div className="stats-grid" style={{ marginBottom: 24 }}>
          {[
            { label: 'Built-in Tools', value: BUILTIN_TOOLS.filter(t => isToolEnabled(t.id, t.enabled)).length, icon: '🛠', color: '#7c3aed' },
            { label: 'Connector Tools', value: unlockedConnectorTools.length, icon: '🔌', color: '#059669' },
            { label: 'MCP Servers', value: mcpServers.length, icon: '📡', color: '#2563eb' },
            { label: 'MCP Tools', value: mcpServers.reduce((n, s) => n + (s.tool_count || 0), 0), icon: '⚡', color: '#d97706' },
          ].map(s => (
            <div key={s.label} className="stat-card">
              <div style={{ fontSize: 26, fontWeight: 900, color: s.color }}>{s.icon} {s.value}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>{s.label}</div>
            </div>
          ))}
        </div>

        <div className="card" style={{ padding: 28, marginBottom: 24 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
            <div>
              <h2 style={{ fontSize: 17, fontWeight: 800, marginBottom: 4 }}>Built-in Agent Tools</h2>
              <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                Always available. Wired directly into every agent's tool loop.
                Tools marked <span style={{ background: '#fef2f2', color: '#991b1b', padding: '1px 6px', borderRadius: 4, fontSize: 10, fontWeight: 700 }}>High Risk</span> require human approval in <strong>GUARDED</strong> autonomy mode.
              </p>
            </div>
            <input className="input" placeholder="Search tools..." value={search} onChange={e => setSearch(e.target.value)} style={{ width: 200, fontSize: 13 }} />
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20 }}>
            {categories.map(cat => {
              const colors = CATEGORY_COLORS[cat]
              return (
                <button key={cat} onClick={() => setCategoryFilter(cat)} style={{
                  padding: '5px 14px', borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                  border: `1px solid ${categoryFilter === cat ? (colors?.border || 'var(--green)') : 'var(--border)'}`,
                  background: categoryFilter === cat ? (colors?.bg || 'var(--green-bg)') : 'var(--bg-white)',
                  color: categoryFilter === cat ? (colors?.fg || 'var(--green-dark)') : 'var(--text-muted)',
                }}>{cat}</button>
              )
            })}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20, alignItems: 'center' }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)' }}>Environment:</span>
            {deploymentTypes.map(dt => {
              const isActive = deploymentFilter === dt
              const c = dt === 'all' ? { bg: '#f3f4f6', fg: '#374151', border: '#d1d5db', label: 'All', icon: '' } : DEPLOYMENT_COLORS[dt]
              return (
                <button key={dt} onClick={() => setDeploymentFilter(dt)}
                  style={{
                    fontSize: 11, fontWeight: 600, padding: '4px 12px', borderRadius: 16, border: `1.5px solid ${isActive ? c.fg : c.border}`,
                    background: isActive ? c.bg : 'transparent', color: isActive ? c.fg : 'var(--text-muted)',
                    cursor: 'pointer', transition: 'all 0.15s',
                  }}>
                  {c.icon && <span style={{ marginRight: 3 }}>{c.icon}</span>}{c.label}
                </button>
              )
            })}
          </div>
          {filtered.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)' }}>
              No tools match your search. Try a different keyword.
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
              {filtered.map(tool => {
                const catColors = CATEGORY_COLORS[tool.category]
                const enabled = isToolEnabled(tool.id, tool.enabled)
                const isToggling = togglingTools.has(tool.id)
                const dt = (tool as any).deploymentType as string
                const dtColors = DEPLOYMENT_COLORS[dt]
                return (
                  <div key={tool.id} className="card" style={{
                    padding: 16, display: 'flex', gap: 14,
                    border: `1px solid ${enabled ? (catColors?.border || 'var(--green-border)') : 'var(--border)'}`,
                    background: enabled ? (catColors?.bg || 'var(--bg-white)') : '#f9fafb',
                    opacity: enabled ? 1 : 0.7,
                    transition: 'all 0.2s',
                  }}>
                    <div style={{
                      width: 44, height: 44, borderRadius: 12, flexShrink: 0,
                      background: catColors?.fg ? `${catColors.fg}15` : '#f3f4f6',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22,
                    }}>{tool.icon}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                        <span style={{ fontWeight: 700, fontSize: 13 }}>{tool.name}</span>
                        {(tool as any).badge && (
                          <span style={{
                            fontSize: 9, padding: '2px 6px', borderRadius: 4, fontWeight: 800,
                            background: (tool as any).badge === 'High Risk' ? '#fef2f2' : '#7c3aed20',
                            color: (tool as any).badge === 'High Risk' ? '#991b1b' : '#7c3aed',
                          }}>
                            {(tool as any).badge === 'High Risk' ? '⚠ High Risk' : (tool as any).badge}
                          </span>
                        )}
                        {!tool.enabled ? (
                          <span style={{ marginLeft: 'auto', fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20,
                            background: '#fef3c7', color: '#92400e',
                          }}>
                            ⚙ Config Needed
                          </span>
                        ) : (
                          <button
                            onClick={() => toggleBuiltinTool(tool.id)}
                            disabled={isToggling}
                            title={enabled ? 'Click to disable this tool for all agents' : 'Click to enable this tool for all agents'}
                            style={{
                              marginLeft: 'auto', fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20,
                              border: `1px solid ${enabled ? '#bbf7d0' : '#e5e7eb'}`,
                              background: enabled ? '#d1fae5' : '#f3f4f6',
                              color: enabled ? '#065f46' : '#9ca3af',
                              cursor: 'pointer', transition: 'all 0.15s',
                            }}
                            onMouseOver={e => {
                              e.currentTarget.style.background = enabled ? '#a7f3d0' : '#e5e7eb'
                            }}
                            onMouseOut={e => {
                              e.currentTarget.style.background = enabled ? '#d1fae5' : '#f3f4f6'
                            }}
                          >
                            {isToggling ? '⟳' : enabled ? '● Active' : '○ Off'}
                          </button>
                        )}
                      </div>
                      <p style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: (tool as any).requires ? 6 : 0 }}>{tool.description}</p>
                      {(tool as any).requires && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#d97706', fontWeight: 600, marginTop: 4 }}>
                          <span>⚠</span>
                          <span>Requires: {(tool as any).requires}</span>
                        </div>
                      )}
                      <div style={{ marginTop: 6, display: 'flex', gap: 4 }}>
                        <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 4, background: catColors?.fg ? `${catColors.fg}15` : '#f3f4f6', color: catColors?.fg || '#64748b', fontWeight: 600 }}>
                          {tool.category}
                        </span>
                        {dtColors && (
                          <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 4, background: dtColors.bg, color: dtColors.fg, border: `1px solid ${dtColors.border}`, fontWeight: 600 }}>
                            {dtColors.icon} {dtColors.label}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Connector-backed tools — summary, details live on Providers page */}
        <div className="card" style={{ padding: 28, marginBottom: 24 }}>
          <div style={{ marginBottom: 20 }}>
            <h2 style={{ fontSize: 17, fontWeight: 800, marginBottom: 4 }}>Connector-backed Tools</h2>
            <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
              Tools exposed by your active connectors. Set up and manage connections on the{' '}
              <Link href="/dashboard/connectors" style={{ color: 'var(--green-dark)', fontWeight: 600 }}>Providers</Link> page.
            </p>
          </div>

          {activeInstances.length > 0 ? (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10, marginBottom: 16 }}>
                {activeInstances.map(conn => {
                  const icon = CONNECTOR_ICONS[conn.tool_id] || '🔌'
                  const toolCount = CONNECTOR_BACKED_TOOLS.filter(t => t.connectorId === conn.tool_id).length
                  return (
                    <div key={conn.id} style={{
                      padding: '12px 14px', borderRadius: 8,
                      border: '1px solid var(--green-border)',
                      background: 'var(--green-bg)',
                      display: 'flex', alignItems: 'center', gap: 10,
                    }}>
                      <span style={{ fontSize: 22 }}>{icon}</span>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{conn.name}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{toolCount} tool{toolCount !== 1 ? 's' : ''} available</div>
                      </div>
                    </div>
                  )
                })}
              </div>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                {unlockedConnectorTools.length} total connector tools across {activeInstances.length} active connection{activeInstances.length !== 1 ? 's' : ''}.{' '}
                Open <Link href="/dashboard/connectors" style={{ color: 'var(--green-dark)', fontWeight: 600 }}>Providers</Link> to add more.
              </p>
            </>
          ) : (
            <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--text-muted)' }}>
              <div style={{ fontSize: 32, marginBottom: 8, opacity: 0.5 }}>🔌</div>
              <div style={{ fontSize: 13, marginBottom: 8 }}>No active connectors.</div>
              <Link href="/dashboard/connectors" style={{ color: 'var(--green-dark)', fontWeight: 600, fontSize: 13 }}>
                Set up your first connector →
              </Link>
            </div>
          )}
        </div>

        <div className="card" style={{ padding: 28 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
            <div>
              <h2 style={{ fontSize: 17, fontWeight: 800, marginBottom: 4 }}>MCP Servers</h2>
              <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Connect any <a href="https://modelcontextprotocol.io" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--green-dark)' }}>Model Context Protocol</a> server to give agents access to databases, APIs, file systems, and more.</p>
            </div>
            <button className="btn btn-primary btn-sm" onClick={() => setShowAddMcp(true)}>+ Add MCP Server</button>
          </div>
          {mcpServers.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '48px 0', color: 'var(--text-muted)' }}>
              <div style={{ fontSize: 44, marginBottom: 12, opacity: 0.5 }}>📡</div>
              <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 6 }}>No MCP servers connected</div>
              <div style={{ fontSize: 13, marginBottom: 20, maxWidth: 400, margin: '0 auto 20px' }}>
                MCP servers give agents access to external tools like GitHub APIs, PostgreSQL databases, or local file systems.
              </div>
              <button className="btn btn-primary" onClick={() => setShowAddMcp(true)}>Connect Your First MCP Server</button>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {mcpServers.map(s => {
                const isActive = s.status === 'ACTIVE'
                const isInactive = s.status === 'INACTIVE'
                const isError = s.status === 'ERROR'
                const cardBorder = isActive ? 'var(--green-border)' : isInactive ? '#e5e7eb' : '#fecaca'
                const cardBg = isActive ? 'var(--green-bg)' : isInactive ? '#f9fafb' : '#fef2f2'
                const iconBg = isActive ? '#d1fae5' : isInactive ? '#f3f4f6' : '#fecaca'
                const badgeBg = isActive ? '#d1fae5' : isInactive ? '#f3f4f6' : '#fecaca'
                const badgeColor = isActive ? '#065f46' : isInactive ? '#6b7280' : '#991b1b'
                const badgeLabel = isActive ? '● Active' : isInactive ? '○ Disabled' : '● Error'
                return (
                  <div key={s.id} style={{
                    display: 'flex', alignItems: 'center', gap: 14,
                    padding: '16px 20px', borderRadius: 12,
                    border: `1px solid ${cardBorder}`,
                    background: cardBg,
                    transition: 'all 0.2s',
                  }}>
                    <div style={{
                      width: 44, height: 44, borderRadius: 12, flexShrink: 0,
                      background: iconBg,
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22,
                    }}>🔌</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 2 }}>{s.name}</div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', fontFamily: 'monospace', wordBreak: 'break-all' }}>{s.url}</div>
                      {s.tools && s.tools.length > 0 && (
                        <div style={{ marginTop: 6, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          {s.tools.slice(0, 6).map(t => (
                            <span key={t} style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: isActive ? '#e0f2fe' : '#f3f4f6', color: isActive ? '#0369a1' : '#64748b', fontFamily: 'monospace' }}>
                              {t}
                            </span>
                          ))}
                          {s.tools.length > 6 && (
                            <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: '#f3f4f6', color: '#64748b' }}>
                              +{s.tools.length - 6} more
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 20,
                        background: badgeBg,
                        color: badgeColor,
                      }}>
                        {badgeLabel}
                      </span>
                      {s.tool_count !== undefined && (
                        <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>{s.tool_count} tool{s.tool_count !== 1 ? 's' : ''}</span>
                      )}
                      <button className="btn btn-sm" onClick={() => toggleMcpServer(s.id, s.name, s.status)}
                        style={{ background: 'transparent', color: isActive ? '#f59e0b' : '#10b981', border: `1px solid ${isActive ? '#fde68a' : '#d1fae5'}`,
                          fontSize: 11, padding: '2px 10px' }}>
                        {isActive ? 'Disable' : 'Enable'}
                      </button>
                      <button className="btn btn-sm" onClick={() => removeMcpServer(s.id, s.name)}
                        style={{ background: 'transparent', color: '#ef4444', border: '1px solid #fecaca', fontSize: 11, padding: '2px 10px' }}>
                        Remove
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
          <div style={{ marginTop: 24, padding: '16px 20px', borderRadius: 12, background: 'var(--bg)', border: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-sub)' }}>📋 Quick-start MCP Servers</span>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Click to pre-fill the connection form</span>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {[{ name: 'GitHub MCP', url: 'npx @modelcontextprotocol/server-github', icon: '🐙', desc: 'PRs, issues, repos' },
                { name: 'Postgres MCP', url: 'npx @modelcontextprotocol/server-postgres', icon: '🐘', desc: 'SQL queries' },
                { name: 'Filesystem MCP', url: 'npx @modelcontextprotocol/server-filesystem', icon: '📁', desc: 'Read/write files' },
                { name: 'Brave Search', url: 'npx @modelcontextprotocol/server-brave-search', icon: '🦁', desc: 'Web search' },
                { name: 'Puppeteer MCP', url: 'npx @modelcontextprotocol/server-puppeteer', icon: '🎭', desc: 'Browser automation' }]
                .map(s => (
                  <button key={s.name} onClick={() => { setMcpForm(f => ({ ...f, name: s.name, url: s.url })); setShowAddMcp(true) }}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-white)', cursor: 'pointer', fontSize: 12, fontWeight: 600, color: 'var(--text-sub)', transition: 'all 0.15s' }}
                    onMouseOver={e => e.currentTarget.style.borderColor = 'var(--green)'}
                    onMouseOut={e => e.currentTarget.style.borderColor = 'var(--border)'}>
                    <span style={{ fontSize: 16 }}>{s.icon}</span>
                    <div style={{ textAlign: 'left' }}>
                      <div>{s.name}</div>
                      <div style={{ fontSize: 9, color: 'var(--text-muted)', fontWeight: 400 }}>{s.desc}</div>
                    </div>
                  </button>
                ))}
            </div>
          </div>
        </div>
      </div>

      {showAddMcp && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: 460 }}>
            <div className="modal-header">
              <h2 className="modal-title">Connect MCP Server</h2>
              <button onClick={() => setShowAddMcp(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: 'var(--text-muted)' }}>✕</button>
            </div>
            <form onSubmit={addMcpServer}>
              <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div className="form-group">
                  <label className="form-label">Server Name *</label>
                  <input className="input" placeholder="e.g. GitHub Tools" value={mcpForm.name} onChange={e => setMcpForm(f => ({ ...f, name: e.target.value }))} required />
                </div>
                <div className="form-group">
                  <label className="form-label">Server URL or Command *</label>
                  <input className="input" placeholder="https://mcp.example.com or npx @org/server" value={mcpForm.url} onChange={e => setMcpForm(f => ({ ...f, url: e.target.value }))} required />
                  <span className="form-hint">HTTP/HTTPS endpoints and stdio command strings are supported.</span>
                </div>
                <div className="form-group">
                  <label className="form-label">Auth Token (optional)</label>
                  <input className="input" type="password" placeholder="Bearer token if required" value={mcpForm.authToken} onChange={e => setMcpForm(f => ({ ...f, authToken: e.target.value }))} />
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setShowAddMcp(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={adding}>{adding ? 'Connecting...' : 'Connect Server'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
      {ConfirmDialog}
    </div>
  )
}

