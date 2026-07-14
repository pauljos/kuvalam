// apps/api/src/services/knowledge.service.js
import { query } from '../db/pool.js'
import { embed } from './llm.service.js'
import { auditLog } from '../utils/audit.js'
import { AppError } from '../utils/errors.js'
import { extractText } from './document-extractor.service.js'
import { uploadFile } from './storage.service.js'
import { randomUUID } from 'crypto'

export async function createKnowledgeBase({ tenantId, name, description, userId }) {
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

export async function ingestDocument({ tenantId, knowledgeBaseId, name, content, mimeType = 'text/plain', userId }) {
  // Store document record
  const { rows: [doc] } = await query(
    `INSERT INTO knowledge_documents (knowledge_base_id, tenant_id, name, source_type, mime_type, status, created_by)
     VALUES ($1,$2,$3,'TEXT',$4,'PROCESSING',$5) RETURNING *`,
    [knowledgeBaseId, tenantId, name, mimeType, userId]
  )

  await auditLog({ eventType: 'knowledge.document_received', tenantId, actorId: userId, actorType: 'USER', resourceType: 'KnowledgeDocument', resourceId: doc.id, action: 'INGEST' })

  // Process asynchronously
  setImmediate(() => processDocument(doc, content, tenantId).catch(err => {
    console.error(`Document ${doc.id} processing failed:`, err.message)
    query(`UPDATE knowledge_documents SET status = 'FAILED' WHERE id = $1`, [doc.id])
  }))

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
  } catch (err) {
    console.error(`[ingestFile] Text extraction failed for ${filename}:`, err.message)
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

  // Load the tenant's llm_config once so embeddings use the tenant's configured
  // OpenAI-compatible provider (not a global env fallback). This lets tenants
  // that supply their own API key have knowledge indexing work out-of-the-box.
  const { rows: [tenant] } = await query('SELECT llm_config FROM tenants WHERE id = $1', [tenantId])
  const llmConfig = tenant?.llm_config || {}

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
  const batchSize = 20
  for (let i = 0; i < chunkIds.length; i += batchSize) {
    const batch = chunkIds.slice(i, i + batchSize)
    try {
      const embeddings = await embed({ text: batch.map(c => c.content), tenantId, llmConfig })
      for (let j = 0; j < batch.length; j++) {
        await query(
          `INSERT INTO knowledge_chunk_embeddings (chunk_id, tenant_id, embedding)
           VALUES ($1,$2,$3)`,
          [batch[j].id, tenantId, JSON.stringify(embeddings[j])]
        )
      }
    } catch (err) {
      console.error('Embedding batch failed:', err.message)
      // Continue with remaining batches
    }
  }

  // 4. Mark document as indexed
  await query(
    `UPDATE knowledge_documents SET status = 'INDEXED', chunk_count = $1, updated_at = NOW() WHERE id = $2`,
    [chunkIds.length, doc.id]
  )

  // 5. Update KB doc count
  await query(
    `UPDATE knowledge_bases SET document_count = document_count + 1 WHERE id = $1`,
    [doc.knowledge_base_id]
  )
}

export async function searchKnowledge({ tenantId, query: searchQuery, knowledgeBaseIds = [], topK = 10, threshold = 0.5 }) {
  if (knowledgeBaseIds.length === 0) return []

  // Get IDs of chunks in these knowledge bases
  const kbIdPlaceholders = knowledgeBaseIds.map((_, i) => `$${i + 2}`).join(',')

  try {
    // Load tenant llm_config so query embedding uses the tenant's configured provider
    const { rows: [tenant] } = await query('SELECT llm_config FROM tenants WHERE id = $1', [tenantId])
    const llmConfig = tenant?.llm_config || {}

    // Semantic search (vector similarity)
    let queryEmbedding
    try {
      const embeddings = await embed({ text: searchQuery, tenantId, llmConfig })
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
  } catch (err) {
    console.error('Search error:', err.message)
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
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim().length > 20)
  const chunks = []
  let currentChunk = ''

  for (const para of paragraphs) {
    if (currentChunk.length + para.length > maxChunkSize * 4 && currentChunk.length > 0) {
      chunks.push(currentChunk.trim())
      currentChunk = ''
    }
    currentChunk += (currentChunk ? '\n\n' : '') + para
  }

  if (currentChunk.trim()) chunks.push(currentChunk.trim())
  return chunks.length > 0 ? chunks : [text.substring(0, maxChunkSize * 4)]
}

function estimateTokens(text) {
  return Math.ceil(text.length / 4)
}
