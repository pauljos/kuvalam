// apps/api/src/db/register_kaggle_mcp.js
import 'dotenv/config'
import { query } from './pool.js'

async function run() {
  try {
    const tenantId = 'e9e3f771-3062-4c7a-a53f-a0e0571a9ab3'
    const name = 'Kaggle MCP'
    const url = 'http://localhost:3005'
    const config = { url }

    // Check if exists
    const { rows } = await query(
      `SELECT id FROM tool_connections WHERE tenant_id = $1 AND name = $2 AND tool_id = 'mcp'`,
      [tenantId, name]
    )

    if (rows.length > 0) {
      await query(
        `UPDATE tool_connections 
         SET config = $1, status = 'ACTIVE' 
         WHERE tenant_id = $2 AND name = $3 AND tool_id = 'mcp'`,
        [config, tenantId, name]
      )
      console.log('✅ Updated existing Kaggle MCP connection in database.')
    } else {
      await query(
        `INSERT INTO tool_connections (tenant_id, tool_id, name, auth_type, config, status)
         VALUES ($1, 'mcp', $2, 'NONE', $3, 'ACTIVE')`,
        [tenantId, name, config]
      )
      console.log('✅ Registered new Kaggle MCP connection in database.')
    }
    process.exit(0)
  } catch (err) {
    console.error('❌ Error registering Kaggle MCP:', err)
    process.exit(1)
  }
}
run()
