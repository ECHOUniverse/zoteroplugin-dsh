/**
 * Minimal inline SVG icon set for the tab (no icon library dependency).
 * All icons inherit `currentColor` and are decorative by default (callers
 * put accessible names on the buttons that contain them).
 *
 * @module @hanxu131/dsh-zotero/client/icons
 */

export type IconName =
  | 'back'
  | 'chevronDown'
  | 'chevronRight'
  | 'search'
  | 'sort'
  | 'folder'
  | 'savedSearch'
  | 'library'
  | 'file'
  | 'check'
  | 'x'
  | 'plus'
  | 'minus'
  | 'message'
  | 'refresh'
  | 'alert'
  | 'tag'
  | 'note'
  | 'settings'
  | 'plugged'
  | 'power'
  | 'highlighter'
  | 'quote'
  | 'save'
  | 'trash'
  | 'sparkles'

const PATHS: Record<IconName, string[]> = {
  back: ['M15 4 L7 12 L15 20'],
  chevronDown: ['M5 9 L12 16 L19 9'],
  chevronRight: ['M9 5 L16 12 L9 19'],
  search: ['M10.5 4 a6.5 6.5 0 1 0 0 13 a6.5 6.5 0 0 0 0-13', 'M15.5 15.5 L20 20'],
  sort: ['M7 4 L7 20', 'M4 8 L7 4 L10 8', 'M17 20 L17 4', 'M14 16 L17 20 L20 16'],
  folder: ['M3 6 h5 l2 2 h11 v11 h-18 z'],
  savedSearch: ['M6 3 h12 v18 l-6 -4 l-6 4 z'],
  library: ['M4 4 v16', 'M8 4 v16', 'M12 5 l4 15', 'M17 6 l3 14'],
  file: ['M6 3 h8 l4 4 v14 h-12 z', 'M14 3 v4 h4'],
  check: ['M4 12 L9 17 L20 6'],
  x: ['M5 5 L19 19', 'M19 5 L5 19'],
  plus: ['M12 4 v16', 'M4 12 h16'],
  minus: ['M4 12 h16'],
  highlighter: ['M9 11 l4 -7 l5 3 l-4 7 z', 'M9 11 l-3 6 l6 3 l3 -6', 'M4 21 h9'],
  quote: ['M7 7 h4 v5 a4 4 0 0 1 -4 4 v-3 a1 1 0 0 0 1 -1 h-1 z', 'M15 7 h4 v5 a4 4 0 0 1 -4 4 v-3 a1 1 0 0 0 1 -1 h-1 z'],
  save: ['M5 4 h11 l3 3 v13 h-14 z', 'M8 4 v5 h7 v-5', 'M8 20 v-6 h8 v6'],
  trash: ['M4 7 h16', 'M9 7 v-3 h6 v3', 'M6 7 l1 13 h10 l1 -13'],
  sparkles: ['M12 4 l1.6 4.4 L18 10 l-4.4 1.6 L12 16 l-1.6 -4.4 L6 10 l4.4 -1.6 z', 'M18.5 15 l0.8 2.2 L21.5 18 l-2.2 0.8 L18.5 21 l-0.8 -2.2 L15.5 18 l2.2 -0.8 z'],
  message: ['M4 5 h16 v11 h-9 l-4 4 v-4 h-3 z'],
  refresh: ['M20 12 a8 8 0 1 1 -2.3 -5.7', 'M20 3 v4 h-4'],
  alert: ['M12 4 a8 8 0 1 1 0 16 a8 8 0 0 1 0-16', 'M12 8 v5', 'M12 15.5 v1'],
  tag: ['M3 12 l9 -9 h9 v9 l-9 9 z', 'M16.5 7.5 h.01'],
  note: ['M5 4 h14 v12 l-4 4 h-10 z', 'M15 20 v-4 h4'],
  settings: ['M12 9 a3 3 0 1 0 0 6 a3 3 0 0 0 0-6', 'M12 3 v3', 'M12 18 v3', 'M3 12 h3', 'M18 12 h3', 'M5.6 5.6 l2.1 2.1', 'M16.3 16.3 l2.1 2.1', 'M18.4 5.6 l-2.1 2.1', 'M7.7 16.3 l-2.1 2.1'],
  plugged: ['M9 3 v5', 'M15 3 v5', 'M7 8 h10 v3 a5 5 0 0 1 -5 5 a5 5 0 0 1 -5 -5 z', 'M12 16 v5'],
  power: ['M12 3 v8', 'M6.3 6.3 a8 8 0 1 0 11.4 0'],
}

export function Icon(props: { name: IconName; size?: number }): JSX.Element {
  const size = props.size ?? 16
  return (
    <svg
      className="dshZotIcon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[props.name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  )
}
