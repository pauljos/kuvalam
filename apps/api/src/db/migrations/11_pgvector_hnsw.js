// apps/api/src/db/migrations/11_pgvector_hnsw.js
// Migration: Add HNSW index on knowledge_chunk_embeddings for fast semantic RAG search
//
// Without this index, every vector similarity query does a full table scan.
// HNSW (Hierarchical Navigable Small World) gives ~100x speedup for cosine ANN search.
//
// Parameters chosen for a balanced accuracy/speed tradeoff:
//   m = 16          — max edges per node (higher = better recall, more memory)
//   ef_construction = 64 — search width during build (higher = better recall, slower build)
//
// NOTE on CREATE INDEX CONCURRENTLY:
//   This command CANNOT run inside an explicit BEGIN…COMMIT transaction block.
//   The migrate runner passes its raw pg.Client in `client` and does NOT wrap
//   individual migrations in transactions, so this is safe. If you ever run
//   this migration manually, ensure autocommit is enabled (i.e. no open txn).
//
// Requires: PostgreSQL 15+ with pgvector extension installed.

import { query } from '../pool.js'

/**
 * @param {import('pg').Client} [_client] — raw pg.Client injected by the migration
 *   runner. Accepted for signature compatibility but not used here because the
 *   module-level `query()` helper correctly handles the non-RLS path. The runner
 *   does not wrap migrations in transactions, so CONCURRENTLY is safe.
 */
export async function up(_client) {
  // Ensure pgvector extension is available
  await query(`CREATE EXTENSION IF NOT EXISTS vector`)

  // Build the HNSW index — CONCURRENTLY means no table lock for the duration of
  // the build. This is safe here because the runner does not open a transaction.
  await query(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS knowledge_chunk_embeddings_hnsw_idx
      ON knowledge_chunk_embeddings
      USING hnsw (embedding vector_cosine_ops)
      WITH (m = 16, ef_construction = 64)
  `)

  // Also add a btree index on (chunk_id, tenant_id) for the JOIN performance
  await query(`
    CREATE INDEX IF NOT EXISTS idx_kce_chunk_tenant
      ON knowledge_chunk_embeddings (chunk_id, tenant_id)
  `)

  console.log('[Migration 11] pgvector HNSW index created on knowledge_chunk_embeddings')
}

export async function down(_client) {
  await query(`DROP INDEX CONCURRENTLY IF EXISTS knowledge_chunk_embeddings_hnsw_idx`)
  await query(`DROP INDEX IF EXISTS idx_kce_chunk_tenant`)
  console.log('[Migration 11] pgvector HNSW index dropped')
}
