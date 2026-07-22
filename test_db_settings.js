import pg from 'pg';
const { Client } = pg;
const client = new Client({ connectionString: 'postgresql://axon:axon_dev_password@localhost:5434/axon_db' });
async function check() {
  await client.connect();
  const { rows } = await client.query(`SELECT id, name, slug FROM tenants ORDER BY created_at DESC LIMIT 1`);
  console.log("Latest Tenant:", rows[0]);
  
  if (rows[0]) {
    const settings = await client.query(`SELECT * FROM tenant_settings WHERE tenant_id = $1`, [rows[0].id]);
    console.log("Settings row exists:", settings.rows.length > 0);
  }
  await client.end();
}
check();
