import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { track } from '../../lib/telemetry'
import { useAuth } from '../../context/AuthContext'
import ConnectAppsModal, {
  getConnections,
  subscribeConnections,
  type ConnectableApp
} from '../ConnectAppsModal'
import SignInStep from './SignInStep'

/**
 * First Run — splash + 4-step setup wizard + launch, per the Run Console handoff
 * (design_handoff_openui/README.md § B/C). Replaces the old Welcome/SignIn/Tour/
 * FirstChat content. The screen-by-screen build wires each control to real state
 * on completion — engine actually flips the local-vs-cloud route, guards +
 * autonomy persist to the same settings store the Inspector reads, and the
 * connected-apps step reflects the REAL connection store (never a hardcoded list).
 *
 * SIGN-IN PLACEMENT (judgment call, flagged): sign-in isn't in the handoff's
 * 4-step flow, but must not silently disappear. It's folded in as a mandatory
 * gate BETWEEN the splash and "choose your engine" — the natural "who are you"
 * cold-start moment, so the per-user engine/apps/guards that follow attach to an
 * identity. It is NOT a numbered stepper item, keeping the wizard exactly the
 * four steps the handoff specifies (engine → apps → rules → ready). Guests may
 * still "Continue without an account" (SignInStep already supports this).
 */

type Engine = 'local' | 'byok' | 'hybrid'
type Autonomy = 'ask' | 'approve' | 'full'
type GuardKey = 'confirm_send' | 'never_delete' | 'redact_cards' | 'block_paid'
type Phase = 'splash' | 'signin' | 'wizard' | 'launch'

interface Props {
  /** Called when onboarding finishes, with a starter prompt to replay (or null). */
  onComplete: (firstMessage: string | null) => void
  /** Wizard step to resume at (1..4); 0 or undefined starts at the splash. */
  initialStep?: number
  /** Reports the current wizard step so the parent can persist/resume it. */
  onStepChange?: (step: number) => void
  /** External defaults (Tweaks panel / tests) — resolved as state ?? prop ?? default. */
  defaultEngine?: Engine
  defaultAutonomy?: Autonomy
}

const ENGINES: Array<{
  value: Engine
  title: string
  tag: string
  tagKind: 'ok' | 'info' | 'warn'
  desc: string
  metaA: string
  metaB: string
}> = [
  {
    value: 'local',
    title: 'Local engine',
    tag: 'RECOMMENDED',
    tagKind: 'ok',
    desc: 'Runs on your machine through Ollama. Private by default, works offline, no usage cost.',
    metaA: 'llama-3.3-70b',
    metaB: 'ready · 0 setup'
  },
  {
    value: 'byok',
    title: 'Your own API key',
    tag: 'YOUR ACCOUNT',
    tagKind: 'info',
    desc: 'Point OpenUI at a frontier model you already pay for. Stronger reasoning on long, multi-app tasks.',
    metaA: 'key stored in keychain',
    metaB: 'you pay the provider'
  },
  {
    value: 'hybrid',
    title: 'Hybrid routing',
    tag: 'ADVANCED',
    tagKind: 'warn',
    desc: 'Local for routine steps, remote only when a task needs more depth. You set the threshold.',
    metaA: 'auto escalation',
    metaB: 'cost cap per run'
  }
]

const AUTONOMIES: Array<{
  value: Autonomy
  title: string
  tag: string
  tagKind: 'ok' | 'info' | 'danger'
  desc: string
}> = [
  {
    value: 'ask',
    title: 'Ask each step',
    tag: 'SAFEST',
    tagKind: 'ok',
    desc: 'Confirm every action before it happens. Slowest, but nothing surprises you.'
  },
  {
    value: 'approve',
    title: 'Approve the plan',
    tag: 'BALANCED',
    tagKind: 'info',
    desc: 'Review the full plan once, then it runs. Anything leaving your workspace still pauses for you.'
  },
  {
    value: 'full',
    title: 'Full auto',
    tag: 'HIGHEST RISK',
    tagKind: 'danger',
    desc: 'Runs end to end without asking. Hard limits below still apply.'
  }
]

const GUARDS: Array<{ key: GuardKey; label: string; desc: string }> = [
  { key: 'confirm_send', label: 'Confirm before sending', desc: 'Pause before any message or email leaves your workspace.' },
  { key: 'never_delete', label: 'Never delete files', desc: 'Block destructive file operations outright.' },
  { key: 'redact_cards', label: 'Redact card and ID numbers', desc: 'Strip card, SSN and passport numbers from anything it reads or writes.' },
  { key: 'block_paid', label: 'Block paid actions', desc: 'Refuse purchases, transfers, and anything that spends money.' }
]

/** Starter prompts for step 4 — honest example tasks, not the prototype strings. */
const STARTERS: Array<{ badge: string; text: string }> = [
  { badge: 'GM', text: 'Triage my inbox and flag anything that needs a reply today' },
  { badge: 'DR', text: "Find last quarter's invoices and total what's still unpaid" },
  { badge: 'WB', text: 'Cancel a subscription and save the confirmation' }
]

/** Persisted settings keys shared with SettingsModal / the Inspector guardrails. */
const GUARD_SETTING: Record<GuardKey, string> = {
  confirm_send: 'guard_confirm_send',
  never_delete: 'guard_never_delete',
  redact_cards: 'guard_redact_cards',
  block_paid: 'guard_block_paid'
}
const AUTONOMY_SETTING: Record<Autonomy, string> = {
  ask: 'ask-each',
  approve: 'approve-plan',
  full: 'full-auto'
}

/** Two-letter mono badge initials from a connector name (handoff badge style). */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/)
  const raw = parts.length >= 2 ? parts[0][0] + parts[1][0] : name.slice(0, 2)
  return raw.toUpperCase()
}

/** The real permission summary a connector grants, by kind. */
function permissionLine(app: ConnectableApp): string {
  switch (app.kind) {
    case 'messaging':
    case 'whatsapp':
      return 'READ + POST'
    case 'browser':
      return 'READ + ACT'
    default:
      return 'READ + WRITE'
  }
}

export default function OnboardingWizard({
  onComplete,
  initialStep,
  onStepChange,
  defaultEngine,
  defaultAutonomy
}: Props): JSX.Element {
  // ── State (README § State Management → First Run): every value resolves as
  //    state ?? prop ?? hardDefault so external defaults work without a remount.
  const [engineState, setEngineState] = useState<Engine | null>(null)
  const [autonomyState, setAutonomyState] = useState<Autonomy | null>(null)
  const [guardsState, setGuardsState] = useState<Partial<Record<GuardKey, boolean>>>({})
  const engine = engineState ?? defaultEngine ?? 'local'
  const autonomy = autonomyState ?? defaultAutonomy ?? 'approve'
  const guardOn = (k: GuardKey): boolean => guardsState[k] ?? true

  const [phase, setPhase] = useState<Phase>('splash')
  const [wizardStep, setWizardStep] = useState<number>(
    initialStep && initialStep >= 1 && initialStep <= 4 ? initialStep : 1
  )
  const [showConnect, setShowConnect] = useState(false)

  // Apps are the REAL connection store — not a divergent local boolean map — so
  // First Run and the console's CONNECTED group can never drift (one source of
  // truth). Live-subscribed so a connect/disconnect reflects instantly.
  const [conns, setConns] = useState<ConnectableApp[]>(getConnections())
  useEffect(() => subscribeConnections(() => setConns(getConnections())), [])
  const connectedCount = conns.filter((c) => c.state === 'connected').length

  const { isAnonymous } = useAuth()
  const startedRef = useRef(false)
  const startTimeRef = useRef(Date.now())

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    track('onboarding_started')
  }, [])

  // Report the wizard step for resume persistence.
  useEffect(() => {
    if (phase === 'wizard') onStepChange?.(wizardStep)
  }, [phase, wizardStep, onStepChange])

  const gotoWizardStep = useCallback((n: number): void => {
    setWizardStep(Math.min(4, Math.max(1, n)))
    setPhase('wizard')
    track('onboarding_step_reached', { step_number: n, step_name: `setup_${n}` })
  }, [])

  // Global keyboard nav (handoff § Interactions): Enter advances, Escape retreats.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const typing = (e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'TEXTAREA'
      if (typing) return
      if (e.key === 'Enter') {
        if (phase === 'splash') setPhase(isAnonymous ? 'signin' : 'wizard')
        else if (phase === 'wizard') { if (wizardStep < 4) gotoWizardStep(wizardStep + 1) }
      } else if (e.key === 'Escape') {
        if (phase === 'wizard' && wizardStep > 1) gotoWizardStep(wizardStep - 1)
        else if (phase === 'wizard') setPhase('signin')
        else if (phase === 'signin') setPhase('splash')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase, wizardStep, isAnonymous, gotoWizardStep])

  /** Persist every chosen setting so the selections actually take effect. */
  const persistSetup = useCallback(async (): Promise<void> => {
    try {
      // Engine genuinely flips the route: local = no cloud, byok/hybrid = cloud.
      await window.openui.setSetting('engine', engine)
      await window.openui.setSetting('cloud_routing_enabled', engine !== 'local')
      await window.openui.setSetting('autonomy_level', AUTONOMY_SETTING[autonomy])
      for (const g of GUARDS) {
        await window.openui.setSetting(GUARD_SETTING[g.key], guardOn(g.key))
      }
    } catch {
      /* best-effort — a failed persist must not trap the user in setup */
    }
  }, [engine, autonomy, guardsState]) // eslint-disable-line react-hooks/exhaustive-deps

  const finish = useCallback(
    (starter: string | null): void => {
      track('onboarding_completed', { duration_ms: Date.now() - startTimeRef.current })
      onComplete(starter)
    },
    [onComplete]
  )

  const openConsole = useCallback(async (): Promise<void> => {
    await persistSetup()
    setPhase('launch')
  }, [persistSetup])

  // ── Splash ────────────────────────────────────────────────────────────────
  if (phase === 'splash') {
    return (
      <div className="ou-fr-dotgrid ou-fr-splash">
        <div className="ou-fr-splash-col">
          <div className="ou-fr-splash-mark" aria-hidden="true" />
          <div className="ou-fr-splash-word">
            <span className="ou-fr-wordmark">OpenUI</span>
            <span className="ou-fr-tagline">AN AGENT THAT WORKS YOUR APPS</span>
          </div>
          <div className="ou-fr-bar" role="progressbar" aria-label="Starting the local engine">
            <div className="ou-fr-bar-fill" />
          </div>
          <div className="ou-fr-splash-status">starting local engine · ollama</div>
          <button
            type="button"
            className="ou-fr-ghost-btn"
            onClick={() => setPhase(isAnonymous ? 'signin' : 'wizard')}
          >
            Continue <span className="ou-fr-kbd">⏎</span>
          </button>
        </div>
      </div>
    )
  }

  // ── Sign-in (mandatory gate; guests may continue) ───────────────────────────
  if (phase === 'signin') {
    return (
      <div className="ou-fr-dotgrid ou-fr-signin-frame">
        <div className="ou-fr-signin-card">
          <SignInStep onAuthed={() => setPhase('wizard')} />
        </div>
      </div>
    )
  }

  // ── Launch state ────────────────────────────────────────────────────────────
  if (phase === 'launch') {
    return (
      <div className="ou-fr-dotgrid ou-fr-launch">
        <div className="ou-fr-splash-col">
          <div className="ou-fr-launch-check" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 20 20">
              <path d="M4 10.5l4 4 8-9" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div className="ou-fr-launch-title">Setup complete</div>
          <div className="ou-fr-splash-status">OPENING THE RUN CONSOLE</div>
          <div className="ou-fr-bar ou-fr-bar-wide" role="progressbar" aria-label="Opening the run console">
            <div className="ou-fr-bar-fill" />
          </div>
          <div className="ou-fr-launch-actions">
            <button type="button" className="ou-fr-primary" onClick={() => finish(null)}>
              Go to console
            </button>
            <button type="button" className="ou-fr-ghost-btn" onClick={() => setPhase('splash')}>
              Replay setup
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── Setup wizard (steps 1–4) ────────────────────────────────────────────────
  return (
    <div className="ou-fr-wizard">
      <SetupRail step={wizardStep} onJump={gotoWizardStep} />
      <div className="ou-fr-main">
        <div className="ou-fr-scroll">
          {wizardStep === 1 && (
            <WizardHeader kicker="STEP 1 OF 4" title="Choose your engine" body="Where should OpenUI's reasoning run? You can change this any time in Settings.">
              <div className="ou-fr-cards" role="radiogroup" aria-label="Engine">
                {ENGINES.map((e) => (
                  <OptionCard
                    key={e.value}
                    role="radio"
                    selected={engine === e.value}
                    onSelect={() => setEngineState(e.value)}
                    title={e.title}
                    tag={e.tag}
                    tagKind={e.tagKind}
                    desc={e.desc}
                    meta={[e.metaA, e.metaB]}
                  />
                ))}
              </div>
            </WizardHeader>
          )}

          {wizardStep === 2 && (
            <WizardHeader kicker="STEP 2 OF 4" title="Connect your apps" body="OpenUI works inside the apps you already use. Connect what you like now — you can add or revoke any app later.">
              <div className="ou-fr-appgrid">
                {conns.map((app) => {
                  const on = app.state === 'connected'
                  return (
                    <div
                      key={app.id}
                      role="checkbox"
                      aria-checked={on}
                      aria-label={app.name}
                      tabIndex={0}
                      className={`ou-fr-apptile${on ? ' on' : ''}`}
                      onClick={() => setShowConnect(true)}
                      onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); setShowConnect(true) } }}
                    >
                      <span className="ou-fr-badge" aria-hidden="true">{initials(app.name)}</span>
                      <div className="ou-fr-apptile-body">
                        <span className="ou-fr-apptile-name">{app.name}</span>
                        <span className="ou-fr-apptile-perm">{permissionLine(app)}</span>
                      </div>
                      <span className={`ou-fr-checkbox${on ? ' on' : ''}`} aria-hidden="true">
                        {on && (
                          <svg width="11" height="11" viewBox="0 0 11 11"><path d="M2 5.5l2.4 2.4L9 3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                        )}
                      </span>
                    </div>
                  )
                })}
              </div>
              <div className="ou-fr-appnote">
                {connectedCount} of {conns.length} connected · you can add or revoke any app later
              </div>
              <button type="button" className="ou-fr-secondary" onClick={() => setShowConnect(true)}>
                Manage connections
              </button>
            </WizardHeader>
          )}

          {wizardStep === 3 && (
            <WizardHeader kicker="STEP 3 OF 4" title="Set the rules" body="How much should OpenUI do on its own before checking with you? Hard limits below always apply, whatever you pick.">
              <div className="ou-fr-cards" role="radiogroup" aria-label="Autonomy">
                {AUTONOMIES.map((a) => (
                  <OptionCard
                    key={a.value}
                    role="radio"
                    selected={autonomy === a.value}
                    onSelect={() => setAutonomyState(a.value)}
                    title={a.title}
                    tag={a.tag}
                    tagKind={a.tagKind}
                    desc={a.desc}
                  />
                ))}
              </div>
              <div className="ou-fr-hardlimits">
                <div className="ou-fr-section-label">HARD LIMITS</div>
                {GUARDS.map((g) => (
                  <ToggleRow
                    key={g.key}
                    label={g.label}
                    desc={g.desc}
                    on={guardOn(g.key)}
                    onToggle={() => setGuardsState((s) => ({ ...s, [g.key]: !guardOn(g.key) }))}
                  />
                ))}
              </div>
            </WizardHeader>
          )}

          {wizardStep === 4 && (
            <WizardHeader kicker="ALL SET" title="Ready to run" body="Here's how OpenUI is set up. Kick off your first run — or start from one of these.">
              <div className="ou-fr-summary">
                <div className="ou-fr-summary-head">YOUR SETUP</div>
                <SummaryRow label="Engine" value={ENGINES.find((e) => e.value === engine)?.title ?? engine} />
                <SummaryRow label="Apps" value={`${connectedCount} connected`} />
                <SummaryRow label="Autonomy" value={AUTONOMIES.find((a) => a.value === autonomy)?.title ?? autonomy} />
                <SummaryRow label="Hard limits" value={`${GUARDS.filter((g) => guardOn(g.key)).length} of 4 active`} />
              </div>
              <div className="ou-fr-section-label" style={{ marginTop: 6 }}>TRY ONE OF THESE FIRST</div>
              <div className="ou-fr-starters">
                {STARTERS.map((s) => (
                  <button key={s.text} type="button" className="ou-fr-starter" onClick={() => void persistSetup().then(() => finish(s.text))}>
                    <span className="ou-fr-badge ou-fr-badge-sm" aria-hidden="true">{s.badge}</span>
                    <span className="ou-fr-starter-text">{s.text}</span>
                    <svg className="ou-fr-starter-chev" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M5 3l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  </button>
                ))}
              </div>
            </WizardHeader>
          )}
        </div>

        {/* Footer bar */}
        <div className="ou-fr-footer">
          <button
            type="button"
            className="ou-fr-ghost-btn ou-fr-back"
            onClick={() => (wizardStep > 1 ? gotoWizardStep(wizardStep - 1) : setPhase(isAnonymous ? 'signin' : 'splash'))}
          >
            ◀ Back
          </button>
          <div className="ou-fr-footer-right">
            {wizardStep === 2 && (
              <button type="button" className="ou-fr-skip" onClick={() => gotoWizardStep(3)}>
                Skip for now
              </button>
            )}
            {wizardStep < 4 ? (
              <button type="button" className="ou-fr-primary" onClick={() => gotoWizardStep(wizardStep + 1)}>
                Continue <span className="ou-fr-kbd ou-fr-kbd-on">⏎</span>
              </button>
            ) : (
              <button type="button" className="ou-fr-primary" onClick={() => void openConsole()}>
                Open OpenUI <span className="ou-fr-kbd ou-fr-kbd-on">⏎</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {showConnect && <ConnectAppsModal onClose={() => setShowConnect(false)} />}
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SetupRail({ step, onJump }: { step: number; onJump: (n: number) => void }): JSX.Element {
  const items = ['Choose your engine', 'Connect your apps', 'Set the rules', 'Ready to run']
  const hints = ['Local or cloud', 'Gmail, Drive, Slack…', 'Autonomy & limits', 'Review & launch']
  return (
    <aside className="ou-fr-rail">
      <div className="ou-fr-section-label">SET UP OPENUI</div>
      <div className="ou-fr-rail-sub">Step {step} of 4 · about 2 minutes</div>
      <div className="ou-fr-stepper">
        {items.map((label, i) => {
          const n = i + 1
          const stateCls = n < step ? 'done' : n === step ? 'current' : 'todo'
          return (
            <button key={label} type="button" className={`ou-fr-step ${stateCls}`} onClick={() => onJump(n)}>
              <span className="ou-fr-step-ring" aria-hidden="true">
                {n < step ? (
                  <svg width="9" height="9" viewBox="0 0 9 9"><path d="M1.6 4.6l1.8 1.8L7.2 2.4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
                ) : (
                  n
                )}
              </span>
              <span className="ou-fr-step-body">
                <span className="ou-fr-step-title">{label}</span>
                <span className="ou-fr-step-hint">{hints[i]}</span>
              </span>
            </button>
          )
        })}
      </div>
      <div className="ou-fr-trust">
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 1l5 2v4c0 3-2.2 5-5 6-2.8-1-5-3-5-6V3l5-2z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></svg>
        <span>Nothing is uploaded during setup. Keys are stored in your OS keychain.</span>
      </div>
    </aside>
  )
}

function WizardHeader({
  kicker,
  title,
  body,
  children
}: {
  kicker: string
  title: string
  body: string
  children: ReactNode
}): JSX.Element {
  return (
    <>
      <div className="ou-fr-header">
        <div className="ou-fr-kicker">{kicker}</div>
        <h1 className="ou-fr-title">{title}</h1>
        <p className="ou-fr-body">{body}</p>
      </div>
      {children}
    </>
  )
}

function OptionCard({
  role,
  selected,
  onSelect,
  title,
  tag,
  tagKind,
  desc,
  meta
}: {
  role: 'radio'
  selected: boolean
  onSelect: () => void
  title: string
  tag: string
  tagKind: 'ok' | 'info' | 'warn' | 'danger'
  desc: string
  meta?: [string, string]
}): JSX.Element {
  return (
    <div
      role={role}
      aria-checked={selected}
      tabIndex={0}
      className={`ou-fr-optcard${selected ? ' selected' : ''}`}
      onClick={onSelect}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect() } }}
    >
      <span className={`ou-fr-radio${selected ? ' on' : ''}`} aria-hidden="true" />
      <div className="ou-fr-optcard-body">
        <div className="ou-fr-optcard-head">
          <span className="ou-fr-optcard-title">{title}</span>
          <span className={`ou-fr-tag ou-fr-tag-${tagKind}`}>{tag}</span>
        </div>
        <p className="ou-fr-optcard-desc">{desc}</p>
        {meta && (
          <div className="ou-fr-optcard-meta">
            <span>{meta[0]}</span>
            <span className="ou-fr-meta-sep">|</span>
            <span>{meta[1]}</span>
          </div>
        )}
      </div>
    </div>
  )
}

function ToggleRow({
  label,
  desc,
  on,
  onToggle
}: {
  label: string
  desc: string
  on: boolean
  onToggle: () => void
}): JSX.Element {
  return (
    <div className="ou-fr-toggle-row">
      <div className="ou-fr-toggle-text">
        <span className="ou-fr-toggle-label">{label}</span>
        <span className="ou-fr-toggle-desc">{desc}</span>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        className={`ou-fr-switch${on ? ' on' : ''}`}
        onClick={onToggle}
      >
        <span className="ou-fr-switch-knob" />
      </button>
    </div>
  )
}

function SummaryRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="ou-fr-summary-row">
      <span className="ou-fr-summary-label">{label}</span>
      <span className="ou-fr-summary-value">{value}</span>
    </div>
  )
}
