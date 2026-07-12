import { useEffect } from 'react'
import type { PlanRequestPayload } from '../env'

interface Props {
  request: PlanRequestPayload
  onApprove: () => void
  onCancel: () => void
}

/**
 * PlanApprovalModal — shown once, before a task-shaped request runs, under the
 * "approve the plan once" autonomy level. It lists the WHOLE plan up front;
 * approving lets OpenUI carry out every step without further per-tool prompts
 * (destructive steps still confirm individually). This is the single gate that
 * replaces the old "confirm one action at a time" friction.
 */
export default function PlanApprovalModal({ request, onApprove, onCancel }: Props): JSX.Element {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onCancel])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Approve plan"
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
          maxWidth: 440,
          width: '90%',
          boxShadow: '0 12px 40px rgba(0, 0, 0, 0.22), 0 0 0 0.5px rgba(0,0,0,0.08)',
          fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif'
        }}
      >
        {/* Checklist icon */}
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: 10,
            background: 'linear-gradient(145deg, #0a84ff, #0060df)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 14
          }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <path d="M9 11l3 3L22 4" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            <path
              d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"
              stroke="white"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />
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
          Approve this plan?
        </h3>

        <p style={{ margin: '0 0 14px', fontSize: 13, color: '#636366', lineHeight: 1.45 }}>
          {request.summary
            ? `OpenUI will do the following to ${request.summary.replace(/\.$/, '')}. Once approved it runs on its own — you won't be asked step by step.`
            : "OpenUI will carry out the following steps on its own once you approve."}
        </p>

        {/* The full checklist */}
        <div
          style={{
            background: '#f2f2f7',
            borderRadius: 10,
            padding: '12px 14px',
            marginBottom: 20,
            maxHeight: 260,
            overflowY: 'auto'
          }}
        >
          {request.steps.map((step, i) => (
            <div
              key={step.id}
              style={{
                display: 'flex',
                gap: 10,
                alignItems: 'flex-start',
                padding: '6px 0',
                borderTop: i === 0 ? 'none' : '0.5px solid #e0e0e6'
              }}
            >
              <div
                style={{
                  flexShrink: 0,
                  width: 20,
                  height: 20,
                  borderRadius: '50%',
                  background: '#0a84ff',
                  color: 'white',
                  fontSize: 11,
                  fontWeight: 600,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginTop: 1
                }}
              >
                {i + 1}
              </div>
              <div style={{ fontSize: 13.5, color: '#1c1c1e', lineHeight: 1.4 }}>{step.title}</div>
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button
            onClick={onCancel}
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
            Cancel
          </button>
          <button
            onClick={onApprove}
            style={{
              padding: '7px 18px',
              borderRadius: 8,
              border: 'none',
              background: '#0a84ff',
              fontSize: 13,
              color: 'white',
              cursor: 'pointer',
              fontWeight: 600,
              fontFamily: 'inherit'
            }}
          >
            Run plan
          </button>
        </div>
      </div>
    </div>
  )
}
