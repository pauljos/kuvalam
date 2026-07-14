// apps/api/src/db/find_tenant.js
import 'dotenv/config'
import { query } from './pool.js'

async function run() {
  const { rows } = await query('SELECT id, name FROM tenants LIMIT 5;')
  console.log('Tenants:', rows)
  process.exit(0)
}
run()
