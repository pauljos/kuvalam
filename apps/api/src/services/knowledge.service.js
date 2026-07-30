// apps/api/src/services/knowledge.service.js
import { query } from '../db/pool.js'
import { embed } from './llm.service.js'
import { auditLog } from '../utils/audit.js'
import { AppError } from '../utils/errors.js'
import { extractText } from './document-extractor.service.js'
import { uploadFile } from './storage.service.js'
import { randomUUID } from 'crypto'
import { checkPlanLimit } from './plan-limits.service.js'

// ─── Knowledge ingestion queue ───────────────────────────────────────────────
// ── L1 Fix: moved from setImmediate (in-process, lost on server restart) to a
// BullMQ queue so document processing is durable and retryable.
// Falls back gracefully to setImmediate when Redis is unavailable.
//
// Queue: 'knowledge-ingestion'
// Job data: { docId, tenantId, content }
// Retries: 3 attempts with exponential backoff

export async function enqueueDocumentProcessing(doc, content, tenantId) {
  try {
    const { Queue } = await import('bullmq')
    const { getRedisConnection } = await import('./queue.service.js')
    const conn = getRedisConnection()
    const knowledgeQueue = new Queue('knowledge-ingestion', {
      connection: conn,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { age: 3600 },
        removeOnFail: { age: 86400 }
      }
    })
    await knowledgeQueue.add('process-document', { docId: doc.id, tenantId, content })
    return
  } catch {
    // Redis unavailable — fall back to setImmediate (same as before)
  }
  // Fallback: in-process async
  setImmediate(() => processDocument(doc, content, tenantId).catch(err => {
    console.error(`[Knowledge] Document ${doc.id} processing failed:`, err.message)
    query(`UPDATE knowledge_documents SET status = 'FAILED' WHERE id = $1`, [doc.id]).catch(() => {})
  }))
}

/**
 * Register the BullMQ worker for knowledge ingestion.
 * Called from queue.service.js initQueues() so all workers start together.
 */
export async function createKnowledgeWorker(conn, logger) {
  const { Worker } = await import('bullmq')
  const worker = new Worker('knowledge-ingestion', async (job) => {
    const { docId, tenantId, content } = job.data
    // Re-fetch the document to get full record
    const { rows: [doc] } = await query(
      'SELECT * FROM knowledge_documents WHERE id = $1 AND tenant_id = $2',
      [docId, tenantId]
    )
    if (!doc) return // document deleted before processing started
    if (doc.status === 'INDEXED' || doc.status === 'PARTIALLY_INDEXED') return // already processed
    await processDocument(doc, content, tenantId)
  }, {
    connection: conn,
    concurrency: parseInt(process.env.KNOWLEDGE_CONCURRENCY || '3'),
  })

  worker.on('failed', (job, err) => {
    if (logger) logger.error(
      { jobId: job?.id, docId: job?.data?.docId, err: err?.message },
      '[Knowledge] Document processing permanently failed after retries'
    )
    // Mark document as FAILED in DB (best-effort)
    if (job?.data?.docId) {
      query(
        `UPDATE knowledge_documents SET status = 'FAILED' WHERE id = $1 AND status = 'PROCESSING'`,
        [job.data.docId]
      ).catch(() => {})
    }
  })

  return worker
}

/**
 * Recover documents stuck as PROCESSING from before a server restart.
 * Call this on startup after queue workers are initialised.
 */
export async function recoverStuckDocuments() {
  try {
    // Documents stuck as PROCESSING for more than 30 minutes — server likely
    // crashed mid-processing. Re-enqueue them.
    const { rows: stuck } = await query(
      `SELECT id, tenant_id, name FROM knowledge_documents
       WHERE status = 'PROCESSING'
         AND updated_at < NOW() - INTERVAL '30 minutes'
       LIMIT 50`
    )
    for (const doc of stuck) {
      // We don’t have the original content in DB, so we can only mark as FAILED
      // A user re-upload will be needed. This prevents silent stuck state.
      await query(
        `UPDATE knowledge_documents
         SET status = 'FAILED',
             updated_at = NOW()
         WHERE id = $1 AND status = 'PROCESSING'`,
        [doc.id]
      )
      console.warn(`[Knowledge] Recovered stuck doc '${doc.name}' (${doc.id}) — marked as FAILED (re-upload required)`)
    }
    if (stuck.length > 0) {
      console.log(`[Knowledge] Startup recovery: marked ${stuck.length} stuck document(s) as FAILED`)
    }
  } catch (err) {
    console.warn('[Knowledge] Startup recovery failed:', err.message)
  }
}

export async function createKnowledgeBase({ tenantId, name, description, userId }) {
  // Plan limit check
  const { rows: [countRow] } = await query(
    'SELECT COUNT(*) as count FROM knowledge_bases WHERE tenant_id = $1',
    [tenantId]
  )
  await checkPlanLimit(tenantId, 'kbs', parseInt(countRow?.count || 0))
  const { rows: [kb] } = await query(
    `INSERT INTO knowledge_bases (tenant_id, name, description) VALUES ($1,$2,$3) RETURNING *`,
    [tenantId, name, description]
  )
  await auditLog({ eventType: 'knowledge.base_created', tenantId, actorId: userId, actorType: 'USER', resourceType: 'KnowledgeBase', resourceId: kb.id, action: 'CREATE' })
  return kb
}

export async function listKnowledgeBases(tenantId) {
  const { rows } = await query('SELECT * FROM knowledge_bases WHERE tenant_id = $1 ORDER BY created_at DESC', [tenantId])
  return rows
}

export async function getKnowledgeBase(tenantId, kbId) {
  const { rows: [kb] } = await query('SELECT * FROM knowledge_bases WHERE id = $1 AND tenant_id = $2', [kbId, tenantId])
  if (!kb) throw new AppError('KB_NOT_FOUND', 'Knowledge base not found', 404)
  return kb
}

export async function deleteKnowledgeBase(tenantId, kbId, userId) {
  const { rows: [kb] } = await query('SELECT * FROM knowledge_bases WHERE id = $1 AND tenant_id = $2', [kbId, tenantId])
  if (!kb) throw new AppError('KB_NOT_FOUND', 'Knowledge base not found', 404)
  // CASCADE deletes: documents, chunks, agent_knowledge_bases links
  await query('DELETE FROM knowledge_bases WHERE id = $1 AND tenant_id = $2', [kbId, tenantId])
  await auditLog({ eventType: 'knowledge.base_deleted', tenantId, actorId: userId, actorType: 'USER', resourceType: 'KnowledgeBase', resourceId: kbId, action: 'DELETE' })
  return { deleted: true }
}

export async function deleteDocument(tenantId, docId, userId) {
  const { rows: [doc] } = await query(
    'SELECT * FROM knowledge_documents WHERE id = $1 AND tenant_id = $2',
    [docId, tenantId]
  )
  if (!doc) throw new AppError('DOCUMENT_NOT_FOUND', 'Document not found', 404)

  // Delete chunks first (embeddings CASCADE), then the document record
  await query('DELETE FROM knowledge_chunks WHERE document_id = $1', [docId])
  await query('DELETE FROM knowledge_documents WHERE id = $1 AND tenant_id = $2', [docId, tenantId])

  await auditLog({ eventType: 'knowledge.document_deleted', tenantId, actorId: userId, actorType: 'USER', resourceType: 'KnowledgeDocument', resourceId: docId, action: 'DELETE' })
  return { deleted: true, documentId: docId, name: doc.name }
}

export async function ingestDocument({ tenantId, knowledgeBaseId, name, content, mimeType = 'text/plain', userId }) {
  // Store document record
  const { rows: [doc] } = await query(
    `INSERT INTO knowledge_documents (knowledge_base_id, tenant_id, name, source_type, mime_type, status, created_by)
     VALUES ($1,$2,$3,'TEXT',$4,'PROCESSING',$5) RETURNING *`,
    [knowledgeBaseId, tenantId, name, mimeType, userId]
  )

  await auditLog({ eventType: 'knowledge.document_received', tenantId, actorId: userId, actorType: 'USER', resourceType: 'KnowledgeDocument', resourceId: doc.id, action: 'INGEST' })

  // ── L1 Fix: enqueue via BullMQ instead of setImmediate ──────────────────
  // setImmediate was lost on server restart, leaving docs stuck as PROCESSING.
  // BullMQ persists jobs in Redis with retry support.
  await enqueueDocumentProcessing(doc, content, tenantId)

  return { documentId: doc.id, name, status: 'PROCESSING' }
}

export async function ingestFile({ tenantId, knowledgeBaseId, filename, fileBuffer, mimeType, userId }) {
  // Phase 3: Upload file via storage abstraction (S3 or local fallback)
  const fileId = randomUUID()
  const storageKey = `${tenantId}/${knowledgeBaseId}/${fileId}_${filename}`
  await uploadFile(storageKey, fileBuffer, mimeType)

  // Phase 3: Extract text using document-extractor (supports PDF, DOCX, TXT, MD)
  let content = ''
  try {
    content = await extractText(fileBuffer, mimeType, filename)
  } catch {
    content = fileBuffer.toString('utf8') // last-resort fallback
  }

  if (!content || content.trim().length < 10) {
    throw new AppError('EMPTY_DOCUMENT', 'Could not extract meaningful text from the uploaded file', 400)
  }

  return ingestDocument({ tenantId, knowledgeBaseId, name: filename, content, mimeType, userId })
}

async function processDocument(doc, content, tenantId) {
  // 1. Chunk the document
  const chunks = chunkText(content)

  // Always use Ollama nomic-embed-text (768-dim) for embeddings to match
  // the pgvector column dimension. Passing llmConfig would trigger the tenant's
  // configured provider (e.g. OpenAI 1536-dim), causing dimension mismatches.

  // 2. Save chunks
  const chunkIds = []
  for (let i = 0; i < chunks.length; i++) {
    const { rows: [chunk] } = await query(
      `INSERT INTO knowledge_chunks (document_id, tenant_id, chunk_index, content, token_count)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [doc.id, tenantId, i, chunks[i], estimateTokens(chunks[i])]
    )
    chunkIds.push({ id: chunk.id, content: chunks[i] })
  }

  // 3. Generate embeddings in batches of 20
  // ── Track failures so we can mark partially-indexed documents honestly ──
  // Previously a silent catch meant all embedding failures were invisible —
  // documents were marked INDEXED even when most chunks had no embedding,
  // causing RAG to return empty results with no error signal.
  const batchSize = 20
  let indexedChunkCount = 0
  const failedChunkIds = []

  for (let i = 0; i < chunkIds.length; i += batchSize) {
    const batch = chunkIds.slice(i, i + batchSize)
    try {
      const embeddings = await embed({ text: batch.map(c => c.content), tenantId })
      for (let j = 0; j < batch.length; j++) {
        await query(
          `INSERT INTO knowledge_chunk_embeddings (chunk_id, tenant_id, embedding)
           VALUES ($1,$2,$3)`,
          [batch[j].id, tenantId, JSON.stringify(embeddings[j])]
        )
        indexedChunkCount++
      }
    } catch (err) {
      // Record which chunks failed so we can surface the gap
      failedChunkIds.push(...batch.map(c => c.id))
      console.warn(`[Knowledge] Embedding batch failed for doc ${doc.id} (chunks ${i}–${i + batch.length - 1}): ${err.message}`)
    }
  }

  // 4. Mark document status — INDEXED if all chunks embedded, PARTIALLY_INDEXED if some failed
  const finalStatus = failedChunkIds.length === 0
    ? 'INDEXED'
    : (indexedChunkCount === 0 ? 'FAILED' : 'PARTIALLY_INDEXED')

  await query(
    `UPDATE knowledge_documents
     SET status = $1,
         chunk_count = $2,
         indexed_chunk_count = $3,
         updated_at = NOW()
     WHERE id = $4`,
    [finalStatus, chunkIds.length, indexedChunkCount, doc.id]
  )

  if (failedChunkIds.length > 0) {
    console.warn(`[Knowledge] Doc ${doc.id} marked as ${finalStatus}: ${indexedChunkCount}/${chunkIds.length} chunks indexed (${failedChunkIds.length} embedding failures)`)
  }

  // 5. Update KB doc count — only for documents that were at least partially indexed
  if (finalStatus === 'INDEXED' || finalStatus === 'PARTIALLY_INDEXED') {
    await query(
      `UPDATE knowledge_bases SET document_count = document_count + 1 WHERE id = $1`,
      [doc.knowledge_base_id]
    )
  }
}

export async function searchKnowledge({ tenantId, query: searchQuery, knowledgeBaseIds = [], topK = 10, threshold = 0.5 }) {
  if (knowledgeBaseIds.length === 0) return []

  // Get IDs of chunks in these knowledge bases
  const kbIdPlaceholders = knowledgeBaseIds.map((_, i) => `$${i + 2}`).join(',')

  try {
    // Semantic search (vector similarity)
    // Always use Ollama nomic-embed-text (768-dim) for search to match the vector DB column dimension.
    // Passing llmConfig would trigger the tenant's configured provider (e.g. OpenAI 1536-dim),
    // which causes a dimension mismatch against vector(768).
    let queryEmbedding
    try {
      const embeddings = await embed({ text: searchQuery, tenantId })
      queryEmbedding = embeddings[0]
    } catch {
      // Fall back to keyword search only if embedding fails
      return keywordSearch(tenantId, searchQuery, knowledgeBaseIds, topK)
    }

    const embeddingStr = JSON.stringify(queryEmbedding)

    // Hybrid search: semantic + keyword
    const { rows: semanticResults } = await query(
      `SELECT kc.id, kc.content, kc.document_id, kc.metadata,
              kd.name as document_name,
              1 - (kce.embedding <=> $1::vector) as score
       FROM knowledge_chunk_embeddings kce
       JOIN knowledge_chunks kc ON kc.id = kce.chunk_id
       JOIN knowledge_documents kd ON kd.id = kc.document_id
       WHERE kce.tenant_id = $${knowledgeBaseIds.length + 2}
         AND kd.knowledge_base_id IN (${kbIdPlaceholders})
         AND kc.status = 'ACTIVE'
         AND 1 - (kce.embedding <=> $1::vector) > $${knowledgeBaseIds.length + 3}
       ORDER BY score DESC
       LIMIT $${knowledgeBaseIds.length + 4}`,
      [embeddingStr, ...knowledgeBaseIds, tenantId, threshold, topK]
    )

    return semanticResults.map(r => ({
      id: r.id,
      content: r.content,
      documentId: r.document_id,
      documentName: r.document_name,
      score: parseFloat(r.score),
      metadata: r.metadata
    }))
  } catch {
    return []
  }
}

async function keywordSearch(tenantId, searchQuery, knowledgeBaseIds, topK) {
  const kbPlaceholders = knowledgeBaseIds.map((_, i) => `$${i + 3}`).join(',')
  const { rows } = await query(
    `SELECT kc.id, kc.content, kc.document_id, kd.name as document_name,
            ts_rank(to_tsvector('english', kc.content), plainto_tsquery('english', $1)) as score
     FROM knowledge_chunks kc
     JOIN knowledge_documents kd ON kd.id = kc.document_id
     WHERE kc.tenant_id = $2
       AND kd.knowledge_base_id IN (${kbPlaceholders})
       AND kc.status = 'ACTIVE'
       AND to_tsvector('english', kc.content) @@ plainto_tsquery('english', $1)
     ORDER BY score DESC LIMIT $${knowledgeBaseIds.length + 3}`,
    [searchQuery, tenantId, ...knowledgeBaseIds, topK]
  )
  return rows.map(r => ({ ...r, score: parseFloat(r.score) }))
}

export async function listDocuments(tenantId, knowledgeBaseId) {
  const { rows } = await query(
    'SELECT * FROM knowledge_documents WHERE knowledge_base_id = $1 AND tenant_id = $2 ORDER BY created_at DESC',
    [knowledgeBaseId, tenantId]
  )
  return rows
}

export async function getDocument(tenantId, docId) {
  const { rows: [doc] } = await query(
    'SELECT * FROM knowledge_documents WHERE id = $1 AND tenant_id = $2',
    [docId, tenantId]
  )
  if (!doc) throw new AppError('DOCUMENT_NOT_FOUND', 'Document not found', 404)
  return doc
}

// Text chunking: paragraph-based strategy
function chunkText(text, maxChunkSize = 512) {
  // Split on double newlines first (paragraphs)
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim().length > 20)
  const chunks = []
  let currentChunk = ''

  for (const para of paragraphs) {
    // If adding this paragraph would make the chunk too large, commit current chunk
    if (currentChunk.length + para.length > maxChunkSize * 4 && currentChunk.length > 0) {
      chunks.push(currentChunk.trim())
      currentChunk = ''
    }
    // If a single paragraph is still too large (e.g. CSV with no blank lines),
    // split it on newlines too — each line becomes a mini-chunk
    if (para.length > maxChunkSize * 6) {
      // Push whatever we have so far
      if (currentChunk.trim()) {
        chunks.push(currentChunk.trim())
        currentChunk = ''
      }
      // Split large paragraph into sub-chunks by newlines
      const lines = para.split('\n').filter(l => l.trim())
      let lineChunk = ''
      for (const line of lines) {
        if (lineChunk.length + line.length > maxChunkSize * 4 && lineChunk.length > 0) {
          chunks.push(lineChunk.trim())
          lineChunk = ''
        }
        lineChunk += (lineChunk ? '\n' : '') + line
      }
      if (lineChunk.trim()) currentChunk = lineChunk.trim()
    } else {
      currentChunk += (currentChunk ? '\n\n' : '') + para
    }
  }

  if (currentChunk.trim()) chunks.push(currentChunk.trim())
  return chunks.length > 0 ? chunks : [text.substring(0, maxChunkSize * 4)]
}

function estimateTokens(text) {
  return Math.ceil(text.length / 4)
}

// ─── Reprocess a single document (re-chunk + re-embed from stored chunks) ─────
export async function reprocessDocument(tenantId, docId, userId) {
  const { rows: [doc] } = await query(
    'SELECT * FROM knowledge_documents WHERE id = $1 AND tenant_id = $2',
    [docId, tenantId]
  )
  if (!doc) throw new AppError('DOCUMENT_NOT_FOUND', 'Document not found', 404)

  // Reassemble original content from existing chunks
  const { rows: oldChunks } = await query(
    'SELECT content FROM knowledge_chunks WHERE document_id = $1 ORDER BY chunk_index',
    [docId]
  )
  const content = oldChunks.map(c => c.content).join('\n\n')

  if (!content || content.trim().length < 10) {
    throw new AppError('NO_CONTENT', 'No recoverable content found for reprocessing. Please re-upload the document.', 400)
  }

  // Delete old chunks and embeddings (CASCADE)
  await query('DELETE FROM knowledge_chunks WHERE document_id = $1', [docId])

  // Reset doc status and re-process
  await query(
    `UPDATE knowledge_documents SET status = 'PROCESSING', chunk_count = 0, indexed_chunk_count = 0, updated_at = NOW() WHERE id = $1`,
    [docId]
  )

  await enqueueDocumentProcessing(doc, content, tenantId)
  await auditLog({ eventType: 'knowledge.document_reprocessed', tenantId, actorId: userId, actorType: 'USER', resourceType: 'KnowledgeDocument', resourceId: docId, action: 'REPROCESS' })

  return { documentId: docId, name: doc.name, status: 'PROCESSING' }
}

// ─── Reprocess all FAILED / PARTIALLY_INDEXED documents in a KB ──────────────
export async function reprocessKnowledgeBase(tenantId, kbId, userId) {
  const kb = await getKnowledgeBase(tenantId, kbId)

  const { rows: docs } = await query(
    `SELECT id, name, status FROM knowledge_documents
     WHERE knowledge_base_id = $1 AND tenant_id = $2
       AND status IN ('FAILED', 'PARTIALLY_INDEXED', 'PROCESSING')
     ORDER BY created_at`,
    [kbId, tenantId]
  )

  if (docs.length === 0) {
    return { reprocessed: 0, message: 'No documents need reprocessing. All documents are fully indexed.' }
  }

  let count = 0
  for (const doc of docs) {
    try {
      await reprocessDocument(tenantId, doc.id, userId)
      count++
    } catch (err) {
      console.warn(`[Knowledge] Failed to reprocess doc ${doc.id}: ${err.message}`)
    }
  }

  await auditLog({ eventType: 'knowledge.base_reprocessed', tenantId, actorId: userId, actorType: 'USER', resourceType: 'KnowledgeBase', resourceId: kbId, action: 'REPROCESS_ALL' })

  return { reprocessed: count, total: docs.length, message: `Reprocessing ${count} of ${docs.length} documents.` }
}

// ─── Import from PostgreSQL into Knowledge Base ────────────────────────────

/**
 * Import PostgreSQL table rows as documents into a Knowledge Base.
 * Each table becomes one document (or batch of documents) with all rows
 * formatted as structured text, which then gets chunked and embedded
 * for vector search.
 *
 * Uses discoverDBSchema() from graph-db-importer.service.js for schema scanning.
 */
export async function importDBToKnowledgeBase(tenantId, kbId, userId, { tables: selectedTables, limit = 500, rowsPerDoc = 200, connectionId } = {}) {
  const { discoverDBSchema, resolveDBSource: getDBSource } = await import('./graph-db-importer.service.js')

  const kb = await getKnowledgeBase(tenantId, kbId)
  const schema = await discoverDBSchema(tenantId, connectionId)
  const db = await getDBSource(tenantId, connectionId)

  const toImport = selectedTables && selectedTables.length > 0
    ? schema.tables.filter(t => selectedTables.includes(`${t.schema}.${t.name}`) || selectedTables.includes(t.name))
    : schema.tables

  if (toImport.length === 0) {
    return { tables: 0, documents: 0, totalRows: 0, errors: ['No matching tables found'] }
  }

  const errors = []
  let totalDocs = 0
  let totalRows = 0
  let tablesProcessed = 0

  try {
    for (const tbl of toImport) {
      try {
        const flavor = db.flavor || 'postgres'
        const isMySQL = flavor === 'mysql' || flavor === 'mariadb'
        const q = isMySQL ? '`' : '"'
        const { rows } = await db.query(
          `SELECT * FROM ${q}${tbl.schema}${q}.${q}${tbl.name}${q} LIMIT $1`,
          [limit || 500]
        )

      if (rows.length === 0) {
        tablesProcessed++
        continue
      }

      totalRows += rows.length

      // Format rows as structured text documents, in batches of rowsPerDoc
      const cols = tbl.columns.map(c => c.name)
      const batches = []

      for (let i = 0; i < rows.length; i += rowsPerDoc) {
        const batch = rows.slice(i, i + rowsPerDoc)
        const header = `Table: ${tbl.schema}.${tbl.name}\nColumns: ${cols.join(', ')}\n\n`
        const body = batch.map((row, idx) => {
          const fields = cols.map(c => {
            const val = row[c]
            if (val === null || val === undefined) return `${c}: (null)`
            if (typeof val === 'string' && val.length > 2000) return `${c}: ${val.slice(0, 2000)}...`
            if (Buffer.isBuffer(val)) return `${c}: (binary)`
            if (val instanceof Date) return `${c}: ${val.toISOString()}`
            if (typeof val === 'object') return `${c}: ${JSON.stringify(val).slice(0, 1000)}`
            return `${c}: ${val}`
          }).join('\n')
          return `--- Row ${i + idx + 1} ---\n${fields}`
        }).join('\n\n')
        batches.push(header + body)
      }

      // Ingest each batch as a separate document
      for (let b = 0; b < batches.length; b++) {
        const docName = batches.length === 1
          ? `${tbl.schema}.${tbl.name} (${rows.length} rows)`
          : `${tbl.schema}.${tbl.name} batch ${b + 1}/${batches.length} (${Math.min(rowsPerDoc, rows.length - b * rowsPerDoc)} rows)`

        await ingestDocument({
          tenantId,
          knowledgeBaseId: kbId,
          name: docName,
          content: batches[b],
          mimeType: 'text/plain',
          userId,
        })

        totalDocs++
      }

      tablesProcessed++
    } catch (e) {
      errors.push(`${tbl.name}: ${e.message}`)
    }
  }

  return {
    tables: tablesProcessed,
    documents: totalDocs,
    totalRows,
    errors: errors.length > 0 ? errors : undefined,
  }
  } finally {
    if (db.pool) {
      await db.pool.end().catch(() => {})
    }
  }
}
