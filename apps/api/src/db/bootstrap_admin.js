// apps/api/src/db/bootstrap_admin.js
// One-shot script to create the first OWNER user + tenant for an on-prem install.
// Idempotent: if a user with the given email already exists, it is reused; if the
// tenant slug already exists it is reused. Safe to run more than once.
//
// Env vars (all required unless a value already exists):
//   ADMIN_EMAIL       — owner login email
//   ADMIN_PASSWORD    — owner password (min 8 chars)
//   ADMIN_NAME        — display name (default: "Administrator")
//   TENANT_NAME       — organisation display name
//   TENANT_SLUG       — url-safe tenant slug (a-z0-9-)
//
// Usage:
//   node apps/api/src/db/bootstrap_admin.js
//   docker compose exec api node src/db/bootstrap_admin.js

import bcrypt from 'bcryptjs'
import pg from 'pg'

const REQUIRED = ['ADMIN_EMAIL', 'ADMIN_PASSWORD', 'TENANT_NAME', 'TENANT_SLUG']
const missing = REQUIRED.filter(k => !process.env[k])
if (missing.length) {
  console.error(`❌ Missing required env vars: ${missing.join(', ')}`)
  process.exit(1)
}

const email = String(process.env.ADMIN_EMAIL).toLowerCase().trim()
const password = String(process.env.ADMIN_PASSWORD)
const name = process.env.ADMIN_NAME || 'Administrator'
const tenantName = String(process.env.TENANT_NAME).trim()
const tenantSlug = String(process.env.TENANT_SLUG).toLowerCase().trim()

if (password.length < 8) {
  console.error('❌ ADMIN_PASSWORD must be at least 8 characters')
  process.exit(1)
}
if (!/^[a-z0-9-]+$/.test(tenantSlug)) {
  console.error('❌ TENANT_SLUG must be lowercase alphanumeric with hyphens only')
  process.exit(1)
}
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('❌ ADMIN_EMAIL is not a valid email address')
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

  // 1. Get-or-create the user
  let userId
  const { rows: existingUser } = await client.query(
    'SELECT id FROM users WHERE email = $1',
    [email]
  )
  if (existingUser.length > 0) {
    userId = existingUser[0].id
    console.log(`ℹ️  User already exists: ${email} (${userId})`)
  } else {
    const passwordHash = await bcrypt.hash(password, 12)
    const { rows: [user] } = await client.query(
      `INSERT INTO users (email, password_hash, name, email_verified)
       VALUES ($1, $2, $3, true) RETURNING id`,
      [email, passwordHash, name]
    )
    userId = user.id
    console.log(`✅ Created user: ${email}`)
  }

  // 2. Get-or-create the tenant
  let tenantId
  const { rows: existingTenant } = await client.query(
    'SELECT id FROM tenants WHERE slug = $1',
    [tenantSlug]
  )
  if (existingTenant.length > 0) {
    tenantId = existingTenant[0].id
    console.log(`ℹ️  Tenant already exists: ${tenantSlug} (${tenantId})`)
  } else {
    // On-prem defaults to ENTERPRISE plan (no artificial caps for a self-hosted install)
    const { rows: [tenant] } = await client.query(
      `INSERT INTO tenants (name, slug, plan, status)
       VALUES ($1, $2, 'ENTERPRISE', 'ACTIVE') RETURNING id`,
      [tenantName, tenantSlug]
    )
    tenantId = tenant.id
    console.log(`✅ Created tenant: ${tenantName} (${tenantSlug})`)
  }

  // 3. Ensure the user is OWNER of the tenant
  const { rows: existingMember } = await client.query(
    'SELECT id, role FROM tenant_members WHERE tenant_id = $1 AND user_id = $2',
    [tenantId, userId]
  )
  if (existingMember.length === 0) {
    await client.query(
      `INSERT INTO tenant_members (tenant_id, user_id, role, status, joined_at)
       VALUES ($1, $2, 'OWNER', 'ACTIVE', NOW())`,
      [tenantId, userId]
    )
    console.log(`✅ Attached user as OWNER of tenant`)
  } else if (existingMember[0].role !== 'OWNER') {
    await client.query(
      `UPDATE tenant_members SET role = 'OWNER', status = 'ACTIVE' WHERE id = $1`,
      [existingMember[0].id]
    )
    console.log(`✅ Promoted existing member to OWNER`)
  } else {
    console.log(`ℹ️  User is already OWNER of tenant`)
  }

  await client.query('COMMIT')
  console.log('\n🎉 Bootstrap complete. Sign in at your web URL with:')
  console.log(`     Email:    ${email}`)
  console.log(`     Tenant:   ${tenantSlug}`)
} catch (err) {
  await client.query('ROLLBACK')
  console.error('❌ Bootstrap failed:', err.message)
  process.exit(1)
} finally {
  await client.end()
}
