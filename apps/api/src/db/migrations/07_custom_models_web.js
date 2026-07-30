import pg from 'pg';
const { Client } = pg;

export async function up(runnerClient) {
  // Use the runner's client if provided, otherwise create our own (standalone mode)
  const client = runnerClient || await (async () => {
    const c = new Client({
      connectionString: process.env.DATABASE_URL || 'postgresql://axon:axon_dev_password@localhost:5434/axon_db'
    });
    await c.connect();
    return c;
  })();

  const ownsConnection = !runnerClient;

  try {
    await client.query(`
      ALTER TABLE custom_models
      ADD COLUMN IF NOT EXISTS web_url TEXT;
    `);
    console.log('✅ Added web_url column to custom_models table.');

  } catch (err) {
    console.error('❌ Error altering table:', err.message);
    throw err;
  } finally {
    if (ownsConnection) await client.end();
  }
}

// Allow running directly: node src/db/migrations/07_custom_models_web.js
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  up().catch(err => { console.error(err); process.exit(1); });
}
