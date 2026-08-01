import fetch from 'node-fetch' // Node 18+ has global fetch, but just in case, we'll use global fetch

async function run() {
  console.log("=== Testing Workflow & Trigger Creation via Builder Bot ===")
  const authRes = await fetch('http://localhost:3001/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': 'http://localhost:3000' },
    body: JSON.stringify({ email: 'test@example.com', password: 'password123', tenantSlug: 'test-org' })
  })
  const authData = await authRes.json()
  const token = authRes.headers.get('set-cookie')?.split(';')[0]?.split('=')[1]
  const tenantId = 'f74f5487-bc05-4fa8-803a-2d4a7282f4a3'
  console.log(`✅ Logged in as test@example.com`)

  console.log("\n--- Sending request to create Workflow and Trigger ---")
  const builderRes = await fetch(`http://localhost:3001/api/v1/tenants/${tenantId}/builder/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': `kuvalam_token=${token}`, 'Origin': 'http://localhost:3000' },
    body: JSON.stringify({
      message: "Please create a workflow named 'Motability Claim Workflow' that processes claims. Then, create a WEBHOOK trigger for this workflow."
    })
  })
  const builderData = await builderRes.json()
  console.log("Builder Response Message:\n", builderData?.data?.message || builderData)
  
  if (builderData?.data?.actions) {
    console.log("\nBuilder Actions Executed:")
    builderData.data.actions.forEach(a => {
      console.log(`- Tool: ${a.tool}`)
      console.log(`  Success: ${a.success}`)
      console.log(`  Result Name: ${a.result?.name}`)
      console.log(`  Resource Type: ${a.result?.resourceType}`)
      if (!a.success) console.log(`  Error: ${a.error}`)
    })
  }

  // Let's verify in the DB if the workflow exists
  console.log("\n--- Fetching Workflows ---")
  const wfRes = await fetch(`http://localhost:3001/api/v1/tenants/${tenantId}/workflows`, {
    headers: { 'Cookie': `kuvalam_token=${token}`, 'Origin': 'http://localhost:3000' }
  })
  const wfData = await wfRes.json()
  const myWf = wfData.data?.find(w => w.name === 'Motability Claim Workflow')
  if (myWf) {
    console.log(`✅ Workflow verified in DB: ${myWf.name} (ID: ${myWf.id})`)
  } else {
    console.log(`❌ Workflow not found in DB list.`)
  }
}
run().catch(console.error)
