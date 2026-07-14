// apps/api/src/db/migrate.js
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import pg from 'pg'
import { createRequire } from 'module'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Load env from apps/api/.env
const envPath = join(__dirname, '../../.env')
try {
  const { config } = await import('dotenv')
  config({ path: envPath })
} catch { /* dotenv optional */ }

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

    // Auto-discover migrations from infra/migrations — pick up any *.sql file
    // ordered by filename (which starts with NNN_). This way ops don't have to
    // remember to edit this file when adding a new migration.
    const migrationsDir = join(__dirname, '../../../../infra/migrations')
    const { readdirSync } = await import('fs')
    const migrations = readdirSync(migrationsDir)
      .filter(f => /^\d+_.+\.sql$/i.test(f))
      .sort()
      .map(f => ({ name: f.replace(/\.sql$/i, ''), file: join(migrationsDir, f) }))

    for (const migration of migrations) {
      const { rows } = await client.query(
        'SELECT id FROM _migrations WHERE name = $1',
        [migration.name]
      )

      if (rows.length > 0) {
        console.log(`  ⏭  ${migration.name} (already applied)`)
        continue
      }

      const sql = readFileSync(migration.file, 'utf8')
      await client.query(sql)
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

// Load env if running directly
if (process.env.DATABASE_URL === undefined) {
  const { config } = await import('dotenv')
  config({ path: new URL('../../.env', import.meta.url).pathname })
}

migrate()
