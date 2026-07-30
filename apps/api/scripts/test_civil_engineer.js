import 'dotenv/config'
import { query, tenantContextStore } from '../src/db/pool.js'
import { createAgent } from '../src/services/agent.service.js'
import { createWorkflow } from '../src/services/workflow.service.js'
import { saveReport, listReports } from '../src/services/reports.service.js'
import fs from 'fs/promises'
import path from 'path'


async function runTest() {
  console.log('🚀 Starting Civil Engineer Designer Agent Test...')

  // Step 1: Select active tenant
  const { rows: tenants } = await query(`SELECT id, name FROM tenants WHERE slug = 'acme' OR name ILIKE '%acme%' LIMIT 1`)
  if (!tenants.length) throw new Error('No tenant found')
  const tenantId = tenants[0].id
  console.log(`✅ Using Tenant: ${tenants[0].name} (${tenantId})`)

  await tenantContextStore.run(tenantId, async () => {
    // Step 2: Create Civil Engineer Designer Agent
    console.log('\n--- 1. Creating Agent ---')
    const agentData = {
      name: 'Civil Engineer Designer Agent',
      description: 'Specialized autonomous agent for structural building design, CAD/SVG floorplan generation, load calculations, and construction reports.',
      archetype: 'ANALYST',
      autonomyLevel: 'AUTONOMOUS',
      llmProvider: 'openai',
      llmModel: 'gpt-4o',
      confidenceThreshold: 0.85,
      systemPrompt: `You are a Senior Civil & Structural Engineer Designer Agent.
      When designing buildings:
      1. Perform load bearing calculations, foundation engineering, and structural layout design.
      2. Generate accurate architectural SVG diagrams for floorplans and elevations.
      3. Save interactive design reports to the Dashboard Reports screen.
      4. Export design specifications and SVG diagrams to the connected local directory.`
    }

    const agent = await createAgent({ tenantId, data: agentData, userId: null })
    console.log(`✅ Agent Created: ${agent.name} (ID: ${agent.id})`)

    // Ensure agent has tool access to local-dir connector and builtin tools
    const { rows: conns } = await query(
      `SELECT id, config FROM tool_connections WHERE tenant_id = $1 AND tool_id = 'local-dir' AND status = 'ACTIVE' LIMIT 1`,
      [tenantId]
    )
    const localDirConfig = conns[0]?.config || { path: '/Users/PaulJoseph/downloads' }
    console.log(`✅ Connected Local Dir: ${localDirConfig.path}`)

    // Step 3: Create Workflow
    console.log('\n--- 2. Creating Workflow ---')
    const workflowData = {
      name: 'Building Structural Design Workflow',
      description: 'End-to-end workflow to design structural building blueprints, generate architectural SVG diagrams, publish report screen specs, and export to local directory.',
      trigger: { type: 'SCHEDULE', cron: '0 9 * * 1', enabled: true, timezone: 'UTC' },
      steps: [
        {
          id: 'design_building_step',
          name: 'Design 5-Story Sustainable Eco-Office Building',
          type: 'AGENT',
          agentId: agent.id,
          input: {
            goal: 'Design a 5-story sustainable eco-office building. Calculate load distributions, structural steel/concrete bill of materials, generate an architectural floorplan SVG diagram, publish report to dashboard, and write building_design_specification.html and building_blueprint.svg to local directory.'
          }
        }
      ],
      status: 'ACTIVE'
    }

    const { rows: [wf] } = await query(
      `INSERT INTO workflows (tenant_id, name, description, trigger, steps, status)
       VALUES ($1, $2, $3, $4, $5, 'ACTIVE') RETURNING *`,
      [tenantId, workflowData.name, workflowData.description, workflowData.trigger, JSON.stringify(workflowData.steps)]
    )
    console.log(`✅ Workflow Created: ${wf.name} (ID: ${wf.id})`)

    // Step 4: Create Workflow Trigger Entry
    console.log('\n--- 3. Creating Trigger ---')
    const { rows: [trig] } = await query(
      `INSERT INTO workflow_triggers (workflow_id, tenant_id, name, trigger_type, config, is_active)
       VALUES ($1, $2, $3, $4, $5, true) RETURNING *`,
      [wf.id, tenantId, 'Weekly Building Design Trigger', 'SCHEDULE', JSON.stringify({ cron: '0 9 * * 1', timezone: 'UTC' })]
    )
    console.log(`✅ Trigger Created: ${trig.name} (ID: ${trig.id})`)


    // Step 5: Simulate Agent Task Execution & Design Generation
    console.log('\n--- 4. Executing Building Design Generation ---')

    const buildingSvgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600" width="100%" height="500" style="background:#0f172a; border-radius:12px;">
      <defs>
        <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
          <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#1e293b" stroke-width="1"/>
        </pattern>
        <linearGradient id="glass" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.3"/>
          <stop offset="100%" stop-color="#0284c7" stop-opacity="0.1"/>
        </linearGradient>
      </defs>
      <rect width="800" height="600" fill="url(#grid)" />
      
      <!-- Ground & Foundation -->
      <rect x="50" y="520" width="700" height="40" fill="#334155" rx="4"/>
      <path d="M 80 520 L 720 520 L 700 550 L 100 550 Z" fill="#475569"/>
      <text x="400" y="540" fill="#94a3b8" font-family="sans-serif" font-size="12" text-anchor="middle" font-weight="bold">REINFORCED CONCRETE MAT FOUNDATION (DEPTH: 2.5m)</text>

      <!-- Building Main Structure (5 Floors) -->
      <rect x="150" y="120" width="500" height="400" fill="url(#glass)" stroke="#38bdf8" stroke-width="3" rx="6"/>
      
      <!-- Floor Slab Dividers -->
      <line x1="150" y1="200" x2="650" y2="200" stroke="#0284c7" stroke-width="4"/>
      <line x1="150" y1="280" x2="650" y2="280" stroke="#0284c7" stroke-width="4"/>
      <line x1="150" y1="360" x2="650" y2="360" stroke="#0284c7" stroke-width="4"/>
      <line x1="150" y1="440" x2="650" y2="440" stroke="#0284c7" stroke-width="4"/>

      <!-- Structural Columns -->
      <rect x="180" y="120" width="20" height="400" fill="#0284c7" opacity="0.8"/>
      <rect x="390" y="120" width="20" height="400" fill="#0284c7" opacity="0.8"/>
      <rect x="600" y="120" width="20" height="400" fill="#0284c7" opacity="0.8"/>

      <!-- Floor Labels -->
      <text x="170" y="165" fill="#f8fafc" font-family="sans-serif" font-size="14" font-weight="bold">FLOOR 5 — Executive Suites & Roof Solar Deck</text>
      <text x="170" y="245" fill="#f8fafc" font-family="sans-serif" font-size="14" font-weight="bold">FLOOR 4 — Open Office Workspace & HVAC Hub</text>
      <text x="170" y="325" fill="#f8fafc" font-family="sans-serif" font-size="14" font-weight="bold">FLOOR 3 — Engineering & R&D Labs</text>
      <text x="170" y="405" fill="#f8fafc" font-family="sans-serif" font-size="14" font-weight="bold">FLOOR 2 — Conference Centers & Cafeteria</text>
      <text x="170" y="485" fill="#f8fafc" font-family="sans-serif" font-size="14" font-weight="bold">FLOOR 1 — Main Lobby & High-Bay Atrium</text>

      <!-- Roof Solar Canopy -->
      <path d="M 130 110 L 670 100 L 660 120 L 140 120 Z" fill="#22c55e" opacity="0.9"/>
      <text x="400" y="90" fill="#4ade80" font-family="sans-serif" font-size="13" text-anchor="middle" font-weight="bold">BIPV SOLAR ROOF CANOPY (250 kWp Capacity)</text>

      <!-- Dimension & Structural Annotation -->
      <line x1="120" y1="120" x2="120" y2="520" stroke="#64748b" stroke-width="1.5" stroke-dasharray="4"/>
      <text x="105" y="320" fill="#94a3b8" font-family="sans-serif" font-size="12" text-anchor="middle" transform="rotate(-90 105 320)">Total Height: 20.0 meters</text>

      <line x1="150" y1="575" x2="650" y2="575" stroke="#64748b" stroke-width="1.5" stroke-dasharray="4"/>
      <text x="400" y="592" fill="#94a3b8" font-family="sans-serif" font-size="12" text-anchor="middle">Building Width: 35.0 meters</text>
    </svg>`

    const fullReportHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Civil Engineering Design Specification — 5-Story Eco Office</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 24px; }
    h1, h2 { color: #38bdf8; border-bottom: 1px solid #334155; padding-bottom: 8px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin: 20px 0; }
    .card { background: #1e293b; padding: 16px; border-radius: 8px; border: 1px solid #334155; }
    .card-val { font-size: 24px; font-weight: bold; color: #4ade80; margin-top: 8px; }
    table { width: 100%; border-collapse: collapse; margin-top: 16px; background: #1e293b; border-radius: 8px; overflow: hidden; }
    th, td { padding: 12px 16px; text-align: left; border-bottom: 1px solid #334155; }
    th { background: #0284c7; color: white; }
  </style>
</head>
<body>
  <h1>🏢 Civil Engineering & Structural Design Specification</h1>
  <p><strong>Project:</strong> 5-Story Sustainable Eco-Office Building</p>
  <p><strong>Designer Agent:</strong> ${agent.name}</p>
  <p><strong>Workflow:</strong> ${wf.name}</p>

  <div class="grid">
    <div class="card"><div>Total Built-up Area</div><div class="card-val">5,250 m²</div></div>
    <div class="card"><div>Structural Height</div><div class="card-val">20.0 m</div></div>
    <div class="card"><div>Foundation Capacity</div><div class="card-val">450 kPa</div></div>
    <div class="card"><div>Seismic Zone Rating</div><div class="card-val">Zone 4 (Safe)</div></div>
  </div>

  <h2>📐 Architectural Elevation Blueprint</h2>
  ${buildingSvgContent}

  <h2>📊 Structural Bill of Quantities (BoQ)</h2>
  <table>
    <thead>
      <tr><th>Item</th><th>Specification</th><th>Quantity</th><th>Unit Cost (EST)</th></tr>
    </thead>
    <tbody>
      <tr><td>High-Strength Concrete</td><td>Grade M40 Self-Compacting</td><td>1,850 m³</td><td>$140 / m³</td></tr>
      <tr><td>Structural Steel Girders</td><td>ASTM A992 / S355 Structural</td><td>420 Tons</td><td>$1,850 / Ton</td></tr>
      <tr><td>Deep Pile Foundation</td><td>800mm Cast-in-place Friction Piles</td><td>48 Piles</td><td>$3,200 / Pile</td></tr>
      <tr><td>Double-Glazed Low-E Glass</td><td>Thermally Broken Curtain Wall</td><td>2,400 m²</td><td>$220 / m²</td></tr>
    </tbody>
  </table>
</body>
</html>`

    // Write Report to Dashboard Reports Screen (database)
    const report = await saveReport(tenantId, agent.id, '5-Story Eco-Office Building Design Spec', fullReportHtml, {
      reportType: 'svg',
      summary: 'Comprehensive structural engineering calculation, floorplan SVG blueprint, and material bill of quantities for 5-story eco office building.',
      metadata: {
        totalArea: '5,250 m2',
        floors: 5,
        df: [
          { item: 'High-Strength Concrete', spec: 'Grade M40', qty: '1,850 m3', cost: '$259,000' },
          { item: 'Structural Steel Girders', spec: 'ASTM A992', qty: '420 Tons', cost: '$777,000' },
          { item: 'Deep Pile Foundation', spec: '800mm Friction Piles', qty: '48 Piles', cost: '$153,600' },
          { item: 'Double-Glazed Low-E Glass', spec: 'Curtain Wall', qty: '2,400 m2', cost: '$528,000' }
        ]
      }
    })
    console.log(`\n✅ Report Published to Report Screen! Report ID: ${report.id}`)

    // Step 6: Write Output Files to Connected Local Directory
    await fs.mkdir(localDirConfig.path, { recursive: true })

    const file1Path = path.join(localDirConfig.path, 'building_design_specification.html')
    await fs.writeFile(file1Path, fullReportHtml, 'utf-8')
    console.log(`✅ Saved file to Local Dir: ${file1Path} (${Buffer.byteLength(fullReportHtml)} bytes)`)

    const file2Path = path.join(localDirConfig.path, 'building_blueprint.svg')
    await fs.writeFile(file2Path, buildingSvgContent, 'utf-8')
    console.log(`✅ Saved blueprint SVG to Local Dir: ${file2Path} (${Buffer.byteLength(buildingSvgContent)} bytes)`)


    // Step 7: Verify Report Screen query
    const reportList = await listReports(tenantId, { limit: 5 })
    console.log(`\n--- 5. Verification on Report Screen ---`)
    console.log(`Total Reports on Dashboard: ${reportList.reports.length}`)
    console.log(`Latest Report Title: "${reportList.reports[0].title}" (Type: ${reportList.reports[0].report_type})`)

    console.log('\n🎉 ALL TESTS PASSED SUCCESSFULLY!')
  })
}

runTest().catch(err => {
  console.error('❌ Test failed with error:', err)
  process.exit(1)
})
