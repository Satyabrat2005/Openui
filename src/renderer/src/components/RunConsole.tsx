import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { HitlRequestPayload, PlanRequestPayload, ModelPullProgress } from '../env'
import { useTaskActivity } from '../context/TaskActivityContext'
import { useAuth } from '../context/AuthContext'
import { getConnections, subscribeConnections, type ConnectableApp } from './ConnectAppsModal'
import SettingsModal from './SettingsModal'
import ConversationList from './ConversationList'
import { useUpdater } from '../hooks/useUpdater'
import { labelForModel } from '../lib/modelLabel'
import { formatBytes } from '../lib/formatBytes'
import { poseForRuns, POSE_CAPTION, DONE_LINGER_MS } from '../lib/buddyPose'
import SplenBuddy from './SplenBuddy'

/**
 * RunConsole — the Splen home screen, exactly the owner's design:
 *
 *   sidebar: Splen mark · New run · Channels · Settings
 *   main:    greeting · character · composer (Answer/Act + send)
 *
 * Nothing else is on screen. Under it sits the same pipeline as before: a run
 * is beginTask + window.openui.chat, the character's pose follows the real run
 * state (lib/buddyPose), and the latest answer appears under the composer.
 *
 * Approvals are NEVER shown inline here: onApprovalInline is always false, so
 * App's blocking HitlModal / PlanApprovalModal handles every confirmation. That
 * keeps "nothing is sent without asking" on the one surface that can't be
 * scrolled past.
 */

type Mode = 'ask' | 'do'

/** The messaging channels Splen works across, in sidebar order. */
const CHANNELS: Array<{ id: string; name: string }> = [
  { id: 'whatsapp', name: 'WhatsApp' },
  { id: 'telegram', name: 'Telegram' },
  { id: 'slack', name: 'Slack' },
  { id: 'gmail', name: 'Gmail' }
]

/** The Splen mark — a single hooked brush stroke. */
function SplenMark(): JSX.Element {
  return (
    <svg className="ou-sp-mark" width="30" height="30" viewBox="0 0 32 32" aria-hidden="true">
      <path
        d="M11 3.5c-1.6 3.4-3.2 8.6-3 13.4.2 5.2 3.4 9.6 8.6 9.6 4.8 0 8.2-3.5 8.2-7.8 0-4.1-3-7-6.8-7-3 0-5.4 1.8-6.4 4.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M11 3.5l3.4 2.6" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  )
}

interface RunConsoleProps {
  initialMessage?: string | null
  /** Kept for App's contract; approvals always go to App's modal (see header). */
  hitlRequest?: HitlRequestPayload | null
  planRequest?: PlanRequestPayload | null
  onRespondHitl?: (approved: boolean) => void
  onRespondPlan?: (approved: boolean) => void
  /** Always reported false, so App shows its approval modal. */
  onApprovalInline?: (shown: boolean) => void
  /** Conversation-history drawer, opened from App's title bar. */
  historyOpen?: boolean
  onHistoryChange?: (open: boolean) => void
}

export default function RunConsole({
  initialMessage,
  onApprovalInline,
  historyOpen = false,
  onHistoryChange
}: RunConsoleProps): JSX.Element {
  const { tasks, beginTask, focusTask } = useTaskActivity()
  const { tier } = useAuth()
  const { updateState, appVersion, checkForUpdates } = useUpdater()

  const [mode, setMode] = useState<Mode>('do')
  const [input, setInput] = useState('')
  const [showSettings, setShowSettings] = useState(false)

  useEffect(() => { onApprovalInline?.(false) }, [onApprovalInline])

  // Channel dots: WhatsApp is built in; Gmail is Google OAuth from Settings.
  // Telegram/Slack only get a dot when the connection store KNOWS they're on.
  const [conns, setConns] = useState<ConnectableApp[]>(getConnections())
  useEffect(() => subscribeConnections(() => setConns(getConnections())), [])
  const [gmailOn, setGmailOn] = useState(false)
  useEffect(() => {
    window.openui.gmailStatus?.().then((s) => setGmailOn(Boolean(s?.connected))).catch(() => {})
  }, [showSettings])
  const channelOn = (id: string): boolean =>
    id === 'gmail' ? gmailOn : conns.some((c) => c.id === id && c.state === 'connected')

  // Splen download progress (first run). Shown only while a download is going.
  const [pull, setPull] = useState<ModelPullProgress | null>(null)
  useEffect(
    () =>
      window.openui.onModelPull((p) => {
        setPull(p)
        if (p.done) window.setTimeout(() => setPull(null), 2500)
      }),
    []
  )

  // Newest run first; the character and the answer both follow the latest one.
  const runs = useMemo(() => [...tasks].reverse(), [tasks])
  const latest = runs[0] ?? null

  const [modes, setModes] = useState<Record<string, Mode>>({})
  const [, setTick] = useState(0)
  const pose = poseForRuns(runs, modes, Date.now())
  useEffect(() => {
    if (pose !== 'done') return
    const id = window.setTimeout(() => setTick((t) => t + 1), DONE_LINGER_MS)
    return () => window.clearTimeout(id)
  }, [pose, runs])

  const startRun = useCallback(() => {
    const text = input.trim()
    if (!text) return
    setModes((m) => ({ ...m, [text]: mode }))
    // The same send path as before: beginTask opens the run, chat() runs it.
    beginTask(text, 'chat')
    void window.openui.chat(text, tier).catch(() => {})
    setInput('')
  }, [input, beginTask, tier, mode])

  const newRun = useCallback(() => {
    window.openui.clearHistory()
    focusTask(null)
    setInput('')
  }, [focusTask])

  // Replay the starter prompt chosen in First Run exactly once.
  const replayedRef = useRef(false)
  useEffect(() => {
    const msg = initialMessage?.trim()
    if (!msg || replayedRef.current) return
    replayedRef.current = true
    beginTask(msg, 'chat')
    void window.openui.chat(msg, tier).catch(() => {})
  }, [initialMessage, beginTask, tier])

  return (
    <div className="ou-rc ou-sp">
      <aside className="ou-sp-sidebar">
        <div className="ou-sp-brand">
          <SplenMark />
          <span className="ou-sp-brand-name">Splen</span>
        </div>

        <button type="button" className="ou-sp-newrun" onClick={newRun}>
          <span aria-hidden="true">+</span>
          <span>New run</span>
        </button>

        <nav className="ou-sp-channels" aria-label="Channels">
          <div className="ou-sp-section-label">Channels</div>
          {CHANNELS.map((ch) => {
            const on = channelOn(ch.id)
            return (
              <button
                key={ch.id}
                type="button"
                className="ou-sp-channel"
                onClick={() => setShowSettings(true)}
                title={on ? `${ch.name} is connected` : `Set up ${ch.name} in Settings`}
              >
                <span className="ou-sp-channel-name">{ch.name}</span>
                {on && <span className="ou-sp-channel-dot" aria-label={`${ch.name} connected`} />}
              </button>
            )
          })}
        </nav>

        <div className="ou-sp-footer">
          <button type="button" className="ou-sp-channel" onClick={() => setShowSettings(true)}>
            <span className="ou-sp-channel-name">Settings</span>
          </button>
        </div>
      </aside>

      <main className="ou-sp-main">
        <div className="ou-sp-stage">
          <h1 className="ou-sp-greeting" aria-live="polite">{POSE_CAPTION[pose]}</h1>
          <SplenBuddy pose={pose} />

          {pull && (
            <div className="ou-sp-pull" role="status" aria-live="polite" data-testid="model-pull">
              <div className="ou-sp-pull-top">
                <span>{pull.done ? `${labelForModel(pull.model)} ready` : `Downloading ${labelForModel(pull.model)}`}</span>
                <span className="ou-sp-pull-meta">
                  {pull.percent !== null
                    ? `${pull.percent}%${pull.total !== null ? ` · ${formatBytes(pull.completed)} / ${formatBytes(pull.total)}` : ''}`
                    : pull.status}
                </span>
              </div>
              <div className="ou-sp-pull-track">
                <div
                  className={`ou-sp-pull-fill${pull.percent === null ? ' idle' : ''}`}
                  style={pull.percent !== null ? { width: `${pull.percent}%` } : undefined}
                />
              </div>
              {pull.error && <div className="ou-sp-pull-error">{pull.error}</div>}
            </div>
          )}

          <div className="ou-sp-composer">
            <textarea
              className="ou-sp-input"
              value={input}
              rows={3}
              placeholder="Describe a task, or ask question"
              aria-label="Describe a task or ask a question"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                // Enter sends; Shift+Enter is a new line.
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  startRun()
                }
              }}
            />
            <div className="ou-sp-composer-controls">
              <div className="ou-sp-seg" role="radiogroup" aria-label="Run mode">
                <button type="button" role="radio" aria-checked={mode === 'ask'} className={`ou-sp-seg-btn${mode === 'ask' ? ' on' : ''}`} onClick={() => setMode('ask')}>Answer</button>
                <button type="button" role="radio" aria-checked={mode === 'do'} className={`ou-sp-seg-btn${mode === 'do' ? ' on' : ''}`} onClick={() => setMode('do')}>Act</button>
              </div>
              <button type="button" className="ou-sp-send" onClick={startRun} disabled={!input.trim()} aria-label="Send">
                <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M21.5 2.5L10.8 13.2M21.5 2.5l-6.8 19-3.9-8.3-8.3-3.9 19-6.8z" fill="currentColor" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /></svg>
              </button>
            </div>
          </div>

          {latest?.answer && (
            <div className="ou-sp-answer" data-testid="latest-answer">
              {latest.answer}
            </div>
          )}
        </div>
      </main>

      {showSettings && (
        <SettingsModal
          onClose={() => setShowSettings(false)}
          appVersion={appVersion}
          updateStatus={updateState.status}
          onCheckForUpdates={checkForUpdates}
        />
      )}
      {historyOpen && (
        <div className="ou-rc-history-drawer">
          <div className="ou-rc-history-scrim" onClick={() => onHistoryChange?.(false)} />
          <div className="ou-rc-history-panel">
            <ConversationList
              onSelect={(id) => { void window.openui.resumeConversation(id); onHistoryChange?.(false) }}
            />
          </div>
        </div>
      )}
    </div>
  )
}
