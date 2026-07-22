import pg from 'pg';
const { Client } = pg;
const client = new Client({ connectionString: 'postgresql://axon:axon_dev_password@localhost:5434/axon_db' });
async function check() {
  await client.connect();
  const { rows } = await client.query(`SELECT model_name, status, error_message FROM custom_models ORDER BY created_at DESC LIMIT 1`);
  console.log(rows[0]);
  await client.end();
}
check();
