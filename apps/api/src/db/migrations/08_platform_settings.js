// apps/api/src/db/migrations/08_platform_settings.js
// Migration: Create platform_settings table for sysadmin-configurable feature flags
//
// Run with: node apps/api/src/db/migrate.js

import { query } from '../pool.js'

export async function up() {
  await query(`
    CREATE TABLE IF NOT EXISTS platform_settings (
      key         TEXT PRIMARY KEY,
      value       TEXT NOT NULL DEFAULT '',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  // Seed the default settings so they are visible in the admin UI immediately
  // email_verification_required defaults to 'false' — sysadmin must opt-in
  await query(`
    INSERT INTO platform_settings (key, value)
    VALUES ('email_verification_required', 'false')
    ON CONFLICT (key) DO NOTHING
  `)

  console.log('[Migration 08] platform_settings table created')
}

export async function down() {
  await query(`DROP TABLE IF EXISTS platform_settings`)
  console.log('[Migration 08] platform_settings table dropped')
}
