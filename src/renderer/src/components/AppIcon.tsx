import type { AppKind } from '../lib/appKind'

/**
 * A monochrome line glyph for each app kind the agent can drive. Used by the
 * ActivityPanel tile and the Timeline rows. `currentColor` is inherited from
 * the CSS class on the wrapping element, so theming lives in index.css.
 */
export default function AppIcon({ kind, size = 18 }: { kind: AppKind; size?: number }): JSX.Element {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const
  }
  switch (kind) {
    case 'browser':
      return (
        <svg {...common} aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18M12 3c2.5 2.5 2.5 15 0 18M12 3c-2.5 2.5-2.5 15 0 18" />
        </svg>
      )
    case 'github':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.1-1.47-1.1-1.47-.9-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.52 2.34 1.08 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.6 9.6 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2Z" />
        </svg>
      )
    case 'figma':
      return (
        <svg {...common} aria-hidden="true">
          <path d="M9 3h3v6H9a3 3 0 0 1 0-6ZM12 3h3a3 3 0 0 1 0 6h-3V3ZM9 9h3v6H9a3 3 0 0 1 0-6Z" />
          <circle cx="15" cy="12" r="3" />
          <path d="M9 15h3v3a3 3 0 1 1-3-3Z" />
        </svg>
      )
    case 'files':
      return (
        <svg {...common} aria-hidden="true">
          <path d="M4 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7Z" />
        </svg>
      )
    case 'clipboard':
      return (
        <svg {...common} aria-hidden="true">
          <rect x="6" y="4" width="12" height="17" rx="2" />
          <path d="M9 4a3 3 0 0 1 6 0" />
        </svg>
      )
    case 'calendar':
      return (
        <svg {...common} aria-hidden="true">
          <rect x="4" y="5" width="16" height="16" rx="2" />
          <path d="M4 9h16M8 3v4M16 3v4" />
        </svg>
      )
    case 'screen':
      return (
        <svg {...common} aria-hidden="true">
          <rect x="3" y="4" width="18" height="12" rx="2" />
          <path d="M8 20h8M12 16v4" />
        </svg>
      )
    case 'whatsapp':
      return (
        <svg {...common} aria-hidden="true">
          <path d="M4 20l1.4-4A8 8 0 1 1 9 19.2L4 20Z" />
          <path d="M9 9c0 3 3 6 6 6 1-.6.6-1.6 0-2l-1.5-.5-1 1c-1-.5-2-1.5-2.5-2.5l1-1L10.5 8C10 7.4 9 7 9 9Z" />
        </svg>
      )
    case 'messaging':
      return (
        <svg {...common} aria-hidden="true">
          <path d="M4 5h16v11H8l-4 4V5Z" />
        </svg>
      )
    case 'thinking':
      return (
        <svg {...common} aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
      )
    default:
      return (
        <svg {...common} aria-hidden="true">
          <rect x="4" y="4" width="7" height="7" rx="1.5" />
          <rect x="13" y="4" width="7" height="7" rx="1.5" />
          <rect x="4" y="13" width="7" height="7" rx="1.5" />
          <rect x="13" y="13" width="7" height="7" rx="1.5" />
        </svg>
      )
  }
}
