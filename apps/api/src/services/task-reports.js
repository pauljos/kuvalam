// apps/api/src/services/task-reports.js
// Report builder functions — extracted from task.service.js.
// These generate HTML reports, charts, KPIs, and system prompts for agents.

// ─── Colour palette for charts ──────────────────────────────────────────────
export const CHART_COLORS = [
  '#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#8b5cf6', '#ec4899',
  '#06b6d4', '#f97316', '#84cc16', '#14b8a6', '#6366f1', '#e11d48',
  '#0ea5e9', '#d946ef', '#10b981', '#f43f5e'
]
export const CHART_BG_ALPHA = '33' // ~20%

// Markers that indicate a stored system_prompt contains the GENERATED archetype
// blob (produced by generateAgentSystemPrompt) rather than only user guardrails.
// Older agents saved the whole composed prompt at creation; we strip it at
// runtime so the archetype template is always generated fresh and never frozen.
const ARCHETYPE_SECTION = /\n{2,}##\s*(YOUR ROLE|HOW TO WORK|CORE RULES|AGENT CREATION GUIDELINES|DATABASE ACCESS)\b/i
const ARCHETYPE_OPEN = /^\s*You are\s+\*{0,2}[^,\n*]{2,80}\*{0,2}\s*,/i

/**
 * Return ONLY the user-authored guardrails portion of an agent's system_prompt,
 * stripping any embedded archetype template that was frozen in at creation time.
 * Keeps custom sections (e.g. "## Guardrails", domain rules) intact.
 */
export function extractUserGuardrails(systemPrompt) {
  const raw = String(systemPrompt || '').trim()
  if (!raw) return ''

  // Corrupted output guard — a previous refiner run once saved a JSON template
  // placeholder ("<the FULL new custom instructions...>"). Drop that line.
  let text = raw.replace(/^<the FULL new custom instructions[^\n]*>\s*/i, '').trim()
  if (!text) return ''

  // Only treat as a frozen archetype blob if it BOTH opens like one ("You are
  // **Name**, a ... agent.") AND contains the archetype section headings. A
  // hand-written prompt that merely starts with "You are a ... for X" (no `## `
  // archetype sections) is legitimate custom instructions — keep it verbatim.
  const looksBlob = ARCHETYPE_OPEN.test(text) && ARCHETYPE_SECTION.test(text)
  if (looksBlob) {
    const lines = text.split('\n')
    let out = []
    let inCustom = false
    for (const line of lines) {
      const isSection = /^##\s+/.test(line.trim())
      if (isSection) {
        inCustom = !/^##\s*(YOUR ROLE|HOW TO WORK|CORE RULES|AGENT CREATION GUIDELINES|DATABASE ACCESS)\b/i.test(line.trim())
      }
      if (inCustom) out.push(line)
    }
    // Whatever custom sections followed the archetype blob are the guardrails.
    // If none, the prompt WAS purely an archetype blob → no guardrails.
    return out.join('\n').trim()
  }

  // Doesn't look like an archetype blob — treat the whole thing as user guardrails.
  return text
}

// ─── Shared hallucination pattern libraries ──────────────────────────────────
// Used by task synthesis quality scoring. Keep in one place so all paths
// (normal synthesis, artifact-only, future shortcuts) stay consistent.
export const HALLUCINATION_FABRICATION_PATTERNS = [
  'I deployed', 'I published', 'I launched', 'I released',
  'I finalized', 'I shipped', 'I rolled out',
]
export const HALLUCINATION_FUTURE_TENSE_PATTERNS = [
  'I will provide', 'I will implement', 'I will create',
  'I will develop', 'I will need to', 'I would need to',
  'I will continue', 'should be implemented',
  'would require additional', 'next steps',
]
export const HALLUCINATION_DEFLECTION_PATTERNS = [
  'a revised response', 'in the correct format',
  'let me try again', 'I apologize',
  'I hope this', 'let me know if', 'feel free to',
  'please let me know', 'if you have any questions',
  'I would be happy to', "please don't hesitate",
]

export const HALLUCINATION_VAGUENESS_PATTERNS = [
  'could potentially', 'might possibly', 'may or may not',
  'it is worth noting', 'it should be noted', 'generally speaking',
  'in general', 'broadly speaking', 'for the most part',
]

// Convenience bundle for callers that need all three
export const HALLUCINATION_PATTERNS = {
  fabrication: HALLUCINATION_FABRICATION_PATTERNS,
  futureTense: HALLUCINATION_FUTURE_TENSE_PATTERNS,
  deflection: HALLUCINATION_DEFLECTION_PATTERNS,
}

/**
 * Extract expected deliverable types from a task goal string.
 * Returns an array of unique deliverable type strings (lowercase).
 * Used by: reflection prompt (deliverable check), artifact scoring
 * (goal-coverage penalty), and scopeAdherence (deliverable shortfall).
 *
 * The `count` is the authoritative "how many things are expected" metric,
 * based on distinct deliverable keywords found. The `types` array contains
 * human-readable descriptions for display in reflection prompts.
 *
 * @param {string} goal - The task goal text
 * @returns {{types: string[], count: number}} Extracted deliverable info
 */
export function extractGoalDeliverables(goal) {
  if (!goal || typeof goal !== 'string') return { types: [], count: 0 }
  const seen = new Set()
  const types = []

  // ── Primary: count distinct deliverable-type KEYWORDS ─────────────────
  // Each keyword is a deliverable category the goal asks for.
  // Stems match plurals: "diagram" ↔ "diagrams", "flow" ↔ "flows", etc.
  const keywordPattern = /\b(diagrams?|lineage|DDL|ERD|entity[- ]relationships?|data[- ]flows?|flowcharts?|visualizations?|schemas?|blueprints?|drawings?|notebooks?|spreadsheets?|mappings?|plans?|specs?|reports?|charts?|scripts?|summar(y|ies)|analys(e|is)|queries)\b/gi
  const pluralMap = {
    'diagrams': 'diagram', 'flows': 'flow', 'flowcharts': 'flowchart',
    'visualizations': 'visualization', 'schemas': 'schema', 'blueprints': 'blueprint',
    'drawings': 'drawing', 'notebooks': 'notebook', 'spreadsheets': 'spreadsheet',
    'mappings': 'mapping', 'plans': 'plan', 'specs': 'spec',
    'reports': 'report', 'charts': 'chart', 'scripts': 'script',
    'summaries': 'summary', 'queries': 'query',
    'entity relationships': 'entity relationship', 'data flows': 'data flow',
    'analysis': 'analysis', 'analyses': 'analysis',
  }
  let kwMatch
  while ((kwMatch = keywordPattern.exec(goal)) !== null) {
    const raw = kwMatch[0].toLowerCase().replace(/\s+/g, ' ').replace(/-/g, ' ')
    const kw = pluralMap[raw] || raw
    if (!seen.has(kw)) {
      seen.add(kw)
      types.push(kw)
    }
  }
  // The keyword count is the authoritative metric for goal-coverage checks
  const keywordCount = types.length

  // ── Secondary: capture descriptive phrases for display (reflection prompts) ──
  // These provide richer context but don't increase the count.
  const creationPattern = /(?:create|generate|produce|build|write|develop)\s+(?:a\s+|an\s+)?([^,.;]{8,60}?(?:diagram|lineage|DDL|schema|report|chart|model|artefact|artifact|script|file|document|summary|analysis|query|statement|ERD|entity[-\s]relationship|data flow|flowchart|visualization|code|drawing|blueprint|plan|spec|mapping|notebook|spreadsheet))/gi
  let match
  while ((match = creationPattern.exec(goal)) !== null) {
    const d = match[1].trim().toLowerCase()
    if (d.length > 6 && d.length < 80 && !seen.has(d) && !types.some(t => d.includes(t))) {
      seen.add(d)
      // Add as supplemental display text only if it adds new info
      if (types.length < 8) types.push(d)
    }
  }

  return { types: types.slice(0, 8), count: keywordCount }
}

/**
 * Extract a confidence score from a synthesis response.
 * Looks for explicit patterns like "confidence: 0.9" or "95% confident".
 * Falls back to a heuristic based on hedging language.
 */
export function extractConfidence(text) {
  if (!text) return 0.5

  // Explicit decimal: "confidence: 0.85" or "confidence score: 0.9"
  const decimalMatch = text.match(/confidence(?:\s+score)?[:\s]+([0-1]\.\d+)/i)
  if (decimalMatch) return parseFloat(decimalMatch[1])

  // Explicit percentage: "95% confident" or "confidence: 90%"
  const percentMatch = text.match(/(\d{1,3})\s*%\s*confident|confidence[:\s]+(\d{1,3})\s*%/i)
  if (percentMatch) return parseFloat(percentMatch[1] || percentMatch[2]) / 100

  // Heuristic: penalise strong uncertainty language
  const lowConfidenceSignals = /\b(uncertain|unclear|unsure|cannot determine|unable to confirm|may not be|might not)\b/gi
  const highConfidenceSignals = /\b(successfully|completed|confirmed|verified|accurate|correct)\b/gi

  const lowCount = (text.match(lowConfidenceSignals) || []).length
  const highCount = (text.match(highConfidenceSignals) || []).length

  // Start at 0.65 baseline and nudge by signal counts.
  // Lower than the previous 0.85 — matter-of-fact prose shouldn't masquerade
  // as high-confidence output. Confidence must be earned through explicit signals.
  return Math.min(0.99, Math.max(0.1, 0.65 + highCount * 0.04 - lowCount * 0.10))
}

/**
 * Build a rich, professional dashboard report from structured data.
 * Supports:
 *   input.df          — array of row objects (or {columns, rows})
 *   input.charts      — array of { type, title?, x_key, y_key, y_keys?, label? }
 *   input.kpis        — array of { label, value, icon?, trend?, trendLabel? }
 *   input.summary     — text summary paragraph
 *   input.kpi_layout  — 'cards' (default) | 'row'
 */
export function buildRichReportHtml(input, title) {
  const reportId = Date.now()
  // Parse the data frame
  let rows = []
  let columns = []
  if (input.df) {
    let parsed
    try {
      parsed = typeof input.df === 'string' ? JSON.parse(input.df) : input.df
    } catch { parsed = input.df }

    if (Array.isArray(parsed)) {
      // Detect 2D array with header row: [["col1","col2"],[val1,val2],...]
      if (parsed.length > 0 && Array.isArray(parsed[0]) && parsed.every(r => Array.isArray(r))) {
        columns = parsed[0].map(String)
        rows = parsed.slice(1).map(r => {
          const obj = {}
          columns.forEach((c, i) => { obj[c] = r[i] })
          return obj
        })
      } else {
        rows = parsed
      }
    } else if (parsed && typeof parsed === 'object') {
      // Support { columns: [...], rows: [[...], [...]] } format
      if (parsed.columns && parsed.rows) {
        columns = parsed.columns
        rows = parsed.rows.map(r => {
          const obj = {}
          columns.forEach((c, i) => { obj[c] = r[i] })
          return obj
        })
      } else {
        // { key: [...] } → unwrap
        const vals = Object.values(parsed)
        rows = vals.find(v => Array.isArray(v) && v.length > 0) || []
      }
    }
  }
  if (columns.length === 0 && rows.length > 0) {
    columns = Object.keys(rows[0])
  }

  // Parse charts and kpis (models often send them as JSON strings)
  let charts = input.charts || []
  if (typeof charts === 'string') {
    try { charts = JSON.parse(charts) } catch { charts = [] }
  }
  if (!Array.isArray(charts)) charts = []

  let kpis = input.kpis || []
  if (typeof kpis === 'string') {
    try { kpis = JSON.parse(kpis) } catch { kpis = [] }
  }
  if (!Array.isArray(kpis)) kpis = []

  // Auto-compute KPIs from numeric columns — only for larger datasets (>10 rows)
  // Small result sets (like "top 5 buyers") are rankings; KPIs (total/avg/max/min)
  // are meaningless aggregates that bury the actual ranking.
  if (kpis.length === 0 && columns.length > 0 && rows.length > 10) {
    const numericCols = columns.filter(c => rows.some(r => typeof r[c] === 'number'))
    numericCols.slice(0, 4).forEach(col => {
      const vals = rows.map(r => Number(r[col])).filter(v => !isNaN(v))
      if (vals.length > 0) {
        const sum = vals.reduce((a, b) => a + b, 0)
        const avg = sum / vals.length
        const max = Math.max(...vals)
        const min = Math.min(...vals)
        kpis.push(
          { label: `Total ${col}`, value: formatKpiValue(sum) },
          { label: `Avg ${col}`, value: formatKpiValue(avg) },
          { label: `Max ${col}`, value: formatKpiValue(max) },
          { label: `Min ${col}`, value: formatKpiValue(min) }
        )
      }
    })
  }

  // Build charts JS (charts already parsed from string above)
  // Only auto-chart for larger datasets (>10 rows); small rankings don't need charts
  if (charts.length === 0 && columns.length >= 2 && rows.length > 10) {
    // Default: one chart from first two columns
    const xCol = columns[0]
    const yCols = columns.slice(1).filter(c => rows.some(r => typeof r[c] === 'number'))
    if (yCols.length > 0) {
      charts.push({ type: 'bar', title: `${yCols[0]} by ${xCol}`, x_key: xCol, y_key: yCols[0] })
    }
  }

  const chartScripts = charts.map((chart, idx) => {
    const chartId = `chart-${reportId}-${idx}`
    const chartType = normalizeChartType(chart.type || 'bar')
    const xKey = chart.x_key || columns[0]
    const labels = rows.map(r => String(r[xKey] ?? ''))
    const yKeys = chart.y_keys
      ? chart.y_keys
      : chart.y_key
        ? [chart.y_key]
        : columns.slice(1).filter(c => rows.some(r => typeof r[c] === 'number')).slice(0, 1)

    const datasets = yKeys.map((yKey, di) => {
      const data = rows.map(r => Number(r[yKey]) || 0)
      const colorIdx = di % CHART_COLORS.length
      const isPieLike = ['pie', 'doughnut'].includes(chartType)
      const bg = isPieLike
        ? data.map((_, i) => CHART_COLORS[i % CHART_COLORS.length])
        : CHART_COLORS[colorIdx]
      return {
        label: yKeys.length === 1 && chart.label ? chart.label : yKey,
        data,
        backgroundColor: bg,
        borderColor: isPieLike ? undefined : CHART_COLORS[colorIdx],
        borderWidth: isPieLike ? 1 : 2,
        tension: chartType === 'line' ? 0.35 : undefined,
        fill: chartType === 'line' ? false : undefined
      }
    })

    const chartTitle = chart.title || `Chart ${idx + 1}`

    return {
      chartId,
      chartTitle,
      chartType,
      labels: JSON.stringify(labels),
      datasets: JSON.stringify(datasets),
      options: JSON.stringify(buildChartOptions(chartType, chartTitle)),
      width: chart.width || 12
    }
  })

  // Build KPI cards HTML
  const kpiCards = kpis.slice(0, 8).map(kpi => {
    const icon = kpi.icon || getKpiIcon(kpi.label)
    const trendHtml = kpi.trend
      ? `<span style="color:${kpi.trend === 'up' ? '#22c55e' : kpi.trend === 'down' ? '#ef4444' : '#64748b'};font-size:12px;font-weight:600">${kpi.trend === 'up' ? '▲' : kpi.trend === 'down' ? '▼' : '—'} ${kpi.trendLabel || ''}</span>`
      : ''
    return `<div class="kpi-card">
      <div class="kpi-icon">${icon}</div>
      <div class="kpi-value">${kpi.value}</div>
      <div class="kpi-label">${kpi.label}</div>
      ${trendHtml}
    </div>`
  }).join('')

  // Build data table
  const tableHtml = rows.length > 0 ? buildDataTable(rows, columns) : ''

  const summaryHtml = input.summary
    ? `<div class="report-summary">${input.summary}</div>`
    : ''

  // Build chart placeholders
  const chartPlaceholders = chartScripts.map(cs => {
    const isWide = cs.width >= 12
    return `<div class="chart-container${isWide ? ' chart-full' : ''}">
      <div class="chart-title">${cs.chartTitle}</div>
      <div class="chart-wrap"><canvas id="${cs.chartId}"></canvas></div>
    </div>`
  }).join('')

  const hasCharts = chartScripts.length > 0

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
${hasCharts ? '<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0"><\/script>' : ''}
<style>
  :root {
    --bg: #ffffff; --card-bg: #f8fafc; --border: #e2e8f0;
    --text: #1e293b; --text-secondary: #64748b; --text-muted: #94a3b8;
    --blue: #3b82f6; --blue-light: #eff6ff; --green: #22c55e; --red: #ef4444;
    --radius: 12px; --shadow: 0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    background: var(--bg); color: var(--text); line-height: 1.6;
    padding: 32px 24px; max-width: 1200px; margin: 0 auto;
  }
  .report-header { margin-bottom: 28px; }
  .report-header h2 { font-size: 24px; font-weight: 800; color: #0f172a; margin-bottom: 4px; }
  .report-header .report-meta {
    font-size: 13px; color: var(--text-secondary);
    display: flex; gap: 16px; align-items: center;
  }
  .report-summary {
    background: #f0f9ff; border-left: 4px solid var(--blue); border-radius: 8px;
    padding: 14px 18px; margin-bottom: 24px; font-size: 14px; color: #1e40af;
  }
  /* KPI Cards */
  .kpi-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 14px; margin-bottom: 28px;
  }
  .kpi-card {
    background: var(--card-bg); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 18px 16px;
    box-shadow: var(--shadow); transition: box-shadow 0.2s;
  }
  .kpi-card:hover { box-shadow: 0 4px 12px rgba(0,0,0,0.08); }
  .kpi-icon { font-size: 24px; margin-bottom: 6px; }
  .kpi-value { font-size: 26px; font-weight: 800; color: #0f172a; line-height: 1.2; }
  .kpi-label { font-size: 12px; color: var(--text-muted); margin-top: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
  /* Charts */
  .charts-grid {
    display: grid; grid-template-columns: repeat(2, 1fr); gap: 18px; margin-bottom: 28px;
  }
  .chart-container { background: var(--card-bg); border: 1px solid var(--border); border-radius: var(--radius); padding: 18px; box-shadow: var(--shadow); }
  .chart-container.chart-full { grid-column: 1 / -1; }
  .chart-title { font-size: 14px; font-weight: 700; color: #334155; margin-bottom: 10px; }
  .chart-wrap { position: relative; width: 100%; max-height: 320px; }
  .chart-wrap canvas { max-height: 320px; }
  /* Data Table */
  .table-section { margin-bottom: 28px; }
  .table-section h3 { font-size: 16px; font-weight: 700; color: #0f172a; margin-bottom: 10px; }
  .table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); }
  table {
    width: 100%; border-collapse: collapse; font-size: 13px;
    min-width: 600px;
  }
  thead { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
  thead th {
    padding: 12px 14px; color: #ffffff; font-weight: 700; font-size: 12px;
    text-transform: uppercase; letter-spacing: 0.5px; text-align: left;
    white-space: nowrap; position: sticky; top: 0;
  }
  tbody td {
    padding: 10px 14px; border-bottom: 1px solid #f1f5f9; color: #334155;
    max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  tbody tr { transition: background 0.15s; }
  tbody tr:nth-child(even) { background: #f8fafc; }
  tbody tr:hover { background: #eef2ff; }
  tbody td.numeric { font-family: 'SF Mono', 'Menlo', monospace; text-align: right; }
  .no-data { text-align: center; padding: 40px; color: var(--text-muted); font-size: 14px; }
  /* Footer */
  .report-footer {
    border-top: 1px solid var(--border); padding-top: 16px; margin-top: 8px;
    font-size: 12px; color: var(--text-muted); text-align: center;
  }
  @media (max-width: 768px) {
    body { padding: 16px; }
    .charts-grid { grid-template-columns: 1fr; }
    .kpi-grid { grid-template-columns: repeat(2, 1fr); }
  }
  @media print {
    body { padding: 0; }
    .kpi-card, .chart-container { box-shadow: none; border: 1px solid #ddd; break-inside: avoid; }
    .chart-container { page-break-inside: avoid; }
  }
</style>
</head>
<body>
  <div class="report-header">
    <h2 style="margin:0;font-size:20px;font-weight:700">${escapeHtml(title)}</h2>
    <div class="report-meta">
      <span>${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
      <span>·</span>
      <span>${rows.length} records${columns.length > 0 ? ' · ' + columns.length + ' columns' : ''}</span>
    </div>
  </div>

  ${summaryHtml}

  ${kpis.length > 0 ? `<div class="kpi-grid">${kpiCards}</div>` : ''}

  ${chartPlaceholders ? `<div class="charts-grid">${chartPlaceholders}</div>` : ''}

  ${tableHtml ? `<div class="table-section">
    <h3>${escapeHtml(input.table_title || 'Data')}</h3>
    <div class="table-wrap">${tableHtml}</div>
  </div>` : ''}

  <div class="report-footer">
    Generated by Kuvalam AI Agent · ${new Date().toISOString()}
  </div>

  ${hasCharts ? `<script>
    document.addEventListener('DOMContentLoaded', function() {
      var canvas, ctx;
      ${chartScripts.map(cs => `
      canvas = document.getElementById('${cs.chartId}');
      if (canvas) {
        try {
          new Chart(canvas.getContext('2d'), {
            type: '${cs.chartType}',
            data: { labels: ${cs.labels}, datasets: ${cs.datasets} },
            options: ${cs.options}
          });
        } catch(e) { console.warn('Chart ${cs.chartId} failed:', e.message); }
      }`).join('\n')}
    });
  <\/script>` : ''}
</body>
</html>`
}

export function buildDataTable(rows, columns) {
  if (rows.length === 0) return '<div class="no-data">No data available</div>'
  const ths = columns.map(c => {
    const isNumeric = rows.every(r => r[c] === null || r[c] === undefined || typeof r[c] === 'number')
    return `<th class="${isNumeric ? '' : ''}">${escapeHtml(String(c))}</th>`
  }).join('')
  const tbody = rows.map((r, i) => {
    const tds = columns.map(c => {
      const val = r[c]
      const isNum = typeof val === 'number'
      const display = val === null || val === undefined ? '—' : String(val)
      return `<td class="${isNum ? 'numeric' : ''}">${escapeHtml(display)}</td>`
    }).join('')
    return `<tr>${tds}</tr>`
  }).join('')
  return `<table><thead><tr>${ths}</tr></thead><tbody>${tbody}</tbody></table>`
}

export function buildChartOptions(type, titleText) {
  const base = {
    responsive: true,
    maintainAspectRatio: true,
    plugins: {
      legend: {
        position: 'bottom',
        labels: { padding: 16, usePointStyle: true, pointStyleWidth: 8, font: { size: 12 } }
      },
      title: {
        display: false
      }
    }
  }
  // Pie/doughnut specifics
  if (['pie', 'doughnut'].includes(type)) {
    base.plugins.legend.position = 'right'
  }
  // Add scales for non-pie types
  if (!['pie', 'doughnut', 'radar'].includes(type)) {
    base.scales = {
      x: { grid: { display: false }, ticks: { font: { size: 11 } } },
      y: { beginAtZero: true, grid: { color: '#f1f5f9' }, ticks: { font: { size: 11 } } }
    }
  }
  if (type === 'radar') {
    base.scales = {
      r: { beginAtZero: true, ticks: { display: true, backdropColor: 'transparent', font: { size: 10 } } }
    }
  }
  return base
}

export function normalizeChartType(type) {
  const map = {
    bar_chart: 'bar', vertical_bar: 'bar', horizontal_bar: 'bar',
    line_chart: 'line',
    pie_chart: 'pie', doughnut_chart: 'doughnut', donut: 'doughnut',
    scatter_plot: 'scatter', scatter: 'scatter',
    radar_chart: 'radar',
    area: 'line', area_chart: 'line'
  }
  return map[type] || type
}

// ══════════════════════════════════════════════════════════════════════════════
// SVG Report Builder — renders inline vector graphics
// ══════════════════════════════════════════════════════════════════════════════
export function buildSvgReportHtml(svgContent, title, summary) {
  const summaryHtml = summary ? `<div class="report-summary">${escapeHtml(summary)}</div>` : ''
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    background: #ffffff; color: #1e293b; line-height: 1.6;
    padding: 32px 24px; max-width: 1100px; margin: 0 auto;
  }
  .report-header { margin-bottom: 24px; }
  .report-header h2 { font-size: 24px; font-weight: 800; color: #0f172a; margin-bottom: 4px; }
  .report-summary {
    background: #f0f9ff; border-left: 4px solid #3b82f6; border-radius: 8px;
    padding: 14px 18px; margin-bottom: 24px; font-size: 14px; color: #1e40af;
  }
  .svg-container {
    background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px;
    padding: 24px; overflow-x: auto; box-shadow: 0 1px 3px rgba(0,0,0,0.06);
    min-height: 400px; display: flex; align-items: center; justify-content: center;
  }
  .svg-container svg { max-width: 100%; max-height: 100%; width: 100%; height: auto; display: block; }
  .report-footer {
    border-top: 1px solid #e2e8f0; padding-top: 16px; margin-top: 24px;
    font-size: 12px; color: #94a3b8; text-align: center;
  }
  @media print {
    body { padding: 0; }
    .svg-container { box-shadow: none; border: 1px solid #ddd; break-inside: avoid; }
  }
</style>
</head>
<body>
  <div class="report-header"><h2>${escapeHtml(title)}</h2></div>
  ${summaryHtml}
  <div class="svg-container">${svgContent}</div>
  <div class="report-footer">Generated by Kuvalam AI Agent · ${new Date().toISOString()}</div>
</body>
</html>`
}

// ══════════════════════════════════════════════════════════════════════════════
// D3 Report Builder — renders interactive D3.js visualizations
// ══════════════════════════════════════════════════════════════════════════════
export function buildD3ReportHtml(d3Script, d3Data, title, summary) {
  const dataJson = JSON.stringify(d3Data || {}, null, 2)
  const summaryHtml = summary ? `<div class="report-summary">${escapeHtml(summary)}</div>` : ''
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<script src="https://d3js.org/d3.v7.min.js"><\/script>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    background: #ffffff; color: #1e293b; line-height: 1.6;
    padding: 32px 24px; max-width: 1100px; margin: 0 auto;
  }
  .report-header { margin-bottom: 24px; }
  .report-header h2 { font-size: 24px; font-weight: 800; color: #0f172a; margin-bottom: 4px; }
  .report-summary {
    background: #f0f9ff; border-left: 4px solid #3b82f6; border-radius: 8px;
    padding: 14px 18px; margin-bottom: 24px; font-size: 14px; color: #1e40af;
  }
  .d3-container {
    background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px;
    padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); overflow-x: auto;
  }
  .d3-container svg { display: block; margin: 0 auto; }
  .d3-title { font-size: 16px; font-weight: 700; color: #334155; margin-bottom: 16px; }
  .report-footer {
    border-top: 1px solid #e2e8f0; padding-top: 16px; margin-top: 24px;
    font-size: 12px; color: #94a3b8; text-align: center;
  }
  .tooltip {
    position: absolute; background: #1e293b; color: #fff; padding: 6px 10px;
    border-radius: 6px; font-size: 12px; pointer-events: none; z-index: 100;
  }
  @media print { body { padding: 0; } .d3-container { box-shadow: none; break-inside: avoid; } }
</style>
</head>
<body>
  <div class="report-header"><h2>${escapeHtml(title)}</h2></div>
  ${summaryHtml}
  <div class="d3-container">
    <div id="d3-chart"></div>
  </div>
  <div class="report-footer">Generated by Kuvalam AI Agent · ${new Date().toISOString()}</div>
  <script>
  (function() {
    var data = ${dataJson};
    try {
      ${d3Script}
    } catch(e) {
      document.getElementById('d3-chart').innerHTML = '<p style="color:#ef4444">D3 Error: ' + e.message + '</p>';
    }
  })();
  <\/script>
</body>
</html>`
}

// ══════════════════════════════════════════════════════════════════════════════
// Mixed Report Builder — combines multiple formats into a single report
// ══════════════════════════════════════════════════════════════════════════════
export function buildMixedReportHtml(sections, title, summary) {
  const summaryHtml = summary ? `<div class="report-summary">${escapeHtml(summary)}</div>` : ''
  const sectionId = Date.now()

  // Pre-process sections to detect which need Chart.js or D3
  const hasChartSections = sections.some(s => s.format === 'chart')
  const hasD3Sections = sections.some(s => s.format === 'd3')

  const sectionsHtml = sections.map((s, i) => {
    const sid = `section-${sectionId}-${i}`
    const sectionTitle = s.title ? `<div class="section-title">${escapeHtml(s.title)}</div>` : ''

    switch (s.format) {
      case 'svg':
        return `<div class="mixed-section">
          ${sectionTitle}
          <div class="svg-wrap">${s.svg_content || s.content || ''}</div>
        </div>`

      case 'd3':
        return `<div class="mixed-section">
          ${sectionTitle}
          <div id="${sid}" class="d3-wrap"></div>
          <script class="d3-segment" data-id="${sid}" data-script="${escapeHtml(s.d3_script || s.script || '')}" data-data="${escapeHtml(JSON.stringify(s.d3_data || s.data || {}))}"><\/script>
        </div>`

      case 'chart':
        if (s.chart_config) {
          return `<div class="mixed-section">
            ${sectionTitle}
            <div class="chart-wrap"><canvas id="${sid}"></canvas></div>
            <script class="chart-segment" data-id="${sid}" data-config="${escapeHtml(JSON.stringify(s.chart_config))}"><\/script>
          </div>`
        }
        return `<div class="mixed-section">
          ${sectionTitle}
          ${s.html_content || s.content || ''}
        </div>`

      case 'html':
        return `<div class="mixed-section">
          ${sectionTitle}
          <div class="html-wrap">${s.html_content || s.content || ''}</div>
        </div>`

      case 'text':
      default:
        return `<div class="mixed-section">
          ${sectionTitle}
          <div class="text-wrap" style="white-space:pre-wrap;line-height:1.7;font-size:14px">${escapeHtml(s.content || s.text || '')}</div>
        </div>`
    }
  }).join('')

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
${hasChartSections ? '<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0"><\/script>' : ''}
${hasD3Sections ? '<script src="https://d3js.org/d3.v7.min.js"><\/script>' : ''}
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    background: #ffffff; color: #1e293b; line-height: 1.6;
    padding: 32px 24px; max-width: 1100px; margin: 0 auto;
  }
  .report-header { margin-bottom: 28px; }
  .report-header h2 { font-size: 24px; font-weight: 800; color: #0f172a; margin-bottom: 4px; }
  .report-summary {
    background: #f0f9ff; border-left: 4px solid #3b82f6; border-radius: 8px;
    padding: 14px 18px; margin-bottom: 28px; font-size: 14px; color: #1e40af;
  }
  .mixed-section {
    background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px;
    padding: 20px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.04);
  }
  .section-title { font-size: 16px; font-weight: 700; color: #334155; margin-bottom: 14px; padding-bottom: 8px; border-bottom: 2px solid #e2e8f0; }
  .svg-wrap svg { max-width: 100%; height: auto; display: block; margin: 0 auto; }
  .d3-wrap svg { display: block; margin: 0 auto; }
  .d3-wrap { min-height: 200px; }
  .chart-wrap { position: relative; max-height: 350px; }
  .chart-wrap canvas { max-height: 350px; }
  .html-wrap { overflow-x: auto; }
  .text-wrap { color: #475569; }
  .report-footer {
    border-top: 1px solid #e2e8f0; padding-top: 16px; margin-top: 8px;
    font-size: 12px; color: #94a3b8; text-align: center;
  }
  @media print {
    body { padding: 0; }
    .mixed-section { box-shadow: none; break-inside: avoid; }
  }
</style>
</head>
<body>
  <div class="report-header"><h2>${escapeHtml(title)}</h2></div>
  ${summaryHtml}
  ${sectionsHtml}
  <div class="report-footer">Generated by Kuvalam AI Agent · ${new Date().toISOString()}</div>
  <script>
  (function() {
    // Mount Chart.js segments
    document.querySelectorAll('.chart-segment').forEach(function(el) {
      var canvas = document.getElementById(el.dataset.id);
      var config = JSON.parse(el.dataset.config);
      if (canvas && config && typeof Chart !== 'undefined') {
        try { new Chart(canvas, config); } catch(e) { console.warn('Chart ' + el.dataset.id + ' failed:', e.message); }
      }
    });
    // Mount D3 segments
    document.querySelectorAll('.d3-segment').forEach(function(el) {
      var container = document.getElementById(el.dataset.id);
      var script = el.dataset.script;
      var data = JSON.parse(el.dataset.data);
      if (container && script && typeof d3 !== 'undefined') {
        try {
          var fn = new Function('container', 'data', 'd3', script);
          fn(container, data, d3);
        } catch(e) { container.innerHTML = '<p style="color:#ef4444">D3 Error: ' + e.message + '</p>'; }
      }
    });
  })();
  <\/script>
</body>
</html>`
}

export function formatKpiValue(val) {
  if (typeof val !== 'number') return String(val)
  if (Math.abs(val) >= 1e6) return (val / 1e6).toFixed(1) + 'M'
  if (Math.abs(val) >= 1e3) return (val / 1e3).toFixed(1) + 'K'
  return Number.isInteger(val) ? val.toLocaleString() : val.toFixed(2)
}

export function getKpiIcon(label) {
  const l = (label || '').toLowerCase()
  if (/total|sum|revenue|amount/i.test(l)) return '💰'
  if (/avg|average|mean/i.test(l)) return '📊'
  if (/max|highest|peak/i.test(l)) return '🔺'
  if (/min|lowest|minimum/i.test(l)) return '🔻'
  if (/count|number|records/i.test(l)) return '📋'
  if (/rate|percent|%/i.test(l)) return '📈'
  if (/user|customer|client/i.test(l)) return '👥'
  if (/time|duration|speed/i.test(l)) return '⏱'
  return '📌'
}

export function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ─── Report synthesizers ─────────────────────────────────────────────────────

/**
 * Extract HTML content from the agent's final synthesis text.
 * Tries multiple strategies:
 * 1. Already raw HTML content.
 * 2. HTML content inside a ```html (or ```) code fence.
 * 3. Fall back to light markdown → HTML conversion.
 */
export function synthesiseReportHtml(content) {
  if (!content) return ''

  const trimmed = content.trim()

  // 0. Content is already raw HTML/SVG (no markdown fences)
  if (trimmed.startsWith('<')) return sanitiseReportHtml(trimmed)

  // 1a. SVG code block — extract raw SVG (check BEFORE generic HTML block
  //     because ```svg fences contain <svg> which starts with '<')
  const svgFenceMatch = content.match(/```(?:svg|xml)\s*\n?(<svg[\s\S]*?<\/svg>)\s*```/)
  if (svgFenceMatch) {
    return `<div style="display:flex;justify-content:center;align-items:center;min-height:400px;background:#f8fafc;border-radius:8px;padding:24px;overflow-x:auto">${svgFenceMatch[1]}</div>`
  }

  // 1b. Raw SVG embedded in text (not fenced, just floating in markdown)
  const svgRawMatch = content.match(/<svg[\s\S]*?<\/svg>/)
  if (svgRawMatch) {
    return `<div style="display:flex;justify-content:center;align-items:center;min-height:400px;background:#f8fafc;border-radius:8px;padding:24px;overflow-x:auto">${svgRawMatch[0]}</div>`
  }

  // 2. Explicit HTML code block (with or without "html" language tag)
  const htmlBlockMatch = content.match(/```(?:html)?\s*([\s\S]*?)\s*```/)
  if (htmlBlockMatch) {
    const candidate = htmlBlockMatch[1].trim()
    if (candidate.startsWith('<')) return sanitiseReportHtml(candidate)
  }

  // 3. Tool-call JSON pasted by the agent — try to grab the html_content parameter
  const toolCallMatch = content.match(/"publish_dashboard_report"[\s\S]*?"parameters"\s*:\s*(\{[\s\S]*?"html_content"\s*:\s*"[\s\S]*?\}\s*\})/)
  if (toolCallMatch) {
    try {
      const params = JSON.parse(toolCallMatch[1])
      if (params.html_content) return sanitiseReportHtml(params.html_content)
    } catch { /* ignore malformed JSON */ }
  }

  // 4. Markdown → HTML fallback
  return markdownToReportHtml(content)
}

/**
 * Fix common HTML mistakes made by local LLMs that break iframe rendering,
 * especially malformed script src attributes with surrounding quotes.
 */
export function sanitiseReportHtml(html) {
  let sanitised = html
    // Remove surrounding quotes around a URL: src=""https://..."" -> src="https://..."
    .replace(/src=["']{2,}(https?:\/\/[^"'\s]+)["']{2,}/gi, 'src="$1"')
    // Normalize whitespace inside src
    .replace(/src=["']\s*(https?:\/\/[^"'\s]+)\s*["']/gi, 'src="$1"')

  // ── Strip broken <script> blocks that cause srcdoc iframe parse errors ────
  // LLMs sometimes generate <script> tags with HTML-like content (e.g. <canvas...>)
  // instead of JavaScript. These cause "Unexpected token '<'" in srcdoc iframes.
  // We only keep <script> blocks that contain valid JS patterns (function, var, const, let,
  // document., new, Chart, etc.) and strip everything else.
  sanitised = sanitised.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, (fullMatch, inner) => {
    const trimmed = inner.trim()
    // Keep: CDN includes (empty or just whitespace between src tag and close)
    if (!trimmed || /^[\s\r\n]*$/.test(trimmed)) return fullMatch
    // Keep: valid JS starters
    if (/^(var |const |let |function |document\.|window\.|new |if \(|for \(|while \(|try \{|return |\/\/|console\.|\/\*|Chart\(|new Chart)/.test(trimmed)) {
      return fullMatch
    }
    // Strip: anything starting with < (HTML in script block), or nonsense
    return ''
  })

  // Escape any remaining unescaped </script> in inline scripts (LLMs rarely do this,
  // but it's a footgun that breaks the containing iframe).
  sanitised = sanitised.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (full, attrs, body) => {
    return `<script${attrs}>${body.replace(/<\/script>/gi, '<\\/script>')}<\/script>`
  })

  return sanitised
}

/**
 * Very light markdown-to-HTML for agent synthesis text. Keeps the report readable
 * when the agent did not supply rendered HTML.
 */
export function markdownToReportHtml(md) {
  // Strip code blocks and pasted tool-call JSON so they don't appear as raw text
  let text = md
    .replace(/```json[\s\S]*?```/g, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\{\s*"name"\s*:\s*"publish_dashboard_report"[\s\S]*?\}\s*\}/g, '')
    .trim()

  if (!text) return ''

  // Headings
  text = text
    .replace(/^###\s+(.*)$/gim, '<h3 style="font-size:16px;font-weight:700;margin:16px 0 8px;color:#0f172a">$1</h3>')
    .replace(/^##\s+(.*)$/gim, '<h2 style="font-size:18px;font-weight:700;margin:20px 0 10px;color:#0f172a">$1</h2>')
    .replace(/^#\s+(.*)$/gim, '<h1 style="font-size:22px;font-weight:700;margin:24px 0 12px;color:#0f172a">$1</h1>')

  // Bold / italic
  text = text
    .replace(/\*\*\*(.*?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')

  // Lines that look like list items
  const lines = text.split('\n')
  let inList = false
  let listType = null
  let html = ''

  const flushList = () => {
    if (!inList) return
    html += listType === 'ol' ? '</ol>' : '</ul>'
    inList = false
    listType = null
  }

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) {
      flushList()
      html += '<br>'
      continue
    }

    const ulMatch = line.match(/^[-*]\s+(.*)$/)
    const olMatch = line.match(/^\d+\.\s+(.*)$/)

    if (ulMatch || olMatch) {
      const item = (ulMatch || olMatch)[1]
      const type = ulMatch ? 'ul' : 'ol'
      if (!inList || listType !== type) {
        flushList()
        html += type === 'ol'
          ? '<ol style="margin:8px 0 12px 20px;padding:0;line-height:1.6">'
          : '<ul style="margin:8px 0 12px 20px;padding:0;line-height:1.6">'
        inList = true
        listType = type
      }
      html += `<li style="margin:4px 0">${item}</li>`
      continue
    }

    flushList()
    html += `<p style="margin:0 0 12px;line-height:1.6">${line}</p>`
  }
  flushList()

  return html
}

/**
 * Synthesize the agent's ACTUAL runtime context — what resources are truly
 * available right now. This section OVERRIDES the generic archetype template
 * because the archetype doesn't know which KBs are attached, whether a DB
 * exists, what the data_strategy is, or which output tools are scoped.
 *
 * The output is a prescriptive `## YOUR ACTUAL CONTEXT` block that tells
 * the LLM exactly what workflow to follow given the real resources.
 */
function buildRuntimeContext(agent, skills, goal) {
  const parts = []

  // ── 1. Knowledge Sources ──────────────────────────────────────────────
  const kbCount = Array.isArray(agent.knowledge_base_ids) ? agent.knowledge_base_ids.length : 0
  const graphCount = Array.isArray(agent.knowledge_graph_ids) ? agent.knowledge_graph_ids.length : 0
  const hasKb = kbCount > 0 || !!agent._hasKnowledgeContext
  const hasGraph = graphCount > 0
  const fileCount = Array.isArray(agent._files) ? agent._files.length : 0
  const hasFiles = fileCount > 0

  if (hasKb || hasGraph || hasFiles) {
    const sources = []
    if (hasKb) sources.push(`- **${kbCount || '?'} Knowledge Base(s)** attached — SEARCH these FIRST for domain context, requirements, schemas, and reference data`)
    if (hasGraph) sources.push(`- **${graphCount} Knowledge Graph(s)** attached — query entities and relationships for structured domain knowledge`)
    if (hasFiles) sources.push(`- **${fileCount} uploaded file(s)** — review these for task-specific data and requirements`)
    parts.push(`### 📚 Knowledge Sources\n${sources.join('\n')}`)
  } else {
    parts.push(`### 📚 Knowledge Sources\n- **No knowledge bases, graphs, or files attached.** Work from the task goal and your training data. If you need domain context, ask the user to attach a KB.`)
  }

  // ── 2. Database + Strategy ────────────────────────────────────────────
  const hasDb = !!agent._dbConnectionString
  const strategy = agent._dataStrategy || 'none'
  // Only show DB context when strategy isn't explicitly 'none'
  const showDb = hasDb && strategy !== 'none'
  const dbType = agent._dbType || 'postgresql'

  if (showDb) {
    const strategyLabel = { source: 'Source (READ-ONLY)', target: 'Target (WRITE-ONLY)', both: 'Source & Target (READ + WRITE)' }[strategy] || strategy
    const dbLines = [`- **${dbType.toUpperCase()}** database connected`]
    if (agent._activeDbName) dbLines.push(`- Active database: \`${agent._activeDbName}\``)

    // Agent actually has DB CLI tools — compute here since skillNames not yet available
    const _hasDbTools = skills.map(s => (s.name || '').toLowerCase()).some(n => /\b(runQuery|listTables|describeTable|listDatabases|useDatabase)\b/i.test(n))

    if (_hasDbTools) {
      switch (strategy) {
        case 'source':
          dbLines.push(`- **Strategy: ${strategyLabel}**`)
          dbLines.push(`- Use \`listTables\` → \`describeTable\` → \`runQuery\` (SELECT only) to explore and profile data`)
          dbLines.push(`- NEVER execute CREATE, INSERT, UPDATE, DELETE, DROP, ALTER, or TRUNCATE`)
          dbLines.push(`- Produce reports and deliverables from what you READ — use your file/output tools to save results`)
          break
        case 'target':
          dbLines.push(`- **Strategy: ${strategyLabel}**`)
          dbLines.push(`- Read requirements from KBs and files — NOT from existing tables`)
          dbLines.push(`- Use \`runQuery\` for CREATE TABLE, INSERT, UPDATE DML`)
          dbLines.push(`- Use \`listTables\` to check what exists, \`describeTable\` to verify structure`)
          dbLines.push(`- Verify every DDL/DML statement succeeds before the next one`)
          break
        case 'both':
          dbLines.push(`- **Strategy: ${strategyLabel}**`)
          dbLines.push(`- Profile existing data with SELECT (always add LIMIT)`)
          dbLines.push(`- Transform and write results with CREATE TABLE / INSERT`)
          dbLines.push(`- Verify writes succeed before reporting completion`)
          break
        default:
          dbLines.push(`- **Strategy: ${strategyLabel}** — treat as read-only by default`)
      }
    } else {
      // DB connection exists but agent has no DB tools — mention it as context only
      dbLines.push(`- **Strategy: ${strategyLabel}** — database is available as context but you do not have \`runQuery\`/\`listTables\` tools`)
      dbLines.push(`- If you need to query this database, add \`runQuery\` to the agent's tool scopes`)
    }
    parts.push(`### 🗄️ Database\n${dbLines.join('\n')}`)
  }

  // ── 3. Delivery Channel ──────────────────────────────────────────
  // TOOL-AWARE: show ALL scoped tools the agent actually has — no goal filtering.
  // Future tools (email, Jira, IoT, ML, CRM, etc.) automatically appear by
  // matching their name against the category patterns below.
  const skillNames = skills.map(s => (s.name || '').toLowerCase())
  const hasWriteArtifact = skillNames.some(n => /\bwrite.?artifact\b/i.test(n))
  const hasLocalDir = skillNames.some(n => /\blocal.?dir\b|\bfile.?write\b|\bwrite.?file\b/i.test(n))
  const hasBrowser = skillNames.some(n => /\bbrowser.?use\b|\bbrowser\b|\bpuppeteer\b|\bplaywright\b/i.test(n))
  const hasHttp = skillNames.some(n => /\bhttp.?request\b|\brest.?api\b|\bfetch\b/i.test(n))
  const hasPublishReportSkill = skillNames.some(n => /\bpublish.?dashboard.?report\b/i.test(n))
  const hasDbTools = skillNames.some(n => /\b(runQuery|listTables|describeTable|listDatabases|useDatabase)\b/i.test(n))

  // Generic tool → delivery category matching. Add new categories here as the
  // platform grows — no other code changes needed for new tool types to appear
  // in the delivery channel.
  //
  // direction: 'output' → shown in 📤 Delivery Channel (where results GO).
  // direction: 'input'  → tracked for WORKFLOW ACQUIRE, but hidden from
  //                        Delivery Channel (these are data sources, not outputs).
  const TOOL_DELIVERY_CATEGORIES = [
    { pattern: /\b(write.?artifact|local.?dir|file.?write|write.?file|save.?file|create.?file|export.?file)\b/i,       label: 'File Output',   desc: 'saves generated files (.sql, .svg, .md, .csv, .json) to artifact storage', direction: 'output' },
    // goalGate: only show Reports as a delivery channel when the goal
    // actually mentions a dashboard / chart / report. Agents often have
    // publish_dashboard_report scoped but the task is DDL/ERD/docs.
    { pattern: /\b(publish.?dashboard.?report|generate.?report|export.?report|create.?dashboard|build.?report)\b/i,    label: 'Reports',       desc: 'creates interactive dashboards, charts, and formatted reports', direction: 'output', goalGate: /\b(dashboard|chart|visualis|visualiz|graph|plot|interactive|BI\b|metric|KPI|report|analytics|analy(?:s[ei]s|ze)|summary|insight|breakdown|ranking|trend)\b/i },
    { pattern: /\b(browser.?use|browser|puppeteer|playwright|headless|selenium|web.?scrap|page.?snapshot)\b/i,         label: 'Browser',       desc: 'navigates pages, captures screenshots, extracts web data', direction: 'input' },
    { pattern: /\b(http.?request|rest.?api|fetch|webhook|curl|openapi|api.?call|soap|graphql)\b/i,                     label: 'HTTP/API',      desc: 'calls external APIs and webhooks for enrichment or integration', direction: 'input' },
    { pattern: /\b(send.?email|gmail|smtp|mail|email|outlook|mailchimp|sendgrid|postmark|mailgun)\b/i,                 label: 'Email',         desc: 'delivers results and notifications via email (Gmail, SMTP)', direction: 'output' },
    { pattern: /\b(slack|teams|discord|telegram|whatsapp|notify|send.?message|post.?message|webhook.?notify)\b/i,      label: 'Messaging',     desc: 'sends notifications to Slack, Teams, Discord, etc.', direction: 'output' },
    { pattern: /\b(jira|confluence|trello|asana|linear|monday|notion|clickup|ticket|issue.?track|backlog)\b/i,         label: 'Project Tools', desc: 'updates Jira tickets, Confluence pages, and project trackers', direction: 'output' },
    { pattern: /\b(iot|mqtt|device.?control|actuator|sensor|arduino|raspberry|embedded|plc|scada|modbus|zigbee|zwave)\b/i, label: 'IoT/MQTT', desc: 'publishes commands and data to IoT devices and control systems', direction: 'output' },
    { pattern: /\b(ml.?train|ml.?predict|model.?infer|model.?train|train.?model|deploy.?model|fine.?tune|embed|vectorize|classify|ner|sentiment|summarize|translate|transcribe|ocr)\b/i, label: 'ML/AI', desc: 'runs ML models for training, inference, classification, or analysis', direction: 'output' },
    { pattern: /\b(salesforce|hubspot|zoho|pipedrive|crm|customer|lead|contact.?sync|deal|opportunity)\b/i,            label: 'CRM',           desc: 'syncs data with CRM platforms (Salesforce, HubSpot, etc.)', direction: 'output' },
    { pattern: /\b(s3|google.?drive|dropbox|sharepoint|one.?drive|blob.?storage|cloud.?storage|upload|bucket)\b/i,     label: 'Cloud Storage', desc: 'uploads files to S3, Google Drive, Dropbox, SharePoint', direction: 'output' },
    { pattern: /\b(github|gitlab|bitbucket|git|pull.?request|commit|merge|deploy|ci.?cd|jenkins|terraform|pulumi)\b/i, label: 'DevOps/Infra', desc: 'creates PRs, triggers deployments, manages infrastructure', direction: 'output' },
    { pattern: /\b(gsheet|google.?sheet|airtable|smartsheet|spreadsheet|excel|tabular)\b/i,                            label: 'Spreadsheets',  desc: 'reads and writes Google Sheets, Airtable, Excel files', direction: 'output' },
    { pattern: /\b(calendar|schedule|meeting|zoom|teams.?meet|google.?meet|appointment|event)\b/i,                     label: 'Calendar',      desc: 'schedules meetings, creates calendar events and appointments', direction: 'output' },
    { pattern: /\b(searchKnowledge|knowledge.?base.?search|rag.?search|vector.?search|semantic.?search)\b/i,           label: 'Knowledge Search', desc: 'searches knowledge bases (docs, PDFs, policies, Excel) for domain context', direction: 'input' },
    { pattern: /\b(searchGraph|graph.?search|graph.?query|neo4j|knowledge.?graph)\b/i,                                 label: 'Graph Search',  desc: 'queries knowledge graphs for entity relationships and structured facts', direction: 'input' },
  ]

  const goalLower = (goal || '').toLowerCase()

  // Goal-aware gating: categories with goalGate should only appear in the
  // delivery channel when the task goal matches. Reports is the prime example —
  // many agents have publish_dashboard_report scoped but the task is DDL/ERD/docs.
  function categoryVisible(cat) {
    if (!cat.goalGate) return true
    return cat.goalGate.test(goalLower)
  }

  // Build delivery channel: iterate ALL scoped skills, match against categories.
  // Deduplicate — one entry per category, even if multiple tools match.
  const deliverySeen = new Set()
  deliverySeen.add('Text response') // always present
  const deliveryMethods = [
    '→ **Text response** — your final answer is shown to the user',
  ]

  for (const skillName of skillNames) {
    for (const cat of TOOL_DELIVERY_CATEGORIES) {
      if (deliverySeen.has(cat.label)) continue
      if (cat.pattern.test(skillName)) {
        // Always track in deliverySeen — the WORKFLOW section uses it to
        // decide ACQUIRE / DELIVER phases regardless of direction.
        deliverySeen.add(cat.label)
        // Only output channels appear in the Delivery Channel section.
        // Input channels (Browser, HTTP/API, Knowledge Search, Graph Search)
        // are data sources — they belong in WORKFLOW's ACQUIRE step.
        // Goal-gated categories (Reports) are suppressed when the goal
        // doesn't match — e.g. DDL tasks shouldn't suggest dashboards.
        if (cat.direction !== 'input' && categoryVisible(cat)) {
          deliveryMethods.push(`→ **${cat.label}** — ${cat.desc}`)
        }
        break // one category per tool, take first match
      }
    }
  }

  // Warn when the agent lacks output tools. Two tiers:
  //   1. Goal mentions output keywords (generate, create, export…) AND no output tools → suggest write_artifact/report
  //   2. Agent has ZERO output tools at all → always warn (future-proof — catches under-scoped agents early)
  const goalNeedsOutput = /\b(generate|create|build|write|export|output|save|produce|publish|deliver|send|push|upload|deploy|report|diagram|chart|dashboard|html|svg|pdf|png|file|document)\b/i.test(goalLower)
  const _OUTPUT_LABELS = new Set(['File Output', 'Reports', 'Email', 'Messaging', 'Cloud Storage', 'Spreadsheets', 'Project Tools', 'DevOps/Infra', 'IoT/MQTT', 'CRM', 'ML/AI', 'Calendar'])
  const hasAnyOutputTool = [..._OUTPUT_LABELS].some(l => deliverySeen.has(l))
  if (goalNeedsOutput && !hasAnyOutputTool) {
    deliveryMethods.push('→ ⚠️ **No file/report tools configured.** To save outputs, add `write_artifact` or a report tool in agent settings.')
  } else if (!hasAnyOutputTool) {
    // No output tools at all — warn regardless of goal to catch under-scoped agents
    deliveryMethods.push('→ ⚠️ **No output tools configured** — results can only be returned as text. Add `write_artifact` (files), `publish_dashboard_report` (charts), `send_email`, or other output tools in agent settings.')
  }

  parts.push(`### 📤 Delivery Channel\n${deliveryMethods.join('\n')}`)

  // ── 4. SYNTHESIS: Concrete workflow based on actual resources ──────────
  // TOOL-AWARE: the WORKFLOW adapts to the tools the agent actually has.
  // Three phases: ACQUIRE (get the data) → PROCESS (transform/analyze) → DELIVER (output).
  // Each phase only appears if the agent has the relevant tools.
  const workflowSteps = []
  let stepNum = 0

  // ── PHASE 1: ACQUIRE — how the agent gets its data ──
  const acquireMethods = []
  if (hasKb || hasGraph || hasFiles) {
    const resourceNames = []
    if (hasKb) resourceNames.push('knowledge bases')
    if (hasGraph) resourceNames.push('knowledge graphs')
    if (hasFiles) resourceNames.push('uploaded files')
    acquireMethods.push(`search ${resourceNames.join(' and ')}`)
  }
  if (deliverySeen.has('Browser')) {
    acquireMethods.push('use the **browser** to navigate pages, scrape content, and capture data')
  }
  if (deliverySeen.has('HTTP/API')) {
    acquireMethods.push('use **HTTP/REST** calls to fetch data from external APIs and services')
  }
  if (acquireMethods.length > 0) {
    stepNum++
    const joined = acquireMethods.join('; ')
    workflowSteps.push(`**STEP ${stepNum} — ACQUIRE:** ${joined.charAt(0).toUpperCase() + joined.slice(1)}.`)
  }

  // ── PHASE 2: PROCESS — transform, analyze, build (DB-heavy) ──
  if (hasDb && hasDbTools) {
    stepNum++
    const fromKB = acquireMethods.length > 0 ? ' based on acquired context' : ''
    switch (strategy) {
      case 'source':
        workflowSteps.push(`**STEP ${stepNum} — PROFILE:** Use listTables → describeTable → runQuery (SELECT) to explore the database${fromKB}.`)
        break
      case 'target':
        workflowSteps.push(`**STEP ${stepNum} — BUILD:** Use runQuery (CREATE/INSERT) to build or populate the schema${fromKB}.`)
        break
      case 'both':
        workflowSteps.push(`**STEP ${stepNum} — PROFILE & TRANSFORM:** Profile data with SELECT, then transform and write results with CREATE/INSERT${fromKB}.`)
        break
      default:
        workflowSteps.push(`**STEP ${stepNum} — QUERY:** Use runQuery to interact with the database${fromKB}.`)
    }
  }

  // Goal-aware: suppress Reports from DELIVER when the goal doesn't call for a dashboard/chart/report.
  // Many agents have publish_dashboard_report scoped but the task is purely DDL/ERD/documentation.
  const hasDashboardGoal = /\b(dashboard|chart|visualis|visualiz|graph|plot|interactive|BI\b|metric|KPI|report|analytics|analy(?:s[ei]s|ze)|summary|insight|breakdown|ranking|trend)\b/i.test(goalLower)

  // ── PHASE 3: DELIVER — how the agent sends results out ──
  // Match the delivery channel categories to produce the right instruction.
  // Priority: email/messaging > reports > cloud storage > file output > text.
  const deliverMethods = []
  if (deliverySeen.has('Email'))        deliverMethods.push('send results via **email**')
  if (deliverySeen.has('Messaging'))    deliverMethods.push('post a notification to **Slack/Teams/Discord**')
  if (deliverySeen.has('Project Tools')) deliverMethods.push('update the relevant **Jira ticket / Confluence page**')
  if (deliverySeen.has('IoT/MQTT'))     deliverMethods.push('publish commands to the **IoT device/MQTT broker**')
  if (deliverySeen.has('Reports') && hasDashboardGoal) deliverMethods.push('create a **dashboard or report**')
  if (deliverySeen.has('Cloud Storage')) deliverMethods.push('upload files to **S3 / Google Drive / SharePoint**')
  if (deliverySeen.has('Spreadsheets'))  deliverMethods.push('write results to **Google Sheets / Airtable / Excel**')
  if (deliverySeen.has('File Output'))   deliverMethods.push('save all outputs as **files** (write_artifact or local directory)')
  if (deliverySeen.has('DevOps/Infra'))  deliverMethods.push('create a **PR / deploy / trigger CI-CD**')
  if (deliverySeen.has('Calendar'))      deliverMethods.push('schedule a **meeting or calendar event**')

  if (deliverMethods.length > 0) {
    stepNum++
    const joined = deliverMethods.join('; ')
    workflowSteps.push(`**STEP ${stepNum} — DELIVER:** ${joined.charAt(0).toUpperCase() + joined.slice(1)}. Do NOT just describe results — take the action.`)
  } else if (deliverMethods.length === 0 && stepNum > 0) {
    // Agent acquired/processed but has no output tools — tell them to respond as text
    stepNum++
    workflowSteps.push(`**STEP ${stepNum} — RESPOND:** You have no file/output tools configured. Present your findings in a clear summary.`)
    workflowSteps.push('→ For file generation tasks: output the COMPLETE content directly in a fenced code block (HTML, SVG, CSV, JSON, Markdown). Do NOT truncate — produce the full file. The system will extract and save it.')
  }

  // ── Fallback: agent has literally nothing but its training data ──
  if (workflowSteps.length === 0) {
    workflowSteps.push('**Work from your training data and the task goal.** You have no external resources or output tools.')
    workflowSteps.push('→ For informational questions: provide a clear, thorough answer based on your training data.')
    workflowSteps.push('→ For file generation tasks (HTML, SVG, code, CSV, JSON, Markdown): output the COMPLETE content directly in a fenced code block — do NOT truncate or summarise. The system will extract and save it to the artifacts folder.')
  }

  if (workflowSteps.length > 0) {
    parts.push(`### 🛠️ YOUR WORKFLOW (follow this — it reflects your ACTUAL available resources)\n${workflowSteps.join('\n')}`)
  }

  return parts.length > 0
    ? `\n\n## YOUR ACTUAL CONTEXT\n${parts.join('\n\n')}`
    : ''
}

/**
 * Build the system prompt sent to the LLM at the start of each task.
 * Combines agent configuration, available skills, and database context.
 *
 * The stored `system_prompt` holds ONLY the user-authored guardrails. The
 * rich archetype template (role, how-to-work, core rules) is generated FRESH
 * each run from the agent's current archetype/name/description, so template
 * improvements reach existing agents and are never frozen into the row.
 */
export async function buildSystemPrompt(agent, skills, goal = '', builtinToolNames = []) {
  // ── Merge builtin tool scopes with skills so tool detection works ──
  // Skills come from agent_skills (custom skills); builtinToolNames come
  // from agent_tool_scopes (write_artifact, browser_use, etc.). The prompt
  // generation and tool stripping use the combined set to decide what tools
  // the agent actually has.
  const allSkills = [...skills]
  const existingNames = new Set(skills.map(s => (s.name || '').toLowerCase()))
  for (const name of builtinToolNames) {
    if (!existingNames.has(name.toLowerCase())) {
      allSkills.push({ name, description: `Built-in tool: ${name}` })
    }
  }

  // ── Inject runtime tools that are added by the task executor (task.service.js)
  // based on agent configuration, NOT via scopes. These MUST be present in the
  // tool list and the strip guards below, otherwise the agent is told to use a
  // tool that doesn't appear in "YOUR AVAILABLE TOOLS" — confusing the LLM.
  const hasKbAttached = (Array.isArray(agent.knowledge_base_ids) && agent.knowledge_base_ids.length > 0) || !!agent._hasKnowledgeContext
  const hasGraphAttached = Array.isArray(agent.knowledge_graph_ids) && agent.knowledge_graph_ids.length > 0
  if (hasKbAttached && !existingNames.has('searchknowledge')) {
    allSkills.push({ name: 'searchKnowledge', description: 'Search knowledge bases (documents, runbooks, policies) via semantic vector search' })
  }
  if (hasGraphAttached && !existingNames.has('searchgraph')) {
    allSkills.push({ name: 'searchGraph', description: 'Query knowledge graph for entity relationships and structured domain facts' })
  }

  // ── Inject DB tools when agent has a scoped database connector ──────────
  // The task executor (task.service.js) auto-injects runQuery/listTables/
  // describeTable at runtime when a DB connector is scoped to the agent.
  // Without this injection, buildRuntimeContext reports "you do NOT have
  // DB tools" and the available-tool list omits them — contradicting what
  // the runtime actually provides. Mirror the searchKnowledge/searchGraph
  // pattern: detect the resource and inject the corresponding tool names.
  const hasDbConnection = !!agent._dbConnectionString
  const dbStrategyActive = (agent._dataStrategy || 'none') !== 'none'
  if (hasDbConnection && dbStrategyActive) {
    if (!existingNames.has('listtables')) {
      allSkills.push({ name: 'listTables', description: 'List all tables in the connected database' })
    }
    if (!existingNames.has('describetable')) {
      allSkills.push({ name: 'describeTable', description: 'Describe columns, types, and foreign keys for a table' })
    }
    if (!existingNames.has('runquery')) {
      allSkills.push({ name: 'runQuery', description: 'Run a SELECT SQL query against the connected database' })
    }
    if (!!agent._dbConnectionMap) {
      if (!existingNames.has('listdatabases')) {
        allSkills.push({ name: 'listDatabases', description: 'List all available databases in a multi-database setup' })
      }
      if (!existingNames.has('usedatabase')) {
        allSkills.push({ name: 'useDatabase', description: 'Switch the active database connection' })
      }
    }
  }

  // ── User guardrails: strip any embedded archetype blob frozen at creation ──
  const userGuardrails = extractUserGuardrails(agent.system_prompt)

  // ── Archetype template: generated fresh at runtime (not stored) ──
  let archetypePrompt = ''
  try {
    const { generateAgentSystemPrompt } = await import('./agent.service.js')
    archetypePrompt = await generateAgentSystemPrompt(agent.name, agent.description || '', agent.archetype, agent.tenant_id, agent._dataStrategy || 'none') || ''
  } catch {
    archetypePrompt = ''
  }

  // ── Fallback: agents without an archetype (null or unrecognised) get a
  // minimal but complete role prompt. Without this, null-archetype agents
  // receive bare-bones prompts with no role, capabilities, or rules — the
  // LLM has no persona and drifts unpredictably.
  if (!archetypePrompt) {
    const _agentName = agent.name || 'AI Agent'
    const _agentDesc = agent.description || 'general-purpose assistant'
    const hasOutputTools = allSkills.some(s => /\b(write.?artifact|publish.?dashboard|send.?email|slack|teams|webhook.?notify|s3|google.?drive|gsheet|airtable|jira|confluence|github|gitlab|deploy)\b/i.test(s.name))
    archetypePrompt = `## YOUR ROLE\nYou are **${_agentName}**, a ${_agentDesc}.\n\n## HOW TO WORK\n- Use ONLY the tools listed in YOUR AVAILABLE TOOLS above — never invent tool names\n- Follow the workflow in YOUR ACTUAL CONTEXT exactly\n- Provide clear, thorough, well-structured results\n${hasOutputTools ? '- Use your output tools to save or deliver final results — do NOT just describe what you would do' : '- You have no output tools — deliver results directly in your response (fenced code blocks for files, tables for data)'}\n\n## CORE RULES\n- Only call tools that appear in YOUR AVAILABLE TOOLS\n- If you cannot complete the task with available tools, explain what is missing — do not fabricate results\n- Follow the delivery channel instructions in YOUR ACTUAL CONTEXT`
  }

  // ── Config-driven: DB connection presence alone determines whether DB
  // context is injected. No goal-regex guessing — the agent's system_prompt
  // and tool scopes define what it should do; guardrails catch violations.
  const hasDb = !!agent._dbConnectionString
  const showDb = hasDb && (agent._dataStrategy || 'none') !== 'none'

  // ── Strip DB-specific tool references from the archetype when the agent
  // has NO database connection. Prevents the LLM from hallucinating
  // runQuery / listTables / describeTable calls on agents without DB tools.
  if (!hasDb && archetypePrompt) {
    archetypePrompt = archetypePrompt
      .split('\n')
      .filter(line => !/\b(listTables|describeTable|runQuery|listDatabases|useDatabase)\b/i.test(line)
                       && !/^\d+\.\s+(If you have SQL database tools:|Call \`)/i.test(line)
                       && !/\bIf a query fails\b/i.test(line)
                       && !/\bread the error, fix the SQL\b/i.test(line))
      .join('\n')
      .replace(/before touching the database\.?\s*/gi, '. ')
      .replace(/,\s*not in PostgreSQL\.?/gi, '.')
      .replace(/SQL tools for querying databases,\s*/gi, '')
      .replace(/You have direct access to databases via SQL tools,\s*/gi, '')
      .replace(/You specialise in querying databases and\s*/gi, 'You specialise in ')
      .replace(/querying databases and\s*/gi, '')
  }

  // ── Strip knowledge-graph references when no graph is attached ──
  // The hardcoded archetype templates may mention searchGraph / knowledge
  // graphs even when the agent has none. Strip them so the LLM doesn't
  // hallucinate graph queries on agents without graph access.
  const hasGraph = Array.isArray(agent.knowledge_graph_ids) && agent.knowledge_graph_ids.length > 0
  if (!hasGraph && archetypePrompt) {
    archetypePrompt = archetypePrompt
      // Inline mentions: "and knowledge graphs for entity relationships"
      .replace(/,\s*and knowledge graphs for entity relationships\.?/gi, '')
      .replace(/and knowledge graphs for entity relationships\.?/gi, '')
      // Inline searchGraph references
      .replace(/and \`searchGraph\`\s*\(for entity relationships\)\s*/gi, '')
      .replace(/\`searchGraph\`\s*\(for[^)]*\)\s*/gi, '')
      // Lines that only mention searchGraph
      .split('\n')
      .filter(line => !/\bsearchGraph\b/i.test(line))
      .join('\n')
      // Remove orphaned fragment: "knowledge bases for docs/specs," left after
      // DB stripping removed the preceding "You have direct access to..." text.
      // The runtime context already declares KBs — archetype doesn't need to repeat.
      .replace(/^\s*knowledge bases for docs\/specs,?\s*$/gim, '')
      // Cleanup double punctuation / whitespace
      .replace(/,\s*,/g, ',')
      .replace(/,\s*\./g, '.')
      .replace(/\n{3,}/g, '\n\n')
  }

  // ── Strip tool mentions the agent doesn't have scoped ──
  // Archetype templates talk about publish_dashboard_report, browser_use,
  // http_request, etc. as if the agent always has them. Strip references
  // to tools that aren't in the agent's actual skill set so the agent
  // focuses ONLY on tools it actually has.
  if (archetypePrompt) {
    const hasPublishReport = allSkills.some(s => /\bpublish.?dashboard.?report\b/i.test(s.name))
    const hasBrowser = allSkills.some(s => /\bbrowser.?use\b|\bplaywright\b|\bpuppeteer\b/i.test(s.name))
    const hasHttp = allSkills.some(s => /\bhttp.?request\b|\brest.?api\b|\bfetch\b/i.test(s.name))
    const hasWriteArtifact = allSkills.some(s => /\bwrite.?artifact\b/i.test(s.name))
    const hasFileSearch = allSkills.some(s => /\bfile.?search\b/i.test(s.name))
    // hasKbAttached defined above (after allSkills merge) — reuse it
    const hasKbSearch = allSkills.some(s => /\bsearchKnowledge\b|\bknowledge.?base.?search\b|\brag.?search\b/i.test(s.name))

    // Strip searchKnowledge references ONLY if the agent has no KBs attached AND no KB search tool
    if (!hasKbSearch && !hasKbAttached) {
      archetypePrompt = archetypePrompt
        .split('\n')
        .filter(line => !/\bsearchKnowledge\b/i.test(line))
        .join('\n')
        .replace(/,?\s*`searchKnowledge`\s*\([^)]*\)/gi, '')
    }

    if (!hasPublishReport) {
      archetypePrompt = archetypePrompt
        .split('\n')
        .filter(line => !/\bpublish_dashboard_report\b/i.test(line))
        .join('\n')
    }
    // Goal-aware: when the task goal doesn't mention dashboards/charts/reports,
    // strip publish_dashboard_report references from OUTPUT RULES so the agent
    // isn't distracted by instructions about a tool irrelevant to this task.
    // The tool stays listed in YOUR AVAILABLE TOOLS (it IS scoped), but it
    // won't be presented as a delivery option or workflow step.
    const _goalLower = (goal || '').toLowerCase()
    const _hasDashboardGoal = /\b(dashboard|chart|visualis|visualiz|graph|plot|interactive|BI\b|metric|KPI|report|analytics|analy(?:s[ei]s|ze)|summary|insight|breakdown|ranking|trend)\b/i.test(_goalLower)
    if (hasPublishReport && !_hasDashboardGoal) {
      archetypePrompt = archetypePrompt
        .split('\n')
        .filter(line => !/\bpublish_dashboard_report\b/i.test(line))
        .join('\n')
    }
    if (!hasBrowser) {
      archetypePrompt = archetypePrompt
        .split('\n')
        .filter(line => !/\bbrowser_use\b/i.test(line))
        .join('\n')
        .replace(/,\s*\`browser_use\`\s*for[^,.]*/gi, '')
    }
    if (!hasHttp) {
      archetypePrompt = archetypePrompt
        .split('\n')
        .filter(line => !/\bhttp_request\b/i.test(line))
        .join('\n')
    }
    if (!hasWriteArtifact) {
      archetypePrompt = archetypePrompt
        .split('\n')
        .filter(line => !/\bwrite_artifact\b/i.test(line))
        .join('\n')
    }
    if (!hasFileSearch) {
      archetypePrompt = archetypePrompt
        .split('\n')
        .filter(line => !/\bfile_search\b/i.test(line))
        .join('\n')
    }

    // Collapse multiple blank lines from stripping
    archetypePrompt = archetypePrompt.replace(/\n{3,}/g, '\n\n')

    // Renumber ordered lists within each section after stripping.
    // Gaps like "7. 8. 10." become "1. 2. 3." — but scoped per ## section
    // so HOW TO WORK and OUTPUT RULES each start from 1 independently.
    archetypePrompt = archetypePrompt.split(/(?=^## )/m).map(section => {
      let counter = 0
      return section.replace(/^(\d+)\.\s/gm, () => `${++counter}. `)
    }).join('')

    // Clean up orphaned fragments left by stripping: ", not in PostgreSQL."
    // or "Your schema specs..." that was a continuation of removed text.
    archetypePrompt = archetypePrompt
      .replace(/,\s*not in PostgreSQL\.?/gi, '')
      .replace(/\)\s+Your schema specs/gi, '). Your schema specs')
      .replace(/^\s*Your schema specs, policies, and data dictionaries may live in the knowledge base\.?\s*$/gim, '- Your schema specifications, policies, and data dictionaries live in the knowledge base — search for them.')
      // Remove empty lines between bullet/list items
      .replace(/\n{3,}/g, '\n\n')
      // Remove empty ## sections (heading followed by nothing or only whitespace)
      .replace(/^##\s+[^\n]+\n{2,}/gm, '')
  }

  // ── Concrete task goal: inject it FIRST inside PRIMARY TASK so the agent's
  // specific objective — including its key metrics, quantities, and counts —
  // is always front and centre, not just the generic role/guardrails.
  // The runtime task loop passes task.goal here.
  const taskGoal = goal && String(goal).trim() ? String(goal).trim() : ''

  // ── Compose: user's custom guardrails FIRST, then archetype role.
  // Guardrails contain the SPECIFIC project scope and MUST take priority
  // over the generic archetype template. User-defined instructions always
  // override generic template guidance.
  const cleanGuardrails = userGuardrails
    .replace(/^##\s+AGENT[- ]SPECIFIC\s+INSTRUCTIONS\s*/im, '')
    .replace(/^##\s+Guardrails?\s*(?:\([^)]*\))?\s*/gim, '')
    .trim()
  let base

  // ── Tool awareness: inject the actual available skill names at the TOP ──
  // BEFORE guardrails, so the LLM knows what tools exist and won't attempt to
  // use external tools mentioned in old guardrail text (Lucidchart, Draw.io,
  // Apache NiFi, Talend, etc.). This is critical for preventing tool-hallucination.
  const availableToolNames = allSkills.length > 0
    ? allSkills.map(s => s.name).join(', ')
    : ''

  // ── Runtime context: synthesized from ACTUAL available resources ──
  // (KBs, graphs, DB connection, data_strategy, output tools, uploaded files).
  // This is PRESCRIPTIVE — it tells the LLM the concrete workflow based on
  // what it actually has, OVERRIDING the generic archetype template.
  const runtimeContext = buildRuntimeContext(agent, allSkills, goal)

  if (archetypePrompt && cleanGuardrails) {
    // Guardrails FIRST — they define the actual project, archetype is supplementary
    base = `## YOUR AVAILABLE TOOLS (ONLY these exist — do NOT attempt to use any other tools)\n${availableToolNames || 'None configured — add tool scopes in agent settings'}\n\n## PRIMARY TASK (follow this exactly)\n${taskGoal ? `TASK GOAL: ${taskGoal}\n\n` : ''}${cleanGuardrails}${runtimeContext}\n\n## AGENT ROLE & CAPABILITIES\n${archetypePrompt}`
  } else if (archetypePrompt) {
    // Goal is the PRIMARY driver — always put it front and centre, even without user guardrails
    base = `## YOUR AVAILABLE TOOLS (ONLY these exist — do NOT attempt to use any other tools)\n${availableToolNames || 'None configured — add tool scopes in agent settings'}\n\n## PRIMARY TASK (follow this exactly)\n${taskGoal ? `TASK GOAL: ${taskGoal}\n\n` : ''}${runtimeContext}\n\n## AGENT ROLE & CAPABILITIES\n${archetypePrompt}`
  } else {
    base = `## YOUR AVAILABLE TOOLS (ONLY these exist — do NOT attempt to use any other tools)\n${availableToolNames || 'None configured — add tool scopes in agent settings'}${runtimeContext}\n\n${cleanGuardrails || `You are ${agent.name}, an AI agent. ${agent.description || ''}`}${taskGoal ? `\n\n## CURRENT TASK\n${taskGoal}` : ''}`
  }

  // ── Database context: inject only when a DB connection exists ──
  // Tailored to the agent's data_strategy: source (read-only), target
  // (write-only), both (read+write), or none (no DB access).
  let dbContext = ''
  if (showDb) {
    const dbType    = agent._dbType || 'postgresql'
    const dbName    = agent._activeDbName || ''
    const isTrained = !!agent._isTrainedModel
    const multiDb   = !!agent._dbConnectionMap
    const strategy  = agent._dataStrategy || 'none'

    const modelNote = isTrained
      ? `- Model type: TRAINED — fine-tuned specifically for this database. High confidence in SQL.`
      : `- Model type: STANDARD general-purpose. Always verify column names with describeTable before writing SQL.`

    const schemaNote = agent._schemaPreloaded
      ? `- Schema is preloaded in context. Skip listTables/describeTable — go straight to runQuery.`
      : `- Call listTables then describeTable to discover tables, columns, and foreign keys before writing any query.`

    const multiNote = multiDb
      ? `- MULTI-DATABASE: call listDatabases to see all available databases, then useDatabase to switch.`
      : ''

    // Strategy-specific SQL guidance
    let strategyNote = ''
    switch (strategy) {
      case 'source':
        strategyNote = `- READ-ONLY: Use SELECT queries only. NEVER execute CREATE, INSERT, UPDATE, DELETE, DROP, ALTER, or TRUNCATE. Always add LIMIT to avoid runaway result sets.`
        break
      case 'target':
        strategyNote = `- WRITE-ONLY (Target): Use runQuery for CREATE TABLE, INSERT, UPDATE statements. Use SELECT only to verify your writes (with LIMIT). Read requirements from KB/files — not from existing tables unless checking structure with describeTable.`
        break
      case 'both':
        strategyNote = `- READ + WRITE: Profile existing data with SELECT (always add LIMIT), then transform and write results with CREATE TABLE / INSERT. Verify writes succeed before proceeding.`
        break
      default:
        strategyNote = `- Only SELECT queries are allowed. Always add LIMIT to avoid runaway result sets.`
    }

    dbContext = `

## DATABASE ACCESS
- Engine: ${dbType.toUpperCase()}${dbName ? ` (active database: ${dbName})` : ''}
${modelNote}
${multiNote ? multiNote + '\n' : ''}- ${schemaNote}
${strategyNote}
- NEVER guess column or table names — use describeTable to verify before writing SQL.`
  }

  return `${base}${dbContext}`
}
