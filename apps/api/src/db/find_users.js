// apps/api/src/db/find_users.js
import 'dotenv/config'
import { query } from './pool.js'

async function run() {
  const { rows: users } = await query('SELECT id, email, name FROM users;')
  const { rows: members } = await query('SELECT tenant_id, user_id, role FROM tenant_members;')
  console.log('Users:', users)
  console.log('Members:', members)
  process.exit(0)
}
run()
