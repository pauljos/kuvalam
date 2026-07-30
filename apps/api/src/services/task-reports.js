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

  // Start at 0.75 baseline and nudge by signal counts
  return Math.min(0.99, Math.max(0.1, 0.75 + highCount * 0.03 - lowCount * 0.08))
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
// SVG Report Builder — renders inline vector graphics for engineering/medical
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

  // 0. Content is already raw HTML (no markdown fences)
  if (trimmed.startsWith('<')) return sanitiseReportHtml(trimmed)

  // 1. Explicit HTML code block (with or without "html" language tag)
  const htmlBlockMatch = content.match(/```(?:html)?\s*([\s\S]*?)\s*```/)
  if (htmlBlockMatch) {
    const candidate = htmlBlockMatch[1].trim()
    if (candidate.startsWith('<')) return sanitiseReportHtml(candidate)
  }

  // 2. Tool-call JSON pasted by the agent — try to grab the html_content parameter
  const toolCallMatch = content.match(/"publish_dashboard_report"[\s\S]*?"parameters"\s*:\s*(\{[\s\S]*?"html_content"\s*:\s*"[\s\S]*?\}\s*\})/)
  if (toolCallMatch) {
    try {
      const params = JSON.parse(toolCallMatch[1])
      if (params.html_content) return sanitiseReportHtml(params.html_content)
    } catch { /* ignore malformed JSON */ }
  }

  // 3. Markdown → HTML fallback
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
 * Build the system prompt sent to the LLM at the start of each task.
 * Combines agent configuration, available skills, and database context.
 */
export function buildSystemPrompt(agent, skills, goal = '') {
  const base = agent.system_prompt || `You are ${agent.name}, an AI agent. ${agent.description || ''}`
  const skillList = skills.length > 0
    ? `\n\nYour available skills:\n${skills.map(s => `- ${s.name}: ${s.description}`).join('\n')}`
    : ''

  // ── Config-driven: DB connection presence alone determines whether DB
  // context is injected. No goal-regex guessing — the agent's system_prompt
  // and tool scopes define what it should do; guardrails catch violations.
  const hasDb = !!agent._dbConnectionString

  // ── Database context: inject only when a DB connection exists ──
  // Include the DB engine type and trained-vs-connector distinction so the
  // LLM uses the correct SQL dialect and has the right confidence level.
  let dbContext = ''
  if (hasDb) {
    const dbType    = agent._dbType || 'postgresql'
    const dbName    = agent._activeDbName || ''
    const isTrained = !!agent._isTrainedModel
    const multiDb   = !!agent._dbConnectionMap

    const modelNote = isTrained
      ? `- Model type: TRAINED — fine-tuned specifically for this database. High confidence in SQL.`
      : `- Model type: STANDARD general-purpose. Always verify column names with describeTable before writing SQL.`

    const schemaNote = agent._schemaPreloaded
      ? `- Schema is preloaded in context. Skip listTables/describeTable — go straight to runQuery.`
      : `- Call listTables then describeTable to discover tables, columns, and foreign keys before writing any query.`

    const multiNote = multiDb
      ? `- MULTI-DATABASE: call listDatabases to see all available databases, then useDatabase to switch.`
      : ''

    dbContext = `

## DATABASE ACCESS
- Engine: ${dbType.toUpperCase()}${dbName ? ` (active database: ${dbName})` : ''}
${modelNote}
${multiNote ? multiNote + '\n' : ''}- ${schemaNote}
- NEVER guess column or table names — use describeTable to verify before writing SQL.
- Only SELECT queries are allowed. Always add LIMIT to avoid runaway result sets.`
  }

  return `${base}${skillList}${dbContext}`
}
