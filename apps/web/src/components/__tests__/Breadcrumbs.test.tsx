import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { Breadcrumbs } from '@/components/Breadcrumbs'

describe('Breadcrumbs Component', () => {
  it('renders a list of breadcrumb items', () => {
    const items = [
      { label: 'Home', href: '/' },
      { label: 'Dashboard', href: '/dashboard' },
      { label: 'Agents' }
    ]

    render(<Breadcrumbs items={items} />)

    // Verify list structure
    expect(screen.getByRole('navigation', { name: /breadcrumb/i })).toBeInTheDocument()

    // Verify items are rendered
    expect(screen.getByText('Home')).toBeInTheDocument()
    expect(screen.getByText('Dashboard')).toBeInTheDocument()
    expect(screen.getByText('Agents')).toBeInTheDocument()
  })

  it('renders links for items with href except the last item', () => {
    const items = [
      { label: 'Home', href: '/' },
      { label: 'Dashboard', href: '/dashboard' },
      { label: 'Agents', href: '/dashboard/agents' }
    ]

    render(<Breadcrumbs items={items} />)

    // Home and Dashboard should be links
    const homeLink = screen.getByText('Home').closest('a')
    expect(homeLink).toHaveAttribute('href', '/')

    const dashboardLink = screen.getByText('Dashboard').closest('a')
    expect(dashboardLink).toHaveAttribute('href', '/dashboard')

    // The last item (Agents) should not be a link even if href is provided (per Component logic: index === items.length - 1)
    const agentsSpan = screen.getByText('Agents')
    expect(agentsSpan.tagName).toBe('SPAN')
    expect(agentsSpan.closest('a')).toBeNull()
  })

  it('handles mouse enter and mouse leave hover styles', () => {
    const items = [
      { label: 'Home', href: '/' },
      { label: 'Agents' }
    ]

    render(<Breadcrumbs items={items} />)

    const homeLink = screen.getByText('Home').closest('a')!

    // Define a custom getter/setter on style.background to bypass happy-dom's CSS parser shorthand bugs
    let backgroundStyleValue = ''
    Object.defineProperty(homeLink.style, 'background', {
      get() {
        return backgroundStyleValue
      },
      set(val) {
        backgroundStyleValue = val
      },
      configurable: true
    })

    // Find React internal props to invoke handlers directly
    const propsKey = Object.keys(homeLink).find(key => key.startsWith('__reactProps$'))
    if (propsKey) {
      const props = (homeLink as any)[propsKey]
      if (props && props.onMouseEnter && props.onMouseLeave) {
        props.onMouseEnter({ currentTarget: homeLink })
        expect(homeLink.style.background).toBe('var(--bg-hover)')

        props.onMouseLeave({ currentTarget: homeLink })
        expect(homeLink.style.background).toBe('transparent')
        return
      }
    }

    // Fallback using fireEvent
    fireEvent.mouseEnter(homeLink)
    expect(homeLink.style.background).toBe('var(--bg-hover)')

    fireEvent.mouseLeave(homeLink)
    expect(homeLink.style.background).toBe('transparent')
  })
})
