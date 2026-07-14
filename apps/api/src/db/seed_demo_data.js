// apps/api/src/db/seed_demo_data.js
import dotenv from 'dotenv'
dotenv.config({ path: 'apps/api/.env' })

if (process.env.NODE_ENV === 'production') {
  console.error('ERROR: seed_demo_data must not be run in production.')
  process.exit(1)
}

const TENANT_ID = 'e9e3f771-3062-4c7a-a53f-a0e0571a9ab3'
const USER_ID = 'b47d19d7-5b70-49c8-acb4-3173d7db9ade'

async function seed() {
  const { query } = await import('./pool.js')
  console.log('Seeding demo data for tenant:', TENANT_ID)

  try {
    // 1. Ensure we have some agents
    await query('DELETE FROM agent_tasks WHERE tenant_id = $1', [TENANT_ID])
    await query('DELETE FROM agent_skills WHERE agent_id IN (SELECT id FROM agents WHERE tenant_id = $1)', [TENANT_ID])
    await query('DELETE FROM agent_rules WHERE agent_id IN (SELECT id FROM agents WHERE tenant_id = $1)', [TENANT_ID])
    await query('DELETE FROM agent_knowledge_bases WHERE agent_id IN (SELECT id FROM agents WHERE tenant_id = $1)', [TENANT_ID])
    await query('DELETE FROM agents WHERE tenant_id = $1', [TENANT_ID])
    let agentIds = []

    if (true) {
      console.log('Creating demo agents...')
      const agentsToCreate = [
        { name: 'Legal Counsel Bot', archetype: 'LEGAL', description: 'Audits lease agreements and compliance documentation' },
        { name: 'Financial Auditor', archetype: 'FINANCE', description: 'Reconciles invoices against bank statements' },
        { name: 'Customer Success Liaison', archetype: 'SUPPORT', description: 'Drafts responses to high-priority customer complaints' }
      ]

      for (const a of agentsToCreate) {
        const { rows: [created] } = await query(
          `INSERT INTO agents (tenant_id, name, description, archetype, status, autonomy_level, llm_provider, llm_model, confidence_threshold, created_by)
           VALUES ($1, $2, $3, $4, 'ACTIVE', 'SUPERVISED', 'openai', 'gpt-4o', 0.80, $5) RETURNING id`,
          [TENANT_ID, a.name, a.description, a.archetype, USER_ID]
        )
        agentIds.push(created.id)
      }
    }

    const mainAgentId = agentIds[0]

    // 2. Ensure we have a workflow
    const { rows: existingWorkflows } = await query('SELECT id FROM workflows WHERE tenant_id = $1', [TENANT_ID])
    let workflowId
    if (existingWorkflows.length === 0) {
      console.log('Creating demo workflow...')
      const steps = [
        { id: 'extract_entities', type: 'AGENT', input: { agentId: mainAgentId, goal: 'Extract lease terms and monthly amount from {{document}}' } },
        { id: 'human_signoff', type: 'APPROVAL', input: { message: 'Verify extracted lease terms are accurate' } },
        { id: 'post_to_ledger', type: 'HTTP', input: { url: 'https://api.acme.com/v1/ledger', method: 'POST' } }
      ]
      const { rows: [wf] } = await query(
        `INSERT INTO workflows (tenant_id, name, description, trigger, steps, on_failure, status, created_by)
         VALUES ($1, 'Lease Audit Pipeline', 'Chains contract entity extraction, legal verification, and ledger posting.', '{"type":"MANUAL"}', $2, 'STOP', 'ACTIVE', $3) RETURNING id`,
        [TENANT_ID, JSON.stringify(steps), USER_ID]
      )
      workflowId = wf.id
    } else {
      workflowId = existingWorkflows[0].id
    }

    // 3. Clear old mock tasks and logs to avoid duplication if running seed multiple times
    await query('DELETE FROM audit_log WHERE tenant_id = $1 AND actor_type = $2', [TENANT_ID, 'DEMO_SEEDER'])
    await query('DELETE FROM human_feedback WHERE tenant_id = $1', [TENANT_ID])
    await query('DELETE FROM approval_requests WHERE tenant_id = $1 AND requested_by = $2', [TENANT_ID, 'DEMO_SEEDER'])
    await query('DELETE FROM step_executions WHERE tenant_id = $1', [TENANT_ID])
    await query('DELETE FROM workflow_executions WHERE tenant_id = $1', [TENANT_ID])
    await query('DELETE FROM agent_tasks WHERE tenant_id = $1 AND context->>\'demo\' = \'true\'', [TENANT_ID])

    // 4. Create tasks spread across the last 14 days
    console.log('Creating mock agent tasks...')
    const days = 14
    for (let i = days; i >= 0; i--) {
      // 2-4 tasks per day
      const taskCount = Math.floor(Math.random() * 3) + 2
      for (let t = 0; t < taskCount; t++) {
        const date = new Date()
        date.setDate(date.getDate() - i)
        // randomize hour
        date.setHours(Math.floor(Math.random() * 12) + 8, Math.floor(Math.random() * 60))

        const agentId = agentIds[Math.floor(Math.random() * agentIds.length)]
        const status = Math.random() > 0.15 ? 'COMPLETED' : 'FAILED'
        const durationSeconds = Math.floor(Math.random() * 45) + 15
        const started = new Date(date.getTime() - durationSeconds * 1000)

        await query(
          `INSERT INTO agent_tasks (agent_id, tenant_id, goal, context, priority, status, plan, actions, result, error, token_usage, started_at, completed_at, created_by, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
          [
            agentId,
            TENANT_ID,
            `Analyze invoice reference INV-${1000 + i * 10 + t} for compliance`,
            JSON.stringify({ demo: 'true' }),
            'MEDIUM',
            status,
            '{"steps":[]}',
            '[]',
            status === 'COMPLETED' ? '{"status":"APPROVED","complianceRating":"98%"}' : null,
            status === 'FAILED' ? 'Confidence below required threshold (0.80)' : null,
            '{"prompt":1200,"completion":350,"total":1550}',
            started,
            date,
            USER_ID,
            started
          ]
        )
      }
    }

    // 5. Create workflow executions
    console.log('Creating mock workflow executions...')
    for (let i = 0; i < 8; i++) {
      const date = new Date()
      date.setDate(date.getDate() - i)
      const status = i === 0 ? 'PENDING_APPROVAL' : i === 1 ? 'RUNNING' : Math.random() > 0.2 ? 'COMPLETED' : 'FAILED'
      const started = new Date(date.getTime() - 600 * 1000)
      const completed = status === 'COMPLETED' || status === 'FAILED' ? date : null

      const { rows: [exec] } = await query(
        `INSERT INTO workflow_executions (workflow_id, tenant_id, workflow_version, status, context, started_at, completed_at, created_at)
         VALUES ($1, $2, 1, $3, $4, $5, $6, $7) RETURNING id`,
        [workflowId, TENANT_ID, status, JSON.stringify({ currentStepIdx: status === 'PENDING_APPROVAL' ? 1 : 0 }), started, completed, started]
      )

      // Step executions
      await query(
        `INSERT INTO step_executions (execution_id, tenant_id, step_id, step_type, status, input, output, started_at, completed_at, duration_ms)
         VALUES ($1, $2, 'extract_entities', 'AGENT', 'COMPLETED', '{}', '{"entities":{"amount":4500}}', $3, $4, 4500)`,
        [exec.id, TENANT_ID, started, new Date(started.getTime() + 4500)]
      )

      if (status === 'PENDING_APPROVAL') {
        const stepExec = await query(
          `INSERT INTO step_executions (execution_id, tenant_id, step_id, step_type, status, input, started_at)
           VALUES ($1, $2, 'human_signoff', 'APPROVAL', 'PENDING', '{}', $3) RETURNING id`,
          [exec.id, TENANT_ID, new Date(started.getTime() + 5000)]
        )

        // Approval request
        await query(
          `INSERT INTO approval_requests (tenant_id, execution_id, step_id, requested_by, context, status, deadline, risk_level, created_at)
           VALUES ($1, $2, $3, 'DEMO_SEEDER', '{"step":{"id":"human_signoff"},"amount":4500}', 'PENDING', NOW() + INTERVAL '24 hours', 'MEDIUM', $4)`,
          [TENANT_ID, exec.id, stepExec.rows[0].id, new Date(started.getTime() + 6000)]
        )
      } else if (status === 'COMPLETED') {
        const stepExec = await query(
          `INSERT INTO step_executions (execution_id, tenant_id, step_id, step_type, status, input, output, started_at, completed_at, duration_ms)
           VALUES ($1, $2, 'human_signoff', 'APPROVAL', 'COMPLETED', '{}', '{"approved":true}', $3, $4, 12000) RETURNING id`,
          [exec.id, TENANT_ID, new Date(started.getTime() + 5000), new Date(started.getTime() + 17000)]
        )

        await query(
          `INSERT INTO approval_requests (tenant_id, execution_id, step_id, requested_by, context, status, deadline, risk_level, decision, decided_by, decision_note, decided_at, created_at)
           VALUES ($1, $2, $3, 'DEMO_SEEDER', '{"step":{"id":"human_signoff"},"amount":4500}', 'APPROVED', NOW() + INTERVAL '24 hours', 'MEDIUM', 'APPROVED', $4, 'Looks correct', $5, $6)`,
          [TENANT_ID, exec.id, stepExec.rows[0].id, USER_ID, new Date(started.getTime() + 17000), new Date(started.getTime() + 6000)]
        )
      }
    }

    // 6. Create Audit Logs
    console.log('Creating mock audit logs...')
    const auditLogs = [
      { action: 'CREATE_WORKFLOW', resource: 'Workflow', event: 'workflow.created' },
      { action: 'CREATE_AGENT', resource: 'Agent', event: 'agent.created' },
      { action: 'UPDATE_CONNECTOR', resource: 'ToolConnection', event: 'connector.updated' },
      { action: 'EXECUTION_STARTED', resource: 'WorkflowExecution', event: 'workflow.execution_started' },
      { action: 'APPROVAL_APPROVED', resource: 'ApprovalRequest', event: 'approval.decided' }
    ]

    for (let i = 0; i < 15; i++) {
      const date = new Date()
      date.setMinutes(date.getMinutes() - i * 45)
      const log = auditLogs[i % auditLogs.length]
      await query(
        `INSERT INTO audit_log (tenant_id, event_type, actor_type, actor_id, resource_type, action, after_state, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          TENANT_ID,
          log.event,
          'DEMO_SEEDER',
          USER_ID,
          log.resource,
          log.action,
          JSON.stringify({ info: `Simulated demo audit log entry ${i}` }),
          date
        ]
      )
    }

    console.log('🎉 Seeding successfully completed!')
    process.exit(0)
  } catch (err) {
    console.error('Seeding failed:', err)
    process.exit(1)
  }
}

seed()
