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
 * RunConsole — the Splen home screen:
 *
 *   sidebar: Splen mark · New chat · Channels · Recent chats · Settings
 *   main:    an empty chat is the greeting · character · composer; once you
 *            send something it becomes a thread — every message you sent and
 *            every answer, streamed as it is written — with the composer
 *            docked at the bottom, like any chat app.
 *
 * Under it sits the same pipeline as before: a run is beginTask +
 * window.openui.chat and the character's pose follows the real run state
 * (lib/buddyPose). A thread is the runs since the last New chat, plus — when a
 * past chat is reopened from Recent — that chat's saved messages.
 *
 * Approvals are NEVER shown inline here: onApprovalInline is always false, so
 * App's blocking HitlModal / PlanApprovalModal handles every confirmation. That
 * keeps "nothing is sent without asking" on the one surface that can't be
 * scrolled past.
 */

type Mode = 'ask' | 'do'

/** A saved message of a reopened chat (main's resume-conversation). */
interface PastTurn {
  role: 'user' | 'assistant'
  content: string
}

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

  // The open thread: runs from index `threadFrom` of the task list, after the
  // saved messages of a reopened chat (`past`). New chat moves `threadFrom` past
  // every run so far; the runs stay in the list for the character's pose.
  const [threadFrom, setThreadFrom] = useState(0)
  const [past, setPast] = useState<PastTurn[]>([])
  const [openChatId, setOpenChatId] = useState<string | null>(null)
  const tasksRef = useRef(tasks)
  tasksRef.current = tasks

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

  // Newest run first; the character follows the latest one.
  const runs = useMemo(() => [...tasks].reverse(), [tasks])

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

  const newChat = useCallback(() => {
    window.openui.clearHistory()
    focusTask(null)
    setInput('')
    setPast([])
    setOpenChatId(null)
    setThreadFrom(tasksRef.current.length)
  }, [focusTask])

  // Reopen a past chat: main loads it as the context for the next message and
  // returns its messages, which become the top of the thread.
  const openChat = useCallback(async (id: string) => {
    onHistoryChange?.(false)
    let messages: Awaited<ReturnType<typeof window.openui.resumeConversation>> = []
    try {
      messages = (await window.openui.resumeConversation(id)) ?? []
    } catch {
      messages = []
    }
    focusTask(null)
    setOpenChatId(id)
    setThreadFrom(tasksRef.current.length)
    setPast(
      messages
        .filter((m) => (m.role === 'user' || m.role === 'assistant') && (m.content ?? '').trim())
        .map((m) => ({ role: m.role as PastTurn['role'], content: m.content ?? '' }))
    )
  }, [focusTask, onHistoryChange])

  const threadRuns = useMemo(() => tasks.slice(threadFrom), [tasks, threadFrom])
  const inThread = past.length > 0 || threadRuns.length > 0
  const currentChatId = openChatId ?? threadRuns.find((r) => r.conversationId)?.conversationId ?? null

  // Keep the newest message in view while an answer streams in.
  const threadRef = useRef<HTMLDivElement>(null)
  const lastAnswerLength = threadRuns[threadRuns.length - 1]?.answer?.length ?? 0
  useEffect(() => {
    const el = threadRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [past.length, threadRuns.length, lastAnswerLength])

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

        <button type="button" className="ou-sp-newrun" onClick={newChat}>
          <span aria-hidden="true">+</span>
          <span>New chat</span>
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

        <div className="ou-sp-recent" aria-label="Recent chats">
          <div className="ou-sp-section-label">Recent</div>
          <ConversationList selectedId={currentChatId ?? undefined} onSelect={(id) => void openChat(id)} />
        </div>

        <div className="ou-sp-footer">
          <button type="button" className="ou-sp-channel" onClick={() => setShowSettings(true)}>
            <span className="ou-sp-channel-name">Settings</span>
          </button>
        </div>
      </aside>

      <main className={`ou-sp-main${inThread ? ' threaded' : ''}`}>
        {inThread ? (
          <div className="ou-sp-chat">
            <div className="ou-sp-thread" ref={threadRef} data-testid="thread">
              <div className="ou-sp-thread-inner">
                {past.map((m, k) =>
                  m.role === 'user' ? (
                    <div key={`p${k}`} className="ou-sp-msg user">{m.content}</div>
                  ) : (
                    <div key={`p${k}`} className="ou-sp-msg splen">{m.content}</div>
                  )
                )}
                {threadRuns.map((run, k) => {
                  const newest = k === threadRuns.length - 1
                  const working = run.status === 'in_progress'
                  const step = run.steps[run.steps.length - 1]?.label
                  return (
                    <div key={run.id} className="ou-sp-turn">
                      <div className="ou-sp-msg user">{run.title}</div>
                      {run.answer ? (
                        <div
                          className={`ou-sp-msg splen${working ? ' streaming' : ''}`}
                          data-testid={newest ? 'latest-answer' : undefined}
                        >
                          {run.answer}
                        </div>
                      ) : working ? (
                        <div className="ou-sp-msg splen pending" role="status" aria-live="polite">
                          <span className="ou-sp-dots" aria-hidden="true"><i /><i /><i /></span>
                          <span>{step ? `${step}…` : 'Thinking…'}</span>
                        </div>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            </div>
            <div className="ou-sp-dock">
              <div className="ou-sp-dock-status">
                <SplenBuddy pose={pose} />
                <span className="ou-sp-greeting small" aria-live="polite">{POSE_CAPTION[pose]}</span>
              </div>
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

            </div>
          </div>
        ) : (
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

          </div>
        )}
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
            <ConversationList selectedId={currentChatId ?? undefined} onSelect={(id) => void openChat(id)} />
          </div>
        </div>
      )}
    </div>
  )
}
