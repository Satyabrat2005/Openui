import type { PermissionTarget } from '../env'

interface Props {
  permission: PermissionTarget
  onDismiss: () => void
}

const CONTENT: Record<PermissionTarget, { title: string; body: string }> = {
  accessibility: {
    title: 'Accessibility Access Required',
    body: 'OpenUI needs Accessibility access to control your mouse and keyboard. Please grant access in System Settings → Privacy & Security → Accessibility.'
  },
  microphone: {
    title: 'Microphone Access Required',
    body: 'OpenUI needs Microphone access to record your voice. Please grant access in System Settings → Privacy & Security → Microphone.'
  },
  screenRecording: {
    title: 'Screen Recording Access Required',
    body: 'OpenUI needs Screen Recording access to see and describe your screen. Please grant access in System Settings → Privacy & Security → Screen Recording.'
  }
}

export default function PermissionModal({ permission, onDismiss }: Props): JSX.Element {
  const { title, body } = CONTENT[permission]

  const handleOpenSettings = (): void => {
    window.openui.openSettings(permission)
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        background: 'rgba(0, 0, 0, 0.35)'
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div
        style={{
          background: 'var(--ou-bg-panel)',
          border: '1px solid var(--ou-border-card)',
          borderRadius: 'var(--ou-r-composer)',
          padding: '24px 28px',
          maxWidth: 340,
          width: '90%',
          boxShadow: 'var(--ou-shadow-modal)',
          fontFamily: 'var(--ou-font)'
        }}
      >
        {/* Lock icon — amber, since a permission prompt is an "attention" state. */}
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: 10,
            background: 'var(--ou-fill-attention)',
            border: '1px solid var(--ou-fill-attention-border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 14
          }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <rect x="5" y="11" width="14" height="10" rx="2" stroke="var(--ou-status-attention)" strokeWidth="2" fill="none" />
            <path d="M8 11V7a4 4 0 0 1 8 0v4" stroke="var(--ou-status-attention)" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </div>

        <h3
          style={{
            margin: '0 0 8px',
            fontSize: 15,
            fontWeight: 600,
            color: 'var(--ou-text-max)',
            letterSpacing: '-0.01em'
          }}
        >
          {title}
        </h3>

        <p
          style={{
            margin: '0 0 20px',
            fontSize: 13,
            color: 'var(--ou-text-soft)',
            lineHeight: 1.55
          }}
        >
          {body}
        </p>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button
            onClick={onDismiss}
            style={{
              padding: '7px 16px',
              borderRadius: 'var(--ou-r-btn)',
              border: '1px solid var(--ou-border-control)',
              background: 'var(--ou-bg-chip)',
              fontSize: 13,
              color: 'var(--ou-text-mid)',
              cursor: 'pointer',
              fontFamily: 'inherit'
            }}
          >
            Not now
          </button>
          <button
            onClick={handleOpenSettings}
            style={{
              padding: '7px 16px',
              borderRadius: 'var(--ou-r-btn)',
              border: 'none',
              background: 'var(--ou-accent)',
              boxShadow: 'var(--ou-btn-inset)',
              fontSize: 13,
              color: 'var(--ou-accent-on)',
              cursor: 'pointer',
              fontWeight: 650,
              fontFamily: 'inherit'
            }}
          >
            Open System Settings
          </button>
        </div>
      </div>
    </div>
  )
}
