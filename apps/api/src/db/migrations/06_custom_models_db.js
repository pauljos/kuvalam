import pg from 'pg';
const { Client } = pg;

const client = new Client({
  connectionString: 'postgresql://axon:axon_dev_password@localhost:5434/axon_db'
});

async function alterCustomModelsTable() {
  await client.connect();
  console.log('Connected to database.');

  try {
    await client.query(`
      ALTER TABLE custom_models
      ADD COLUMN IF NOT EXISTS data_source VARCHAR(50) DEFAULT 'file',
      ADD COLUMN IF NOT EXISTS db_connection_string TEXT,
      ADD COLUMN IF NOT EXISTS db_query TEXT;
      
      ALTER TABLE custom_models ALTER COLUMN dataset_path DROP NOT NULL;
    `);
    console.log('✅ Added database connection columns to custom_models table.');

  } catch (err) {
    console.error('❌ Error altering table:', err.message);
  } finally {
    await client.end();
  }
}

alterCustomModelsTable();
