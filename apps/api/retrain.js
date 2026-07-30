import 'dotenv/config'
import { retrainCustomModel } from './src/services/custom-models.service.js'
import { query } from './src/db/pool.js'

// Usage: node retrain.js [tenantId]
// If tenantId is provided, only retrains models belonging to that tenant.
async function run() {
  const targetTenant = process.argv[2] || null

  const { rows } = await query(
    targetTenant
      ? `SELECT id, tenant_id, model_name FROM custom_models WHERE tenant_id = $1 AND model_name ILIKE '%kuvalam%'`
      : `SELECT id, tenant_id, model_name FROM custom_models WHERE model_name ILIKE '%kuvalam%'`,
    targetTenant ? [targetTenant] : []
  )

  for (const row of rows) {
    if (row.model_name === 'kuvalam-v2' || row.model_name === 'mykuvalam' || row.model_name === 'kuvalam') {
      console.log('Retraining', row.model_name, '(tenant:', row.tenant_id, ')')
      await retrainCustomModel(row.tenant_id, row.id)
    }
  }
  process.exit(0)
}
run().catch(e => { console.error(e); process.exit(1) })
