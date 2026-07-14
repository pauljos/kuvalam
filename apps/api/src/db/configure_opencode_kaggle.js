// apps/api/src/db/configure_opencode_kaggle.js
import 'dotenv/config'
import { query } from './pool.js'

async function run() {
  try {
    console.log('🔄 Configuring OpenCode & Kaggle Solver Agent for all tenants...')

    // 1. Get all tenants
    const { rows: tenants } = await query('SELECT id, name, llm_config FROM tenants;')
    if (tenants.length === 0) {
      console.error('❌ No tenants found in database.')
      process.exit(1)
    }

    // 2. Get first user (to use as created_by fallback)
    const { rows: users } = await query('SELECT id, email FROM users LIMIT 1;')
    const userId = users.length > 0 ? users[0].id : null

    const systemPrompt = `You are an expert data scientist and Kaggle Grandmaster. Your goal is to solve data science challenges. You analyze the dataset schema, run exploratory data analysis, write robust Python training scripts using LightGBM, XGBoost, and PyTorch, tune hyperparameters cross-validating correctly to prevent overfitting, and output a high-scoring submission file.`

    for (const tenant of tenants) {
      const tenantId = tenant.id
      console.log(`\n⚙️ Processing Tenant: ${tenant.name} (${tenantId})`)

      // 3. Update LLM Config
      const existingConfig = tenant.llm_config || {}
      const updatedConfig = {
        ...existingConfig,
        defaultProvider: 'opencode',
        providers: {
          ...(existingConfig.providers || {}),
          opencode: {
            apiKey: 'sk-xWnkOokd4VeukABGitEZw01invk9hibHs5iH96ah6hkxLd7NwFphrqFEuq8qo3Zq',
            model: 'opencode/zen-coder',
            baseUrl: 'https://console.opencode.ai/inference/openai/v1',
            enabled: true,
            updatedAt: new Date().toISOString()
          }
        }
      }

      await query('UPDATE tenants SET llm_config = $1 WHERE id = $2;', [updatedConfig, tenantId])
      console.log(`  ✅ OpenCode LLM configuration updated.`)

      // 4. Create or update Kaggle Solver Agent
      const { rows: existingAgents } = await query(
        'SELECT id FROM agents WHERE tenant_id = $1 AND name = $2;',
        [tenantId, 'Kaggle Solver']
      )

      if (existingAgents.length > 0) {
        const agentId = existingAgents[0].id
        await query(
          `UPDATE agents
           SET description = $1, archetype = $2, status = $3, autonomy_level = $4,
               llm_provider = $5, llm_model = $6, system_prompt = $7, updated_at = NOW()
           WHERE id = $8;`,
          [
            'Specialist agent trained to autonomously ingest datasets, build machine learning models, and solve complex Kaggle tabular & vision problems.',
            'research',
            'ACTIVE',
            'AUTONOMOUS',
            'opencode',
            'opencode/zen-coder',
            systemPrompt,
            agentId
          ]
        )
        console.log(`  ✅ Kaggle Solver Agent updated (ID: ${agentId}).`)
      } else {
        const { rows: [newAgent] } = await query(
          `INSERT INTO agents (tenant_id, name, description, archetype, status, autonomy_level, llm_provider, llm_model, system_prompt, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING id;`,
          [
            tenantId,
            'Kaggle Solver',
            'Specialist agent trained to autonomously ingest datasets, build machine learning models, and solve complex Kaggle tabular & vision problems.',
            'research',
            'ACTIVE',
            'AUTONOMOUS',
            'opencode',
            'opencode/zen-coder',
            systemPrompt,
            userId
          ]
        )
        console.log(`  ✅ Kaggle Solver Agent created (ID: ${newAgent.id}).`)
      }
    }

    console.log('\n🎉 OpenCode and Kaggle Solver Agent configuration completed for all tenants!')
    process.exit(0)
  } catch (err) {
    console.error('❌ Error configuring database:', err.message)
    process.exit(1)
  }
}

run()
