import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  /** What this boundary protects, e.g. "Chat" — shown in the fallback UI. */
  label: string
  children: ReactNode
  /** Compact fallback for small side panels (no full-height card). */
  compact?: boolean
}

interface State {
  error: Error | null
}

/**
 * Demo-reliability guard (Task 7): a render crash in one panel must never
 * white-screen the whole overlay. React unmounts the entire tree when a render
 * throws with no boundary; with boundaries at the shell and around each major
 * panel, a failure is contained to a small "something broke here" card with a
 * Retry button (remounts just that subtree) while chat, activity, and the
 * confirmation modals keep working.
 *
 * Render-phase errors only — event handlers and async code don't reach
 * boundaries by design; those already surface through the chat error path and
 * the main-process crash reporter.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[ErrorBoundary:${this.props.label}]`, error, info.componentStack)
  }

  private reset = (): void => {
    this.setState({ error: null })
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children

    const { label, compact } = this.props
    return (
      <div
        role="alert"
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          padding: compact ? '12px 14px' : '28px 24px',
          margin: compact ? 4 : 16,
          borderRadius: 12,
          border: '1px solid rgba(255, 69, 58, 0.35)',
          background: 'rgba(255, 69, 58, 0.08)',
          color: '#ff6961',
          textAlign: 'center'
        }}
      >
        <div style={{ fontSize: compact ? 12 : 14, fontWeight: 600 }}>
          {label} hit an error
        </div>
        {!compact && (
          <div style={{ fontSize: 12, color: '#b0525a', maxWidth: 360, wordBreak: 'break-word' }}>
            {this.state.error.message}
          </div>
        )}
        <button
          onClick={this.reset}
          style={{
            marginTop: 4,
            padding: '5px 14px',
            borderRadius: 8,
            border: '1px solid rgba(255, 69, 58, 0.4)',
            background: 'transparent',
            color: '#ff6961',
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
            fontFamily: 'inherit'
          }}
        >
          Retry
        </button>
      </div>
    )
  }
}
