import { query } from '../db/pool.js'
import { spawn, execSync } from 'child_process'
import crypto from 'crypto'
import path from 'path'
import fs from 'fs'
import { del as cacheDel } from './cache.service.js'

// ─── Running training processes ──────────────────────────────────────────────
// Map<modelId, ChildProcess> — allows cancelling a running training job
const runningTrainers = new Map()

// ─── Concurrent training guard ───────────────────────────────────────────────
// Prevents GPU OOM from two simultaneous Unsloth jobs. Default 1 (safe).
const MAX_CONCURRENT_TRAINING = parseInt(process.env.MAX_CONCURRENT_TRAINING || '1', 10)
let activeTrainingCount = 0
const trainingQueue = []  // { modelId, run: () => Promise<void>, resolve, reject }

// ─── Per-tenant model quota ──────────────────────────────────────────────────
// Caps how many active (non-failed, non-cancelled) custom models a tenant can own.
// Default 5. Set to 0 to disable. Counts PENDING/TRAINING/TRAINED/PUSHING/COMPLETED.
const MAX_MODELS_PER_TENANT = parseInt(process.env.MAX_MODELS_PER_TENANT || '5', 10)

async function _checkTenantQuota(tenantId) {
  if (MAX_MODELS_PER_TENANT <= 0) return // quota disabled
  const { rows: [{ count }] } = await query(
    `SELECT COUNT(*)::int FROM custom_models
     WHERE tenant_id = $1 AND status NOT IN ('FAILED', 'CANCELLED')`,
    [tenantId]
  )
  if (count >= MAX_MODELS_PER_TENANT) {
    throw new Error(
      `Tenant model limit reached (${count}/${MAX_MODELS_PER_TENANT}). ` +
      `Delete or cancel an existing model before creating a new one.`
    )
  }
}

function _dequeueTraining() {
  if (trainingQueue.length === 0) return
  if (activeTrainingCount >= MAX_CONCURRENT_TRAINING) return
  const next = trainingQueue.shift()
  activeTrainingCount++
  next.run()
    .then(next.resolve, next.reject)
    .finally(() => {
      activeTrainingCount--
      _dequeueTraining()
    })
}

// ─── Orphan recovery ─────────────────────────────────────────────────────────
// Call after the DB pool is ready. Resets any models stuck in TRAINING
// (left over from a previous process crash/restart) to FAILED.
export async function recoverOrphanedTraining() {
  try {
    const { rowCount } = await query(
      `UPDATE custom_models SET status = 'FAILED',
         error_message = 'Training interrupted by server restart. Please retry.',
         train_checkpoint = NULL
       WHERE status = 'TRAINING'`
    )
    if (rowCount > 0) console.log(`[startup] Recovered ${rowCount} orphaned training job(s)`)
    return rowCount
  } catch (err) {
    console.error('[startup] Orphan recovery failed (pool may not be ready):', err.message)
    return 0
  }
}

export async function cancelTraining(tenantId, modelId) {
  const proc = runningTrainers.get(modelId)
  if (!proc) throw new Error('No running training job found for this model.')

  try {
    proc.kill('SIGTERM')   // send SIGTERM first — Python can catch it
    // If still alive after 3s, force kill
    setTimeout(() => {
      try {
        proc.kill('SIGKILL')
      } catch {}
    }, 3000)
  } catch (err) {
    throw new Error(`Failed to cancel training: ${err.message}`)
  }

  runningTrainers.delete(modelId)

  // Update DB status so the model isn't stuck in TRAINING forever
  query(`UPDATE custom_models SET status = 'CANCELLED', error_message = 'Training cancelled by user', train_checkpoint = NULL WHERE id = $1`, [modelId])
    .catch(err => console.error('[cancelTraining] DB update failed:', err.message))
}

// ─── Read ────────────────────────────────────────────────────────────────────

export async function listCustomModels(tenantId) {
  const { rows } = await query(
    `SELECT id, model_name, base_model_path, data_source, dataset_path, db_query, web_url, db_connection_string,
            status, error_message, train_log, ollama_tag, version, stream_token, created_at, updated_at
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
            train_log, ollama_tag, version, stream_token, train_context, created_at, updated_at
     FROM custom_models
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId, modelId]
  )
  if (!model) return null

  // Attach multi-DB config if present
  try {
    const { rows: dbs } = await query(
      `SELECT db_label, db_connection_string, db_type, sort_order
       FROM custom_model_databases
       WHERE model_id = $1
       ORDER BY sort_order`,
      [modelId]
    )
    if (dbs.length > 0) {
      model.databases = dbs.map(d => ({
        label: d.db_label,
        connectionString: d.db_connection_string,
        dbType: d.db_type,
      }))
    }
  } catch { /* junction table may not exist yet */ }

  return model
}

// ─── Model size validation ────────────────────────────────────────────────────
// 2B parameter threshold — models above this require a GPU for fine-tuning
const PARAM_THRESHOLD = 2_000_000_000

async function _getModelParameterCount(modelPath) {
  try {
    const res = await fetch('http://localhost:11434/api/show', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: modelPath })
    })
    if (!res.ok) return null
    const data = await res.json()
    // Exact count from model_info, or parse human-readable string
    if (data?.model_info?.general?.parameter_count) {
      return Number(data.model_info.general.parameter_count)
    }
    if (data?.details?.parameter_size) {
      const match = data.details.parameter_size.match(/^([\d.]+)([BMK])/)
      if (match) {
        const num = parseFloat(match[1])
        const unit = match[2]
        if (unit === 'B') return num * 1_000_000_000
        if (unit === 'M') return num * 1_000_000
        if (unit === 'K') return num * 1_000
      }
    }
    return null
  } catch {
    return null
  }
}

async function _validateModelForTraining(baseModelPath, hasGPU) {
  if (hasGPU) return // GPU available — any model size is fine

  const paramCount = await _getModelParameterCount(baseModelPath)
  if (paramCount === null) {
    // Can't determine size — warn but allow (model might not be in Ollama yet)
    return
  }

  if (paramCount > PARAM_THRESHOLD) {
    const sizeLabel = paramCount >= 1_000_000_000
      ? `${(paramCount / 1_000_000_000).toFixed(1)}B`
      : `${(paramCount / 1_000_000).toFixed(0)}M`

    throw new Error(
      `Model "${baseModelPath}" has ${sizeLabel} parameters (>2B). ` +
      `Fine-tuning models this large requires a GPU. ` +
      `Please use a smaller model (≤2B params) such as qwen2.5:0.5b (494M) or install PyTorch with CUDA/MPS support.`
    )
  }
}

// ─── Create & Train ───────────────────────────────────────────────────────────

export async function createCustomModel(tenantId, { modelName, baseModelPath, dataSource, datasetPath, dbConnectionString, dbQuery, webUrl, databases }) {
  if (!modelName || !baseModelPath || !dataSource) throw new Error('modelName, baseModelPath, and dataSource are required.')
  if (dataSource === 'file' && !datasetPath) throw new Error('datasetPath is required for file data source.')
  if (dataSource === 'database' && !dbConnectionString && (!databases || databases.length === 0)) throw new Error('dbConnectionString or databases[] is required for database data source.')
  if (dataSource === 'nosql' && !dbConnectionString && (!databases || databases.length === 0)) throw new Error('dbConnectionString (MongoDB URI) or databases[] is required for nosql data source.')
  if (dataSource === 'web' && !webUrl) throw new Error('webUrl is required for web data source.')

  // Normalize: if databases[] provided but dbConnectionString is missing, use the first entry
  const dbList = (databases && databases.length > 0) ? databases : null
  const effectiveConnectionString = dbConnectionString || (dbList ? dbList[0].connectionString : null)

  // ── Enforce per-tenant quota ───────────────────────────────────────────
  await _checkTenantQuota(tenantId)

  const ollamaTag = `t-${tenantId.substring(0,8)}-${modelName.toLowerCase().replace(/[^a-z0-9:\-_.]/g, '-')}`
  await _ensureColumns()

  // Upsert logic: if the model already exists, retrain it instead of creating a new row
  const { rows: [existing] } = await query(
    `SELECT id FROM custom_models WHERE tenant_id = $1 AND (model_name = $2 OR ollama_tag = $3)`,
    [tenantId, modelName, ollamaTag]
  )

  if (existing) {
    return await retrainCustomModel(tenantId, existing.id, {
      baseModelPath, dataSource, datasetPath, dbConnectionString: effectiveConnectionString, dbQuery, webUrl, databases: dbList
    })
  }

  const streamToken = crypto.randomUUID()
  const { rows: [model] } = await query(
    `INSERT INTO custom_models
       (tenant_id, model_name, base_model_path, data_source, dataset_path,
        db_connection_string, db_query, web_url, status, ollama_tag, version, stream_token)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PENDING', $9, 1, $10)
     RETURNING *`,
    [tenantId, modelName, baseModelPath, dataSource, datasetPath, effectiveConnectionString, dbQuery, webUrl, ollamaTag, streamToken]
  )

  // ── Store databases in junction table (upsert, doesn't wipe) ─────────
  if (dbList) {
    await _upsertModelDatabases(model.id, dbList)
  }

  // Validate model size before training (skip if GPU available)
  const hasGPU = _detectGPU()
  await _validateModelForTraining(baseModelPath, hasGPU)

  // Fire-and-forget with explicit catch — prevents unhandled rejections from
  // crashing the Node process and ensures errors are logged.
  _startTrainingJob(model.id, tenantId, modelName, ollamaTag, baseModelPath, dataSource, datasetPath, effectiveConnectionString, dbQuery, webUrl, dbList)
    .catch(err => console.error(`[TRAINING ${modelName}] Unhandled rejection:`, err))
  return model
}

// ─── Retrain an existing custom model ────────────────────────────────────────
// Accepts optional overrides — caller can change data source / base model.
// Bumps version number and resets status to PENDING → TRAINING.

export async function retrainCustomModel(tenantId, modelId, overrides = {}) {
  const existing = await getCustomModel(tenantId, modelId)
  if (!existing) throw new Error('Custom model not found.')
  if (existing.status === 'TRAINING') throw new Error('Model is already training. Wait for it to finish.')

  // Only the explicitly provided databases get retrained. If none provided,
  // retrain using the single dbConnectionString (legacy behavior).
  const retrainDatabases = overrides.databases || null

  const {
    baseModelPath     = existing.base_model_path,
    dataSource        = existing.data_source,
    datasetPath       = existing.dataset_path,
    dbQuery           = existing.db_query,
    webUrl            = existing.web_url,
  } = overrides

  const dbConnectionString = overrides.dbConnectionString
    || (retrainDatabases ? retrainDatabases[0]?.connectionString : null)
    || existing.db_connection_string

  const ollamaTag = existing.ollama_tag || existing.model_name.toLowerCase().replace(/[^a-z0-9:\-_.]/g, '-')
  const nextVersion = (existing.version || 1) + 1
  const retrainStreamToken = crypto.randomUUID()

  // ── Atomically claim the model for (re)training ────────────────────────
  // Row-level guard: only proceed if status is not TRAINING. Two concurrent
  // calls will race — exactly one wins the UPDATE and proceeds.
  // Also null out train_context and train_checkpoint so the cached schema
  // from the previous training run doesn't get reused, and we start fresh.
  const { rowCount: claimed } = await query(
    `UPDATE custom_models
     SET status = 'PENDING', train_log = COALESCE(train_log, '') || E'\n--- Retrain v${nextVersion} ---\n', error_message = NULL,
         base_model_path = $3, data_source = $4, dataset_path = $5,
         db_connection_string = $6, db_query = $7, web_url = $8,
         version = $9, stream_token = $10, train_context = NULL, train_checkpoint = NULL, updated_at = NOW()
     WHERE tenant_id = $1 AND id = $2 AND status != 'TRAINING'`,
    [tenantId, modelId, baseModelPath, dataSource, datasetPath, dbConnectionString, dbQuery, webUrl, nextVersion, retrainStreamToken]
  )
  if (claimed === 0) throw new Error('Model is already training. Wait for it to finish.')

  // ── Merge databases: accumulate with what's already in junction table ──
  let mergedDatabases = [...(existing.databases || [])]
  if (retrainDatabases && retrainDatabases.length > 0) {
    for (const db of retrainDatabases) {
      const idx = mergedDatabases.findIndex(d => d.label === db.label)
      if (idx >= 0) mergedDatabases[idx] = db
      else mergedDatabases.push(db)
    }
  }

  // ── Sync databases junction table (upsert, accumulates across retrains) ──
  if (mergedDatabases.length > 0) {
    await _upsertModelDatabases(modelId, mergedDatabases)
  }

  const updatedModel = await getCustomModel(tenantId, modelId)

  // Validate model size before retraining (skip if GPU available)
  const hasGPU = _detectGPU()
  await _validateModelForTraining(baseModelPath, hasGPU)

  _startTrainingJob(modelId, tenantId, existing.model_name, ollamaTag, baseModelPath, dataSource, datasetPath, dbConnectionString, dbQuery, webUrl, retrainDatabases)
    .catch(err => console.error(`[TRAINING ${existing.model_name}] Unhandled rejection:`, err))
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
    `ALTER TABLE custom_models ADD COLUMN IF NOT EXISTS stream_token TEXT`,
    `ALTER TABLE custom_models ADD COLUMN IF NOT EXISTS train_context TEXT`,
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

// ─── Sync junction table for multi-DB models ────────────────────────────────
// Upserts each entry by (model_id, db_label) so retraining a single new DB
// adds to existing entries instead of wiping them.
async function _upsertModelDatabases(modelId, databases) {
  for (let i = 0; i < databases.length; i++) {
    const db = databases[i]
    const label = db.label || `db_${i + 1}`
    await query(
      `INSERT INTO custom_model_databases (model_id, db_label, db_connection_string, db_type, sort_order)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (model_id, db_label) DO UPDATE SET
         db_connection_string = EXCLUDED.db_connection_string,
         db_type = EXCLUDED.db_type,
         sort_order = EXCLUDED.sort_order`,
      [modelId, label, db.connectionString, db.dbType || 'postgres', i]
    )
  }
}

// ─── The Core Training Orchestrator ──────────────────────────────────────────

async function _startTrainingJob(modelId, tenantId, modelName, ollamaTag, baseModelPath, dataSource, datasetPath, dbConnectionString, dbQuery, webUrl, databases) {
  // ── Concurrent training semaphore ──────────────────────────────────────
  // If already at max capacity, queue this job and return (caller doesn't await).
  if (activeTrainingCount >= MAX_CONCURRENT_TRAINING) {
    console.log(`[TRAINING ${modelName}] Queued (${trainingQueue.length} ahead). Max concurrent: ${MAX_CONCURRENT_TRAINING}`)
    return new Promise((resolve, reject) => {
      trainingQueue.push({
        modelId,
        run: () => _runTrainingJob(modelId, tenantId, modelName, ollamaTag, baseModelPath, dataSource, datasetPath, dbConnectionString, dbQuery, webUrl, databases),
        resolve,
        reject,
      })
    })
  }

  activeTrainingCount++
  try {
    await _runTrainingJob(modelId, tenantId, modelName, ollamaTag, baseModelPath, dataSource, datasetPath, dbConnectionString, dbQuery, webUrl, databases)
  } finally {
    activeTrainingCount--
    _dequeueTraining()
  }
}

async function _runTrainingJob(modelId, tenantId, modelName, ollamaTag, baseModelPath, dataSource, datasetPath, dbConnectionString, dbQuery, webUrl, databases) {
  const log = (line) => {
    console.log(`[TRAINING ${modelName}] ${line}`)
    _appendLog(modelId, line).catch(() => {})
  }
  // Normalize: if databases[] wasn't passed, build single-entry list from legacy params
  const dbList = (databases && databases.length > 0)
    ? databases
    : (dbConnectionString
        ? [{ label: 'default', connectionString: dbConnectionString, dbType: dataSource === 'nosql' ? 'mongodb' : 'postgres' }]
        : [])
  try {
    // Set stream_token if not already set. Append a training-start marker to the log
    // rather than clearing — preserves history across retrains for debugging.
    await query(
      `UPDATE custom_models SET status = 'TRAINING',
         train_log = COALESCE(train_log, '') || E'\\n=== Training started at ' || NOW()::text || E' ===\\n',
         stream_token = COALESCE(stream_token, gen_random_uuid()::text)
       WHERE id = $1`,
      [modelId]
    )
    // Checkpoint: we may be resuming from a previous crash — check what we already did
    const { rows: [cp] } = await query('SELECT train_checkpoint FROM custom_models WHERE id = $1', [modelId])
    let prevCheckpoint = null
    try { prevCheckpoint = cp?.train_checkpoint ? JSON.parse(cp.train_checkpoint) : null } catch {}

    // ── Checkpoint resume: if we have a saved train_context, skip schema extraction ──
    let skipSchemaExtraction = false
    if (prevCheckpoint) {
      log(`🔄 Resuming from checkpoint: phase="${prevCheckpoint.phase}" at ${prevCheckpoint.timestamp || 'unknown'}`)
      // If train_context was saved to DB before the crash, reuse it instead of
      // re-scanning all databases — this saves minutes on multi-DB setups.
      const { rows: [tc] } = await query('SELECT train_context FROM custom_models WHERE id = $1', [modelId])
      if (tc?.train_context) {
        dbContext = tc.train_context
        skipSchemaExtraction = true
        log(`📋 Reusing cached schema from previous run (${dbContext.length} chars).`)
      } else {
        log(`⚠️  No cached schema found — will re-extract.`)
      }
    }

    const _saveCheckpoint = (phase, meta = {}) => {
      const c = JSON.stringify({ phase, ...meta, timestamp: new Date().toISOString() })
      query('UPDATE custom_models SET train_checkpoint = $2 WHERE id = $1', [modelId, c])
        .catch(() => {})  // non-fatal
    }
    log('🚀 Training job started.')

    const hasGPU = _detectGPU()
    const paramCount = await _getModelParameterCount(baseModelPath)
    const sizeLabel = paramCount
      ? paramCount >= 1_000_000_000
        ? `${(paramCount / 1_000_000_000).toFixed(1)}B`
        : `${(paramCount / 1_000_000).toFixed(0)}M`
      : 'unknown'

    log(`📐 Base model: ${baseModelPath} (${sizeLabel} parameters)`)

    if (hasGPU) {
      log('✅ GPU detected — running real LoRA fine-tuning via Unsloth.')
    } else if (paramCount && paramCount <= 2_000_000_000) {
      log(`✅ Model is ≤2B params — CPU fine-tuning is feasible. Setting up...`)
    } else {
      log(`⚠️  No GPU — running Ollama import/copy mode.`)
    }

    let dbContext = dbQuery || ''
    let nosqlJsonlPath = null

    // ── Multi-DB schema extraction ────────────────────────────────────────
    if (!skipSchemaExtraction && (dataSource === 'database' || dataSource === 'nosql') && dbList.length > 0 && !dbQuery) {
      const allContexts = []
      for (const db of dbList) {
        const label = db.label || 'default'
        try {
          if (db.dbType === 'mongodb' || dataSource === 'nosql') {
            log(`📦 Scanning NoSQL database "${label}"...`)
            const result = await _extractMongoSchema(db.connectionString, modelId, log)
            if (result.text) allContexts.push(`-- Database: ${label} (MongoDB) --\n${result.text}`)
            if (result.jsonlPath) nosqlJsonlPath = result.jsonlPath  // use first JSONL
          } else {
            log(`📊 Scanning database "${label}"...`)
            const schemaText = await _extractDatabaseSchema(db.connectionString, log)
            if (schemaText) allContexts.push(`-- Database: ${label} (PostgreSQL) --\n${schemaText}`)
          }
          _saveCheckpoint(`schema_extracted_${label}`)
        } catch (err) {
          log(`⚠️ Failed to scan "${label}": ${err.message}`)
        }
      }
      if (allContexts.length > 0) {
        dbContext = allContexts.join('\n\n')
        log(`✅ Extracted schema from ${allContexts.length} database(s).`)
        // ── Cache the extracted schema so pushToOllama can reuse it ──────
        // Avoids re-scanning all DBs a second time during push.
        query(`UPDATE custom_models SET train_context = $2 WHERE id = $1`, [modelId, dbContext])
          .catch(() => {})
      }
      // Fallback: if no DBs scanned and no dbQuery, try legacy single connection
      if (!dbContext && dbConnectionString && dbList.length === 0) {
        try {
          if (dataSource === 'nosql') {
            const result = await _extractMongoSchema(dbConnectionString, modelId, log)
            dbContext = result.text
            nosqlJsonlPath = result.jsonlPath
          } else {
            dbContext = await _extractDatabaseSchema(dbConnectionString, log)
          }
          _saveCheckpoint('schema_extracted')
        } catch (err) {
          log(`⚠️ Failed to connect to target DB: ${err.message}`)
        }
      }
      // ── Mark schemas fully done so resume can skip re-extraction ────────
      _saveCheckpoint('schemas_done')
    }

    if (hasGPU || (paramCount && paramCount <= 2_000_000_000)) {
      // Pass the ORIGINAL dbQuery (may be empty) to the Python trainer, NOT dbContext.
      // dbContext (the schema text) is only for the Ollama copy/modelfile path.
      _saveCheckpoint('trainer_starting')
      await _runPythonTrainer(modelId, modelName, ollamaTag, baseModelPath, dataSource, datasetPath, dbConnectionString, dbQuery, webUrl, nosqlJsonlPath, log, dbList)
    } else {
      log(`📝 Evaluated training dataset and base model. Setup ready for Ollama creation.`)
    }

    await query(`UPDATE custom_models SET status = 'TRAINED', train_checkpoint = NULL WHERE id = $1`, [modelId])
    log(`🎉 Training phase complete! Awaiting manual approval to push to Ollama.`)

  } catch (err) {
    console.error(`[TRAINING ${modelName}] Fatal error:`, err)
    await _appendLog(modelId, `❌ FATAL: ${err.message}`)
    // Preserve the checkpoint so next retrain can report where it failed
    await query(`UPDATE custom_models SET status = 'FAILED', error_message = $2 WHERE id = $1`, [modelId, err.message])
  } finally {
    // Drain and clean up the log queue promise chain to prevent memory leaks
    if (logQueues[modelId]) {
      await logQueues[modelId].catch(() => {})
      delete logQueues[modelId]
    }
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

    const ollamaTag = model.ollama_tag || model.model_name.toLowerCase().replace(/[^a-z0-9:\-_.]/g, '-')

    // ── Strategy 1: Check for GGUF from GPU/Unsloth training ──────────────
    // The Python trainer saves GGUF to ./{name}/ directory with Modelfile
    const gpuGgufDir = path.resolve(process.cwd(), ollamaTag)
    const gpuModelfile = path.join(gpuGgufDir, 'Modelfile')
    if (fs.existsSync(gpuModelfile)) {
      log(`✅ Found trained GGUF at ${gpuGgufDir} — using real fine-tuned weights.`)
      await _runOllamaCreateFromModelfile(gpuModelfile, ollamaTag, log)
      log(`🎉 Trained GGUF model "${ollamaTag}" registered in Ollama.`)
      await query(`UPDATE custom_models SET status = 'COMPLETED' WHERE id = $1`, [modelId])
      return model
    }

    // ── Strategy 2: Check for LoRA adapter from CPU training ─────────────
    // CPU path saves to ./trained_models/{name}/ (persistent, survives reboots)
    const loraDir = path.resolve(process.cwd(), 'trained_models', ollamaTag)
    const legacyTmpDir = `/tmp/kuvalam_lora_${ollamaTag}`
    const effectiveLoraDir = fs.existsSync(loraDir) ? loraDir
      : fs.existsSync(legacyTmpDir) ? legacyTmpDir
      : null
    if (effectiveLoraDir) {
      log(`✅ Found trained LoRA adapter at ${effectiveLoraDir}.`)
      // Try to convert LoRA → GGUF via merge script, then import
      const merged = await _mergeLoraAndCreateOllama(model.base_model_path, effectiveLoraDir, ollamaTag, log)
      if (merged) {
        log(`🎉 LoRA-merged model "${ollamaTag}" registered in Ollama.`)
        await query(`UPDATE custom_models SET status = 'COMPLETED' WHERE id = $1`, [modelId])
        return model
      }
      log(`⚠️ LoRA merge failed — falling back to system-prompt injection.`)
    }

    // ── Strategy 3: Check if Ollama already has the trained tag ──────────
    // GPU path's Python script may have already run `ollama create`
    const alreadyExists = await _verifyOllamaModel(ollamaTag)
    if (alreadyExists) {
      log(`✅ Model "${ollamaTag}" already registered in Ollama (Python trainer imported it).`)
      await query(`UPDATE custom_models SET status = 'COMPLETED' WHERE id = $1`, [modelId])
      return model
    }

    // ── Fallback: System-prompt-only Modelfile (no real training happened) ──
    log(`⚠️  No trained weights found. Creating system-prompt-only Ollama model.`)
    log(`   This means the base model answers from its original training data.`)
    log(`   For real fine-tuning, use a model ≤2B params or enable GPU.`)

    let dbContext = model.db_query || ''

    // ── Reuse schema cached during training (avoids re-scanning all DBs) ──
    if (!dbContext && model.train_context) {
      log(`📋 Reusing schema cached during training (${model.train_context.length} chars).`)
      dbContext = model.train_context
    }

    if (!dbContext && (model.data_source === 'database' || model.data_source === 'nosql') && !model.db_query) {
      // ── Multi-DB schema extraction (or single-DB fallback) ──────────────
      const dbs = model.databases && model.databases.length > 0
        ? model.databases
        : (model.db_connection_string
            ? [{ label: 'default', connectionString: model.db_connection_string, dbType: model.data_source === 'nosql' ? 'mongodb' : 'postgres' }]
            : [])
      const allContexts = []
      for (const db of dbs) {
        try {
          if (db.dbType === 'mongodb') {
            log(`📦 Scanning "${db.label}"...`)
            const result = await _extractMongoSchema(db.connectionString, model.id, log)
            if (result.text) allContexts.push(`-- Database: ${db.label} (MongoDB) --\n${result.text}`)
          } else {
            log(`📊 Scanning "${db.label}"...`)
            const schema = await _extractDatabaseSchema(db.connectionString, log)
            if (schema) allContexts.push(`-- Database: ${db.label} (PostgreSQL) --\n${schema}`)
          }
        } catch (err) {
          log(`⚠️ "${db.label}" extract failed: ${err.message}`)
        }
      }
      if (allContexts.length > 0) dbContext = allContexts.join('\n\n')
    }

    await _runOllamaCopy(modelId, ollamaTag, model.base_model_path, model.data_source, model.dataset_path, model.web_url, dbContext, log)

    log(`🔍 Verifying "${ollamaTag}" in Ollama...`)
    const verified = await _verifyOllamaModel(ollamaTag)
    log(verified ? `✅ Verified "${ollamaTag}" in Ollama.` : `⚠️  Not yet in Ollama tags.`)

    await query(`UPDATE custom_models SET status = 'COMPLETED' WHERE id = $1`, [modelId])
    log(`🎉 Successfully added to Ollama registry!`)
    return model
  } catch (err) {
    log(`❌ Push failed: ${err.message}`)
    await query(`UPDATE custom_models SET status = 'FAILED', error_message = $2 WHERE id = $1`, [modelId, err.message])
    throw err
  }
}

// ─── Run ollama create from an existing Modelfile (preserves trained weights) ─
async function _runOllamaCreateFromModelfile(modelfilePath, ollamaTag, log) {
  log(`⚙️  Running: ollama create ${ollamaTag} -f ${modelfilePath}`)
  await new Promise((resolve, reject) => {
    const proc = spawn('ollama', ['create', ollamaTag, '-f', modelfilePath])
    proc.stdout.on('data', (d) => d.toString().split('\n').filter(Boolean).forEach(log))
    proc.stderr.on('data', (d) => d.toString().split('\n').filter(Boolean).forEach(l => log(`⚙️  ${l}`)))
    proc.on('close', (code) => {
      code === 0 ? resolve() : reject(new Error(`ollama create exited with code ${code}`))
    })
  })
  log(`✅ Ollama model "${ollamaTag}" created successfully.`)
}

// ─── Merge LoRA adapter into base model and create Ollama GGUF ──────────────
async function _mergeLoraAndCreateOllama(baseModelPath, loraDir, ollamaTag, log) {
  try {
    const scriptPath = path.resolve(process.cwd(), 'src/services/merge_lora.py')
    // Prefer project venv
    const venvPython = path.resolve(process.cwd(), '../../.venv/bin/python')
    const venvPythonAlt = path.resolve(process.cwd(), '../.venv/bin/python')
    const pythonCmd = fs.existsSync(venvPython) ? venvPython
      : fs.existsSync(venvPythonAlt) ? venvPythonAlt
      : 'python3'

    if (!fs.existsSync(scriptPath)) {
      log(`⚠️ merge_lora.py not found — cannot merge LoRA.`)
      return false
    }

    log(`🐍 Running LoRA merge: ${pythonCmd} ${scriptPath} --base ${baseModelPath} --lora ${loraDir} --name ${ollamaTag}`)
    await new Promise((resolve, reject) => {
      const proc = spawn(pythonCmd, [scriptPath, '--base', baseModelPath, '--lora', loraDir, '--name', ollamaTag])
      proc.stdout.on('data', (d) => d.toString().split('\n').filter(Boolean).forEach(log))
      proc.stderr.on('data', (d) => d.toString().split('\n').filter(Boolean).forEach(l => log(`⚠️  ${l}`)))
      proc.on('close', (code) => {
        code === 0 ? resolve() : reject(new Error(`LoRA merge exited with code ${code}`))
      })
    })

    // Merge script should create ollamaTag/Modelfile → import it
    const mergedDir = path.resolve(process.cwd(), ollamaTag)
    const mergedModelfile = path.join(mergedDir, 'Modelfile')
    if (fs.existsSync(mergedModelfile)) {
      await _runOllamaCreateFromModelfile(mergedModelfile, ollamaTag, log)
      return true
    }
    return false
  } catch (err) {
    log(`⚠️ LoRA merge failed: ${err.message}`)
    return false
  }
}

// ─── GPU Detection ────────────────────────────────────────────────────────────

function _detectGPU() {
  try {
    // Use project venv Python if available
    const venvPython = path.resolve(process.cwd(), '../../.venv/bin/python')
    const venvPythonAlt = path.resolve(process.cwd(), '../.venv/bin/python')
    const pythonCmd = fs.existsSync(venvPython) ? venvPython
      : fs.existsSync(venvPythonAlt) ? venvPythonAlt
      : 'python3'
    execSync(`${pythonCmd} -c "import torch; assert torch.cuda.is_available() or torch.backends.mps.is_available()"`, { stdio: 'ignore' })
    return true
  } catch { return false }
}

// ─── Python LoRA Trainer (GPU path) ──────────────────────────────────────────

function _runPythonTrainer(modelId, modelName, ollamaTag, baseModelPath, dataSource, datasetPath, dbConnectionString, dbQuery, webUrl, nosqlJsonlPath, log) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.resolve(process.cwd(), 'src/services/llm_trainer.py')

    // Prefer the project venv if it exists, otherwise fall back to system python3
    const venvPython = path.resolve(process.cwd(), '../../.venv/bin/python')
    const venvPythonAlt = path.resolve(process.cwd(), '../.venv/bin/python')
    const pythonCmd = fs.existsSync(venvPython) ? venvPython
      : fs.existsSync(venvPythonAlt) ? venvPythonAlt
      : 'python3'

    const args = [scriptPath, '--base', baseModelPath, '--name', ollamaTag, '--datasource', dataSource]
    if (dataSource === 'file')     args.push('--dataset', datasetPath)
    if (dataSource === 'database') args.push('--db_url', dbConnectionString, '--db_query', dbQuery)
    if (dataSource === 'nosql')    args.push('--nosql_jsonl', nosqlJsonlPath || '')
    if (dataSource === 'web')      args.push('--web_url', webUrl)
    log(`🐍 Running: ${pythonCmd} ${scriptPath} ...`)
    const py = spawn(pythonCmd, args)
    runningTrainers.set(modelId, py)  // track so UI can cancel
    py.stdout.on('data', (d) => d.toString().split('\n').filter(Boolean).forEach(log))
    py.stderr.on('data', (d) => d.toString().split('\n').filter(Boolean).forEach(l => log(`⚠️  ${l}`)))
    py.on('close', (code) => {
      runningTrainers.delete(modelId)  // cleanup on exit
      code === 0 ? resolve() : reject(new Error(`Trainer exited with code ${code}`))
    })
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
    if (!sourceModel) throw new Error('No local Ollama models found. Pull a model first (e.g., ollama pull qwen2.5:14b)')
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
  else if (dataSource === 'nosql') {
    systemPrompt += ` Fine-tuned on NoSQL document database knowledge.`
    if (dbContext) systemPrompt += `\n\nMongoDB Context:\n${dbContext}`
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
// Uses a short-lived connection pool (max 2) instead of raw pg.Client to avoid
// ephemeral port exhaustion when scanning many databases concurrently.
// Returns ONLY column names + types — never sample row data, because this text
// can end up baked into Ollama model system prompts permanently.

// Cache pools by connection string so repeated extracts reuse the same pool.
const _schemaPools = new Map()

async function _extractDatabaseSchema(connectionString, log) {
  const pg = await import('pg').then(m => m.default || m)
  let pool = _schemaPools.get(connectionString)
  if (!pool) {
    pool = new pg.Pool({ connectionString, max: 2, idleTimeoutMillis: 10_000 })
    _schemaPools.set(connectionString, pool)
  }
  try {
    const { rows: tables } = await pool.query(
      `SELECT table_schema, table_name 
       FROM information_schema.tables 
       WHERE table_schema NOT IN ('pg_catalog', 'information_schema')`
    )
    let schemaText = ""
    for (const { table_schema, table_name } of tables) {
      log(`📊 Scanning table: ${table_schema}.${table_name}...`)
      const { rows: cols } = await pool.query(
        `SELECT column_name, data_type 
         FROM information_schema.columns 
         WHERE table_schema = $1 AND table_name = $2`,
        [table_schema, table_name]
      )
      schemaText += `Table ${table_schema}.${table_name}: ` + cols.map(c => `${c.column_name} (${c.data_type})`).join(', ') + '\n'
      schemaText += '\n'
    }
    return schemaText.trim() || 'Empty database.'
  } finally {
    // Don't end the pool — it's cached for reuse. Let the Map own its lifecycle.
  }
}

// ─── Extract MongoDB Schema ───────────────────────────────────────────────────
// Connects to MongoDB, scans all collections, samples documents, and returns:
//   1. A human-readable schema summary (for system prompt fallback)
//   2. Writes structured JSONL to /tmp for the Python trainer to consume
async function _extractMongoSchema(mongoUri, modelId, log) {
  try {
    const { MongoClient } = await import('mongodb')
    const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 })
    await client.connect()
    const db = client.db()  // use the database from the URI, or default

    const collections = await db.listCollections().toArray()
    const colNames = collections.map(c => c.name)
    log(`📦 MongoDB: found ${colNames.length} collections: ${colNames.join(', ')}`)

    if (colNames.length === 0) {
      await client.close()
      return { text: 'Empty MongoDB database — no collections found.', jsonlPath: null }
    }

    const allCollections = []
    const schemaLines = []

    for (const colName of colNames) {
      log(`📊 Scanning collection: ${colName}...`)
      const coll = db.collection(colName)
      const sampleDocs = await coll.find({}).limit(20).toArray()
      const totalCount = await coll.estimatedDocumentCount()

      // Detect all unique field paths (including nested)
      const fieldMap = new Map()  // fieldPath -> Set of types
      for (const doc of sampleDocs) {
        _walkFields(doc, '', fieldMap)
      }

      const fields = []
      for (const [field, types] of fieldMap) {
        fields.push({ name: field, types: [...types] })
      }

      const collectionData = {
        collection: colName,
        totalDocuments: totalCount,
        sampleCount: sampleDocs.length,
        fields,
        documents: sampleDocs.map(d => {
          // Clean ObjectId/Date for JSON serialization
          const cleaned = {}
          for (const [k, v] of Object.entries(d)) {
            if (v && typeof v === 'object' && v._bsontype === 'ObjectId') {
              cleaned[k] = v.toString()
            } else if (v instanceof Date) {
              cleaned[k] = v.toISOString()
            } else if (v && typeof v === 'object' && !Array.isArray(v)) {
              cleaned[k] = _cleanBSON(v)
            } else if (Array.isArray(v)) {
              cleaned[k] = v.map(item =>
                item && typeof item === 'object' && !Array.isArray(item) ? _cleanBSON(item) : item
              )
            } else {
              cleaned[k] = v
            }
          }
          return cleaned
        })
      }

      allCollections.push(collectionData)

      // Human-readable schema summary — NEVER include sample document data.
      // This text can end up baked into Ollama model system prompts permanently.
      schemaLines.push(`Collection: ${colName} (${totalCount} documents)`)
      for (const f of fields) {
        schemaLines.push(`  ${f.name}: ${f.types.join(' | ')}`)
      }
      schemaLines.push('')
    }

    await client.close()

    // Write structured JSONL for the Python trainer
    const tmpDir = (await import('os')).tmpdir()
    const jsonlPath = path.join(tmpDir, `kuvalam_mongo_${modelId}.jsonl`)
    const fsPromises = await import('fs/promises')
    // Write as one JSON object (not line-by-line — easier for Python to parse)
    await fsPromises.writeFile(jsonlPath, JSON.stringify({ collections: allCollections }, null, 2), 'utf8')
    log(`📄 MongoDB schema written to ${jsonlPath}`)

    return {
      text: schemaLines.join('\n') || 'No collections found.',
      jsonlPath
    }
  } catch (err) {
    log(`⚠️ MongoDB extraction failed: ${err.message}`)
    return { text: `MongoDB schema unavailable: ${err.message}`, jsonlPath: null }
  }
}

// ─── Walk nested document fields for type detection ───────────────────────────
function _walkFields(obj, prefix, fieldMap) {
  if (!obj || typeof obj !== 'object') return
  for (const [key, val] of Object.entries(obj)) {
    const fullPath = prefix ? `${prefix}.${key}` : key
    const type = _detectValueType(val)
    if (!fieldMap.has(fullPath)) fieldMap.set(fullPath, new Set())
    fieldMap.get(fullPath).add(type)
    // Recurse into nested objects (but not arrays of primitives)
    if (val && typeof val === 'object' && !Array.isArray(val) && !(val instanceof Date)) {
      _walkFields(val, fullPath, fieldMap)
    }
    // For arrays of objects, walk the first element to detect sub-fields
    if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object' && val[0] !== null) {
      const first = val[0]
      if (!(first instanceof Date)) {
        _walkFields(first, `${fullPath}[]`, fieldMap)
      }
    }
  }
}

function _detectValueType(val) {
  if (val === null || val === undefined) return 'null'
  if (val instanceof Date) return 'date'
  if (typeof val === 'object' && val._bsontype === 'ObjectId') return 'objectId'
  if (Array.isArray(val)) return 'array'
  if (typeof val === 'object') return 'object'
  if (typeof val === 'number') return Number.isInteger(val) ? 'integer' : 'float'
  if (typeof val === 'boolean') return 'boolean'
  return 'string'
}

function _cleanBSON(obj) {
  if (!obj || typeof obj !== 'object') return obj
  const cleaned = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object' && v._bsontype === 'ObjectId') {
      cleaned[k] = v.toString()
    } else if (v instanceof Date) {
      cleaned[k] = v.toISOString()
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      cleaned[k] = _cleanBSON(v)
    } else if (Array.isArray(v)) {
      cleaned[k] = v.map(item =>
        item && typeof item === 'object' && !Array.isArray(item) ? _cleanBSON(item) : item
      )
    } else {
      cleaned[k] = v
    }
  }
  return cleaned
}
