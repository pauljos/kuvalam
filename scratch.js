import { query } from './apps/api/src/db/pool.js'

async function setupLocalLlama() {
  // 1. Update the default tenant to point to Ollama
  await query(`
    UPDATE tenants 
    SET llm_config = $1 
    WHERE id = 'tenant-1'
  `, [{
    defaultProvider: 'local',
    providers: {
      local: {
        baseUrl: 'http://localhost:11434/v1',
        model: 'llama3.2', // Or llama3
        apiKey: 'not-needed'
      }
    }
  }])
  
  // 2. Update the agent to use local provider and llama model
  await query(`
    UPDATE agents
    SET llm_provider = 'local', llm_model = 'llama3.2'
    WHERE id = '9fe4e7d0-7e4a-4e13-8bf5-bd5af52b435d'
  `)
  
  console.log("Local LLaMA configuration applied!")
  process.exit(0)
}

setupLocalLlama().catch(console.error)
