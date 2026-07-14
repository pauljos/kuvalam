// apps/api/src/db/check.js
import 'dotenv/config'
import { query } from './pool.js'

async function check() {
  try {
    const { rows: tables } = await query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;`
    )
    console.log('Tables in database:')
    console.log(tables.map(t => t.table_name))
    process.exit(0)
  } catch (err) {
    console.error('Failed to query tables:', err)
    process.exit(1)
  }
}
check()
