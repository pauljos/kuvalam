'use client'
import { useEffect, useState } from 'react'
import { useApp } from '@/lib/context'
import { api, API_BASE } from '@/lib/api'
import { useConfirm } from '@/components/ConfirmModal'
import RestConnectorForm, { type RestConfig } from '@/components/RestConnectorForm'

const CONNECTORS = [
  {
    id: 'slack',
    name: 'Slack',
    icon: '💬',
    description: 'Send messages, create channels, and notify teams automatically.',
    category: 'Communication',
    deploymentType: 'cloud',
    // Slack is OAuth-first, but also accepts a bot token (xoxb-...) pasted
    // directly — set `hasApiKeyFallback` and the modal shows both options.
    authType: 'OAUTH',
    hasApiKeyFallback: true,
    fallbackLabel: 'Or paste a Slack bot token',
    fallbackFields: [
      { name: 'token', label: 'Bot Token', type: 'password', placeholder: 'xoxb-...' },
    ],
    docsUrl: 'https://api.slack.com/apps',
  },
  {
    id: 'jira',
    name: 'Jira',
    icon: '📋',
    description: 'Create, update, and track Jira issues from agent workflows.',
    category: 'Project Management',
    deploymentType: 'cloud',
    authType: 'API_KEY',
    fields: [
      { name: 'apiKey', label: 'API Token', type: 'password', placeholder: 'ATATT3x...' },
      { name: 'baseUrl', label: 'Jira Base URL', type: 'text', placeholder: 'https://yourorg.atlassian.net' },
      { name: 'email', label: 'Email', type: 'email', placeholder: 'admin@yourorg.com' },
      { name: 'projectKey', label: 'Default Project Key', type: 'text', placeholder: 'ENG (optional)' },
    ],
  },
  {
    id: 'github',
    name: 'GitHub',
    icon: '🐙',
    description: 'Manage repositories, PRs, and issues with AI-powered automation.',
    category: 'Developer Tools',
    deploymentType: 'cloud',
    authType: 'API_KEY',
    fields: [
      { name: 'token', label: 'Personal Access Token', type: 'password', placeholder: 'ghp_...' },
    ],
  },
  {
    id: 'gmail',
    name: 'Gmail',
    icon: '📧',
    description: 'Read, draft, and send emails on behalf of your team.',
    category: 'Communication',
    deploymentType: 'cloud',
    authType: 'OAUTH',
    docsUrl: 'https://console.cloud.google.com',
  },
  {
    id: 'notion',
    name: 'Notion',
    icon: '📝',
    description: 'Create pages, update databases, and manage workspace content.',
    category: 'Productivity',
    deploymentType: 'cloud',
    authType: 'API_KEY',
    fields: [
      { name: 'apiKey', label: 'Integration Secret', type: 'password', placeholder: 'secret_...' },
    ],
  },
  {
    id: 'salesforce',
    name: 'Salesforce',
    icon: '☁️',
    description: 'Query and update CRM records, contacts, and opportunities.',
    category: 'CRM',
    deploymentType: 'cloud',
    authType: 'OAUTH',
    docsUrl: 'https://login.salesforce.com',
  },

  {
    id: 'linear',
    name: 'Linear',
    icon: '🔷',
    description: 'Create and update Linear issues from agent task outputs.',
    category: 'Project Management',
    deploymentType: 'cloud',
    authType: 'API_KEY',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', placeholder: 'lin_api_...' },
    ],
  },
  {
    id: 'webhook',
    name: 'Custom Webhook',
    icon: '🔗',
    description: 'Send structured payloads to any HTTP endpoint on agent events.',
    category: 'Custom',
    deploymentType: 'generic',
    authType: 'API_KEY',
    multiInstance: true,
    fields: [
      { name: 'url', label: 'Endpoint URL', type: 'text', placeholder: 'https://your.api/webhook' },
      { name: 'secret', label: 'Signing Secret (optional)', type: 'password', placeholder: 'whsec_...' },
    ],
  },
  {
    id: 'database',
    name: 'SQL Database',
    icon: '🗄️',
    description: 'Read-only SQL access for PostgreSQL, MySQL or MariaDB so agents can answer questions grounded in your data.',
    category: 'Data',
    deploymentType: 'generic',
    authType: 'API_KEY',
    multiInstance: true,
    fields: [
      { name: 'flavor',   label: 'Database type',     type: 'select',   options: [
          { value: 'postgres', label: 'PostgreSQL' },
          { value: 'mysql',    label: 'MySQL' },
          { value: 'mariadb',  label: 'MariaDB' },
      ], defaultValue: 'postgres' },
      { name: 'host',     label: 'Host',              type: 'text',     placeholder: 'db.example.com' },
      { name: 'port',     label: 'Port',              type: 'text',     placeholder: '5432 (pg) / 3306 (mysql)' },
      { name: 'database', label: 'Database name',     type: 'text',     placeholder: 'app_production' },
      { name: 'user',     label: 'User',              type: 'text',     placeholder: 'kuvalam_readonly' },
      { name: 'password', label: 'Password',          type: 'password', placeholder: '••••••••' },
      { name: 'ssl',      label: 'SSL mode (optional)', type: 'text',   placeholder: 'require | strict (blank = no SSL)', optional: true },
    ],
  },
  // ═══════════════════════════════════════════════════════════════════════
  // Cloud Infrastructure
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'aws',
    name: 'Amazon Web Services',
    icon: '☁️',
    description: 'Manage EC2, S3, Lambda, CloudWatch and 200+ AWS services via agent-driven automation.',
    category: 'Cloud',
    deploymentType: 'cloud',
    authType: 'API_KEY',
    multiInstance: true,
    fields: [
      { name: 'accessKeyId', label: 'Access Key ID', type: 'text', placeholder: 'AKIA...' },
      { name: 'secretAccessKey', label: 'Secret Access Key', type: 'password', placeholder: '••••' },
      { name: 'region', label: 'Default Region', type: 'text', placeholder: 'us-east-1', defaultValue: 'us-east-1' },
    ],
  },
  {
    id: 'kubernetes',
    name: 'Kubernetes',
    icon: '☸️',
    description: 'Execute kubectl commands against any cluster — deploy, scale, troubleshoot, and monitor workloads.',
    category: 'Cloud',
    deploymentType: 'generic',
    authType: 'API_KEY',
    multiInstance: true,
    fields: [
      { name: 'kubeconfig', label: 'Kubeconfig (paste)', type: 'text', placeholder: 'apiVersion: v1\nkind: Config\n...' },
      { name: 'context', label: 'Default Context (optional)', type: 'text', placeholder: 'prod-cluster' },
    ],
  },
  {
    id: 'terraform',
    name: 'Terraform Cloud',
    icon: '🏗️',
    description: 'Manage infrastructure-as-code — plan, apply, and destroy Terraform runs from agent workflows.',
    category: 'Cloud',
    deploymentType: 'cloud',
    authType: 'API_KEY',
    fields: [
      { name: 'apiToken', label: 'Terraform Cloud API Token', type: 'password', placeholder: 'tf-api-...' },
      { name: 'organization', label: 'Organization Name', type: 'text', placeholder: 'my-org' },
    ],
  },
  // ═══════════════════════════════════════════════════════════════════════
  // IoT & Edge
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'mqtt',
    name: 'MQTT Broker',
    icon: '📡',
    description: 'Publish/subscribe to MQTT topics — connect agents to IoT sensors, devices, and edge gateways.',
    category: 'IoT',
    deploymentType: 'generic',
    authType: 'API_KEY',
    multiInstance: true,
    fields: [
      { name: 'brokerUrl', label: 'Broker URL', type: 'text', placeholder: 'mqtt://broker.example.com:1883' },
      { name: 'clientId', label: 'Client ID (optional)', type: 'text', placeholder: 'kuvalam-agent' },
      { name: 'username', label: 'Username (optional)', type: 'text', placeholder: 'device_user' },
      { name: 'password', label: 'Password (optional)', type: 'password', placeholder: '••••' },
    ],
  },
  {
    id: 'thingsboard',
    name: 'ThingsBoard',
    icon: '📊',
    description: 'IoT platform — query device telemetry, manage assets, and trigger rules from agent logic.',
    category: 'IoT',
    deploymentType: 'generic',
    authType: 'API_KEY',
    fields: [
      { name: 'baseUrl', label: 'ThingsBoard URL', type: 'text', placeholder: 'https://thingsboard.example.com' },
      { name: 'apiToken', label: 'JWT Token', type: 'password', placeholder: 'eyJ...' },
    ],
  },
  // ═══════════════════════════════════════════════════════════════════════
  // Communication
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'twilio',
    name: 'Twilio',
    icon: '📱',
    description: 'Send SMS, make voice calls, and manage phone numbers via Twilio Programmable Messaging & Voice.',
    category: 'Communication',
    deploymentType: 'cloud',
    authType: 'API_KEY',
    fields: [
      { name: 'accountSid', label: 'Account SID', type: 'text', placeholder: 'AC...' },
      { name: 'authToken', label: 'Auth Token', type: 'password', placeholder: '••••' },
      { name: 'fromNumber', label: 'From Phone Number', type: 'text', placeholder: '+1234567890' },
    ],
  },
  {
    id: 'sendgrid',
    name: 'SendGrid',
    icon: '✉️',
    description: 'Send transactional emails at scale — welcome emails, alerts, reports via SendGrid Mail API.',
    category: 'Communication',
    deploymentType: 'cloud',
    authType: 'API_KEY',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', placeholder: 'SG....' },
      { name: 'fromEmail', label: 'Default From Email', type: 'email', placeholder: 'agent@yourcompany.com' },
    ],
  },
  {
    id: 'discord',
    name: 'Discord',
    icon: '🎮',
    description: 'Post messages, manage channels, and interact with Discord servers via bot integration.',
    category: 'Communication',
    deploymentType: 'cloud',
    authType: 'API_KEY',
    fields: [
      { name: 'botToken', label: 'Bot Token', type: 'password', placeholder: 'MTE...' },
      { name: 'defaultChannel', label: 'Default Channel ID (optional)', type: 'text', placeholder: '123456789' },
    ],
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp',
    icon: '📱',
    description: 'Live conversational agents over WhatsApp. Agents reply to messages, run queries, and send notifications via Meta Cloud API.',
    category: 'Communication',
    deploymentType: 'cloud',
    authType: 'API_KEY',
    multiInstance: true,
    fields: [
      { name: 'phoneNumberId', label: 'Phone Number ID', type: 'text', placeholder: '123456789012345' },
      { name: 'accessToken', label: 'Access Token', type: 'password', placeholder: 'EAA...' },
      { name: 'verifyToken', label: 'Verify Token (webhook)', type: 'text', placeholder: 'my-custom-token' },
      { name: 'webhookSecret', label: 'App Secret (HMAC validation)', type: 'password', placeholder: 'abc123...', optional: true },
    ],
    docsUrl: 'https://developers.facebook.com/docs/whatsapp/cloud-api',
  },
  {
    id: 'telegram',
    name: 'Telegram',
    icon: '✈️',
    description: 'Live conversational agents over Telegram. Agents reply to DMs and groups, run DB queries, and send notifications via Bot API.',
    category: 'Communication',
    deploymentType: 'cloud',
    authType: 'API_KEY',
    multiInstance: true,
    fields: [
      { name: 'botToken', label: 'Bot Token', type: 'password', placeholder: '123:ABC...' },
      { name: 'secretToken', label: 'Webhook Secret Token (optional)', type: 'text', placeholder: 'my-secret-token', optional: true },
    ],
    docsUrl: 'https://core.telegram.org/bots/api',
  },
  // ═══════════════════════════════════════════════════════════════════════
  // Payments & Finance
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'stripe',
    name: 'Stripe',
    icon: '💳',
    description: 'Query payments, refunds, customers, and subscriptions — automate billing workflows with agents.',
    category: 'Finance',
    deploymentType: 'cloud',
    authType: 'API_KEY',
    fields: [
      { name: 'secretKey', label: 'Secret Key', type: 'password', placeholder: 'sk_live_...' },
      { name: 'webhookSecret', label: 'Webhook Signing Secret (optional)', type: 'password', placeholder: 'whsec_...' },
    ],
  },
  {
    id: 'quickbooks',
    name: 'QuickBooks',
    icon: '📚',
    description: 'Access invoices, expenses, and accounting data via QuickBooks Online API.',
    category: 'Finance',
    deploymentType: 'cloud',
    authType: 'OAUTH',
    docsUrl: 'https://developer.intuit.com',
  },
  // ═══════════════════════════════════════════════════════════════════════
  // Support, ITSM & CRM
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'zendesk',
    name: 'Zendesk',
    icon: '🎧',
    description: 'Create, update, and resolve support tickets — agents can triage and respond to customer issues.',
    category: 'Support',
    deploymentType: 'cloud',
    authType: 'API_KEY',
    fields: [
      { name: 'subdomain', label: 'Subdomain', type: 'text', placeholder: 'yourcompany' },
      { name: 'email', label: 'Agent Email', type: 'email', placeholder: 'bot@yourcompany.com' },
      { name: 'apiToken', label: 'API Token', type: 'password', placeholder: '••••' },
    ],
  },
  {
    id: 'servicenow',
    name: 'ServiceNow',
    icon: '🔄',
    description: 'ITSM automation — manage incidents, change requests, and CMDB records from agent tasks.',
    category: 'Support',
    deploymentType: 'cloud',
    authType: 'API_KEY',
    fields: [
      { name: 'instanceUrl', label: 'Instance URL', type: 'text', placeholder: 'https://dev12345.service-now.com' },
      { name: 'username', label: 'Username', type: 'text', placeholder: 'admin' },
      { name: 'password', label: 'Password', type: 'password', placeholder: '••••' },
    ],
  },
  {
    id: 'hubspot',
    name: 'HubSpot',
    icon: '🧲',
    description: 'CRM automation — manage contacts, deals, companies, and marketing campaigns.',
    category: 'CRM',
    deploymentType: 'cloud',
    authType: 'API_KEY',
    fields: [
      { name: 'apiKey', label: 'Private App Access Token', type: 'password', placeholder: 'pat-...' },
    ],
  },
  // ═══════════════════════════════════════════════════════════════════════
  // Data & Analytics
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'snowflake',
    name: 'Snowflake',
    icon: '❄️',
    description: 'Run analytical SQL queries on petabyte-scale data warehouses — agents can answer questions from your data lake.',
    category: 'Data',
    deploymentType: 'cloud',
    authType: 'API_KEY',
    fields: [
      { name: 'account', label: 'Account Identifier', type: 'text', placeholder: 'xy12345.us-east-1' },
      { name: 'username', label: 'Username', type: 'text', placeholder: 'AGENT_USER' },
      { name: 'password', label: 'Password', type: 'password', placeholder: '••••' },
      { name: 'warehouse', label: 'Warehouse', type: 'text', placeholder: 'COMPUTE_WH' },
      { name: 'database', label: 'Database', type: 'text', placeholder: 'PROD_ANALYTICS' },
      { name: 'schema', label: 'Schema (optional)', type: 'text', placeholder: 'PUBLIC' },
    ],
  },
  {
    id: 'redshift',
    name: 'Amazon Redshift',
    icon: '🔴',
    description: 'Query petabyte-scale data warehouses — agents can run analytical SQL across billions of rows.',
    category: 'Data',
    deploymentType: 'cloud',
    authType: 'API_KEY',
    multiInstance: true,
    fields: [
      { name: 'host', label: 'Host', type: 'text', placeholder: 'my-cluster.xxxxxx.us-east-1.redshift.amazonaws.com' },
      { name: 'port', label: 'Port', type: 'text', placeholder: '5439', defaultValue: '5439' },
      { name: 'database', label: 'Database', type: 'text', placeholder: 'prod_analytics' },
      { name: 'user', label: 'User', type: 'text', placeholder: 'kuvalam_readonly' },
      { name: 'password', label: 'Password', type: 'password', placeholder: '••••••••' },
      { name: 'ssl', label: 'SSL mode (optional)', type: 'text', placeholder: 'require (blank = no SSL)', optional: true },
    ],
  },
  {
    id: 'oracle',
    name: 'Oracle Database',
    icon: '🔶',
    description: 'Connect to Oracle databases for agent-driven queries — supports 19c, 21c, and 23ai.',
    category: 'Data',
    deploymentType: 'generic',
    authType: 'API_KEY',
    multiInstance: true,
    fields: [
      { name: 'host', label: 'Host', type: 'text', placeholder: 'oracle.example.com' },
      { name: 'port', label: 'Port', type: 'text', placeholder: '1521', defaultValue: '1521' },
      { name: 'service', label: 'Service Name or SID', type: 'text', placeholder: 'ORCLPDB1' },
      { name: 'user', label: 'User', type: 'text', placeholder: 'kuvalam_readonly' },
      { name: 'password', label: 'Password', type: 'password', placeholder: '••••••••' },
    ],
  },
  {
    id: 'elasticsearch',
    name: 'Elasticsearch',
    icon: '🔎',
    description: 'Full-text search, log analytics, and vector search — agents can query logs, metrics, and documents.',
    category: 'Data',
    deploymentType: 'generic',
    authType: 'API_KEY',
    fields: [
      { name: 'baseUrl', label: 'Elasticsearch URL', type: 'text', placeholder: 'https://es.example.com:9200' },
      { name: 'apiKey', label: 'Encoded API Key', type: 'password', placeholder: 'ApiKey base64...' },
      { name: 'defaultIndex', label: 'Default Index Pattern (optional)', type: 'text', placeholder: 'logs-*' },
    ],
  },
  {
    id: 'redis',
    name: 'Redis',
    icon: '🔴',
    description: 'Cache and pub/sub — agents can read/write cached data and subscribe to real-time channels.',
    category: 'Data',
    deploymentType: 'generic',
    authType: 'API_KEY',
    fields: [
      { name: 'connectionUrl', label: 'Redis URL', type: 'text', placeholder: 'redis://user:pass@host:6379/0' },
    ],
  },
  // ═══════════════════════════════════════════════════════════════════════
  // Monitoring & Observability
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'prometheus',
    name: 'Prometheus',
    icon: '🔥',
    description: 'Query metrics and alerts — agents can investigate incidents, check SLIs, and trigger runbooks.',
    category: 'Monitoring',
    deploymentType: 'generic',
    authType: 'API_KEY',
    fields: [
      { name: 'baseUrl', label: 'Prometheus URL', type: 'text', placeholder: 'https://prometheus.example.com' },
      { name: 'username', label: 'Basic Auth User (optional)', type: 'text', placeholder: 'admin' },
      { name: 'password', label: 'Basic Auth Password (optional)', type: 'password', placeholder: '••••' },
    ],
  },
  {
    id: 'datadog',
    name: 'Datadog',
    icon: '🐶',
    description: 'Query metrics, logs, and APM traces — agents can investigate incidents and surface actionable insights.',
    category: 'Monitoring',
    deploymentType: 'cloud',
    authType: 'API_KEY',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', placeholder: '••••' },
      { name: 'appKey', label: 'Application Key', type: 'password', placeholder: '••••' },
      { name: 'site', label: 'Datadog Site', type: 'text', placeholder: 'datadoghq.com', defaultValue: 'datadoghq.com' },
    ],
  },
  // ═══════════════════════════════════════════════════════════════════════
  // Documentation & Knowledge
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'confluence',
    name: 'Confluence',
    icon: '📖',
    description: 'Search, create, and update wiki pages — agents can document findings and keep runbooks up to date.',
    category: 'Documentation',
    deploymentType: 'cloud',
    authType: 'API_KEY',
    fields: [
      { name: 'baseUrl', label: 'Confluence URL', type: 'text', placeholder: 'https://yourorg.atlassian.net/wiki' },
      { name: 'email', label: 'Email', type: 'email', placeholder: 'bot@yourorg.com' },
      { name: 'apiToken', label: 'API Token', type: 'password', placeholder: 'ATATT3x...' },
    ],
  },
  // ═══════════════════════════════════════════════════════════════════════
  // Knowledge Infrastructure — Vector DBs & Graph DBs
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'vector-db',
    name: 'Vector Database',
    icon: '🧬',
    description: 'External vector database for semantic search & RAG. Connect Weaviate, Qdrant, Pinecone, Milvus, Chroma, or any pgvector instance.',
    category: 'Knowledge',
    deploymentType: 'generic',
    authType: 'API_KEY',
    multiInstance: true,
    fields: [
      { name: 'kind', label: 'Vector DB Type', type: 'select', options: [
        { value: 'weaviate', label: 'Weaviate' },
        { value: 'qdrant', label: 'Qdrant' },
        { value: 'pinecone', label: 'Pinecone' },
        { value: 'milvus', label: 'Milvus' },
        { value: 'chroma', label: 'Chroma' },
        { value: 'pgvector', label: 'pgvector (external PostgreSQL)' },
      ], defaultValue: 'weaviate' },
      { name: 'baseUrl', label: 'Base URL', type: 'text', placeholder: 'https://your-vector-db:8080' },
      { name: 'apiKey', label: 'API Key', type: 'password', placeholder: '••••' },
      { name: 'collection', label: 'Collection / Index Name', type: 'text', placeholder: 'kuvalam_docs' },
      { name: 'embeddingModel', label: 'Embedding Model', type: 'text', placeholder: 'text-embedding-3-large', defaultValue: 'text-embedding-3-large' },
      { name: 'dimensions', label: 'Vector Dimensions', type: 'text', placeholder: '1536', defaultValue: '1536' },
    ],
  },
  {
    id: 'knowledge-graph',
    name: 'Knowledge Graph',
    icon: '🕸️',
    description: 'Entity-relationship graph for structured knowledge traversal. Connect Neo4j or ArangoDB for graph-based reasoning.',
    category: 'Knowledge',
    deploymentType: 'generic',
    authType: 'API_KEY',
    multiInstance: true,
    fields: [
      { name: 'kind', label: 'Graph Type', type: 'select', options: [
        { value: 'neo4j', label: 'Neo4j (Cypher)' },
        { value: 'arangodb', label: 'ArangoDB (AQL)' },
      ], defaultValue: 'neo4j' },
      { name: 'baseUrl', label: 'URL', type: 'text', placeholder: 'bolt://localhost:7687 (Neo4j) or https://localhost:8529 (ArangoDB)' },
      { name: 'username', label: 'Username', type: 'text', placeholder: 'neo4j' },
      { name: 'password', label: 'Password', type: 'password', placeholder: '••••' },
      { name: 'database', label: 'Database Name', type: 'text', placeholder: 'neo4j', defaultValue: 'neo4j' },
    ],
  },
  // ═══════════════════════════════════════════════════════════════════════
  // Custom / Generic
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'rest',
    name: 'Generic REST API',
    icon: '🌐',
    description: 'Point at any HTTP API. Define baseUrl, auth, and one operation per endpoint — each becomes a tool your agents can call.',
    category: 'Custom',
    deploymentType: 'generic',
    authType: 'API_KEY',
    multiInstance: true,
    // No `fields` — this connector uses a bespoke form (RestConnectorForm).
    fields: [],
  },
]

const LOCAL_CONNECTORS = [
  {
    id: 'local-shell',
    name: 'Local Terminal / Shell',
    icon: '💻',
    description: 'Grant agents the ability to run bash/zsh commands directly on this machine.',
    category: 'Local Machine',
    deploymentType: 'local',
    authType: 'API_KEY',
    multiInstance: true,
    fields: [], // No fields needed
  },
  {
    id: 'local-applescript',
    name: 'Mac Automation',
    icon: '🍎',
    description: 'Execute AppleScript to control macOS desktop applications.',
    category: 'Local Machine',
    deploymentType: 'local',
    authType: 'API_KEY',
    multiInstance: true,
    fields: [],
  },
  {
    id: 'local-dir',
    name: 'Local Directory',
    icon: '📁',
    description: 'Allow agents to read files directly from a local folder on this machine.',
    category: 'Local Machine',
    deploymentType: 'local',
    authType: 'API_KEY',
    multiInstance: true,
    fields: [
      { name: 'path', label: 'Absolute Folder Path', type: 'text', placeholder: '/Users/you/projects/docs' },
    ],
  },
  {
    id: 'docker',
    name: 'Docker Engine',
    icon: '🐳',
    description: 'Run commands in containers, list containers, fetch logs. Requires Docker running on the host.',
    category: 'Infrastructure',
    deploymentType: 'local',
    authType: 'API_KEY',
    multiInstance: true,
    fields: [
      { name: 'socketPath', label: 'Docker Socket (optional)', type: 'text', placeholder: '/var/run/docker.sock' },
    ],
  },
  {
    id: 'ssh',
    name: 'SSH Remote Host',
    icon: '🔑',
    description: 'Execute commands on remote machines via SSH and upload files via SCP. Requires SSH key-based auth.',
    category: 'Infrastructure',
    deploymentType: 'generic',
    authType: 'API_KEY',
    multiInstance: true,
    fields: [
      { name: 'host', label: 'Remote Host', type: 'text', placeholder: 'prod.example.com or 10.0.1.50' },
      { name: 'port', label: 'SSH Port', type: 'text', placeholder: '22', defaultValue: '22' },
      { name: 'user', label: 'SSH User', type: 'text', placeholder: 'root', defaultValue: 'root' },
      { name: 'privateKey', label: 'SSH Private Key Path (optional)', type: 'text', placeholder: '~/.ssh/id_rsa' },
    ],
  },
]

export default function ConnectorsPage() {
  const { tenantId, toast } = useApp()
  const { confirm, ConfirmDialog } = useConfirm()
  const [activeConnections, setActiveConnections] = useState<any[]>([])
  const [configuring, setConfiguring] = useState<typeof CONNECTORS[0] | null>(null)
  const [formValues, setFormValues] = useState<Record<string, string>>({})
  const [restConfig, setRestConfig] = useState<RestConfig | null>(null)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<Record<string, 'ok' | 'fail'>>({})
  const [modalTestState, setModalTestState] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle')
  const [modalTestError, setModalTestError] = useState<string | null>(null)
  const [editingConnection, setEditingConnection] = useState<any | null>(null) // non-null = edit mode

  const [loadingOauth, setLoadingOauth] = useState(false)
  const [existingOauthApp, setExistingOauthApp] = useState<any>(null)

  // BYOC — per-tenant OAuth app credentials the user pastes in the popup.
  // When the API returns OAUTH_APP_NOT_CONFIGURED, we surface a form asking
  // for Client ID / Client Secret rather than falling back to env vars.
  const [oauthAppForm, setOauthAppForm] = useState<{
    show: boolean
    provider: string       // backend provider (google, slack, jira, microsoft, salesforce)
    redirectUri: string
    clientId: string
    clientSecret: string
    saving: boolean
  } | null>(null)

  useEffect(() => {
    if (tenantId) loadConnectors(tenantId)

    // Handle OAuth Callback responses
    const params = new URLSearchParams(window.location.search)
    if (params.get('success') === 'true') {
      toast('success', 'Integration connected!', 'Your connector is now active.')
      window.history.replaceState({}, document.title, window.location.pathname)
    } else if (params.get('error')) {
      toast('error', 'OAuth failed', params.get('error') || 'Connection failed')
      window.history.replaceState({}, document.title, window.location.pathname)
    }
  }, [tenantId])

  // Close the config modal on Escape — matches how the rest of the app
  // handles overlay dismissal.
  useEffect(() => {
    if (!configuring) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setConfiguring(null); setRestConfig(null); setOauthAppForm(null); setModalTestState('idle'); setModalTestError(null) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [configuring])

  async function initiateOAuthFlow(providerId: string) {
    setLoadingOauth(true)
    try {
      const existing = activeConnections.find(c => c.tool_id === providerId && c.auth_type === 'OAUTH2')
      const connectorId = existing?.id || null
      try {
        const data = await api.request(`/tenants/${tenantId}/connectors/oauth/initiate`, {
          method: 'POST',
          body: JSON.stringify({ provider: providerId, service: 'default', connectorId })
        })
        const authUrl = data?.authorizationUrl
        if (authUrl) { window.location.href = authUrl }
        else throw new Error('No authorization URL returned from server')
      } catch (err: any) {
        if (err.code === 'OAUTH_APP_NOT_CONFIGURED') {
          const details = err.details || {}
          setOauthAppForm({
            show: true,
            provider: details.provider || providerId,
            redirectUri: details.redirectUri || `${API_BASE.replace(/\/api\/v1$/, '')}/api/v1/oauth/callback`,
            clientId: '',
            clientSecret: '',
            saving: false
          })
          toast('info', 'One-time setup required',
            `Paste your ${details.provider || providerId} OAuth Client ID and Secret to continue. Nothing is stored in env vars.`)
          return
        }
        throw new Error(err.message || `Failed to initiate OAuth (HTTP ${err.status})`)
      }
    } catch (err: any) {
      toast('error', 'OAuth failed', err.message)
    } finally {
      setLoadingOauth(false)
    }
  }

  async function saveTenantOAuthApp() {
    if (!oauthAppForm || !configuring) return
    setOauthAppForm(f => f && { ...f, saving: true })
    try {
      await api.request(`/tenants/${tenantId}/oauth/apps/${oauthAppForm.provider}`, {
        method: 'PUT',
        body: JSON.stringify({
          clientId: oauthAppForm.clientId.trim(),
          clientSecret: oauthAppForm.clientSecret,
          redirectUri: oauthAppForm.redirectUri
        })
      })
      // Immediately proceed to the OAuth handshake now that creds exist.
      setOauthAppForm(null)
      await initiateOAuthFlow(configuring.id)
    } catch (err: any) {
      toast('error', 'Could not save OAuth app', err.message)
      setOauthAppForm(f => f && { ...f, saving: false })
    }
  }

  async function loadConnectors(tid: string) {
    try {
      const data = await api.request(`/tenants/${tid}/connectors`)
      setActiveConnections(data?.connectors || data || [])
    } catch { /* API may not have this endpoint yet */ }
  }

  function isConnected(toolId: string) {
    return activeConnections.some(c => c.tool_id === toolId && c.status === 'ACTIVE')
  }

  // For OAuth connectors: proactively check if the tenant has registered OAuth credentials.
  // If not, immediately open the BYOC form so the user isn't bounced through a 409 first.
  async function openOAuthConnector(connector: typeof CONNECTORS[0]) {
    setConfiguring(connector)
    setModalTestState('idle')
    setModalTestError(null)
    setOauthAppForm(null)
    setExistingOauthApp(null)
    try {
      const data = await api.request(`/tenants/${tenantId}/oauth/apps/${connector.id}`)
      if (data?.configured) {
        setExistingOauthApp(data)
      } else {
        // Credentials not yet set up — show the registration form immediately
        setOauthAppForm({
          show: true,
          provider: connector.id,
          redirectUri: data?.defaultRedirectUri || `${API_BASE}/api/v1/oauth/callback`,
          clientId: '',
          clientSecret: '',
          saving: false
        })
      }
      // If configured, oauthAppForm stays null → modal shows 'Authorise with X →' button
    } catch {
      // API unreachable — fall through to normal 'Authorise with X →' flow
    }
  }

  async function testAndSave(e: React.FormEvent, authTypeOverride?: string) {
    e.preventDefault()
    if (!configuring) return
    setModalTestState('testing')
    setModalTestError(null)
    setSaving(true)
    let connId: string | null = editingConnection?.id || null
    const isEdit = !!editingConnection
    try {
      const config = configuring.id === 'rest'
        ? (restConfig || { baseUrl: '', auth: { type: 'none' }, operations: [] })
        : { ...(editingConnection?.config || {}), ...formValues }
      // Step 1: Save (create or update)
      const connName = formValues['_name']?.trim() || editingConnection?.name || configuring.name
      if (isEdit) {
        await api.request(`/tenants/${tenantId}/connectors/${connId}`, {
          method: 'PUT',
          body: JSON.stringify({
            name: connName,
            config,
            deploymentType: (configuring as any).deploymentType,
          })
        })
      } else {
        const saveData = await api.request(`/tenants/${tenantId}/connectors`, {
          method: 'POST',
          body: JSON.stringify({
            toolId: configuring.id,
            name: configuring.id === 'rest' && (restConfig?.baseUrl)
              ? (formValues['_name']?.trim() || `REST · ${new URL(restConfig!.baseUrl).host}`)
              : connName,
            authType: authTypeOverride || configuring.authType,
            config,
            deploymentType: (configuring as any).deploymentType,
          })
        })
        connId = saveData?.id
      }

      // Step 2: Test immediately
      const result = await api.request(`/tenants/${tenantId}/connectors/${connId}/test`, {
        method: 'POST'
      })
      const ok = result?.success === true

      if (ok) {
        // Test passed — connector is now ACTIVE
        setModalTestState('ok')
        loadConnectors(tenantId)
        toast('success', isEdit ? 'Connection updated!' : 'Connection verified!',
          isEdit ? `${editingConnection?.name || configuring.name} re-tested and active.` : `${configuring.name} is now active.`)
        setTimeout(() => {
          setConfiguring(null)
          setFormValues({})
          setRestConfig(null)
          setEditingConnection(null)
          setModalTestState('idle')
          setModalTestError(null)
        }, 900)
      } else {
        // Test failed — delete only for new connectors; edit keeps the row (still PENDING)
        const errMsg = result?.message || 'Credentials could not be verified. Check your settings and try again.'
        if (!isEdit && connId) {
          await api.request(`/tenants/${tenantId}/connectors/${connId}`, {
            method: 'DELETE'
          }).catch(() => {})
        }
        setModalTestState('fail')
        setModalTestError(errMsg)
      }
    } catch (err: any) {
      // Clean up if we saved before the error (new connectors only)
      if (!isEdit && connId) {
        await api.request(`/tenants/${tenantId}/connectors/${connId}`, {
          method: 'DELETE'
        }).catch(() => {})
      }
      setModalTestState('fail')
      setModalTestError(err.message || 'An unexpected error occurred.')
    } finally {
      setSaving(false)
    }
  }

  async function removeConnector(connectorId: string) {
    const conn = activeConnections.find(c => c.id === connectorId)
    const ok = await confirm({
      title: `Remove ${conn?.name || 'this connector'}?`,
      description: 'Agents and workflows that use this connector will fail on their next run.',
      confirmLabel: 'Remove connector',
      variant: 'danger',
    })
    if (!ok) return
    try {
      await api.deleteConnector(tenantId, connectorId)
      loadConnectors(tenantId)
      toast('info', 'Connector removed', '')
    } catch { /* silent */ }
  }

  async function testConnector(connectorId: string) {
    setTesting(connectorId)
    try {
      const result = await api.testConnector(tenantId, connectorId)
      const ok = result?.success === true
      setTestResult(prev => ({ ...prev, [connectorId]: ok ? 'ok' : 'fail' }))
      toast(ok ? 'success' : 'error',
        ok ? 'Connector verified' : 'Connector test failed',
        result?.message || (ok ? 'Connected.' : 'Check credentials or provider settings.'))
      loadConnectors(tenantId)
    } catch (err: any) {
      setTestResult(prev => ({ ...prev, [connectorId]: 'fail' }))
      toast('error', 'Connector test failed', err.message)
    } finally {
      setTesting(null)
    }
  }

  const [visibleConnectors, setVisibleConnectors] = useState(CONNECTORS)
  const [deploymentFilter, setDeploymentFilter] = useState<'all' | 'local' | 'cloud' | 'generic'>('all')

  useEffect(() => {
    if (typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
      setVisibleConnectors([...CONNECTORS, ...LOCAL_CONNECTORS])
    }
  }, [])

  const DEPLOYMENT_COLORS: Record<string, { bg: string; fg: string; border: string; label: string; icon: string }> = {
    local:   { bg: '#fff7ed', fg: '#9a3412', border: '#fed7aa', label: 'Local',   icon: '🖥️' },
    cloud:   { bg: '#eff6ff', fg: '#1d4ed8', border: '#bfdbfe', label: 'Cloud',   icon: '☁️' },
    generic: { bg: '#f0fdf4', fg: '#166534', border: '#bbf7d0', label: 'Generic', icon: '🌐' },
  }

  const deploymentTypes = ['all', 'local', 'cloud', 'generic'] as const

  const filteredByDeployment = deploymentFilter === 'all'
    ? visibleConnectors
    : visibleConnectors.filter(c => (c as any).deploymentType === deploymentFilter)

  const categories = [...new Set(filteredByDeployment.map(c => c.category))]

  return (
    <div className="animate-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Integrations</h1>
          <p className="page-sub">Connect your tools and services so agents can act on your behalf</p>
        </div>
        {activeConnections.length > 0 && (
          <div style={{ display: 'flex', gap: 8 }}>
            <span className="badge badge-active" style={{ fontSize: 11 }}>
              ● {activeConnections.filter(c => c.status === 'ACTIVE').length} Active
            </span>
            {activeConnections.filter(c => c.status === 'ERROR').length > 0 && (
              <span className="badge badge-expired" style={{ fontSize: 11 }}>
                ✕ {activeConnections.filter(c => c.status === 'ERROR').length} Error
              </span>
            )}
            {activeConnections.filter(c => c.status === 'PENDING').length > 0 && (
              <span className="badge badge-awaiting_approval" style={{ fontSize: 11 }}>
                ○ {activeConnections.filter(c => c.status === 'PENDING').length} Pending
              </span>
            )}
          </div>
        )}
      </div>

      <div className="tab-bar" style={{ marginTop: 20 }}>
        <a href="/dashboard/connectors" className="tab-bar-item active">Providers</a>
        <a href="/dashboard/tools" className="tab-bar-item">Tools & MCP</a>
      </div>

      <div className="page-body">
        {/* How Connectors relate to Tools */}
        <div className="card" style={{ padding: 14, marginBottom: 20, display: 'flex', gap: 12, alignItems: 'flex-start', background: 'linear-gradient(135deg, #f0fdf4 0%, #ecfdf5 100%)', border: '1px solid var(--green-border)' }}>
          <span style={{ fontSize: 18, lineHeight: 1.4 }}>🔑</span>
          <div style={{ fontSize: 13, color: 'var(--text-sub)', lineHeight: 1.6 }}>
            <strong>Providers are credential stores</strong> — think of them as the account your agent acts through.
            Once a provider is <em>Active</em> (passes the Test), the matching tools appear on
            <a href="/dashboard/tools" style={{ color: 'var(--green-dark)' }}> Tools &amp; MCP</a> and become
            callable by every agent on this tenant. New providers start as <em>Pending</em> until verified.
          </div>
        </div>
        {/* Deployment type filter */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginRight: 4 }}>Environment:</span>
          {deploymentTypes.map(dt => {
            const isActive = deploymentFilter === dt
            const c = dt === 'all' ? { bg: '#f3f4f6', fg: '#374151', border: '#d1d5db', label: 'All', icon: '' } : DEPLOYMENT_COLORS[dt]
            return (
              <button key={dt} onClick={() => setDeploymentFilter(dt)}
                style={{
                  fontSize: 12, fontWeight: 600, padding: '6px 14px', borderRadius: 20, border: `1.5px solid ${isActive ? c.fg : c.border}`,
                  background: isActive ? c.bg : 'transparent', color: isActive ? c.fg : 'var(--text-muted)',
                  cursor: 'pointer', transition: 'all 0.15s',
                }}>
                {c.icon && <span style={{ marginRight: 4 }}>{c.icon}</span>}{c.label}
              </button>
            )
          })}
        </div>

        {/* Configured Connections (Active + Pending + Error) */}
        {activeConnections.length > 0 && (
          <div className="card" style={{ padding: 24, marginBottom: 28 }}>
            <h2 style={{ fontSize: 15, fontWeight: 800, marginBottom: 16 }}>Configured Connections</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {activeConnections.map(conn => {
                const def = [...CONNECTORS, ...LOCAL_CONNECTORS].find(c => c.id === conn.tool_id)
                const isActive = conn.status === 'ACTIVE'
                const isError = conn.status === 'ERROR'
                const dt = conn.deployment_type || (def as any)?.deploymentType || 'cloud'
                const dtColors = DEPLOYMENT_COLORS[dt] || DEPLOYMENT_COLORS['cloud']
                return (
                  <div key={conn.id} style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '14px 18px', borderRadius: 10,
                    border: `1px solid ${isActive ? 'var(--green-border)' : isError ? '#fecaca' : '#fef3c7'}`,
                    background: isActive ? 'var(--green-bg)' : isError ? '#fef2f2' : '#fffbeb',
                    transition: 'all 0.2s',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <div style={{
                        width: 40, height: 40, borderRadius: 10, flexShrink: 0,
                        background: isActive ? '#d1fae5' : isError ? '#fecaca' : '#fef3c7',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20,
                      }}>
                        {def?.icon || '🔗'}
                      </div>
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontWeight: 700, fontSize: 14 }}>{conn.name}</span>
                          {dtColors && (
                            <span style={{
                              fontSize: 9, fontWeight: 700, padding: '2px 8px', borderRadius: 10,
                              background: dtColors.bg, color: dtColors.fg, border: `1px solid ${dtColors.border}`,
                            }}>
                              {dtColors.icon} {dtColors.label}
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                          Connected {new Date(conn.created_at).toLocaleDateString()}
                          {conn.last_tested_at && ` · Tested ${new Date(conn.last_tested_at).toLocaleDateString()}`}
                        </div>
                        {isError && conn.last_error && (
                          <div style={{ fontSize: 11, color: '#991b1b', marginTop: 4, maxWidth: 400 }}>⚠ {conn.last_error}</div>
                        )}
                        {conn.status === 'PENDING' && (
                          <div style={{ fontSize: 11, color: '#92400e', marginTop: 4 }}>
                            {conn.auth_type === 'OAUTH2'
                              ? 'Awaiting OAuth authorisation — click Reconnect to retry.'
                              : 'Click "Test" to verify credentials and activate.'}
                          </div>
                        )}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span style={{
                        fontSize: 11, fontWeight: 700, padding: '4px 12px', borderRadius: 20,
                        background: isActive ? '#d1fae5' : isError ? '#fecaca' : '#fef3c7',
                        color: isActive ? '#065f46' : isError ? '#991b1b' : '#92400e',
                      }}>
                        {isActive ? '● Active' : isError ? '● Error' : '○ Pending'}
                      </span>
                      <button className="btn btn-secondary btn-sm" disabled={testing === conn.id}
                        onClick={() => testConnector(conn.id)}
                        style={{ fontSize: 12, padding: '4px 12px' }}>
                        {testing === conn.id ? (
                          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>⟳ Testing...</span>
                        ) : 'Test'}
                      </button>
                      {conn.auth_type !== 'OAUTH2' && (
                        <button className="btn btn-sm" onClick={() => {
                          const def = [...CONNECTORS, ...LOCAL_CONNECTORS].find(c => c.id === conn.tool_id)
                          if (def) {
                            setEditingConnection(conn)
                            setConfiguring(def)
                            setModalTestState('idle')
                            setModalTestError(null)
                            const seeded: Record<string, string> = {}
                            for (const f of (def.fields || [])) {
                              const val = conn.config?.[f.name] || conn.config?.connection_string || ''
                              if (val) seeded[f.name] = val
                            }
                            // Carry over name
                            if (conn.name) seeded['_name'] = conn.name
                            setFormValues(seeded)
                            if (def.id === 'rest') {
                              setRestConfig(conn.config as any || null)
                            }
                          }
                        }}
                          style={{ background: 'transparent', color: 'var(--text-sub)', border: '1px solid var(--border)', fontSize: 12, padding: '4px 12px' }}>
                          Edit
                        </button>
                      )}
                      <button className="btn btn-sm" onClick={() => removeConnector(conn.id)}
                        style={{ background: '#FEF2F2', color: '#dc2626', border: '1px solid #FECACA', fontSize: 12, padding: '4px 12px' }}>Remove</button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Connector Catalogue by Category */}
        {categories.map(category => (
          <div key={category} style={{ marginBottom: 32 }}>
            <h2 style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: 14 }}>
              {category}
            </h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16 }}>
              {filteredByDeployment.filter(c => c.category === category).map(connector => {
                const connected = isConnected(connector.id)
                const isMulti = !!(connector as any).multiInstance
                const instanceCount = activeConnections.filter(c => c.tool_id === connector.id && c.status === 'ACTIVE').length
                // Multi-instance connectors always show "+ Connect"; single-instance switches to "Reconfigure"
                const showConnect = isMulti || !connected
                const dt = ((connector as any).deploymentType as string) || 'generic'
                const dtColors = DEPLOYMENT_COLORS[dt] || DEPLOYMENT_COLORS['generic']
                return (
                  <div key={connector.id} className="card card-hover" style={{
                    padding: 24, transition: 'all 0.2s',
                    border: connected ? '1px solid var(--green-border)' : '1px solid var(--border)',
                    background: connected ? 'var(--green-bg)' : 'var(--bg-white)',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: 16 }}>
                      <div style={{
                        width: 48, height: 48, borderRadius: 14, flexShrink: 0,
                        background: connected ? '#d1fae5' : '#f3f4f6',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 26,
                      }}>
                        {connector.icon}
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                          <h3 style={{ fontSize: 16, fontWeight: 800 }}>{connector.name}</h3>
                          {dtColors && (
                            <span style={{
                              fontSize: 9, fontWeight: 700, padding: '2px 8px', borderRadius: 10,
                              background: dtColors.bg, color: dtColors.fg, border: `1px solid ${dtColors.border}`,
                              whiteSpace: 'nowrap',
                            }}>
                              {dtColors.icon} {dtColors.label}
                            </span>
                          )}
                          {isMulti && instanceCount > 0 && (
                            <span className="badge badge-active" style={{ fontSize: 9, padding: '2px 8px' }}>
                              {instanceCount} connected
                            </span>
                          )}
                          {!isMulti && connected && (
                            <span className="badge badge-active" style={{ fontSize: 9, padding: '2px 8px' }}>Connected</span>
                          )}
                        </div>
                        <p style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5, margin: 0 }}>{connector.description}</p>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      {showConnect ? (
                        <button className="btn btn-primary btn-sm" style={{ flex: 1 }}
                          onClick={() => {
                            if (connector.authType === 'OAUTH') {
                              openOAuthConnector(connector)
                            } else {
                              setConfiguring(connector)
                              setModalTestState('idle')
                              setModalTestError(null)
                              const seeded: Record<string, string> = {}
                              for (const f of (connector.fields || [])) {
                                const d = (f as { defaultValue?: string }).defaultValue
                                if (d) seeded[f.name] = d
                              }
                              setFormValues(seeded)
                            }
                          }}>
                          {isMulti && instanceCount > 0 ? '+ Add Another' : '+ Connect'}
                        </button>
                      ) : (
                        <button className="btn btn-secondary btn-sm" style={{ flex: 1 }}
                          onClick={() => {
                            if (connector.authType === 'OAUTH') {
                              openOAuthConnector(connector)
                            } else {
                              setConfiguring(connector)
                              setModalTestState('idle')
                              setModalTestError(null)
                            }
                          }}>
                          Reconfigure
                        </button>
                      )}
                      <span style={{
                        fontSize: 10, padding: '4px 10px', borderRadius: 6, fontWeight: 600,
                        background: connector.authType === 'OAUTH' ? '#eff6ff' : '#f0fdf4',
                        border: `1px solid ${connector.authType === 'OAUTH' ? '#bfdbfe' : '#bbf7d0'}`,
                        color: connector.authType === 'OAUTH' ? '#1d4ed8' : '#166534',
                        display: 'flex', alignItems: 'center',
                      }}>
                        {connector.authType === 'OAUTH' ? '🔑 OAuth' : '🔐 API Key'}
                      </span>
                    </div>
                    {/* Show tool count hint */}
                    <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-muted)' }}>
                      {connector.id === 'slack' ? <span>Unlocks <strong>5</strong> agent tools</span> :
                       connector.id === 'jira' ? <span>Unlocks <strong>2</strong> agent tools</span> :
                       connector.id === 'github' ? <span>Unlocks <strong>3</strong> agent tools</span> :
                       connector.id === 'gmail' ? <span>Unlocks <strong>3</strong> agent tools</span> :
                       connector.id === 'notion' ? <span>Unlocks <strong>4</strong> agent tools</span> :
                       connector.id === 'linear' ? <span>Unlocks <strong>3</strong> agent tools</span> :
                       connector.id === 'salesforce' ? <span>Unlocks <strong>2</strong> agent tools</span> :
                       connector.id === 'webhook' ? <span>Unlocks <strong>1</strong> agent tool</span> :
                       connector.id === 'database' ? <span>Unlocks <strong>4</strong> database tools per connector</span> :
                       connector.id === 'rest' ? <span>Unlocks custom tools per defined operation</span> :
                       connector.id === 'aws' ? <span>Unlocks <strong>5</strong> AWS tools</span> :
                       connector.id === 'kubernetes' ? <span>Unlocks <strong>3</strong> kubectl tools</span> :
                       connector.id === 'terraform' ? <span>Unlocks <strong>2</strong> IaC tools</span> :
                       connector.id === 'mqtt' ? <span>Unlocks <strong>2</strong> MQTT tools</span> :
                       connector.id === 'thingsboard' ? <span>Unlocks <strong>2</strong> IoT tools</span> :
                       connector.id === 'twilio' ? <span>Unlocks <strong>2</strong> communication tools</span> :
                       connector.id === 'sendgrid' ? <span>Unlocks <strong>2</strong> email tools</span> :
                       connector.id === 'discord' ? <span>Unlocks <strong>2</strong> chat tools</span> :
                       connector.id === 'whatsapp' ? <span>Unlocks <strong>2</strong> messaging tools</span> :
                       connector.id === 'telegram' ? <span>Unlocks <strong>2</strong> messaging tools</span> :
                       connector.id === 'stripe' ? <span>Unlocks <strong>4</strong> payment tools</span> :
                       connector.id === 'zendesk' ? <span>Unlocks <strong>3</strong> support tools</span> :
                       connector.id === 'servicenow' ? <span>Unlocks <strong>2</strong> ITSM tools</span> :
                       connector.id === 'hubspot' ? <span>Unlocks <strong>3</strong> CRM tools</span> :
                       connector.id === 'snowflake' ? <span>Unlocks <strong>2</strong> analytics tools</span> :
                       connector.id === 'elasticsearch' ? <span>Unlocks <strong>2</strong> search tools</span> :
                       connector.id === 'redis' ? <span>Unlocks <strong>3</strong> cache tools</span> :
                       connector.id === 'prometheus' ? <span>Unlocks <strong>3</strong> monitoring tools</span> :
                       connector.id === 'datadog' ? <span>Unlocks <strong>3</strong> observability tools</span> :
                       connector.id === 'confluence' ? <span>Unlocks <strong>3</strong> wiki tools</span> :
                       connector.id === 'docker' ? <span>Unlocks <strong>4</strong> container tools</span> :
                       connector.id === 'ssh' ? <span>Unlocks <strong>2</strong> remote exec tools</span> :
                       <span>&nbsp;</span>}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Config Modal */}
      {configuring && (
        <div
          className="modal-overlay"
          onClick={(e) => {
            // Only close when the click hits the backdrop itself
            if (e.target === e.currentTarget) {
              setConfiguring(null); setRestConfig(null); setOauthAppForm(null); setModalTestState('idle'); setModalTestError(null)
            }
          }}
        >
          <div className="modal" style={{ maxWidth: configuring.id === 'rest' ? 780 : 480 }}>
            <div className="modal-header">
              <h2 className="modal-title">{configuring.icon} {editingConnection ? 'Edit' : 'Connect'} {configuring.name}</h2>
              <button onClick={() => { setConfiguring(null); setRestConfig(null); setOauthAppForm(null); setEditingConnection(null); setModalTestState('idle'); setModalTestError(null) }}
                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 18 }}>✕</button>
            </div>
            {configuring.authType === 'OAUTH' ? (
              <>
                <div className="modal-body" style={{ padding: '28px 24px 16px' }}>
                  <div style={{ textAlign: 'center', marginBottom: 20 }}>
                    <div style={{ fontSize: 44, marginBottom: 12 }}>{configuring.icon}</div>
                    <p style={{ color: 'var(--text-sub)', margin: 0, lineHeight: 1.6, fontSize: 13 }}>
                      {configuring.name} uses OAuth 2.0. You'll be redirected to {configuring.name} to grant access, then bounced back here.
                    </p>
                    <p style={{ color: 'var(--text-muted)', margin: '10px 0 0', fontSize: 11, lineHeight: 1.5 }}>
                      Being signed into {configuring.name} in your browser isn't enough &mdash; you have to grant this app explicit permission from here.
                    </p>
                  </div>

                  {oauthAppForm?.show ? (
                    // BYOC form — collect Client ID / Secret in the popup so
                    // production installs never require .env-based secrets.
                    <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 8, padding: 16 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>
                        Register your {configuring.name} OAuth app (one-time setup)
                      </div>
                      <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '0 0 12px', lineHeight: 1.5 }}>
                        To connect {configuring.name}, create an OAuth 2.0 Client ID in the {configuring.name} developer console.
                        Set the <strong>Authorised redirect URI</strong> to the value below, then paste your Client ID and Secret here.
                        These are saved encrypted to your tenant — you only do this once.
                      </p>
                      <div className="form-group" style={{ marginBottom: 10 }}>
                        <label className="form-label" style={{ fontSize: 11 }}>Authorised redirect URI (copy into provider console)</label>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <input className="input" readOnly value={oauthAppForm.redirectUri}
                            style={{ fontSize: 11, fontFamily: 'monospace' }} onFocus={e => e.currentTarget.select()} />
                          <button type="button" className="btn btn-secondary btn-sm"
                            onClick={() => { navigator.clipboard?.writeText(oauthAppForm.redirectUri); toast('success', 'Copied', 'Redirect URI copied to clipboard') }}>
                            Copy
                          </button>
                        </div>
                      </div>
                      <div className="form-group" style={{ marginBottom: 10 }}>
                        <label className="form-label" style={{ fontSize: 11 }}>Client ID</label>
                        <input
                          className="input"
                          type="text"
                          autoFocus
                          placeholder="e.g. 123456789-abc.apps.googleusercontent.com"
                          value={oauthAppForm.clientId}
                          onChange={e => setOauthAppForm(f => f && { ...f, clientId: e.target.value })}
                        />
                      </div>
                      <div className="form-group" style={{ marginBottom: 14 }}>
                        <label className="form-label" style={{ fontSize: 11 }}>Client Secret</label>
                        <input
                          className="input"
                          type="password"
                          placeholder="Stored encrypted (AES-256-GCM)"
                          value={oauthAppForm.clientSecret}
                          onChange={e => setOauthAppForm(f => f && { ...f, clientSecret: e.target.value })}
                        />
                      </div>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button type="button" className="btn btn-secondary" style={{ flex: 1 }}
                          onClick={() => setOauthAppForm(null)} disabled={oauthAppForm.saving}>
                          Cancel
                        </button>
                        <button type="button" className="btn btn-primary" style={{ flex: 1 }}
                          onClick={saveTenantOAuthApp}
                          disabled={oauthAppForm.saving || !oauthAppForm.clientId.trim() || !oauthAppForm.clientSecret}>
                          {oauthAppForm.saving ? 'Saving…' : 'Save & Authorise →'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <button
                        onClick={() => initiateOAuthFlow(configuring.id)}
                        className="btn btn-primary"
                        disabled={loadingOauth}
                        style={{ width: '100%', justifyContent: 'center' }}
                      >
                        {loadingOauth ? 'Initiating...' : `Authorise with ${configuring.name} →`}
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={async () => {
                          console.log('DEBUG: Update button clicked!', { configuring, existingOauthApp })
                          setOauthAppForm({
                            show: true,
                            provider: configuring.id,
                            redirectUri: existingOauthApp?.redirectUri || `${API_BASE}/api/v1/oauth/callback`,
                            clientId: existingOauthApp?.clientId || '',
                            clientSecret: existingOauthApp ? '••••••••' : '',
                            saving: false
                          })
                        }}
                        style={{ width: '100%', justifyContent: 'center', marginTop: 10 }}
                      >
                        ⚙️ Update Client ID & Secret
                      </button>
                      {configuring.docsUrl && (
                        <div style={{ textAlign: 'center', marginTop: 10 }}>
                          <a href={configuring.docsUrl} target="_blank" rel="noreferrer"
                             style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                            Setup guide ↗
                          </a>
                        </div>
                      )}
                    </>
                  )}

                  {(configuring as { hasApiKeyFallback?: boolean }).hasApiKeyFallback && (
                    <>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '20px 0 14px' }}>
                        <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
                        <span style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1 }}>OR</span>
                        <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
                      </div>
                      <form
                        onSubmit={async (e) => {
                          await testAndSave(e, 'API_KEY')
                        }}
                      >
                        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-sub)', marginBottom: 10 }}>
                          {(configuring as { fallbackLabel?: string }).fallbackLabel || 'Paste an API token instead'}
                        </div>
                        {((configuring as { fallbackFields?: Array<{ name: string; label: string; type: string; placeholder?: string }> }).fallbackFields || []).map(field => (
                          <div key={field.name} className="form-group" style={{ marginBottom: 12 }}>
                            <label className="form-label">{field.label}</label>
                            <input
                              className="input"
                              type={field.type}
                              placeholder={field.placeholder}
                              value={formValues[field.name] || ''}
                              onChange={ev => setFormValues(v => ({ ...v, [field.name]: ev.target.value }))}
                              required
                            />
                          </div>
                        ))}
                        {modalTestState === 'fail' && modalTestError && (
                          <div style={{ padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, color: '#991b1b', fontSize: 12, marginBottom: 8 }}>
                            ⚠ {modalTestError}
                          </div>
                        )}
                        <button type="submit" className="btn btn-secondary btn-sm" disabled={saving || modalTestState === 'testing'} style={{ width: '100%', justifyContent: 'center' }}>
                          {modalTestState === 'testing' ? '⏳ Testing…' : modalTestState === 'ok' ? '✓ Connected!' : 'Test & Connect'}
                        </button>
                      </form>
                    </>
                  )}
                </div>
              </>
            ) : configuring.id === 'rest' ? (
              <form onSubmit={testAndSave}>
                <div className="modal-body" style={{ maxHeight: '70vh', overflowY: 'auto' }}>
                  <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>
                    Configure a REST API. Each operation you define becomes a callable tool for your agents.
                  </p>
                  <div className="form-group" style={{ marginBottom: 12 }}>
                    <label className="form-label">Connection Name *</label>
                    <input
                      className="input"
                      placeholder="e.g. Stripe API, Weather Service…"
                      value={formValues['_name'] || ''}
                      onChange={e => setFormValues(v => ({ ...v, _name: e.target.value }))}
                      required
                    />
                  </div>
                  <RestConnectorForm
                    initial={restConfig || undefined}
                    onChange={setRestConfig}
                  />
                </div>
                {modalTestState === 'fail' && modalTestError && (
                  <div style={{ padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, color: '#991b1b', fontSize: 12, marginBottom: 12 }}>
                    ⚠ {modalTestError}
                  </div>
                )}
                <div className="modal-footer">
                  <button type="button" className="btn btn-secondary" onClick={() => { setConfiguring(null); setRestConfig(null); setEditingConnection(null); setModalTestState('idle'); setModalTestError(null) }}>Cancel</button>
                  <button type="submit" className="btn btn-primary" disabled={saving || modalTestState === 'testing' || !restConfig?.baseUrl || (restConfig?.operations?.length || 0) === 0}>
                    {modalTestState === 'testing' ? '⏳ Testing…' : modalTestState === 'ok' ? '✓ Connected!' : editingConnection ? 'Save & Re-test' : 'Test & Connect'}
                  </button>
                </div>
              </form>
            ) : (
              <form onSubmit={testAndSave}>
                <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                    Enter your {configuring.name} credentials. They are stored encrypted and only used server-side.
                  </p>
                  {/* Connection Name — always first field for non-OAuth connectors */}
                  <div className="form-group">
                    <label className="form-label">Connection Name *</label>
                    <input
                      className="input"
                      placeholder={configuring.multiInstance ? `e.g. Production ${configuring.name}, Staging ${configuring.name}…` : `e.g. My ${configuring.name}`}
                      value={formValues['_name'] || ''}
                      onChange={e => setFormValues(v => ({ ...v, _name: e.target.value }))}
                      required
                    />
                    <span className="form-hint">A memorable name to tell this connection apart from others of the same type.</span>
                  </div>
                  {configuring.fields?.map(field => (
                    <div key={field.name} className="form-group">
                      <label className="form-label">{field.label}</label>
                      {field.type === 'select' ? (
                        <select
                          className="input"
                          value={formValues[field.name] || (field as { defaultValue?: string }).defaultValue || ''}
                          onChange={e => setFormValues(v => ({ ...v, [field.name]: e.target.value }))}
                          required={!(field as { optional?: boolean }).optional}
                        >
                          {((field as { options?: { value: string; label: string }[] }).options || []).map(opt => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                          ))}
                        </select>
                      ) : (
                        <input
                          className="input"
                          type={field.type}
                          placeholder={field.placeholder}
                          value={formValues[field.name] || ''}
                          onChange={e => setFormValues(v => ({ ...v, [field.name]: e.target.value }))}
                          required={!(field as { optional?: boolean }).optional}
                        />
                      )}
                    </div>
                  ))}
                </div>
                {modalTestState === 'fail' && modalTestError && (
                  <div style={{ padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, color: '#991b1b', fontSize: 12 }}>
                    ⚠ {modalTestError}
                  </div>
                )}
                <div className="modal-footer">
                  <button type="button" className="btn btn-secondary" onClick={() => { setConfiguring(null); setEditingConnection(null); setModalTestState('idle'); setModalTestError(null) }}>Cancel</button>
                  <button type="submit" className="btn btn-primary" disabled={saving || modalTestState === 'testing'}>
                    {modalTestState === 'testing' ? '⏳ Testing…' : modalTestState === 'ok' ? '✓ Connected!' : editingConnection ? 'Save & Re-test' : 'Test & Connect'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
      {ConfirmDialog}
    </div>
  )
}
