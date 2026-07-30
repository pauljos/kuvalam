#!/usr/bin/env node
/**
 * Test script for debugging data analytics agent report generation
 * Helps identify why reports aren't showing up on the dashboard
 */

const API_BASE = process.env.API_URL || 'http://localhost:3001/api/v1'

async function apiCall(method, path, body = null, token = null) {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`
  
  const opts = { method, headers }
  if (body) opts.body = JSON.stringify(body)
  
  const res = await fetch(`${API_BASE}${path}`, opts)
  const data = await res.json()
  
  if (!res.ok) {
    throw new Error(data.error?.message || `HTTP ${res.status}`)
  }
  
  return data.data
}

async function main() {
  console.log('🧪 Testing Report Generation\n')

  // Login
  console.log('1️⃣  Logging in...')
  const auth = await apiCall('POST', '/auth/login', {
    email: 'admin@example.com',
    password: 'password'
  })
  const token = auth.accessToken
  const tenantId = auth.tenants[0].id
  console.log(`   ✅ Logged in as ${auth.user.email}`)
  console.log(`   📦 Tenant: ${auth.tenants[0].name} (${tenantId})\n`)

  // Get agents
  console.log('2️⃣  Finding agents...')
  const { agents } = await apiCall('GET', `/tenants/${tenantId}/agents`, null, token)
  
  if (agents.length === 0) {
    console.log('   ⚠️  No agents found. Create an agent first.')
    process.exit(1)
  }

  // Find or use first analytics agent
  const analyticsAgent = agents.find(a => 
    a.archetype === 'ANALYTICS' || 
    /analyt|data|report/i.test(a.name)
  ) || agents[0]
  
  console.log(`   ✅ Using agent: ${analyticsAgent.name} (${analyticsAgent.id})`)
  console.log(`   📊 Model: ${analyticsAgent.llm_provider} / ${analyticsAgent.llm_model}`)
  console.log(`   📝 Status: ${analyticsAgent.status}\n`)

  // Check existing reports
  console.log('3️⃣  Checking existing reports...')
  const existingReports = await apiCall('GET', `/tenants/${tenantId}/reports`, null, token)
  console.log(`   📄 Found ${existingReports.length} existing report(s)\n`)

  // Test 1: Simple analytics goal with explicit keywords
  console.log('4️⃣  Test 1: Simple analytics report')
  const testGoal1 = 'Create a dashboard report analyzing our Q4 sales performance. Include charts showing revenue trends and push it to the dashboard.'
  console.log(`   📝 Goal: "${testGoal1}"`)
  
  try {
    const task1 = await apiCall('POST', `/tenants/${tenantId}/agents/${analyticsAgent.id}/tasks`, {
      goal: testGoal1
    }, token)
    console.log(`   ✅ Task dispatched: ${task1.taskId}`)
    console.log(`   ⏳ Waiting for completion (checking every 3s)...\n`)
    
    // Poll for completion
    let completed = false
    let attempts = 0
    const maxAttempts = 40 // 2 minutes max
    
    while (!completed && attempts < maxAttempts) {
      await new Promise(r => setTimeout(r, 3000))
      attempts++
      
      const taskStatus = await apiCall(
        'GET', 
        `/tenants/${tenantId}/agents/${analyticsAgent.id}/tasks/${task1.taskId}`,
        null,
        token
      )
      
      process.stdout.write(`   [${attempts}/${maxAttempts}] Status: ${taskStatus.status}...`)
      
      if (taskStatus.status === 'COMPLETED') {
        completed = true
        console.log(' ✅ COMPLETED\n')
        
        // Show task details
        console.log('   📊 Task Result:')
        console.log(`   - Confidence: ${taskStatus.result?.confidence || 'N/A'}`)
        console.log(`   - Actions taken: ${taskStatus.actions?.length || 0}`)
        console.log(`   - Tokens used: ${taskStatus.token_usage?.total || 0}\n`)
        
        // Check if publish_dashboard_report was called
        const publishAction = taskStatus.actions?.find(a => a.skill === 'publish_dashboard_report')
        if (publishAction) {
          console.log('   ✅ Agent CALLED publish_dashboard_report tool')
          console.log(`   📝 Input params:`, JSON.stringify(publishAction.input, null, 2))
          console.log(`   📤 Output:`, JSON.stringify(publishAction.output, null, 2))
        } else {
          console.log('   ⚠️  Agent DID NOT call publish_dashboard_report tool')
          console.log('   📋 Actions taken:', taskStatus.actions?.map(a => a.skill).join(', ') || 'none')
        }
        console.log()
        
        // Check if report was created
        const newReports = await apiCall('GET', `/tenants/${tenantId}/reports`, null, token)
        const reportCount = newReports.length - existingReports.length
        if (reportCount > 0) {
          console.log(`   ✅ ${reportCount} new report(s) created!`)
          const latestReport = newReports[0]
          console.log(`   📊 Report: "${latestReport.title}"`)
          console.log(`   👤 By: ${latestReport.agent_name || 'System'}`)
          console.log(`   🕐 Created: ${new Date(latestReport.created_at).toLocaleString()}`)
        } else {
          console.log('   ❌ No new reports were created')
          console.log('   💡 Check the server logs for [REPORT TOOL] and [AUTO-REPORT] messages')
        }
        
        break
      } else if (taskStatus.status === 'FAILED') {
        console.log(' ❌ FAILED\n')
        console.log(`   Error: ${taskStatus.error || 'Unknown error'}`)
        break
      } else if (taskStatus.status === 'CANCELLED') {
        console.log(' 🛑 CANCELLED\n')
        break
      }
      
      process.stdout.write('\r')
    }
    
    if (!completed && attempts >= maxAttempts) {
      console.log('\n   ⏰ Task timed out (still running)')
    }
    
  } catch (err) {
    console.error(`   ❌ Test failed: ${err.message}`)
  }

  console.log('\n' + '='.repeat(80))
  console.log('📋 DEBUGGING CHECKLIST:\n')
  console.log('1. Check server logs for:')
  console.log('   [REPORT TOOL] Called with params - shows if tool was called and what params')
  console.log('   [AUTO-REPORT] Fallback check - shows if auto-fallback was triggered\n')
  console.log('2. Verify LLM model supports function calling:')
  console.log(`   Current: ${analyticsAgent.llm_provider} / ${analyticsAgent.llm_model}`)
  console.log('   Recommended: gpt-4o, claude-3-5-sonnet, or llama3.1:8b+\n')
  console.log('3. Check if agent has proper skills configured')
  console.log('4. Verify dashboard_reports table exists:')
  console.log('   SELECT * FROM dashboard_reports ORDER BY created_at DESC LIMIT 5;\n')
  console.log('='.repeat(80))
}

main().catch(err => {
  console.error('\n❌ Script failed:', err.message)
  console.error(err.stack)
  process.exit(1)
})
