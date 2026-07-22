// apps/api/src/db/reset_password.js
import 'dotenv/config'
import bcrypt from 'bcryptjs'
import { query } from './pool.js'

async function run() {
  try {
    const hash = await bcrypt.hash('password', 10)
    await query("UPDATE users SET password_hash = $1 WHERE email = 'admin@acme.com';", [hash])
    console.log('✅ Updated admin@acme.com password to "password" (hash:', hash, ')')
    process.exit(0)
  } catch (err) {
    console.error('❌ Error updating password:', err.message)
    process.exit(1)
  }
}
run()
