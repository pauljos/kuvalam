import pg from 'pg';
const { Client } = pg;

const client = new Client({
  connectionString: 'postgresql://axon:axon_dev_password@localhost:5434/axon_db'
});

async function alterCustomModelsTableWeb() {
  await client.connect();
  console.log('Connected to database.');

  try {
    await client.query(`
      ALTER TABLE custom_models
      ADD COLUMN IF NOT EXISTS web_url TEXT;
    `);
    console.log('✅ Added web_url column to custom_models table.');

  } catch (err) {
    console.error('❌ Error altering table:', err.message);
  } finally {
    await client.end();
  }
}

alterCustomModelsTableWeb();
