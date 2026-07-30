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
      CREATE TABLE IF NOT EXISTS custom_models (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
        model_name VARCHAR(255) NOT NULL,
        base_model_path VARCHAR(512) NOT NULL,
        dataset_path VARCHAR(512) NOT NULL,
        status VARCHAR(50) DEFAULT 'PENDING',
        output_dir VARCHAR(512),
        error_message TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ Created custom_models table.');

    // Create generic modtime function if missing
    await client.query(`
      CREATE OR REPLACE FUNCTION update_modified_column()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = CURRENT_TIMESTAMP;
        RETURN NEW;
      END;
      $$ language 'plpgsql';
    `);

    // Add trigger for updated_at if not exists
    await client.query(`
      DROP TRIGGER IF EXISTS update_custom_models_modtime ON custom_models;
      CREATE TRIGGER update_custom_models_modtime
      BEFORE UPDATE ON custom_models
      FOR EACH ROW
      EXECUTE FUNCTION update_modified_column();
    `);
    console.log('✅ Trigger update_custom_models_modtime created.');

  } catch (err) {
    console.error('❌ Error creating table:', err.message);
    throw err;
  } finally {
    if (ownsConnection) await client.end();
  }
}

// Allow running directly: node src/db/migrations/05_custom_models.js
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  up().catch(err => { console.error(err); process.exit(1); });
}
