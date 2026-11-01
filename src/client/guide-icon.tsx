/**
 * Guide artwork for the right-sidebar entry: a blue linear open book.
 *
 * The host renders `guide.icon` as a React component at a fixed size
 * (`size=26` when a description is shown). This mirrors the built-in guide
 * artwork contract (root `width`/`height`/`className`, `viewBox="0 0 36 36"`,
 * `fill="none"`, 2px `#539CFA` stroke, no gradient, generous padding) so the
 * "Zotero 文库" entry reads like the stock tabs instead of the default gray
 * cube glyph. It is deliberately separate from `icons.tsx`, whose UI icons
 * inherit `currentColor`.
 *
 * @module @hanxu131/dsh-zotero/client/guide-icon
 */

/**
 * Open-book artwork: both pages share the center spine (18, 10.5 → 18, 28),
 * plus a minimal bookmark tucked into the right page. Geometry stays inside
 * ~6.5–29.5 so the strokes keep the built-in ~7px padding in the 36 box.
 */
const PATHS = [
  'M18 10.5 C15.5 8.7 11.2 7.9 6.5 8.5 L6.5 25.9 C11.2 25.3 15.5 26.1 18 28 C20.5 26.1 24.8 25.3 29.5 25.9 L29.5 8.5 C24.8 7.9 20.5 8.7 18 10.5 Z',
  'M18 10.5 L18 28',
  'M23 9.6 L23 16.5 L25 14.9 L27 16.5 L27 9.3',
]

/** The built-in guide artwork blue. */
const GUIDE_BLUE = '#539CFA'

/** Render the guide artwork at the host-provided size (decorative). */
export function GuideLibraryIcon(props: { size: number; className?: string }): JSX.Element {
  return (
    <svg
      width={props.size}
      height={props.size}
      className={props.className}
      aria-hidden="true"
      viewBox="0 0 36 36"
      fill="none"
      stroke={GUIDE_BLUE}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {PATHS.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  )
}
