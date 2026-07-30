// apps/api/src/db/migrations/09_soft_delete.js
// Migration: Add soft-delete columns to agents and workflows tables
// Also adds indexed_chunk_count to knowledge_documents for partial indexing tracking
//
// Run with: node apps/api/src/db/migrate.js

import { query } from '../pool.js'

export async function up() {
  // ── agents: soft-delete support ──────────────────────────────────────────
  await query(`
    ALTER TABLE agents
      ADD COLUMN IF NOT EXISTS deleted_at  TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS deleted_by  UUID REFERENCES users(id) ON DELETE SET NULL
  `)

  // ── workflows: soft-delete support ──────────────────────────────────────
  await query(`
    ALTER TABLE workflows
      ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ
  `)

  // ── knowledge_documents: partial indexing tracking ───────────────────────
  await query(`
    ALTER TABLE knowledge_documents
      ADD COLUMN IF NOT EXISTS indexed_chunk_count INTEGER DEFAULT 0
  `)

  // Add PARTIALLY_INDEXED and FAILED to the status enum if not already present
  // PostgreSQL: adding enum values is safe and non-blocking in newer versions
  await query(`
    DO $$ BEGIN
      BEGIN
        ALTER TYPE knowledge_document_status ADD VALUE IF NOT EXISTS 'PARTIALLY_INDEXED';
      EXCEPTION WHEN duplicate_object THEN NULL;
      END;
      BEGIN
        ALTER TYPE knowledge_document_status ADD VALUE IF NOT EXISTS 'FAILED';
      EXCEPTION WHEN duplicate_object THEN NULL;
      END;
    END $$
  `).catch(() => {
    // If the type doesn't use a PG enum, this is a no-op
  })

  // Index to efficiently exclude ARCHIVED agents from listings
  await query(`
    CREATE INDEX IF NOT EXISTS idx_agents_active
      ON agents (tenant_id, status)
      WHERE status != 'ARCHIVED'
  `)

  console.log('[Migration 09] Soft-delete columns and partial indexing tracking added')
}

export async function down() {
  await query(`ALTER TABLE agents DROP COLUMN IF EXISTS deleted_at, DROP COLUMN IF EXISTS deleted_by`)
  await query(`ALTER TABLE workflows DROP COLUMN IF EXISTS deleted_at`)
  await query(`ALTER TABLE knowledge_documents DROP COLUMN IF EXISTS indexed_chunk_count`)
  await query(`DROP INDEX IF EXISTS idx_agents_active`)
  console.log('[Migration 09] Soft-delete columns removed')
}
