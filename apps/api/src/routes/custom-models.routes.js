import { listCustomModels, getCustomModel, createCustomModel, activateCustomModel, retrainCustomModel, deleteCustomModel, pushToOllama, cancelTraining } from '../services/custom-models.service.js'
import { query } from '../db/pool.js'

export default async function (fastify, opts) {

  // List all custom models for a tenant
  fastify.get('/tenants/:tenantId/custom-models', {
    preValidation: [fastify.authenticate]
  }, async (request, reply) => {
    const { tenantId } = request.params
    const models = await listCustomModels(tenantId)
    return { success: true, data: { customModels: models } }
  })

  // ── SSE: stream live training log to the browser ───────────────────────────
  // Exactly how HuggingFace AutoTrain / W&B stream training progress.
  // The client opens an EventSource; we push new log lines every 600ms until done.
  // Auth: accepts either a JWT accessToken (query: ?token=) or a dedicated
  //       stream_token (query: ?stream_token=) that never expires for this model.
  fastify.get('/tenants/:tenantId/custom-models/:modelId/log-stream', async (request, reply) => {
    const { tenantId, modelId } = request.params
    const token = request.query.token
    const streamToken = request.query.stream_token

    // Verify model belongs to this tenant
    const { rows: [model] } = await query(
      'SELECT id, status, stream_token FROM custom_models WHERE id = $1 AND tenant_id = $2',
      [modelId, tenantId]
    )
    if (!model) return reply.status(404).send('Not found')

    // Authenticate: accept either JWT accessToken or dedicated stream_token
    let authenticated = false
    if (token) {
      try {
        fastify.jwt.verify(token)
        authenticated = true
      } catch {}
    }
    if (!authenticated && streamToken && model.stream_token) {
      authenticated = (streamToken === model.stream_token)
    }
    if (!authenticated) return reply.status(401).send('Unauthorized: Valid token or stream_token required')

    // Set SSE headers, explicitly including CORS since raw.writeHead bypasses Fastify plugins
    const origin = request.headers.origin || '*'
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // disable nginx buffering
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true'
    })
    reply.raw.flushHeaders()

    let sentLength = 0
    let closed = false

    const send = (event, data) => {
      try { reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) } catch {}
    }

    const close = () => {
      if (closed) return
      closed = true
      clearInterval(interval)
      try { reply.raw.end() } catch {}
    }

    send('connected', { modelId, message: 'Log stream connected.', streamToken: model.stream_token })

    // Polling interval — checks for new log lines and terminal status
    const interval = setInterval(async () => {
      try {
        const { rows: [row] } = await query(
          'SELECT train_log, status FROM custom_models WHERE id = $1',
          [modelId]
        )
        if (!row) { close(); return }

        const fullLog = row.train_log || ''
        if (fullLog.length > sentLength) {
          const newContent = fullLog.slice(sentLength)
          sentLength = fullLog.length
          const lines = newContent.split('\n').filter(l => l.trim())
          for (const line of lines) {
            send('log', { line })
          }
        }

        // Close stream when training finishes / pauses / fails
        const terminal = ['TRAINED', 'COMPLETED', 'FAILED']
        if (terminal.includes(row.status)) {
          send('done', { status: row.status })
          close()
        }
      } catch { close() }
    }, 600)

    // Run the first check immediately (don't wait 600ms)
    ;(async () => {
      try {
        const { rows: [row] } = await query(
          'SELECT train_log, status FROM custom_models WHERE id = $1',
          [modelId]
        )
        if (!row) { close(); return }

        const fullLog = row.train_log || ''
        if (fullLog.length > sentLength) {
          sentLength = fullLog.length
          const lines = fullLog.split('\n').filter(l => l.trim())
          for (const line of lines) {
            send('log', { line })
          }
        }

        const terminal = ['TRAINED', 'COMPLETED', 'FAILED']
        if (terminal.includes(row.status)) {
          send('done', { status: row.status })
          close()
        }
      } catch {}
    })()

    // Clean up if client disconnects
    request.raw.on('close', () => close())
  })


  // Get a specific custom model status
  fastify.get('/tenants/:tenantId/custom-models/:modelId', {
    preValidation: [fastify.authenticate]
  }, async (request, reply) => {
    const { tenantId, modelId } = request.params
    const model = await getCustomModel(tenantId, modelId)
    if (!model) {
      return reply.status(404).send({ success: false, error: { message: 'Model not found' } })
    }
    return { success: true, data: { customModel: model } }
  })

  // NEW: List locally available Ollama models to populate the base model selector
  fastify.get('/tenants/:tenantId/custom-models/ollama/available', {
    preValidation: [fastify.authenticate]
  }, async (request, reply) => {
    try {
      const res = await fetch('http://localhost:11434/api/tags')
      if (!res.ok) return reply.send({ success: true, data: { models: [] } })
      const data = await res.json()
      const models = (data.models || []).map(m => ({
        name: m.name,
        size: m.size,
        modified: m.modified_at
      }))
      return reply.send({ success: true, data: { models } })
    } catch {
      return reply.send({ success: true, data: { models: [] } })
    }
  })

  // Cancel a running training job
  fastify.post('/tenants/:tenantId/custom-models/:modelId/cancel', {
    preValidation: [fastify.authenticate]
  }, async (request, reply) => {
    const { tenantId, modelId } = request.params
    try {
      cancelTraining(tenantId, modelId)
    } catch (err) {
      // Process may have already exited — still update DB status
    }
    await query(`UPDATE custom_models SET status = 'FAILED', error_message = 'Cancelled by user' WHERE id = $1 AND tenant_id = $2`, [modelId, tenantId])
    return { success: true, data: { message: 'Training cancelled.' } }
  })

  // NEW: Activate a completed custom model (set it as the default LLM provider)
  fastify.post('/tenants/:tenantId/custom-models/:modelId/activate', {
    preValidation: [fastify.authenticate]
  }, async (request, reply) => {
    const { tenantId, modelId } = request.params
    try {
      await activateCustomModel(tenantId, modelId)
      return { success: true, data: { message: 'Model activated as default provider.' } }
    } catch (err) {
      return reply.status(400).send({ success: false, error: { message: err.message } })
    }
  })

  // NEW: Retrain an existing custom model (bumps version, accepts optional overrides)
  fastify.post('/tenants/:tenantId/custom-models/:modelId/retrain', {
    preValidation: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        properties: {
          baseModelPath:      { type: 'string' },
          dataSource:         { type: 'string', enum: ['file', 'database', 'web'] },
          datasetPath:        { type: 'string' },
          dbConnectionString: { type: 'string' },
          dbQuery:            { type: 'string' },
          webUrl:             { type: 'string' },
        }
      }
    }
  }, async (request, reply) => {
    const { tenantId, modelId } = request.params
    try {
      const model = await retrainCustomModel(tenantId, modelId, request.body || {})
      return { success: true, data: { customModel: model } }
    } catch (err) {
      return reply.status(400).send({ success: false, error: { message: err.message } })
    }
  })

  // Start a new fine-tuning job
  fastify.post('/tenants/:tenantId/custom-models', {
    preValidation: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['modelName', 'baseModelPath', 'dataSource'],
        properties: {
          modelName: { type: 'string' },
          baseModelPath: { type: 'string' },
          dataSource: { type: 'string', enum: ['file', 'database', 'web'] },
          datasetPath: { type: 'string' },
          dbConnectionString: { type: 'string' },
          dbQuery: { type: 'string' },
          webUrl: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const { tenantId } = request.params
    const { modelName, baseModelPath, dataSource, datasetPath, dbConnectionString, dbQuery, webUrl } = request.body
    
    try {
      const model = await createCustomModel(tenantId, { modelName, baseModelPath, dataSource, datasetPath, dbConnectionString, dbQuery, webUrl })
      return { success: true, data: { customModel: model } }
    } catch (err) {
      return reply.status(400).send({ success: false, error: { message: err.message } })
    }
  })

  // Test PostgreSQL / MySQL Database connection and extract table metadata
  fastify.post('/tenants/:tenantId/custom-models/test-db-connection', {
    preValidation: [fastify.authenticate]
  }, async (request, reply) => {
    const { dbConnectionString } = request.body || {}
    if (!dbConnectionString) return reply.status(400).send({ success: false, error: { message: 'dbConnectionString is required.' } })
    
    try {
      const pg = await import('pg').then(m => m.default || m)
      const client = new pg.Client(dbConnectionString)
      await client.connect()
      try {
        const { rows: tables } = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'")
        const tableNames = tables.map(t => t.table_name)
        let sampleCount = 0
        for (const t of tableNames) {
          try {
            const { rows: r } = await client.query(`SELECT count(*) FROM "${t}"`)
            sampleCount += parseInt(r[0]?.count || '0', 10)
          } catch {}
        }
        return reply.send({
          success: true,
          data: {
            tables: tableNames,
            totalTables: tableNames.length,
            message: `Connected successfully to PostgreSQL! Found ${tableNames.length} table(s): ${tableNames.join(', ')} (~${sampleCount} total records extracted).`
          }
        })
      } finally {
        await client.end()
      }
    } catch (err) {
      return reply.status(400).send({ success: false, error: { message: `Database connection failed: ${err.message}` } })
    }
  })

  // ── DELETE a custom model ──────────────────────────────────────────────────
  fastify.delete('/tenants/:tenantId/custom-models/:modelId', {
    preValidation: [fastify.authenticate]
  }, async (request, reply) => {
    const { tenantId, modelId } = request.params
    try {
      await deleteCustomModel(tenantId, modelId)
      return { success: true, data: { message: 'Model deleted.' } }
    } catch (err) {
      return reply.status(400).send({ success: false, error: { message: err.message } })
    }
  })

  // ── PUSH to Ollama ─────────────────────────────────────────────────────────
  fastify.post('/tenants/:tenantId/custom-models/:modelId/push-to-ollama', {
    preValidation: [fastify.authenticate]
  }, async (request, reply) => {
    const { tenantId, modelId } = request.params
    try {
      await pushToOllama(tenantId, modelId)
      return { success: true, data: { message: 'Model pushed to Ollama.' } }
    } catch (err) {
      return reply.status(400).send({ success: false, error: { message: err.message } })
    }
  })
}
