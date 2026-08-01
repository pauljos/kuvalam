import fs from 'fs'
import path from 'path'

async function run() {
  console.log("=== End-to-End Test ===")
  const authRes = await fetch('http://localhost:3001/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': 'http://localhost:3000' },
    body: JSON.stringify({ email: 'test@example.com', password: 'password123', tenantSlug: 'test-org' })
  })
  const authData = await authRes.json()
  const token = authRes.headers.get('set-cookie')?.split(';')[0]?.split('=')[1]
  const tenantId = 'f74f5487-bc05-4fa8-803a-2d4a7282f4a3'
  console.log(`✅ Logged in as ${authData.data?.user?.email || 'test@example.com'} (Tenant: ${tenantId})`)

  console.log("\n--- Testing Builder Chat File Upload ---")
  const filePath = path.resolve('/Users/PaulJoseph/.gemini/antigravity-ide/brain/3a861baf-2b79-425c-938d-922793a81212/scratch/Motability_CLAIMS_LSM_MAPPING (1).xlsx')
  const fileContent = fs.readFileSync(filePath).toString('base64')
  
  const builderRes = await fetch(`http://localhost:3001/api/v1/tenants/${tenantId}/builder/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': `kuvalam_token=${token}`, 'Origin': 'http://localhost:3000' },
    body: JSON.stringify({
      message: "create a knowledge base named Motability Builder Test and upload the attached file to it",
      attachments: [{
        name: "Motability_CLAIMS_LSM_MAPPING (1).xlsx",
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        contentBase64: fileContent
      }]
    })
  })
  const builderData = await builderRes.json()
  console.log("Builder Response:\n", builderData?.data?.message || builderData)
  if (builderData?.data?.actions) {
    console.log("Builder Actions Executed:\n", JSON.stringify(builderData.data.actions.map(a => ({ tool: a.tool, success: a.success, resource: a.result?.resourceType, name: a.result?.name })), null, 2))
  }

  console.log("\n--- Testing Medical Chart Designer ---")
  // Find agent ID
  const agentsRes = await fetch(`http://localhost:3001/api/v1/tenants/${tenantId}/agents`, {
    headers: { 'Cookie': `kuvalam_token=${token}`, 'Origin': 'http://localhost:3000' }
  })
  const agentsData = await agentsRes.json()
  const agent = agentsData.data?.find(a => a.name === 'Medical Chart Designer')
  if (!agent) {
    console.log("❌ Agent 'Medical Chart Designer' not found.")
    return
  }
  console.log(`✅ Found Agent '${agent.name}' (ID: ${agent.id})`)

  const taskRes = await fetch(`http://localhost:3001/api/v1/tenants/${tenantId}/agents/${agent.id}/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': `kuvalam_token=${token}`, 'Origin': 'http://localhost:3000' },
    body: JSON.stringify({
      description: "Generate an interactive adult dental chart"
    })
  })
  const taskData = await taskRes.json()
  console.log(`✅ Task spawned: ${taskData.data?.id || 'Unknown'}`)
  
  // Wait a few seconds for the agent to finish
  console.log("Waiting 25 seconds for agent to complete task and generate report...")
  await new Promise(r => setTimeout(r, 25000))

  const reportsRes = await fetch(`http://localhost:3001/api/v1/tenants/${tenantId}/reports`, {
    headers: { 'Cookie': `kuvalam_token=${token}`, 'Origin': 'http://localhost:3000' }
  })
  const reportsData = await reportsRes.json()
  const report = reportsData.data[0]
  if (report) {
    console.log(`✅ Report generated: ${report.title} (Format: ${report.outputFormat})`)
    if (report.outputFormat === 'svg') {
      console.log(`SVG Content length: ${report.content?.svg_content?.length} characters`)
      if (report.content?.svg_content?.includes('<script>')) {
        console.log(`✅ SVG contains interactive <script> tags as requested.`)
      }
    }
  } else {
    console.log("❌ No reports generated yet.")
  }
}
run().catch(console.error)
