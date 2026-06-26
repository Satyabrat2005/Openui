import type { HitlRequestPayload } from '../env'

interface Props {
  request: HitlRequestPayload
  onAllow: () => void
  onDeny: () => void
}

/** Format tool args as a compact, readable list of key: value lines. */
function formatArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args)
  if (entries.length === 0) return '(no parameters)'
  return entries
    .map(([k, v]) => {
      const val = typeof v === 'object' ? JSON.stringify(v) : String(v)
      // Truncate long values so they don't overflow the modal.
      return `${k}: ${val.length > 80 ? val.slice(0, 77) + '…' : val}`
    })
    .join('\n')
}

export default function HitlModal({ request, onAllow, onDeny }: Props): JSX.Element {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        background: 'rgba(0, 0, 0, 0.45)'
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div
        style={{
          background: 'rgba(255, 255, 255, 0.98)',
          backdropFilter: 'blur(20px)',
          borderRadius: 14,
          padding: '24px 28px',
          maxWidth: 400,
          width: '90%',
          boxShadow: '0 12px 40px rgba(0, 0, 0, 0.22), 0 0 0 0.5px rgba(0,0,0,0.08)',
          fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif'
        }}
      >
        {/* Shield icon */}
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: 10,
            background: 'linear-gradient(145deg, #ff453a, #d70015)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 14
          }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <path
              d="M12 2L3 6v6c0 5.25 3.75 10.15 9 11.25C17.25 22.15 21 17.25 21 12V6L12 2z"
              stroke="white"
              strokeWidth="2"
              strokeLinejoin="round"
              fill="none"
            />
            <path d="M12 8v4" stroke="white" strokeWidth="2" strokeLinecap="round" />
            <circle cx="12" cy="15" r="1" fill="white" />
          </svg>
        </div>

        <h3
          style={{
            margin: '0 0 4px',
            fontSize: 15,
            fontWeight: 600,
            color: '#1c1c1e',
            letterSpacing: '-0.01em'
          }}
        >
          Allow this action?
        </h3>

        <p
          style={{
            margin: '0 0 14px',
            fontSize: 13,
            color: '#636366',
            lineHeight: 1.45
          }}
        >
          OpenUI wants to run a state-changing tool. Review the details below and
          confirm.
        </p>

        {/* Tool label */}
        <div
          style={{
            background: '#f2f2f7',
            borderRadius: 8,
            padding: '10px 12px',
            marginBottom: 10
          }}
        >
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: '#8e8e93',
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              marginBottom: 4
            }}
          >
            Action
          </div>
          <div style={{ fontSize: 14, fontWeight: 500, color: '#1c1c1e' }}>
            {request.label}
          </div>
        </div>

        {/* Args */}
        <div
          style={{
            background: '#f2f2f7',
            borderRadius: 8,
            padding: '10px 12px',
            marginBottom: 20
          }}
        >
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: '#8e8e93',
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              marginBottom: 4
            }}
          >
            Parameters
          </div>
          <pre
            style={{
              margin: 0,
              fontSize: 12,
              color: '#3c3c43',
              fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              lineHeight: 1.5
            }}
          >
            {formatArgs(request.args)}
          </pre>
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button
            onClick={onDeny}
            style={{
              padding: '7px 18px',
              borderRadius: 8,
              border: '0.5px solid #d1d1d6',
              background: 'white',
              fontSize: 13,
              color: '#3c3c43',
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontWeight: 500
            }}
          >
            Deny
          </button>
          <button
            onClick={onAllow}
            style={{
              padding: '7px 18px',
              borderRadius: 8,
              border: 'none',
              background: '#34c759',
              fontSize: 13,
              color: 'white',
              cursor: 'pointer',
              fontWeight: 600,
              fontFamily: 'inherit'
            }}
          >
            Allow
          </button>
        </div>
      </div>
    </div>
  )
}
