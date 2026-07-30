#!/usr/bin/env node
/**
 * Quick test to verify Ollama models endpoint is working
 */

const API_BASE = process.env.API_URL || 'http://localhost:3001/api/v1'

async function test() {
  console.log('🧪 Testing Ollama Models Endpoint\n')

  // Login
  console.log('1️⃣  Logging in...')
  const loginRes = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'admin@example.com',
      password: 'password'
    })
  })
  const authData = await loginRes.json()
  const token = authData.data.accessToken
  const tenantId = authData.data.tenants[0].id
  console.log(`   ✅ Logged in\n`)

  // Test Ollama endpoint
  console.log('2️⃣  Fetching Ollama models...')
  const ollamaRes = await fetch(
    `${API_BASE}/tenants/${tenantId}/custom-models/ollama/available`,
    {
      headers: { 'Authorization': `Bearer ${token}` }
    }
  )
  const ollamaData = await ollamaRes.json()
  
  console.log('   Response:', JSON.stringify(ollamaData, null, 2))
  
  if (ollamaData.success && ollamaData.data?.models) {
    const models = ollamaData.data.models
    console.log(`\n   ✅ Found ${models.length} model(s):\n`)
    models.forEach(m => {
      if (typeof m === 'string') {
        console.log(`   - ${m}`)
      } else {
        const size = m.size ? `(${(m.size / 1e9).toFixed(1)} GB)` : ''
        console.log(`   - ${m.name} ${size}`)
      }
    })
  } else {
    console.log('   ⚠️  No models found or Ollama not running')
    console.log('   💡 Make sure Ollama is running: ollama serve')
    console.log('   💡 Check with: ollama list')
  }

  // Test direct Ollama connection
  console.log('\n3️⃣  Testing direct Ollama connection...')
  try {
    const directRes = await fetch('http://localhost:11434/api/tags')
    if (directRes.ok) {
      const directData = await directRes.json()
      console.log(`   ✅ Ollama is running`)
      console.log(`   📦 Models: ${directData.models?.length || 0}`)
    } else {
      console.log(`   ❌ Ollama returned status: ${directRes.status}`)
    }
  } catch (err) {
    console.log(`   ❌ Cannot connect to Ollama: ${err.message}`)
    console.log(`   💡 Start Ollama with: ollama serve`)
  }
}

test().catch(err => {
  console.error('\n❌ Test failed:', err.message)
  process.exit(1)
})
