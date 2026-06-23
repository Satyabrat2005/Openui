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
  }
}

export default function PermissionModal({ permission, onDismiss }: Props): JSX.Element {
  const { title, body } = CONTENT[permission]

  const handleOpenSettings = (): void => {
    window.openui.openSettings(permission)
  }

  return (
    <div
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
          background: 'rgba(255, 255, 255, 0.97)',
          backdropFilter: 'blur(20px)',
          borderRadius: 14,
          padding: '24px 28px',
          maxWidth: 340,
          width: '90%',
          boxShadow: '0 12px 40px rgba(0, 0, 0, 0.22), 0 0 0 0.5px rgba(0,0,0,0.08)',
          fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif'
        }}
      >
        {/* Lock icon */}
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: 10,
            background: 'linear-gradient(145deg, #ff9f0a, #ff6b00)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 14
          }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <rect x="5" y="11" width="14" height="10" rx="2" stroke="white" strokeWidth="2" fill="none" />
            <path d="M8 11V7a4 4 0 0 1 8 0v4" stroke="white" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </div>

        <h3
          style={{
            margin: '0 0 8px',
            fontSize: 15,
            fontWeight: 600,
            color: '#1c1c1e',
            letterSpacing: '-0.01em'
          }}
        >
          {title}
        </h3>

        <p
          style={{
            margin: '0 0 20px',
            fontSize: 13,
            color: '#3c3c43',
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
              borderRadius: 8,
              border: '0.5px solid #d1d1d6',
              background: 'white',
              fontSize: 13,
              color: '#3c3c43',
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
              borderRadius: 8,
              border: 'none',
              background: '#007aff',
              fontSize: 13,
              color: 'white',
              cursor: 'pointer',
              fontWeight: 500,
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
