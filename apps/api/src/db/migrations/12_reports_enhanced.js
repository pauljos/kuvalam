// apps/api/src/db/migrations/10_reports_enhanced.js
// Migration: Enhance dashboard_reports with sharing, TTL, soft-delete, type tagging and download support

import { query } from '../pool.js'

export async function up(_client) {
  // Add new columns to dashboard_reports
  await query(`
    ALTER TABLE dashboard_reports
      ADD COLUMN IF NOT EXISTS report_type    TEXT    NOT NULL DEFAULT 'html'
                                              CHECK (report_type IN ('chart','svg','d3','data_model','mixed','html')),
      ADD COLUMN IF NOT EXISTS is_public      BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS public_token   TEXT    UNIQUE,
      ADD COLUMN IF NOT EXISTS expires_at     TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS archived_at    TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS metadata       JSONB   NOT NULL DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS summary        TEXT,
      ADD COLUMN IF NOT EXISTS download_formats TEXT[] NOT NULL DEFAULT '{}'
  `)

  // Efficient lookups for listing, filtering, and cursor pagination
  await query(`CREATE INDEX IF NOT EXISTS idx_reports_tenant_agent_created
    ON dashboard_reports (tenant_id, agent_id, created_at DESC)
    WHERE archived_at IS NULL`)

  await query(`CREATE INDEX IF NOT EXISTS idx_reports_public_token
    ON dashboard_reports (public_token) WHERE public_token IS NOT NULL`)

  await query(`CREATE INDEX IF NOT EXISTS idx_reports_expires
    ON dashboard_reports (expires_at) WHERE expires_at IS NOT NULL AND archived_at IS NULL`)

  // webhook_sources: add require_hmac flag for M10
  await query(`
    ALTER TABLE webhook_sources
      ADD COLUMN IF NOT EXISTS require_hmac BOOLEAN NOT NULL DEFAULT false
  `)

  console.log('[Migration 10] dashboard_reports enhanced + webhook_sources require_hmac added')
}

export async function down(_client) {
  await query(`
    ALTER TABLE dashboard_reports
      DROP COLUMN IF EXISTS report_type,
      DROP COLUMN IF EXISTS is_public,
      DROP COLUMN IF EXISTS public_token,
      DROP COLUMN IF EXISTS expires_at,
      DROP COLUMN IF EXISTS archived_at,
      DROP COLUMN IF EXISTS metadata,
      DROP COLUMN IF EXISTS summary,
      DROP COLUMN IF EXISTS download_formats
  `)
  await query(`DROP INDEX IF EXISTS idx_reports_tenant_agent_created`)
  await query(`DROP INDEX IF EXISTS idx_reports_public_token`)
  await query(`DROP INDEX IF EXISTS idx_reports_expires`)
  await query(`ALTER TABLE webhook_sources DROP COLUMN IF EXISTS require_hmac`)
  console.log('[Migration 10] Reverted')
}
