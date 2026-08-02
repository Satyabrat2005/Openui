import { useEffect, useState } from 'react'

interface Props {
  /** Called once the user has made a choice (allow or skip) so the host can unmount. */
  onClose: () => void
}

/**
 * First-launch privacy consent prompt for anonymous usage analytics.
 *
 * Shown only when consent status is UNKNOWN. Deliberately non-manipulative: the
 * two choices are the same size and visual weight, so "Skip" is exactly as easy
 * to pick as "Allow". "Skip" is treated as a permanent "no" (it never reappears,
 * but is reversible from Settings) and does NOT block the app — dismissing it
 * lets the user start working immediately.
 */
export default function ConsentModal({ onClose }: Props): JSX.Element {
  const [busy, setBusy] = useState(false)

  const choose = async (allow: boolean): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      if (allow) await window.openui.grantConsent()
      else await window.openui.denyConsent()
    } catch {
      // Even if persisting the choice fails, don't trap the user behind the modal.
    } finally {
      onClose()
    }
  }

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Privacy consent"
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 10000,
        background: 'rgba(0, 0, 0, 0.35)'
      }}
      // Keep clicks inside the modal from reaching the overlay's hide handler.
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div
        style={{
          background: 'var(--ou-bg-panel)',
          border: '1px solid var(--ou-border-card)',
          borderRadius: 'var(--ou-r-composer)',
          padding: '24px 28px',
          maxWidth: 380,
          width: '90%',
          maxHeight: '85vh',
          overflowY: 'auto',
          boxShadow: 'var(--ou-shadow-modal)',
          fontFamily: 'var(--ou-font)'
        }}
      >
        {/* Chart / analytics icon */}
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: 10,
            background: 'var(--ou-accent)',
            boxShadow: 'var(--ou-btn-inset)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 14
          }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <path d="M5 19V11" stroke="var(--ou-accent-on)" strokeWidth="1.8" strokeLinecap="round" />
            <path d="M12 19V5" stroke="var(--ou-accent-on)" strokeWidth="1.8" strokeLinecap="round" />
            <path d="M19 19v-6" stroke="var(--ou-accent-on)" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </div>

        <h3
          style={{
            margin: '0 0 8px',
            fontSize: 16,
            fontWeight: 600,
            color: 'var(--ou-text-max)',
            letterSpacing: '-0.01em'
          }}
        >
          Help us improve OpenUI
        </h3>

        <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--ou-text-soft)', lineHeight: 1.55 }}>
          We&apos;d like to collect anonymous usage data to understand how OpenUI is used and make
          it better.
        </p>

        <Section title="What we collect" tone="neutral">
          <Item>App opens and crashes</Item>
          <Item>Feature usage (which tools, which models)</Item>
          <Item>Performance metrics (response times)</Item>
          <Item>Subscription tier and OS version</Item>
        </Section>

        <Section title="What we NEVER collect" tone="never">
          <Item>Your chat messages or voice recordings</Item>
          <Item>The contents or paths of your files</Item>
          <Item>Screenshots or personal data</Item>
          <Item>Your API keys</Item>
        </Section>

        <p style={{ margin: '-4px 0 20px', fontSize: 11, color: 'var(--ou-text-meta)', lineHeight: 1.5, fontStyle: 'italic' }}>
          (Crash reports may include de-identified internal code locations — never your data.)
        </p>

        <p style={{ margin: '4px 0 20px', fontSize: 12, color: 'var(--ou-text-meta)', lineHeight: 1.5 }}>
          You can change this anytime in Settings.
        </p>

        {/* Two equally-weighted choices — no dark pattern. */}
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            type="button"
            disabled={busy}
            onClick={() => void choose(false)}
            style={{
              flex: 1,
              padding: '9px 16px',
              borderRadius: 'var(--ou-r-btn)',
              border: '1px solid var(--ou-border-control)',
              background: 'var(--ou-bg-chip)',
              fontSize: 13,
              fontWeight: 600,
              color: 'var(--ou-text-mid)',
              cursor: busy ? 'default' : 'pointer',
              fontFamily: 'inherit'
            }}
          >
            Skip
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void choose(true)}
            style={{
              flex: 1,
              padding: '9px 16px',
              borderRadius: 'var(--ou-r-btn)',
              border: 'none',
              background: 'var(--ou-accent)',
              boxShadow: 'var(--ou-btn-inset)',
              fontSize: 13,
              fontWeight: 650,
              color: 'var(--ou-accent-on)',
              cursor: busy ? 'default' : 'pointer',
              fontFamily: 'inherit'
            }}
          >
            Allow Analytics
          </button>
        </div>
      </div>
    </div>
  )
}

function Section({
  title,
  tone,
  children
}: {
  title: string
  tone: 'neutral' | 'never'
  children: React.ReactNode
}): JSX.Element {
  return (
    <div style={{ marginBottom: 14 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          color: tone === 'never' ? 'var(--ou-status-danger-text)' : 'var(--ou-accent-text)',
          marginBottom: 6
        }}
      >
        {title}
      </div>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: 'var(--ou-text-soft)', lineHeight: 1.6 }}>
        {children}
      </ul>
    </div>
  )
}

function Item({ children }: { children: React.ReactNode }): JSX.Element {
  return <li>{children}</li>
}
