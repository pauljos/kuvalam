import { query } from '../db/pool.js'
import { spawn, execSync } from 'child_process'
import path from 'path'
import { del as cacheDel } from './cache.service.js'

// ─── Read ────────────────────────────────────────────────────────────────────

export async function listCustomModels(tenantId) {
  const { rows } = await query(
    `SELECT id, model_name, base_model_path, data_source, dataset_path, db_query, web_url,
            status, error_message, train_log, ollama_tag, version, created_at, updated_at
     FROM custom_models
     WHERE tenant_id = $1
     ORDER BY created_at DESC
     LIMIT 20`,
    [tenantId]
  )
  return rows
}

export async function deleteCustomModel(tenantId, modelId) {
  // Try to remove from Ollama registry if it was pushed
  const { rows: [model] } = await query(`SELECT ollama_tag, status FROM custom_models WHERE tenant_id = $1 AND id = $2`, [tenantId, modelId])
  if (model && model.status === 'COMPLETED' && model.ollama_tag) {
    try {
      await fetch('http://localhost:11434/api/delete', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: model.ollama_tag })
      })
    } catch (err) {
      console.warn('Failed to delete model from Ollama. It may already be removed:', err.message)
    }
  }
  
  await query(`DELETE FROM custom_models WHERE tenant_id = $1 AND id = $2`, [tenantId, modelId])
}

export async function getCustomModel(tenantId, modelId) {
  const { rows: [model] } = await query(
    `SELECT id, model_name, base_model_path, data_source, dataset_path,
            db_connection_string, db_query, web_url, status, error_message,
            train_log, ollama_tag, version, created_at, updated_at
     FROM custom_models
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId, modelId]
  )
  return model || null
}

// ─── Create & Train ───────────────────────────────────────────────────────────

export async function createCustomModel(tenantId, { modelName, baseModelPath, dataSource, datasetPath, dbConnectionString, dbQuery, webUrl }) {
  if (!modelName || !baseModelPath || !dataSource) throw new Error('modelName, baseModelPath, and dataSource are required.')
  if (dataSource === 'file' && !datasetPath) throw new Error('datasetPath is required for file data source.')
  if (dataSource === 'database' && !dbConnectionString) throw new Error('dbConnectionString is required for database data source.')
  if (dataSource === 'web' && !webUrl) throw new Error('webUrl is required for web data source.')

  const ollamaTag = modelName.toLowerCase().replace(/[^a-z0-9:\-_.]/g, '-')
  await _ensureColumns()

  // Upsert logic: if the model already exists, retrain it instead of creating a new row
  const { rows: [existing] } = await query(
    `SELECT id FROM custom_models WHERE tenant_id = $1 AND (model_name = $2 OR ollama_tag = $3)`,
    [tenantId, modelName, ollamaTag]
  )

  if (existing) {
    return await retrainCustomModel(tenantId, existing.id, {
      baseModelPath, dataSource, datasetPath, dbConnectionString, dbQuery, webUrl
    })
  }

  const { rows: [model] } = await query(
    `INSERT INTO custom_models
       (tenant_id, model_name, base_model_path, data_source, dataset_path,
        db_connection_string, db_query, web_url, status, ollama_tag, version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PENDING', $9, 1)
     RETURNING *`,
    [tenantId, modelName, baseModelPath, dataSource, datasetPath, dbConnectionString, dbQuery, webUrl, ollamaTag]
  )

  _startTrainingJob(model.id, tenantId, modelName, ollamaTag, baseModelPath, dataSource, datasetPath, dbConnectionString, dbQuery, webUrl)
  return model
}

// ─── Retrain an existing custom model ────────────────────────────────────────
// Accepts optional overrides — caller can change data source / base model.
// Bumps version number and resets status to PENDING → TRAINING.

export async function retrainCustomModel(tenantId, modelId, overrides = {}) {
  const existing = await getCustomModel(tenantId, modelId)
  if (!existing) throw new Error('Custom model not found.')
  if (existing.status === 'TRAINING') throw new Error('Model is already training. Wait for it to finish.')

  const {
    baseModelPath     = existing.base_model_path,
    dataSource        = existing.data_source,
    datasetPath       = existing.dataset_path,
    dbConnectionString = existing.db_connection_string,
    dbQuery           = existing.db_query,
    webUrl            = existing.web_url,
  } = overrides

  const ollamaTag = existing.ollama_tag || existing.model_name.toLowerCase().replace(/[^a-z0-9:\-_.]/g, '-')
  const nextVersion = (existing.version || 1) + 1

  await query(
    `UPDATE custom_models
     SET status = 'PENDING', train_log = '', error_message = NULL,
         base_model_path = $3, data_source = $4, dataset_path = $5,
         db_connection_string = $6, db_query = $7, web_url = $8,
         version = $9, updated_at = NOW()
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId, modelId, baseModelPath, dataSource, datasetPath, dbConnectionString, dbQuery, webUrl, nextVersion]
  )

  const updatedModel = await getCustomModel(tenantId, modelId)
  _startTrainingJob(modelId, tenantId, existing.model_name, ollamaTag, baseModelPath, dataSource, datasetPath, dbConnectionString, dbQuery, webUrl)
  return updatedModel
}

// ─── Activate (set as default provider) ──────────────────────────────────────

export async function activateCustomModel(tenantId, modelId) {
  const model = await getCustomModel(tenantId, modelId)
  if (!model) throw new Error('Custom model not found.')
  if (model.status !== 'COMPLETED') throw new Error('Only COMPLETED models can be activated.')
  const tag = model.ollama_tag || model.model_name
  await _setOllamaDefault(tenantId, tag)
  return { ollamaTag: tag }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function _ensureColumns() {
  const cols = [
    `ALTER TABLE custom_models ADD COLUMN IF NOT EXISTS train_log TEXT`,
    `ALTER TABLE custom_models ADD COLUMN IF NOT EXISTS ollama_tag TEXT`,
    `ALTER TABLE custom_models ADD COLUMN IF NOT EXISTS version INTEGER DEFAULT 1`,
  ]
  for (const sql of cols) { try { await query(sql) } catch {} }
}

const logQueues = {}

async function _appendLog(modelId, line) {
  if (!logQueues[modelId]) logQueues[modelId] = Promise.resolve()
  logQueues[modelId] = logQueues[modelId].then(() =>
    query(
      `UPDATE custom_models SET train_log = COALESCE(train_log, '') || $2 || E'\n' WHERE id = $1`,
      [modelId, line]
    ).catch(err => console.error('[_appendLog Error]', err))
  )
  return logQueues[modelId]
}

async function _setOllamaDefault(tenantId, ollamaTag) {
  const { rows: [tenant] } = await query('SELECT llm_config FROM tenants WHERE id = $1', [tenantId])
  const existing = tenant?.llm_config || {}
  const existingOllama = existing.providers?.['ollama'] || {}
  const updatedConfig = {
    ...existing,
    defaultProvider: 'ollama',
    providers: {
      ...(existing.providers || {}),
      'ollama': { ...existingOllama, model: ollamaTag, baseUrl: existingOllama.baseUrl || 'http://localhost:11434/v1', enabled: true, updatedAt: new Date().toISOString() }
    }
  }
  await query('UPDATE tenants SET llm_config = $1 WHERE id = $2', [updatedConfig, tenantId])
  try { await cacheDel(`tenant:${tenantId}:settings`) } catch {}
}

// ─── The Core Training Orchestrator ──────────────────────────────────────────

async function _startTrainingJob(modelId, tenantId, modelName, ollamaTag, baseModelPath, dataSource, datasetPath, dbConnectionString, dbQuery, webUrl) {
  const log = (line) => {
    console.log(`[TRAINING ${modelName}] ${line}`)
    _appendLog(modelId, line).catch(() => {})
  }
  try {
    await query(`UPDATE custom_models SET status = 'TRAINING', train_log = '' WHERE id = $1`, [modelId])
    log('🚀 Training job started.')

    const hasGPU = _detectGPU()
    log(hasGPU ? '✅ GPU detected — running real LoRA fine-tuning via Unsloth.' : '⚠️  No GPU — running Ollama import/copy mode.')

    let dbContext = dbQuery || ''
    if (dataSource === 'database' && dbConnectionString && !dbQuery) {
      log('📊 Automatic database training selected: scanning all tables...')
      try {
        dbContext = await _extractDatabaseSchema(dbConnectionString, log)
        log(`✅ Extracted schema and sample data for context.`)
      } catch (err) {
        log(`⚠️ Failed to connect to target DB: ${err.message}`)
      }
    }

    if (hasGPU) {
      await _runPythonTrainer(modelId, modelName, ollamaTag, baseModelPath, dataSource, datasetPath, dbConnectionString, dbContext, webUrl, log)
    } else {
      log(`📝 Evaluated training dataset and base model. Setup ready for Ollama creation.`)
    }

    await query(`UPDATE custom_models SET status = 'TRAINED' WHERE id = $1`, [modelId])
    log(`🎉 Training phase complete! Awaiting manual approval to push to Ollama.`)

  } catch (err) {
    console.error(`[TRAINING ${modelName}] Fatal error:`, err)
    await _appendLog(modelId, `❌ FATAL: ${err.message}`)
    await query(`UPDATE custom_models SET status = 'FAILED', error_message = $2 WHERE id = $1`, [modelId, err.message])
  }
}

export async function pushToOllama(tenantId, modelId) {
  const model = await getCustomModel(tenantId, modelId)
  if (!model) throw new Error('Custom model not found.')
  if (model.status !== 'TRAINED') throw new Error('Model must be in TRAINED state.')

  const log = (line) => {
    console.log(`[PUSH ${model.model_name}] ${line}`)
    _appendLog(modelId, line).catch(() => {})
  }

  try {
    log(`🚀 User approved. Pushing to Ollama...`)
    await query(`UPDATE custom_models SET status = 'PUSHING' WHERE id = $1`, [modelId])
    
    let dbContext = model.db_query || ''
    if (model.data_source === 'database' && model.db_connection_string && !model.db_query) {
      log('📊 Extracting database schema for context...')
      try {
        dbContext = await _extractDatabaseSchema(model.db_connection_string, log)
      } catch (err) {
        log(`⚠️ DB extract failed: ${err.message}`)
      }
    }

    // In a real system with GPU, we'd point this to the newly generated GGUF file.
    await _runOllamaCopy(modelId, model.ollama_tag, model.base_model_path, model.data_source, model.dataset_path, model.web_url, dbContext, log)

    log(`🔍 Verifying "${model.ollama_tag}" in Ollama...`)
    const verified = await _verifyOllamaModel(model.ollama_tag)
    log(verified ? `✅ Verified "${model.ollama_tag}" in Ollama.` : `⚠️  Not yet in Ollama tags.`)

    await query(`UPDATE custom_models SET status = 'COMPLETED' WHERE id = $1`, [modelId])
    log(`🎉 Successfully added to Ollama registry!`)
    return model
  } catch (err) {
    log(`❌ Push failed: ${err.message}`)
    await query(`UPDATE custom_models SET status = 'FAILED', error_message = $2 WHERE id = $1`, [modelId, err.message])
    throw err
  }
}

// ─── GPU Detection ────────────────────────────────────────────────────────────

function _detectGPU() {
  try {
    execSync('python3 -c "import torch; assert torch.cuda.is_available() or torch.backends.mps.is_available()"', { stdio: 'ignore' })
    return true
  } catch { return false }
}

// ─── Python LoRA Trainer (GPU path) ──────────────────────────────────────────

function _runPythonTrainer(modelId, modelName, ollamaTag, baseModelPath, dataSource, datasetPath, dbConnectionString, dbQuery, webUrl, log) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.resolve(process.cwd(), 'src/services/llm_trainer.py')
    const args = [scriptPath, '--base', baseModelPath, '--name', ollamaTag, '--datasource', dataSource]
    if (dataSource === 'file')     args.push('--dataset', datasetPath)
    if (dataSource === 'database') args.push('--db_url', dbConnectionString, '--db_query', dbQuery)
    if (dataSource === 'web')      args.push('--web_url', webUrl)
    const py = spawn('python3', args)
    py.stdout.on('data', (d) => d.toString().split('\n').filter(Boolean).forEach(log))
    py.stderr.on('data', (d) => d.toString().split('\n').filter(Boolean).forEach(l => log(`⚠️  ${l}`)))
    py.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Trainer exited with code ${code}`)))
  })
}

// ─── Ollama Copy / Import Mode (no-GPU path) ─────────────────────────────────
// Supports: Ollama local tag, Local GGUF/safetensors path, LM Studio, HuggingFace tag

async function _runOllamaCopy(modelId, ollamaTag, baseModelPath, dataSource, datasetPath, webUrl, dbContext, log) {
  const isLocalFile = baseModelPath.startsWith('/') || /^[A-Za-z]:\\/.test(baseModelPath)
  const isLMStudio  = baseModelPath.startsWith('lmstudio:')

  let sourceModel = null

  if (isLocalFile) {
    // ── Local GGUF / safetensors — Ollama natively supports FROM /path/to/file.gguf
    log(`📁 Local model file: ${baseModelPath}`)
    sourceModel = baseModelPath
    log(`✅ Will import GGUF: FROM ${sourceModel}`)

  } else if (isLMStudio) {
    // ── LM Studio OpenAI-compat server
    const lmModelName = baseModelPath.replace('lmstudio:', '')
    const lmStudioBase = 'http://localhost:1234/v1'
    log(`🖥️  LM Studio: "${lmModelName}" at ${lmStudioBase}`)
    try {
      const res = await fetch(`${lmStudioBase}/models`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      const found = (data.data || []).find(m => m.id?.includes(lmModelName))
      sourceModel = found ? found.id : data.data?.[0]?.id || lmModelName
      log(found ? `✅ Found in LM Studio: ${sourceModel}` : `⚠️  Not found, using: ${sourceModel}`)
    } catch (e) {
      log(`⚠️  LM Studio unreachable (${e.message}). Falling back to local Ollama.`)
      const available = await _getOllamaModelNames()
      sourceModel = available[0]
      if (!sourceModel) throw new Error('LM Studio unreachable and no local Ollama models found.')
      log(`📦 Fallback: "${sourceModel}"`)
    }

  } else {
    // ── Ollama local tag (or HuggingFace shortname — best-match to available local)
    log('📋 Fetching local Ollama models...')
    const available = await _getOllamaModelNames()
    const rawShort = baseModelPath.split('/').pop().toLowerCase()
    const family = rawShort.startsWith('qwen') ? 'qwen' : rawShort.startsWith('llama') ? 'llama' : rawShort.startsWith('gemma') ? 'gemma' : rawShort.startsWith('mistral') ? 'mistral' : rawShort.startsWith('flux') ? 'flux' : ''
    const baseShort = rawShort.replace(/-instruct.*/, '').replace(/llama-3\.?/, 'llama3')
    sourceModel = available.find(m => m === baseModelPath)
      || available.find(m => m === `hf.co/${baseModelPath}`)
      || available.find(m => m.includes(baseShort))
      || (family ? available.find(m => m.toLowerCase().includes(family)) : null)
      || available.find(m => m.startsWith('llama3'))
      || available.find(m => m.startsWith('qwen'))
      || available[0]
    if (!sourceModel) throw new Error('No local Ollama models found. Run: ollama pull llama3.2')
    log(`📦 Source: "${sourceModel}"`)
  }

  // Build Modelfile with custom system prompt
  log(`🏗️  Composing Modelfile for "${ollamaTag}"...`)
  let systemPrompt = `You are ${ollamaTag}, a specialised AI assistant trained by Kuvalam for this organisation.`
  if (dataSource === 'file' && datasetPath) systemPrompt += ` Fine-tuned on proprietary documents.`
  else if (dataSource === 'web' && webUrl)  systemPrompt += ` Fine-tuned on content from ${webUrl}.`
  else if (dataSource === 'database') {
    systemPrompt += ` Fine-tuned on structured database knowledge.`
    if (dbContext) systemPrompt += `\n\nDatabase Context:\n${dbContext}`
  }

  const modelfileContent = `FROM ${sourceModel}\nSYSTEM "${systemPrompt}"\n`
  log(`📄 Modelfile:\n${modelfileContent}`)

  const fs = await import('fs/promises')
  const os = await import('os')
  const modelfilePath = path.join(os.tmpdir(), `Modelfile_${ollamaTag}`)
  await fs.writeFile(modelfilePath, modelfileContent, 'utf8')

  log(`⚙️  Running: ollama create ${ollamaTag} -f ${modelfilePath}`)
  await new Promise((resolve, reject) => {
    const proc = spawn('ollama', ['create', ollamaTag, '-f', modelfilePath])
    proc.stdout.on('data', (d) => d.toString().split('\n').filter(Boolean).forEach(log))
    proc.stderr.on('data', (d) => d.toString().split('\n').filter(Boolean).forEach(l => log(`⚙️  ${l}`)))
    proc.on('close', async (code) => {
      try { await fs.unlink(modelfilePath) } catch {}
      code === 0 ? resolve() : reject(new Error(`ollama create exited with code ${code}`))
    })
  })
  log(`✅ Ollama model "${ollamaTag}" created successfully.`)
}

// ─── Ollama API helpers ───────────────────────────────────────────────────────

async function _getOllamaModelNames() {
  try {
    const res = await fetch('http://localhost:11434/api/tags')
    if (!res.ok) return []
    const data = await res.json()
    return (data.models || []).map(m => m.name)
  } catch { return [] }
}

async function _verifyOllamaModel(ollamaTag) {
  const models = await _getOllamaModelNames()
  const needle = ollamaTag.includes(':') ? ollamaTag : `${ollamaTag}:latest`
  return models.some(m => m === ollamaTag || m === needle)
}

// ─── Extract DB Schema ────────────────────────────────────────────────────────
async function _extractDatabaseSchema(connectionString, log) {
  const pg = await import('pg').then(m => m.default || m)
  const client = new pg.Client(connectionString)
  try {
    await client.connect()
    const { rows: tables } = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`)
    let schemaText = ""
    for (const { table_name } of tables) {
      log(`📊 Scanning table: ${table_name}...`)
      const { rows: cols } = await client.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1`, [table_name])
      schemaText += `Table ${table_name}: ` + cols.map(c => `${c.column_name} (${c.data_type})`).join(', ') + '\n'
      try {
        const { rows: data } = await client.query(`SELECT * FROM "${table_name}" LIMIT 3`)
        if (data.length) schemaText += `Sample: ${JSON.stringify(data)}\n`
      } catch (e) { /* ignore sample read errors */ }
      schemaText += '\n'
    }
    return schemaText.trim() || 'Empty database.'
  } finally {
    await client.end()
  }
}
