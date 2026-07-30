// Quick script to reprocess Motability docs with working embed
import { query } from '../src/db/pool.js'
import { embed } from '../src/services/llm.service.js'

async function main() {
  // Get tenant
  const { rows: [tenant] } = await query('SELECT id, llm_config FROM tenants LIMIT 1')
  console.log('Tenant:', tenant.id)

  // Get all FAILED Motability docs
  const { rows: docs } = await query(
    "SELECT id, name, status, knowledge_base_id FROM knowledge_documents WHERE name LIKE '%Motability%' AND status = 'FAILED'"
  )
  console.log(`Found ${docs.length} FAILED docs`)

  for (const doc of docs) {
    console.log(`\n=== Processing: ${doc.name} ===`)

    // Get existing chunks
    const { rows: chunks } = await query(
      'SELECT content FROM knowledge_chunks WHERE document_id = $1 ORDER BY chunk_index',
      [doc.id]
    )

    if (chunks.length === 0) {
      console.log('  No chunks found — document needs re-upload (content lost during failed reprocess). Skipping.')
      continue
    }

    const content = chunks.map(c => c.content).join('\n\n')
    console.log('Content length:', content.length)

    // Delete old chunks (CASCADE removes embeddings too)
    await query('DELETE FROM knowledge_chunks WHERE document_id = $1', [doc.id])

    // Reset doc status
    await query(
      "UPDATE knowledge_documents SET status = 'PROCESSING', chunk_count = 0, indexed_chunk_count = 0, updated_at = NOW() WHERE id = $1",
      [doc.id]
    )

    // Re-chunk
    function chunkText(text, maxLen = 2000, overlap = 200) {
      const chunks = []
      let start = 0
      while (start < text.length) {
        const end = Math.min(start + maxLen, text.length)
        chunks.push(text.slice(start, end))
        start = end - overlap
        if (start >= text.length) break
        if (start < 0) start = 0
      }
      return chunks
    }

    const newChunks = chunkText(content)
    console.log('New chunks:', newChunks.length)

    // Save new chunks
    const chunkIds = []
    for (let i = 0; i < newChunks.length; i++) {
      const { rows: [chunk] } = await query(
        'INSERT INTO knowledge_chunks (document_id, tenant_id, chunk_index, content, token_count) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [doc.id, tenant.id, i, newChunks[i], Math.ceil(newChunks[i].length / 4)]
      )
      chunkIds.push({ id: chunk.id, content: newChunks[i] })
    }

    // Generate embeddings via Ollama fallback
    const batchSize = 20
    let indexedCount = 0
    for (let i = 0; i < chunkIds.length; i += batchSize) {
      const batch = chunkIds.slice(i, i + batchSize)
      try {
        const embeddings = await embed({
          text: batch.map(c => c.content),
          tenantId: tenant.id,
          llmConfig: tenant.llm_config || {}
        })
        for (let j = 0; j < batch.length; j++) {
          await query(
            'INSERT INTO knowledge_chunk_embeddings (chunk_id, tenant_id, embedding) VALUES ($1,$2,$3)',
            [batch[j].id, tenant.id, JSON.stringify(embeddings[j])]
          )
          indexedCount++
        }
        const pct = Math.round((i + batch.length) / chunkIds.length * 100)
        console.log(`  Batch ${i / batchSize + 1}: OK (${pct}%) dims=${embeddings[0]?.length}`)
      } catch (err) {
        console.error(`  Batch ${i / batchSize + 1}: FAILED - ${err.message}`)
      }
    }

    // Set final status
    const finalStatus = indexedCount === chunkIds.length ? 'INDEXED'
      : indexedCount === 0 ? 'FAILED'
      : 'PARTIALLY_INDEXED'

    await query(
      'UPDATE knowledge_documents SET status = $1, chunk_count = $2, indexed_chunk_count = $3, updated_at = NOW() WHERE id = $4',
      [finalStatus, chunkIds.length, indexedCount, doc.id]
    )

    if (finalStatus !== 'FAILED') {
      await query(
        'UPDATE knowledge_bases SET document_count = document_count + 1 WHERE id = $1',
        [doc.knowledge_base_id]
      )
    }

    console.log(`  RESULT: ${finalStatus} (${indexedCount}/${chunkIds.length} chunks)`)
  }

  console.log('\n=== ALL DONE ===')
  process.exit(0)
}

main().catch(err => {
  console.error('FATAL:', err)
  process.exit(1)
})
