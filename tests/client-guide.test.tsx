/**
 * Right-sidebar guide entry tests: the "Zotero 文库" registration must carry
 * a real `icon` component — without one the host falls back to the default
 * gray cube glyph. The artwork itself must keep the built-in guide contract
 * (36 box, 2px `#539CFA` stroke, `fill="none"`, no gradient, padded geometry).
 */
import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { apply, TAB_DEFINITION_ID, TAB_KIND } from '../src/client.tsx'
import { GuideLibraryIcon } from '../src/client/guide-icon.tsx'

/** Defensive registration face from client.tsx (structural, unexported). */
interface RegisteredDefinition {
  readonly id: string
  readonly kind: string
  readonly guide?: readonly {
    readonly id: string
    readonly order: number
    readonly title: () => string
    readonly description?: () => string
    readonly icon?: (props: { readonly size: number; readonly className?: string }) => React.ReactNode
  }[]
}

/** Run `apply` against a recording stub and return the registered tab type. */
function captureTabDefinition(): RegisteredDefinition {
  const registered: RegisteredDefinition[] = []
  apply({
    locale: {
      register: () => () => {},
      bind: () => (key: string) => key,
    },
    slots: {
      inject: () => () => {},
      register: () => () => {},
    },
    sidebarRightTabs: {
      register: (definition: Record<string, unknown>) => {
        registered.push(definition as RegisteredDefinition)
        return () => {}
      },
    },
    effect: (callback: () => void | (() => void)) => {
      callback()
      return () => {}
    },
  })
  expect(registered).toHaveLength(1)
  return registered[0]!
}

describe('guide registration', () => {
  it('registers the zotero tab with one zotero-library guide entry', () => {
    const definition = captureTabDefinition()
    expect(definition.id).toBe(TAB_DEFINITION_ID)
    expect(definition.kind).toBe(TAB_KIND)
    expect(definition.guide).toHaveLength(1)
    const entry = definition.guide![0]!
    expect(entry.id).toBe('zotero-library')
    expect(entry.order).toBe(100)
    expect(typeof entry.title).toBe('function')
    expect(typeof entry.description).toBe('function')
  })

  it('carries the guide icon component (missing icon falls back to the gray cube)', () => {
    const entry = captureTabDefinition().guide![0]!
    expect(entry.icon).toBe(GuideLibraryIcon)
  })
})

describe('GuideLibraryIcon artwork contract', () => {
  it('renders the built-in guide artwork shape at the host-provided size', () => {
    const html = renderToStaticMarkup(React.createElement(GuideLibraryIcon, { size: 26, className: 'host-guide-icon' }))
    expect(html).toContain('width="26"')
    expect(html).toContain('height="26"')
    expect(html).toContain('class="host-guide-icon"')
    expect(html).toContain('viewBox="0 0 36 36"')
    expect(html).toContain('fill="none"')
    expect(html).toContain('stroke="#539CFA"')
    expect(html).toContain('stroke-width="2"')
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('<path')
  })

  it('keeps the artwork flat and padded (no gradient, geometry inside the 36 box)', () => {
    const html = renderToStaticMarkup(React.createElement(GuideLibraryIcon, { size: 26 }))
    expect(html).not.toMatch(/gradient|url\(#/)
    const paths = [...html.matchAll(/ d="([^"]+)"/g)].map((match) => match[1]!)
    expect(paths.length).toBeGreaterThanOrEqual(2)
    for (const d of paths) {
      for (const coordinate of d.match(/-?\d+(?:\.\d+)?/g) ?? []) {
        const value = Number(coordinate)
        // ~7px padding all around: strokes stay within 5.5–30.5 of the 36 box.
        expect(value).toBeGreaterThanOrEqual(5.5)
        expect(value).toBeLessThanOrEqual(30.5)
      }
    }
  })
})
