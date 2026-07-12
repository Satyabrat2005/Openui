import { useEffect, useState } from 'react'
import type { HitlRequestPayload } from '../env'

interface Props {
  request: HitlRequestPayload
  onAllow: () => void
  onDeny: () => void
  /** Called with the picked candidate when request.choices is present. */
  onSelect?: (choice: string) => void
}

/**
 * Unanswered confirmations auto-deny after this long. Keeps a forgotten prompt
 * from stalling the whole agent run (deny = the safe default); the main
 * process has its own slightly-longer backstop in case this UI never renders.
 */
const AUTO_DENY_SECONDS = 120

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

export default function HitlModal({ request, onAllow, onDeny, onSelect }: Props): JSX.Element {
  const [secondsLeft, setSecondsLeft] = useState(AUTO_DENY_SECONDS)
  const choices = request.choices ?? []
  const isChoice = choices.length > 0
  const [picked, setPicked] = useState<string | null>(isChoice ? choices[0] : null)

  // Restart the countdown for each new request; deny/cancel automatically at zero.
  useEffect(() => {
    setSecondsLeft(AUTO_DENY_SECONDS)
    const timer = setInterval(() => {
      setSecondsLeft((s) => s - 1)
    }, 1000)
    return () => clearInterval(timer)
  }, [request.id])

  // Reset the selection whenever a new choice request comes in.
  useEffect(() => {
    setPicked(isChoice ? choices[0] : null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.id])

  useEffect(() => {
    if (secondsLeft <= 0) onDeny()
  }, [secondsLeft, onDeny])

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
        {/* Icon */}
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: 10,
            background: isChoice
              ? 'linear-gradient(145deg, #0a84ff, #0060df)'
              : 'linear-gradient(145deg, #ff453a, #d70015)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 14
          }}
        >
          {isChoice ? (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="9" stroke="white" strokeWidth="2" />
              <path
                d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.8.4-1 .8-1 1.7"
                stroke="white"
                strokeWidth="2"
                strokeLinecap="round"
                fill="none"
              />
              <circle cx="12" cy="17" r="1" fill="white" />
            </svg>
          ) : (
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
          )}
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
          {isChoice ? request.label : 'Allow this action?'}
        </h3>

        {isChoice ? (
          <>
            <p
              style={{
                margin: '0 0 12px',
                fontSize: 13,
                color: '#636366',
                lineHeight: 1.45
              }}
            >
              OpenUI couldn&apos;t confidently tell which one you meant. Pick the right one, or cancel.
            </p>

            <div
              role="radiogroup"
              aria-label="Candidates"
              style={{
                background: '#f2f2f7',
                borderRadius: 8,
                padding: 6,
                marginBottom: 20,
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                maxHeight: 240,
                overflowY: 'auto'
              }}
            >
              {choices.map((choice) => {
                const selected = choice === picked
                return (
                  <button
                    key={choice}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setPicked(choice)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      width: '100%',
                      textAlign: 'left',
                      border: 'none',
                      background: selected ? '#fff' : 'transparent',
                      boxShadow: selected ? '0 0 0 1px rgba(10,132,255,0.4)' : 'none',
                      borderRadius: 6,
                      padding: '9px 10px',
                      cursor: 'pointer',
                      fontFamily: 'inherit'
                    }}
                  >
                    <span
                      style={{
                        width: 16,
                        height: 16,
                        borderRadius: '50%',
                        border: selected ? '5px solid #0a84ff' : '1.5px solid #c7c7cc',
                        background: '#fff',
                        flexShrink: 0
                      }}
                    />
                    <span style={{ fontSize: 13.5, color: '#1c1c1e' }}>{choice}</span>
                  </button>
                )
              })}
            </div>
          </>
        ) : (
          <>
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
          </>
        )}

        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <span
            style={{
              fontSize: 11,
              color: secondsLeft <= 15 ? '#ff3b30' : '#8e8e93',
              marginRight: 'auto'
            }}
          >
            {isChoice ? 'Auto-cancels' : 'Auto-denies'} in {Math.max(secondsLeft, 0)}s
          </span>
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
            {isChoice ? 'Cancel' : 'Deny'}
          </button>
          {isChoice ? (
            <button
              onClick={() => picked && onSelect?.(picked)}
              disabled={!picked}
              style={{
                padding: '7px 18px',
                borderRadius: 8,
                border: 'none',
                background: picked ? '#0a84ff' : '#a9d3ff',
                fontSize: 13,
                color: 'white',
                cursor: picked ? 'pointer' : 'default',
                fontWeight: 600,
                fontFamily: 'inherit'
              }}
            >
              Select
            </button>
          ) : (
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
          )}
        </div>
      </div>
    </div>
  )
}
