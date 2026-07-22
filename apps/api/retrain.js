import 'dotenv/config'
import { retrainCustomModel } from './src/services/custom-models.service.js'
import { query } from './src/db/pool.js'

async function run() {
  const { rows } = await query("SELECT id, tenant_id, model_name FROM custom_models WHERE model_name ILIKE '%kuvalam%'");
  for (const row of rows) {
    if (row.model_name === 'kuvalam-v2' || row.model_name === 'mykuvalam' || row.model_name === 'kuvalam') {
      console.log('Retraining', row.model_name)
      await retrainCustomModel(row.tenant_id, row.id)
    }
  }
  process.exit(0)
}
run().catch(e => { console.error(e); process.exit(1) })
