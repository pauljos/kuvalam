import fetch from 'node-fetch';
import pg from 'pg';
const { Client } = pg;

const client = new Client({
  connectionString: 'postgresql://axon:axon_dev_password@localhost:5434/axon_db'
});

async function runTest() {
  await client.connect();
  
  // 1. Find a non-system admin user
  const { rows } = await client.query(`
    SELECT id, email, is_system_admin, default_tenant_id 
    FROM users 
    WHERE is_system_admin = false AND default_tenant_id IS NOT NULL
    LIMIT 1
  `);
  
  if (rows.length === 0) {
    console.log("No regular users found. Creating a test user...");
    // If we need to create one, we would do it here, but usually there's at least one.
    await client.end();
    return;
  }
  
  const user = rows[0];
  console.log(`Found non-system admin: ${user.email} (Tenant: ${user.default_tenant_id})`);
  
  // For the API test, we need a JWT. Kuvalam's auth generates it, but since we have DB access, 
  // we can just bypass the login screen by generating the exact payload the API expects,
  // or hitting the login endpoint if we know the password.
  // We'll just generate the token directly using the same JWT secret from .env
  
  await client.end();
}

runTest();
