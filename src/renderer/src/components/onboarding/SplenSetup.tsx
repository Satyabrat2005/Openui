import { useCallback, useEffect, useRef, useState } from 'react'
import type { ModelPullProgress, ModelStatus } from '../../env'
import { track } from '../../lib/telemetry'
import { formatBytes } from '../../lib/formatBytes'

/**
 * SplenSetup — first run for the Splen texting agent. Three short steps:
 *
 *   1. Download Splen  — the one thing a user must do. It keeps downloading in
 *                         the background, so Continue is never blocked on it.
 *   2. Your channels   — what works now (WhatsApp Desktop) and what is one
 *                         click away later (Gmail, Telegram) — no forms here.
 *   3. Ready           — three things to try; picking one runs it first.
 *
 * Every step has its states: the model missing / downloading / installed /
 * failed / not yet offered to this account. The safe defaults the old wizard
 * chose (local engine, ask before sending, all guards on) are saved here too,
 * so finishing setup never leaves a setting unset.
 */

interface Props {
  /** Called when setup finishes, with a starter prompt to replay (or null). */
  onComplete: (firstMessage: string | null) => void
  /** Step to resume at (1..3). */
  initialStep?: number
  /** Reports the current step so the parent can persist/resume it. */
  onStepChange?: (step: number) => void
}

/** main/models.ts SPLEN_MODEL. */
const SPLEN_MODEL_ID = 'openui/splen:4b'

const STEPS = ['Download Splen', 'Your channels', 'Ready'] as const

const STARTERS = [
  'Summarise my unread WhatsApp chats',
  'What did I miss in Gmail today?',
  'Draft a reply to my last Telegram message'
]

/** The settings the old wizard persisted, at their safe values. */
const SAFE_DEFAULTS: Array<[string, string | boolean]> = [
  ['engine', 'local'],
  ['cloud_routing_enabled', false],
  ['autonomy_level', 'approve-plan'],
  ['guard_confirm_send', true],
  ['guard_never_delete', true],
  ['guard_redact_cards', true],
  ['guard_block_paid', true]
]

export default function SplenSetup({ onComplete, initialStep, onStepChange }: Props): JSX.Element {
  const [step, setStep] = useState(initialStep && initialStep >= 1 && initialStep <= 3 ? initialStep : 1)
  const startedAt = useRef(Date.now())

  useEffect(() => { track('onboarding_started') }, [])
  useEffect(() => { onStepChange?.(step) }, [step, onStepChange])

  // ── Splen model state ─────────────────────────────────────────────────────
  // undefined = checking; null = not offered to this account yet.
  const [splen, setSplen] = useState<ModelStatus | null | undefined>(undefined)
  const [pull, setPull] = useState<ModelPullProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(() => {
    window.openui
      .listLocalModels()
      .then((list) => setSplen((list ?? []).find((m) => m.id === SPLEN_MODEL_ID) ?? null))
      .catch(() => setSplen(null))
  }, [])
  useEffect(() => { refresh() }, [refresh])
  useEffect(
    () =>
      window.openui.onModelPull((p) => {
        if (p.model !== SPLEN_MODEL_ID) return
        setPull(p)
        if (p.done) refresh()
      }),
    [refresh]
  )
  const download = useCallback(async () => {
    setError(null)
    setPull({ model: SPLEN_MODEL_ID, status: 'starting download', percent: null, completed: null, total: null, layer: null, done: false })
    try {
      const result = await window.openui.downloadModel(SPLEN_MODEL_ID)
      if (!result.ok) {
        setError(result.message)
        setPull(null)
      }
    } catch {
      setError('The download could not start. Check your connection and try again.')
      setPull(null)
    } finally {
      refresh()
    }
  }, [refresh])

  const finish = useCallback(
    async (starter: string | null) => {
      try {
        for (const [key, value] of SAFE_DEFAULTS) await window.openui.setSetting(key, value)
      } catch {
        /* best-effort — a failed save must not trap the user in setup */
      }
      track('onboarding_completed', { duration_ms: Date.now() - startedAt.current })
      onComplete(starter)
    },
    [onComplete]
  )

  const downloading = pull !== null && !pull.done
  const installed = splen?.installed === true || pull?.done === true

  return (
    <div className="ou-setup" data-testid="splen-setup">
      <header className="ou-setup-head">
        <div className="ou-setup-brand">
          <svg width="20" height="20" viewBox="0 0 32 32" aria-hidden="true">
            <path
              d="M11 3.5c-1.6 3.4-3.2 8.6-3 13.4.2 5.2 3.4 9.6 8.6 9.6 4.8 0 8.2-3.5 8.2-7.8 0-4.1-3-7-6.8-7-3 0-5.4 1.8-6.4 4.4M11 3.5l3.4 2.6"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span>Splen</span>
        </div>
        <ol className="ou-setup-steps" aria-label="Setup steps">
          {STEPS.map((label, i) => (
            <li
              key={label}
              className={i + 1 === step ? 'current' : i + 1 < step ? 'done' : ''}
              aria-current={i + 1 === step ? 'step' : undefined}
            >
              <span className="ou-setup-step-num">{String(i + 1).padStart(2, '0')}</span>
              {label}
            </li>
          ))}
        </ol>
      </header>

      <main className="ou-setup-body">
        {step === 1 && (
          <section className="ou-setup-panel" aria-labelledby="setup-title">
            <h1 id="setup-title" className="ou-setup-title">First, download Splen.</h1>
            <p className="ou-setup-lede">
              Splen’s model runs on this computer, so your messages never leave it. It’s a one-time
              download{splen?.approxSize ? ` of ${splen.approxSize}` : ''}, and it keeps going while you finish setting up.
            </p>

            <div className={`ou-setup-model${error ? ' error' : ''}`} role="status" aria-live="polite" data-testid="setup-model">
              {splen === undefined ? (
                <div className="ou-sp-skeleton" aria-label="Checking"><span style={{ width: '60%' }} /><span style={{ width: '40%' }} /></div>
              ) : splen === null ? (
                <div className="ou-setup-model-text">
                  <strong>Splen isn’t available for your account yet</strong>
                  <span>We’re opening it up in waves. You can finish setting up now — the download appears in Settings as soon as it’s ready.</span>
                </div>
              ) : installed ? (
                <div className="ou-setup-model-text">
                  <strong><span className="ou-setup-check" aria-hidden="true">✓</span> Splen is on this computer</strong>
                  <span>You’re ready to go.</span>
                </div>
              ) : downloading ? (
                <>
                  <div className="ou-setup-model-text">
                    <strong>Downloading Splen</strong>
                    <span className="ou-sp-mono">
                      {pull?.percent != null
                        ? `${pull.percent}%${pull.total != null ? ` · ${formatBytes(pull.completed)} of ${formatBytes(pull.total)}` : ''}`
                        : pull?.status}
                    </span>
                  </div>
                  <div className="ou-sp-model-track wide" aria-hidden="true">
                    <div
                      className={`ou-sp-model-fill${pull?.percent == null ? ' idle' : ''}`}
                      style={pull?.percent != null ? { width: `${pull.percent}%` } : undefined}
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="ou-setup-model-text">
                    <strong>{error ? 'The download stopped' : `Splen 4B · ${splen.approxSize}`}</strong>
                    <span>{error ?? 'Downloads once. Needs about 4 GB of free space.'}</span>
                  </div>
                  <button type="button" className="ou-sp-btn primary" onClick={() => void download()}>
                    {error ? 'Try again' : 'Download'}
                  </button>
                </>
              )}
            </div>

            <div className="ou-setup-actions">
              <button
                type="button"
                className={installed || downloading || splen === null ? 'ou-setup-next' : 'ou-setup-back'}
                onClick={() => setStep(2)}
              >
                {installed || downloading || splen === null ? 'Continue' : 'Skip for now'}
              </button>
            </div>
          </section>
        )}

        {step === 2 && (
          <section className="ou-setup-panel" aria-labelledby="setup-title">
            <h1 id="setup-title" className="ou-setup-title">Where your messages are.</h1>
            <p className="ou-setup-lede">Splen reads these for you. Connect the rest any time from the sidebar.</p>
            <ul className="ou-setup-channels">
              <li>
                <span className="ou-setup-ch-name">WhatsApp</span>
                <span className="ou-setup-ch-body">Works with WhatsApp Desktop on this computer. Keep it signed in — no other setup.</span>
                <span className="ou-setup-ch-state ready">Ready</span>
              </li>
              <li>
                <span className="ou-setup-ch-name">Gmail</span>
                <span className="ou-setup-ch-body">Sign in with Google from Settings → Gmail.</span>
                <span className="ou-setup-ch-state">Later</span>
              </li>
              <li>
                <span className="ou-setup-ch-name">Telegram</span>
                <span className="ou-setup-ch-body">Create a bot with @BotFather and paste its token in Settings → Telegram.</span>
                <span className="ou-setup-ch-state">Later</span>
              </li>
            </ul>
            <p className="ou-setup-note">Splen never sends a message without asking you first.</p>
            <div className="ou-setup-actions">
              <button type="button" className="ou-setup-back" onClick={() => setStep(1)}>Back</button>
              <button type="button" className="ou-setup-next" onClick={() => setStep(3)}>Continue</button>
            </div>
          </section>
        )}

        {step === 3 && (
          <section className="ou-setup-panel" aria-labelledby="setup-title">
            <h1 id="setup-title" className="ou-setup-title">You’re set.</h1>
            <p className="ou-setup-lede">Try one of these, or open Splen and ask anything.</p>
            <ul className="ou-sp-suggest">
              {STARTERS.map((s) => (
                <li key={s}>
                  <button type="button" className="ou-sp-suggest-row" onClick={() => void finish(s)}>
                    <span>{s}</span>
                    <span className="ou-sp-suggest-arrow" aria-hidden="true">→</span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="ou-setup-actions">
              <button type="button" className="ou-setup-back" onClick={() => setStep(2)}>Back</button>
              <button type="button" className="ou-setup-next" onClick={() => void finish(null)}>Open Splen</button>
            </div>
          </section>
        )}
      </main>
    </div>
  )
}
