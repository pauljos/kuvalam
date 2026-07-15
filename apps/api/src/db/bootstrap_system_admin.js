// apps/api/src/db/bootstrap_system_admin.js
// Creates a system administrator user with platform-wide access.
// System admins can manage all tenants and have elevated privileges.
//
// Env vars (all required):
//   SYSADMIN_EMAIL     — system admin email
//   SYSADMIN_PASSWORD  — system admin password (min 8 chars)
//   SYSADMIN_NAME      — display name (default: "System Administrator")
//
// Usage:
//   SYSADMIN_EMAIL=admin@example.com SYSADMIN_PASSWORD=secure123 node src/db/bootstrap_system_admin.js

import bcrypt from 'bcryptjs'
import pg from 'pg'

const REQUIRED = ['SYSADMIN_EMAIL', 'SYSADMIN_PASSWORD']
const missing = REQUIRED.filter(k => !process.env[k])
if (missing.length) {
  console.error(`❌ Missing required env vars: ${missing.join(', ')}`)
  process.exit(1)
}

const email = String(process.env.SYSADMIN_EMAIL).toLowerCase().trim()
const password = String(process.env.SYSADMIN_PASSWORD)
const name = process.env.SYSADMIN_NAME || 'System Administrator'

if (password.length < 8) {
  console.error('❌ SYSADMIN_PASSWORD must be at least 8 characters')
  process.exit(1)
}
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('❌ SYSADMIN_EMAIL is not a valid email address')
  process.exit(1)
}
if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL is not set')
  process.exit(1)
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
await client.connect()

try {
  await client.query('BEGIN')

  // Check if user exists
  const { rows: existingUser } = await client.query(
    'SELECT id, is_system_admin FROM users WHERE email = $1',
    [email]
  )

  if (existingUser.length > 0) {
    // User exists - promote to system admin if not already
    if (existingUser[0].is_system_admin) {
      console.log(`ℹ️  User ${email} is already a system admin`)
    } else {
      await client.query(
        'UPDATE users SET is_system_admin = true WHERE id = $1',
        [existingUser[0].id]
      )
      console.log(`✅ Promoted ${email} to system admin`)
    }
  } else {
    // Create new system admin user
    const passwordHash = await bcrypt.hash(password, 12)
    const { rows: [user] } = await client.query(
      `INSERT INTO users (email, password_hash, name, email_verified, is_system_admin)
       VALUES ($1, $2, $3, true, true) RETURNING id`,
      [email, passwordHash, name]
    )
    console.log(`✅ Created system admin: ${email} (${user.id})`)
  }

  await client.query('COMMIT')
  console.log('\n🎉 System admin setup complete. Sign in with:')
  console.log(`     Email: ${email}`)
  console.log('\nNote: System admins have platform-wide access to all tenants.')
} catch (err) {
  await client.query('ROLLBACK')
  console.error('❌ System admin setup failed:', err.message)
  process.exit(1)
} finally {
  await client.end()
}
