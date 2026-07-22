import pg from 'pg';
const { Client } = pg;

const client = new Client({
  connectionString: 'postgresql://axon:axon_dev_password@localhost:5434/axon_db'
});

async function run() {
  await client.connect();
  const { rows } = await client.query(`
    SELECT u.id, u.email, u.is_system_admin, tm.tenant_id, tm.role 
    FROM users u
    JOIN tenant_members tm ON u.id = tm.user_id
    WHERE u.is_system_admin = false AND tm.status = 'ACTIVE'
    LIMIT 1
  `);
  
  if (rows.length > 0) {
    console.log("Non-Admin User Found:", rows[0]);
  } else {
    console.log("No non-admin users found. You may need to create one.");
  }
  await client.end();
}
run();
