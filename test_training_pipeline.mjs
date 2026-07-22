import pg from 'pg';

const DB_URL = 'postgresql://axon:axon_dev_password@localhost:5434/axon_db';

async function run() {
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  
  const res = await client.query(`SELECT id, status, model_name, created_at FROM custom_models ORDER BY created_at DESC LIMIT 1`);
  await client.end();
  
  if (res.rows.length > 0) {
    console.log(`LATEST JOB STATUS: ${res.rows[0].status}`);
  } else {
    console.log("No jobs found.");
  }
}

run().catch(console.error);
