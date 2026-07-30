'use client'
import { useEffect, useState, use } from 'react'
import Link from 'next/link'
import { API } from '@/lib/api'

/** Mirrors backend resolveDownloadFormats — client-side fallback for legacy reports */
function getAvailableFormats(
  reportType: string | undefined,
  htmlContent: string | undefined,
  storedFormats: string[] | undefined,
): string[] {
  if (storedFormats && storedFormats.length > 0) return storedFormats
  const formats = new Set<string>(['html'])
  const type = (reportType || '').toLowerCase()
  const html = htmlContent || ''
  if (type === 'svg' || html.includes('<svg')) formats.add('svg')
  if (type === 'data_model') { formats.add('svg'); formats.add('pdf') }
  if (['chart', 'd3', 'mixed', 'data_model'].includes(type)) formats.add('pdf')
  if (html.includes('<table') && html.includes('<td')) formats.add('csv')
  return Array.from(formats)
}

type SharedReport = {
  id: string
  title: string
  report_type: string
  summary: string | null
  html_content: string
  download_formats: string[]
  agent_name: string | null
  created_at: string
}

export default function SharedReportPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params)
  const [report, setReport] = useState<SharedReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [downloading, setDownloading] = useState<string | null>(null)

  useEffect(() => {
    if (!token) return
    setLoading(true)
    fetch(`${API}/reports/public/${token}`)
      .then(async res => {
        const json = await res.json()
        if (!res.ok || !json.success) throw new Error(json.error?.message || 'Failed to load report')
        setReport(json.data as SharedReport)
      })
      .catch((err: Error) => {
        // Handle expired links specifically
        if (err.message?.includes('expired') || err.message?.includes('not found')) {
          setError('This report link has expired or is no longer available.')
        } else {
          setError(err.message || 'Failed to load report')
        }
      })
      .finally(() => setLoading(false))
  }, [token])

  async function handleDownload(format: string) {
    if (!report) return
    setDownloading(format)
    try {
      const res = await fetch(`${API}/reports/public/${token}/download?format=${format}`)
      if (!res.ok) throw new Error(`Download failed (${res.status})`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const disposition = res.headers.get('Content-Disposition')
      const nameMatch = disposition?.match(/filename="?(.+?)"?$/i)
      a.download = nameMatch?.[1] || `report.${format}`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (err: any) {
      console.error('Download error:', err)
    } finally {
      setDownloading(null)
    }
  }

  // Loading state
  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', background: '#f8fafc' }}>
        <div style={{ textAlign: 'center' }}>
          <div className="skeleton" style={{ width: 400, height: 32, marginBottom: 16 }} />
          <p style={{ color: '#64748b' }}>Loading report…</p>
        </div>
      </div>
    )
  }

  // Error state
  if (error || !report) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', background: '#f8fafc' }}>
        <div style={{ maxWidth: 480, textAlign: 'center', padding: 40 }}>
          <h1 style={{ fontSize: 48, marginBottom: 8 }}>📋</h1>
          <h2 style={{ fontSize: 24, fontWeight: 600, marginBottom: 12, color: '#1e293b' }}>
            {error?.includes('expired') ? 'Link Expired' : 'Report Not Available'}
          </h2>
          <p style={{ color: '#64748b', marginBottom: 24 }}>{error || 'Report not found'}</p>
          <Link href="/" style={{ color: '#2563eb', textDecoration: 'underline' }}>
            Go to Kuvalam
          </Link>
        </div>
      </div>
    )
  }

  const formats = getAvailableFormats(report.report_type, report.html_content, report.download_formats)

  const dateStr = new Date(report.created_at).toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  })

  return (
    <div style={{ minHeight: '100vh', background: '#f8fafc' }}>
      {/* Header */}
      <header style={{
        background: '#fff', borderBottom: '1px solid #e2e8f0',
        padding: '16px 24px', display: 'flex', alignItems: 'center',
        justifyContent: 'space-between', flexWrap: 'wrap', gap: 12
      }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0, color: '#0f172a' }}>
            {report.title}
          </h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#64748b' }}>
            {report.agent_name && <span>{report.agent_name} · </span>}
            {dateStr} · <span style={{
              display: 'inline-block', background: '#dbeafe', color: '#1e40af',
              padding: '1px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600
            }}>{report.report_type}</span>
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {formats.map(fmt => (
            <button
              key={fmt}
              onClick={() => handleDownload(fmt)}
              disabled={downloading === fmt}
              style={{
                padding: '6px 14px', border: '1px solid #cbd5e1', borderRadius: 6,
                background: downloading === fmt ? '#f1f5f9' : '#fff',
                fontSize: 13, fontWeight: 500, cursor: downloading === fmt ? 'not-allowed' : 'pointer',
                color: '#334155'
              }}
            >
              {downloading === fmt ? '⏳' : ''} .{fmt}
            </button>
          ))}
          <span style={{ fontSize: 12, color: '#94a3b8' }}>
            Powered by <Link href="/" style={{ color: '#2563eb', textDecoration: 'underline' }}>Kuvalam</Link>
          </span>
        </div>
      </header>

      {/* Summary (if any) */}
      {report.summary && (
        <div style={{ maxWidth: 960, margin: '16px auto 0', padding: '0 24px' }}>
          <p style={{ color: '#475569', fontSize: 14, lineHeight: 1.6 }}>{report.summary}</p>
        </div>
      )}

      {/* Report Content */}
      <div style={{ maxWidth: 1100, margin: '24px auto', padding: '0 24px 40px' }}>
        <iframe
          srcDoc={report.html_content}
          title={report.title}
          sandbox="allow-scripts"
          style={{
            width: '100%', minHeight: '70vh', border: '1px solid #e2e8f0',
            borderRadius: 12, background: '#fff'
          }}
        />
      </div>
    </div>
  )
}
