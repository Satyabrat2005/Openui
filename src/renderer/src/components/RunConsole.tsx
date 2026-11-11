import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, Settings as SettingsIcon } from 'lucide-react'
import type { HitlRequestPayload, PlanRequestPayload, ModelPullProgress, ModelStatus, TaskCard } from '../env'
import { useTaskActivity } from '../context/TaskActivityContext'
import { useAuth } from '../context/AuthContext'
import { getConnections, subscribeConnections, type ConnectableApp } from './ConnectAppsModal'
import SettingsModal, { type SettingsChannel, type SettingsSection } from './SettingsModal'
import ConversationList from './ConversationList'
import { useUpdater } from '../hooks/useUpdater'
import { formatBytes } from '../lib/formatBytes'
import { poseForRuns, POSE_CAPTION, DONE_LINGER_MS } from '../lib/buddyPose'
import SplenBuddy from './SplenBuddy'

/**
 * RunConsole — the Splen home screen.
 *
 *   sidebar: Splen · New chat · Recent chats · Channels · Settings
 *   main:    an empty chat is a greeting, the composer and three things to try;
 *            once you send something it becomes a thread — every message you
 *            sent and every answer, streamed as it is written — with the
 *            composer docked at the bottom.
 *
 * Every screen state is designed, not just the happy path: the Splen model
 * missing / downloading / failed (a strip above the composer), a reopened chat
 * loading (skeleton), an answer on its way (skeleton + the step it is on), and
 * a run that failed (the reason and a Try again).
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

/** main/models.ts SPLEN_MODEL — the id the model list reports Splen under. */
const SPLEN_MODEL_ID = 'openui/splen:4b'

/** The messaging channels Splen works across, in sidebar order. */
const CHANNELS: Array<{ id: SettingsChannel; name: string }> = [
  { id: 'whatsapp', name: 'WhatsApp' },
  { id: 'gmail', name: 'Gmail' },
  { id: 'telegram', name: 'Telegram' },
  { id: 'slack', name: 'Slack' }
]

/** Things to try on an empty chat — each fills the composer, never sends. */
const SUGGESTIONS = [
  'Summarise my unread WhatsApp chats',
  'What did I miss in Gmail today?',
  'Draft a reply to my last Telegram message'
]

function greeting(now = new Date()): string {
  const h = now.getHours()
  if (h < 5) return 'Good evening'
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  return 'Good evening'
}

/** The Splen mark — a single hooked brush stroke. */
function SplenMark(): JSX.Element {
  return (
    <svg className="ou-sp-mark" width="22" height="22" viewBox="0 0 32 32" aria-hidden="true">
      <path
        d="M11 3.5c-1.6 3.4-3.2 8.6-3 13.4.2 5.2 3.4 9.6 8.6 9.6 4.8 0 8.2-3.5 8.2-7.8 0-4.1-3-7-6.8-7-3 0-5.4 1.8-6.4 4.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M11 3.5l3.4 2.6" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  )
}

/** Placeholder lines while text is on its way. */
function Skeleton({ lines = 3 }: { lines?: number }): JSX.Element {
  return (
    <div className="ou-sp-skeleton" aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} style={{ width: `${[92, 78, 54, 70][i % 4]}%` }} />
      ))}
    </div>
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
  const [settingsAt, setSettingsAt] = useState<{ section: SettingsSection; channel?: SettingsChannel } | null>(null)
  const showSettings = settingsAt !== null
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // The open thread: runs from index `threadFrom` of the task list, after the
  // saved messages of a reopened chat (`past`). New chat moves `threadFrom` past
  // every run so far; the runs stay in the list for the character's pose.
  const [threadFrom, setThreadFrom] = useState(0)
  const [past, setPast] = useState<PastTurn[]>([])
  const [openChatId, setOpenChatId] = useState<string | null>(null)
  const [resuming, setResuming] = useState(false)
  const [resumeError, setResumeError] = useState(false)
  const tasksRef = useRef(tasks)
  tasksRef.current = tasks
  // Splen answers one message at a time (main refuses a second turn). While an
  // answer is running, Send, New chat and opening a past chat wait for it.
  const busy = tasks.some((t) => t.status === 'in_progress')
  const isBusy = (): boolean => tasksRef.current.some((t) => t.status === 'in_progress')

  useEffect(() => { onApprovalInline?.(false) }, [onApprovalInline])

  // Channel status: Gmail is Google OAuth from Settings; Telegram and Slack are
  // "on" once Settings holds a token for them; WhatsApp is built in.
  const [conns, setConns] = useState<ConnectableApp[]>(getConnections())
  useEffect(() => subscribeConnections(() => setConns(getConnections())), [])
  const [gmailOn, setGmailOn] = useState(false)
  useEffect(() => {
    window.openui.gmailStatus?.().then((s) => setGmailOn(Boolean(s?.connected))).catch(() => {})
  }, [showSettings])
  const [tokenOn, setTokenOn] = useState({ telegram: false, slack: false })
  useEffect(() => {
    const has = (key: string): Promise<boolean> =>
      window.openui.getSetting(key).then((v) => typeof v === 'string' && v.trim() !== '', () => false)
    void Promise.all([has('telegram_bot_token'), has('slack_token')]).then(([telegram, slack]) => setTokenOn({ telegram, slack }))
  }, [showSettings])
  const channelOn = (id: SettingsChannel): boolean =>
    id === 'gmail'
      ? gmailOn
      : id === 'telegram' || id === 'slack'
        ? tokenOn[id] || conns.some((c) => c.id === id && c.state === 'connected')
        : conns.some((c) => c.id === id && c.state === 'connected')

  // ── The Splen model: is it on this computer? ──────────────────────────────
  // null = still checking (or the list could not be read): no strip at all.
  const [splen, setSplen] = useState<ModelStatus | null>(null)
  const [splenError, setSplenError] = useState<string | null>(null)
  const refreshModels = useCallback(() => {
    window.openui
      .listLocalModels?.()
      .then((list) => setSplen((list ?? []).find((m) => m.id === SPLEN_MODEL_ID) ?? null))
      .catch(() => setSplen(null))
  }, [])
  useEffect(() => { refreshModels() }, [refreshModels, showSettings])

  // Download progress (Splen's download reports on the same channel).
  const [pull, setPull] = useState<ModelPullProgress | null>(null)
  useEffect(
    () =>
      window.openui.onModelPull((p) => {
        setPull(p)
        if (p.done) {
          refreshModels()
          window.setTimeout(() => setPull(null), 2500)
        }
      }),
    [refreshModels]
  )
  const downloadSplen = useCallback(async () => {
    setSplenError(null)
    setPull({ model: SPLEN_MODEL_ID, status: 'starting download', percent: null, completed: null, total: null, layer: null, done: false })
    try {
      const result = await window.openui.downloadModel(SPLEN_MODEL_ID)
      if (!result.ok) {
        setSplenError(result.message)
        setPull(null)
      }
    } catch {
      setSplenError('The download could not start. Check your connection and try again.')
      setPull(null)
    } finally {
      refreshModels()
    }
  }, [refreshModels])

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

  const send = useCallback(
    (raw: string) => {
      const text = raw.trim()
      if (!text || isBusy()) return
      setModes((m) => ({ ...m, [text]: mode }))
      // The same send path as before: beginTask opens the run, chat() runs it.
      beginTask(text, 'chat')
      void window.openui.chat(text, tier).catch(() => {})
    },
    [beginTask, tier, mode]
  )

  const startRun = useCallback(() => {
    if (!input.trim() || isBusy()) return
    send(input)
    setInput('')
  }, [input, send])

  const newChat = useCallback(() => {
    if (isBusy()) return
    window.openui.clearHistory()
    focusTask(null)
    setInput('')
    setPast([])
    setOpenChatId(null)
    setResumeError(false)
    setThreadFrom(tasksRef.current.length)
    inputRef.current?.focus()
  }, [focusTask])

  // Ctrl/Cmd+N starts a new chat, as in every chat app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        newChat()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [newChat])

  // Reopen a past chat: main loads it as the context for the next message and
  // returns its messages, which become the top of the thread.
  const openChat = useCallback(async (id: string) => {
    if (isBusy()) return
    onHistoryChange?.(false)
    focusTask(null)
    setOpenChatId(id)
    setThreadFrom(tasksRef.current.length)
    setPast([])
    setResumeError(false)
    setResuming(true)
    try {
      const messages = (await window.openui.resumeConversation(id)) ?? []
      setPast(
        messages
          .filter((m) => (m.role === 'user' || m.role === 'assistant') && (m.content ?? '').trim())
          .map((m) => ({ role: m.role as PastTurn['role'], content: m.content ?? '' }))
      )
    } catch {
      setResumeError(true)
    } finally {
      setResuming(false)
    }
  }, [focusTask, onHistoryChange])

  const threadRuns = useMemo(() => tasks.slice(threadFrom), [tasks, threadFrom])
  const inThread = resuming || resumeError || past.length > 0 || threadRuns.length > 0
  const currentChatId = openChatId ?? threadRuns.find((r) => r.conversationId)?.conversationId ?? null

  // Keep the newest message in view while an answer streams in.
  const threadRef = useRef<HTMLDivElement>(null)
  const lastAnswerLength = threadRuns[threadRuns.length - 1]?.answer?.length ?? 0
  useEffect(() => {
    const el = threadRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [past.length, threadRuns.length, lastAnswerLength])

  // The composer grows with what you type, up to a limit, then scrolls.
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [input, inThread])

  // Replay the starter prompt chosen in First Run exactly once.
  const replayedRef = useRef(false)
  useEffect(() => {
    const msg = initialMessage?.trim()
    if (!msg || replayedRef.current) return
    replayedRef.current = true
    beginTask(msg, 'chat')
    void window.openui.chat(msg, tier).catch(() => {})
  }, [initialMessage, beginTask, tier])

  const pullActive = pull !== null && !pull.done && pull.model === SPLEN_MODEL_ID
  const showModelStrip = splen !== null && (!splen.installed || pullActive || splenError !== null)

  const modelStrip = showModelStrip ? (
    <div className={`ou-sp-model${splenError ? ' error' : ''}`} role="status" aria-live="polite" data-testid="model-strip">
      {splenError ? (
        <>
          <div className="ou-sp-model-text">
            <span className="ou-sp-model-title">The Splen download stopped</span>
            <span className="ou-sp-model-sub">{splenError}</span>
          </div>
          <button type="button" className="ou-sp-btn" onClick={() => void downloadSplen()}>Try again</button>
        </>
      ) : pullActive ? (
        <>
          <div className="ou-sp-model-text">
            <span className="ou-sp-model-title">Downloading Splen</span>
            <span className="ou-sp-model-sub ou-sp-mono">
              {pull?.percent != null
                ? `${pull.percent}%${pull.total != null ? ` · ${formatBytes(pull.completed)} of ${formatBytes(pull.total)}` : ''}`
                : pull?.status}
            </span>
          </div>
          <div className="ou-sp-model-track" aria-hidden="true">
            <div
              className={`ou-sp-model-fill${pull?.percent == null ? ' idle' : ''}`}
              style={pull?.percent != null ? { width: `${pull.percent}%` } : undefined}
            />
          </div>
        </>
      ) : (
        <>
          <div className="ou-sp-model-text">
            <span className="ou-sp-model-title">Download Splen to get started</span>
            <span className="ou-sp-model-sub">One time, {splen?.approxSize}. It runs on this computer — your messages never leave it.</span>
          </div>
          <button type="button" className="ou-sp-btn primary" onClick={() => void downloadSplen()}>Download</button>
        </>
      )}
    </div>
  ) : null

  const composer = (
    <div className="ou-sp-composer">
      <textarea
        ref={inputRef}
        className="ou-sp-input"
        value={input}
        rows={1}
        placeholder={inThread ? 'Reply to Splen…' : 'Ask about your messages, or tell Splen what to do'}
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
      <div className="ou-sp-composer-bar">
        <div className="ou-sp-seg" role="radiogroup" aria-label="Run mode">
          <button type="button" role="radio" aria-checked={mode === 'ask'} className={`ou-sp-seg-btn${mode === 'ask' ? ' on' : ''}`} onClick={() => setMode('ask')}>Answer</button>
          <button type="button" role="radio" aria-checked={mode === 'do'} className={`ou-sp-seg-btn${mode === 'do' ? ' on' : ''}`} onClick={() => setMode('do')}>Act</button>
        </div>
        <span className="ou-sp-hint">{mode === 'do' ? 'Splen asks before it sends anything' : 'Splen only reads and answers'}</span>
        <button type="button" className="ou-sp-send" onClick={startRun} disabled={!input.trim() || busy} aria-label={busy ? 'Splen is still answering' : 'Send'} title={busy ? 'Splen is still answering' : undefined}>
          <ArrowUp size={17} strokeWidth={2.25} aria-hidden="true" />
        </button>
      </div>
    </div>
  )

  const renderRun = (run: TaskCard, newest: boolean): JSX.Element => {
    const working = run.status === 'in_progress'
    const failed = run.status === 'failed'
    const step = run.steps[run.steps.length - 1]?.label
    return (
      <div key={run.id} className="ou-sp-turn">
        <div className="ou-sp-msg user">{run.title}</div>
        {failed ? (
          <div className="ou-sp-msg splen failed" role="alert" data-testid={newest ? 'latest-answer' : undefined}>
            <span className="ou-sp-failed-label">Couldn’t finish this</span>
            <span>{run.answer || 'Something went wrong before Splen could answer.'}</span>
            <button type="button" className="ou-sp-btn" onClick={() => send(run.title)}>Try again</button>
          </div>
        ) : run.answer ? (
          <div className={`ou-sp-msg splen${working ? ' streaming' : ''}`} data-testid={newest ? 'latest-answer' : undefined}>
            {run.answer}
          </div>
        ) : working ? (
          <div className="ou-sp-msg splen pending" role="status" aria-live="polite">
            <span className="ou-sp-step">{step ? `${step}…` : 'Thinking…'}</span>
            <Skeleton lines={2} />
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <div className="ou-rc ou-sp">
      <aside className="ou-sp-sidebar">
        <div className="ou-sp-brand">
          <SplenMark />
          <span className="ou-sp-brand-name">Splen</span>
        </div>

        <button type="button" className="ou-sp-newrun" onClick={newChat} disabled={busy} title={busy ? 'Wait for Splen to finish answering' : undefined}>
          <span className="ou-sp-newrun-plus" aria-hidden="true">+</span>
          <span>New chat</span>
          <kbd className="ou-sp-kbd" aria-hidden="true">Ctrl N</kbd>
        </button>

        <div className="ou-sp-recent" aria-label="Recent chats">
          <div className="ou-sp-section-label">Recent</div>
          <ConversationList selectedId={currentChatId ?? undefined} onSelect={(id) => void openChat(id)} />
        </div>

        <nav className="ou-sp-channels" aria-label="Channels">
          <div className="ou-sp-section-label">Channels</div>
          {CHANNELS.map((ch) => {
            const on = channelOn(ch.id)
            return (
              <button
                key={ch.id}
                type="button"
                className={`ou-sp-channel${on ? ' on' : ''}`}
                onClick={() => setSettingsAt({ section: 'channels', channel: ch.id })}
                title={on ? `${ch.name} is connected` : `Set up ${ch.name} in Settings`}
              >
                <span className="ou-sp-channel-dot" aria-hidden="true" />
                <span className="ou-sp-channel-name">{ch.name}</span>
                <span className="ou-sp-channel-state">{on ? 'On' : 'Set up'}</span>
                {on && <span className="ou-sr-only">{`${ch.name} connected`}</span>}
              </button>
            )
          })}
        </nav>

        <button type="button" className="ou-sp-channel ou-sp-settings" onClick={() => setSettingsAt({ section: 'general' })}>
          <SettingsIcon size={16} strokeWidth={1.75} aria-hidden="true" />
          <span className="ou-sp-channel-name">Settings</span>
        </button>
      </aside>

      <main className={`ou-sp-main${inThread ? ' threaded' : ''}`}>
        {inThread ? (
          <div className="ou-sp-chat">
            <div className="ou-sp-thread" ref={threadRef} data-testid="thread">
              <div className="ou-sp-thread-inner">
                {resuming && (
                  <div className="ou-sp-turn" data-testid="thread-loading">
                    <Skeleton lines={1} />
                    <Skeleton lines={3} />
                  </div>
                )}
                {resumeError && (
                  <div className="ou-sp-msg splen failed" role="alert">
                    <span className="ou-sp-failed-label">This chat couldn’t be opened</span>
                    <span>It may have been removed. Start a new chat, or pick another from Recent.</span>
                    <button type="button" className="ou-sp-btn" onClick={newChat}>New chat</button>
                  </div>
                )}
                {past.map((m, k) => (
                  <div key={`p${k}`} className={`ou-sp-msg ${m.role === 'user' ? 'user' : 'splen'}`}>{m.content}</div>
                ))}
                {threadRuns.map((run, k) => renderRun(run, k === threadRuns.length - 1))}
              </div>
            </div>
            <div className="ou-sp-dock">
              <div className="ou-sp-dock-status">
                <SplenBuddy pose={pose} />
                <span className="ou-sp-greeting small" aria-live="polite">{POSE_CAPTION[pose]}</span>
              </div>
              {modelStrip}
              {composer}
            </div>
          </div>
        ) : (
          <div className="ou-sp-stage">
            <div className="ou-sp-hero">
              <SplenBuddy pose={pose} />
              <h1 className="ou-sp-display">
                {greeting()}<span className="ou-sp-display-dot">.</span>
              </h1>
              <p className="ou-sp-lede" aria-live="polite">
                <span className="ou-sp-greeting">{POSE_CAPTION[pose]}</span>{' '}
                Ask about your WhatsApp, Gmail and Telegram, or have Splen reply for you.
              </p>
            </div>
            {modelStrip}
            {composer}
            <ul className="ou-sp-suggest" aria-label="Things to try">
              {SUGGESTIONS.map((s) => (
                <li key={s}>
                  <button
                    type="button"
                    className="ou-sp-suggest-row"
                    onClick={() => {
                      setInput(s)
                      inputRef.current?.focus()
                    }}
                  >
                    <span>{s}</span>
                    <span className="ou-sp-suggest-arrow" aria-hidden="true">→</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </main>

      {settingsAt && (
        <SettingsModal
          initialSection={settingsAt.section}
          initialChannel={settingsAt.channel}
          onClose={() => setSettingsAt(null)}
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
