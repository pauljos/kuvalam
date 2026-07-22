import 'dotenv/config'
import { deleteCustomModel } from './src/services/custom-models.service.js'
import { query } from './src/db/pool.js'

async function run() {
  const { rows } = await query("SELECT id, tenant_id, model_name FROM custom_models LIMIT 1");
  if (rows.length > 0) {
    console.log("Found model to delete:", rows[0].model_name)
    await deleteCustomModel(rows[0].tenant_id, rows[0].id)
    console.log("Deleted!")
  } else {
    console.log("No models to delete")
  }
  process.exit(0)
}
run().catch(e => { console.error(e); process.exit(1) })
