'use client'
import Link from 'next/link'

interface Crumb {
  label: string
  href?: string
}

export function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" style={{ marginBottom: 12 }}>
      <ol style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, listStyle: 'none', margin: 0, padding: 0 }}>
        {items.map((crumb, idx) => {
          const isLast = idx === items.length - 1
          return (
            <li key={idx} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)' }}>
              {crumb.href && !isLast ? (
                <Link
                  href={crumb.href}
                  style={{
                    color: 'var(--text-muted)', textDecoration: 'none',
                    fontWeight: 600, padding: '2px 6px', borderRadius: 4,
                    transition: 'background 0.1s',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  {crumb.label}
                </Link>
              ) : (
                <span style={{ color: isLast ? 'var(--text)' : 'var(--text-muted)', fontWeight: isLast ? 700 : 600, padding: '2px 6px' }}>
                  {crumb.label}
                </span>
              )}
              {!isLast && <span style={{ color: 'var(--border-dark, #c4d5b6)', fontSize: 11 }}>/</span>}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
