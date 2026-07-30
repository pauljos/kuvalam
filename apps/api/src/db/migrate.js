// apps/api/src/db/migrate.js
// Unified migration runner — handles both:
//   • SQL files in infra/migrations/          (e.g. 001_initial_schema.sql)
//   • JS files  in apps/api/src/db/migrations/ (e.g. 10_reports_enhanced.js)
//
// Both sets are sorted together by filename prefix so they run in
// dependency order. The _migrations table tracks both by name.
//
// JS migrations must export:  export async function up() { ... }
// SQL migrations are executed verbatim via pg Client.
//
// IMPORTANT: CREATE INDEX CONCURRENTLY cannot run inside an explicit
// transaction block. JS migrations that need it should use the exported
// `pool` directly or accept a raw Client with autocommit. This runner does
// NOT wrap individual migrations in BEGIN/COMMIT — each migration is atomic
// only if the migration itself manages its transaction.

import { readFileSync, readdirSync } from 'fs'
import { join, dirname, basename, extname } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import pg from 'pg'
import 'dotenv/config'

const __dirname = dirname(fileURLToPath(import.meta.url))

async function migrate() {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()

  console.log('🔄 Running Kuvalam database migrations...')

  try {
    // Create migrations tracking table
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)

    // ── Discover SQL migrations ────────────────────────────────────────────
    const sqlDir = process.env.NODE_ENV === 'production'
      ? '/app/infra/migrations'
      : join(__dirname, '../../../../infra/migrations')

    const sqlMigrations = readdirSync(sqlDir)
      .filter(f => /^\d+_.+\.sql$/i.test(f))
      .map(f => ({
        name: f.replace(/\.sql$/i, ''),
        type: 'sql',
        file: join(sqlDir, f),
      }))

    // ── Discover JS migrations ─────────────────────────────────────────────
    const jsDir = join(__dirname, 'migrations')
    const jsMigrations = readdirSync(jsDir)
      .filter(f => /^\d+_.+\.(js|mjs)$/i.test(f))
      .map(f => ({
        name: basename(f, extname(f)),
        type: 'js',
        file: join(jsDir, f),
      }))

    // ── Merge and sort by numeric prefix ──────────────────────────────────
    // Extract leading number from filename for stable cross-type ordering.
    // e.g. "025_knowledge_graphs" → 25, "10_reports_enhanced" → 10
    const allMigrations = [...sqlMigrations, ...jsMigrations].sort((a, b) => {
      const numA = parseInt(a.name.match(/^(\d+)/)?.[1] || '0', 10)
      const numB = parseInt(b.name.match(/^(\d+)/)?.[1] || '0', 10)
      return numA - numB
    })

    // ── Run each migration if not already applied ─────────────────────────
    for (const migration of allMigrations) {
      const { rows } = await client.query(
        'SELECT id FROM _migrations WHERE name = $1',
        [migration.name]
      )

      if (rows.length > 0) {
        console.log(`  ⏭  ${migration.name} (already applied)`)
        continue
      }

      console.log(`  ▶  ${migration.name} [${migration.type}]`)

      if (migration.type === 'sql') {
        const sql = readFileSync(migration.file, 'utf8')
        await client.query(sql)
      } else {
        // JS migration: import module and call up()
        // Legacy standalone scripts in this folder may not export up() — skip them
        // gracefully with a warning. Only new-style migrations with up()/down() are run.
        const mod = await import(pathToFileURL(migration.file).href)
        if (typeof mod.up !== 'function') {
          console.log(`  ⏭  ${migration.name} [js] — no up() export, skipping (legacy standalone script)`)
          // Mark as applied so we don't warn every run
          await client.query('INSERT INTO _migrations (name) VALUES ($1) ON CONFLICT DO NOTHING', [migration.name])
          continue
        }
        // Inject the pg client so migrations can run non-transactional
        // statements (like CREATE INDEX CONCURRENTLY) when needed.
        await mod.up(client)
      }

      await client.query('INSERT INTO _migrations (name) VALUES ($1)', [migration.name])
      console.log(`  ✅ ${migration.name}`)
    }

    console.log('✅ All migrations complete')
  } catch (err) {
    console.error('❌ Migration failed:', err.message)
    process.exit(1)
  } finally {
    await client.end()
  }
}

migrate()
