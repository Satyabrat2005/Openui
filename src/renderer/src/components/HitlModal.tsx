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

/** Tool args as readable rows; long values are trimmed so the card stays compact. */
function argRows(args: Record<string, unknown>): Array<[string, string]> {
  return Object.entries(args).map(([k, v]) => {
    const val = typeof v === 'object' ? JSON.stringify(v) : String(v)
    return [k.replace(/_/g, ' '), val.length > 160 ? val.slice(0, 157) + '…' : val]
  })
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

  // Escape denies, same as the auto-deny timeout — deny is the only safe default here.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onDeny()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onDeny])

  const rows = argRows(request.args)
  const urgent = secondsLeft <= 15

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Confirmation required"
      className="ou-hitl-scrim"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="ou-hitl">
        <div className="ou-hitl-kicker">{isChoice ? 'Which one did you mean?' : 'Needs your OK'}</div>
        <h3 className="ou-hitl-title">{isChoice ? request.label : request.label || 'Allow this action?'}</h3>

        {isChoice ? (
          <>
            <p className="ou-hitl-sub">Splen couldn’t tell for sure. Pick the right one, or cancel.</p>
            <div role="radiogroup" aria-label="Candidates" className="ou-hitl-choices">
              {choices.map((choice) => {
                const selected = choice === picked
                return (
                  <button
                    key={choice}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    className={`ou-hitl-choice${selected ? ' on' : ''}`}
                    onClick={() => setPicked(choice)}
                  >
                    <span className="ou-hitl-radio" aria-hidden="true" />
                    <span>{choice}</span>
                  </button>
                )
              })}
            </div>
          </>
        ) : (
          <>
            <p className="ou-hitl-sub">Nothing happens until you allow it. Check the details first.</p>

            {/* Recipient checks: a recipient the user never named, or one taken
                from someone else's message (see src/main/sendGuards.ts). */}
            {request.warnings && request.warnings.length > 0 && (
              <div role="alert" data-testid="hitl-recipient-warnings" className="ou-hitl-warn">
                <div className="ou-hitl-warn-title">Check before you allow</div>
                {request.warnings.map((w) => (
                  <div key={w}>{w}</div>
                ))}
              </div>
            )}

            {rows.length > 0 ? (
              <dl className="ou-hitl-rows">
                {rows.map(([k, v]) => (
                  <div key={k} className="ou-hitl-row">
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="ou-hitl-sub">(no details)</p>
            )}
          </>
        )}

        <div className="ou-hitl-actions">
          <span className={`ou-hitl-timer${urgent ? ' urgent' : ''}`}>
            {isChoice ? 'Cancels' : 'Denies'} itself in {Math.max(secondsLeft, 0)}s
          </span>
          <button type="button" className="ou-hitl-btn" onClick={onDeny}>
            {isChoice ? 'Cancel' : 'Deny'}
          </button>
          {isChoice ? (
            <button
              type="button"
              className="ou-hitl-btn primary"
              onClick={() => picked && onSelect?.(picked)}
              disabled={!picked}
            >
              Select
            </button>
          ) : (
            <button type="button" className="ou-hitl-btn primary" onClick={onAllow}>
              Allow
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
