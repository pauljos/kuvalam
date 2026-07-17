// apps/api/src/db/list_users.js
// Quick script to list all users and their tenants from local database

import pg from 'pg'
import 'dotenv/config'

const client = new pg.Client({ connectionString: process.env.DATABASE_URL })

async function listUsers() {
  await client.connect()
  
  console.log('\n=== USERS ===')
  const { rows: users } = await client.query(`
    SELECT id, email, name, is_system_admin, created_at 
    FROM users 
    ORDER BY created_at DESC
  `)
  console.table(users)
  
  console.log('\n=== TENANTS ===')
  const { rows: tenants } = await client.query(`
    SELECT id, name, slug, approval_status, status, created_at 
    FROM tenants 
    ORDER BY created_at DESC
  `)
  console.table(tenants)
  
  console.log('\n=== USER-TENANT MAPPINGS ===')
  const { rows: mappings } = await client.query(`
    SELECT 
      u.email, 
      u.name as user_name,
      u.is_system_admin,
      t.name as tenant_name, 
      t.slug as tenant_slug, 
      tm.role 
    FROM users u 
    LEFT JOIN tenant_members tm ON tm.user_id = u.id 
    LEFT JOIN tenants t ON t.id = tm.tenant_id
    ORDER BY u.email
  `)
  console.table(mappings)
  
  await client.end()
}

listUsers().catch(console.error)
