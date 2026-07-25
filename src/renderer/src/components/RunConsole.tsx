import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TaskCard, TouchedResource, Workflow, HitlRequestPayload, PlanRequestPayload } from '../env'
import type { AppKind } from '../lib/appKind'
import { useTaskActivity } from '../context/TaskActivityContext'
import { useAuth } from '../context/AuthContext'
import { queueOf, statusToken, resolveInspectorOpen, inlineApprovalVisible, connectedScope } from '../lib/runQueue'
import ConnectAppsModal, { getConnections, subscribeConnections, type ConnectableApp } from './ConnectAppsModal'
import SettingsModal from './SettingsModal'
import ConversationList from './ConversationList'
import WorkflowsUI from './WorkflowsUI'
import { useUpdater } from '../hooks/useUpdater'

/**
 * RunConsole — the three-column working surface (README § D). Replaces the old
 * AssistantPopup + ActivityPanel + ConnectedRail layout with:
 *
 *   sidebar (246px) · content (composer + run ledger) · inspector (352px)
 *
 * Every region is wired to its REAL source in the same pass: the ledger maps
 * TaskActivityContext cards → run rows; the sidebar's RUNS counts and the
 * composer scope pills come from the queue model + the live connection store;
 * "Start run" reuses the existing chat pipeline (beginTask + window.openui.chat);
 * the inspector reads plan/touched/guardrails from the focused card + settings.
 */

type Mode = 'ask' | 'do'
type Filter = 'all' | 'running' | 'waiting' | 'done'
type GuardKey = 'confirm_send' | 'never_delete' | 'redact_cards' | 'block_paid'

const GUARD_META: Array<{ key: GuardKey; label: string }> = [
  { key: 'confirm_send', label: 'Confirm before sending' },
  { key: 'never_delete', label: 'Never delete files' },
  { key: 'redact_cards', label: 'Redact card numbers' },
  { key: 'block_paid', label: 'Block paid actions' }
]
const GUARD_SETTING: Record<GuardKey, string> = {
  confirm_send: 'guard_confirm_send',
  never_delete: 'guard_never_delete',
  redact_cards: 'guard_redact_cards',
  block_paid: 'guard_block_paid'
}

/** Two-letter mono badge per app kind (handoff badge geometry). */
const BADGE: Record<AppKind, string> = {
  browser: 'WB', github: 'GH', figma: 'FI', files: 'FS', clipboard: 'CB',
  calendar: 'CA', screen: 'SC', whatsapp: 'WA', messaging: 'MS', app: 'AP', thinking: '··'
}
const APP_LABEL: Record<AppKind, string> = {
  browser: 'Web', github: 'GitHub', figma: 'Figma', files: 'Files', clipboard: 'Clipboard',
  calendar: 'Calendar', screen: 'Screen', whatsapp: 'WhatsApp', messaging: 'Messaging', app: 'App', thinking: 'Thinking'
}

/** Reused from ActivityPanel — elapsed/duration formatting (do not reimplement). */
function durationLabel(card: TaskCard): string {
  const end = card.endedAt ?? Date.now()
  const ms = end - card.startedAt
  if (ms < 1000) return '0:00'
  const s = Math.round(ms / 1000)
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

/**
 * Poll a live thumbnail of the primary display while `active`, so the inspector
 * can show a real "watch it run" feed — the same read-only desktopCapturer path
 * read_screen() uses (main's `openui:screen:thumbnail`). 700ms reads like video
 * without the capture cost of a true stream; the last frame is kept between
 * polls so a transient failure never blanks the view.
 */
function useScreenThumbnail(active: boolean): string | null {
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const busy = useRef(false)
  useEffect(() => {
    if (!active) {
      setDataUrl(null)
      return
    }
    let live = true
    const tick = async (): Promise<void> => {
      if (busy.current) return
      busy.current = true
      try {
        const res = await window.openui.captureScreenThumbnail()
        if (live && res.ok && res.dataUrl) setDataUrl(res.dataUrl)
      } catch {
        /* transient capture failure — keep the last frame */
      } finally {
        busy.current = false
      }
    }
    void tick()
    const id = window.setInterval(() => void tick(), 700)
    return () => {
      live = false
      window.clearInterval(id)
    }
  }, [active])
  return dataUrl
}

interface RunConsoleProps {
  initialMessage?: string | null
  /** Active plain (non-choice) HITL request, surfaced inline when its run is visible. */
  hitlRequest?: HitlRequestPayload | null
  /** Active plan-approval request, surfaced inline when its run is visible. */
  planRequest?: PlanRequestPayload | null
  onRespondHitl?: (approved: boolean) => void
  onRespondPlan?: (approved: boolean) => void
  /** Reports whether an approval is currently shown INLINE (so App can suppress the modal). */
  onApprovalInline?: (shown: boolean) => void
  /** Workspace/conversation-history drawer open state (controlled by App so the
   *  title-bar switcher and the account row share one drawer). */
  historyOpen?: boolean
  onHistoryChange?: (open: boolean) => void
}

export default function RunConsole({
  initialMessage,
  hitlRequest,
  planRequest,
  onRespondHitl,
  onRespondPlan,
  onApprovalInline,
  historyOpen = false,
  onHistoryChange
}: RunConsoleProps): JSX.Element {
  const { tasks, beginTask, focusedId, focusTask, runningCount, waitingCount } = useTaskActivity()
  const { tier, user } = useAuth()
  const { updateState, appVersion, checkForUpdates } = useUpdater()

  const [mode, setMode] = useState<Mode>('do')
  const [filter, setFilter] = useState<Filter>('all')
  const [input, setInput] = useState('')
  const [showConnect, setShowConnect] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showWorkflows, setShowWorkflows] = useState(false)
  const setShowHistory = (open: boolean): void => onHistoryChange?.(open)

  // Live connection store — single source of truth for CONNECTED + scope pills.
  const [conns, setConns] = useState<ConnectableApp[]>(getConnections())
  useEffect(() => subscribeConnections(() => setConns(getConnections())), [])
  const connected = useMemo(() => connectedScope(conns), [conns])

  // Scheduled runs have no live TaskCard — they come from saved workflows.
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  useEffect(() => {
    window.openui.listWorkflows().then(setWorkflows).catch(() => setWorkflows([]))
  }, [])

  // Guardrails: global defaults from settings (shared with First Run), plus
  // per-run overrides layered on top (README separates the two — don't collapse).
  const [globalGuards, setGlobalGuards] = useState<Record<GuardKey, boolean>>({
    confirm_send: true, never_delete: true, redact_cards: true, block_paid: true
  })
  useEffect(() => {
    GUARD_META.forEach(({ key }) => {
      window.openui.getSetting(GUARD_SETTING[key]).then((v) => {
        if (typeof v === 'boolean') setGlobalGuards((g) => ({ ...g, [key]: v }))
      }).catch(() => {})
    })
  }, [])
  const [perRunGuards, setPerRunGuards] = useState<Record<string, Partial<Record<GuardKey, boolean>>>>({})

  // Inspector auto-collapse: narrow = width < 1180; hidden when narrow unless the
  // user explicitly opened it. Manual state ALWAYS wins over the responsive value
  // (a manual open is not clobbered by the next resize).
  const [narrow, setNarrow] = useState(() => window.innerWidth < 1180)
  const [inspectorManual, setInspectorManual] = useState<boolean | null>(null)
  useEffect(() => {
    const onResize = (): void => setNarrow(window.innerWidth < 1180)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const inspectorOpen = resolveInspectorOpen(inspectorManual, narrow)

  // Newest run first.
  const runs = useMemo(() => [...tasks].reverse(), [tasks])
  const selected = runs.find((r) => r.id === focusedId) ?? runs[0] ?? null

  const filtered = useMemo(
    () => runs.filter((r) => {
      if (filter === 'all') return true
      if (filter === 'running') return queueOf(r) === 'active' && r.status === 'in_progress'
      if (filter === 'waiting') return queueOf(r) === 'waiting'
      return r.status !== 'in_progress'
    }),
    [runs, filter]
  )
  const finishedCount = runs.filter((r) => r.status !== 'in_progress').length

  // ── Inline approval reconciliation ──────────────────────────────────────────
  // A HITL/plan request belongs to the run currently paused on it (queue ===
  // 'waiting'). If that run is visible in the ledger we render the callout inline
  // and tell App to suppress the modal; otherwise App keeps the modal fallback so
  // the request is never silently missed.
  const hasRequest = !!(hitlRequest || planRequest)
  const approvalTarget = useMemo(() => runs.find((r) => queueOf(r) === 'waiting') ?? null, [runs])
  const inlineVisible = inlineApprovalVisible(hasRequest, approvalTarget?.id, filtered.map((r) => r.id))
  useEffect(() => { onApprovalInline?.(inlineVisible) }, [inlineVisible, onApprovalInline])
  // Cleanup: if this console unmounts, make sure App re-enables its modal.
  useEffect(() => () => onApprovalInline?.(false), [onApprovalInline])

  const approvalFor = (run: TaskCard): ApprovalCallout | null => {
    if (!hasRequest || run.id !== approvalTarget?.id) return null
    if (planRequest) {
      return {
        title: 'Approve the plan',
        detail: `${planRequest.summary} (${planRequest.steps.length} step${planRequest.steps.length === 1 ? '' : 's'})`,
        onApprove: () => onRespondPlan?.(true),
        onDeny: () => onRespondPlan?.(false)
      }
    }
    if (hitlRequest) {
      return {
        title: 'Approve this action',
        detail: hitlRequest.label,
        onApprove: () => onRespondHitl?.(true),
        onDeny: () => onRespondHitl?.(false)
      }
    }
    return null
  }

  const startRun = useCallback(() => {
    const text = input.trim()
    if (!text) return
    // Reuse the existing pipeline exactly — beginTask opens the ledger row, and
    // window.openui.chat(message, tier) is the SAME send path AssistantPopup uses.
    beginTask(text, 'chat')
    void window.openui.chat(text, tier).catch(() => {})
    setInput('')
  }, [input, beginTask, tier])

  const newRun = useCallback(() => {
    window.openui.clearHistory()
    focusTask(null)
    setInput('')
  }, [focusTask])

  // Run a saved workflow through the same pipeline as a typed run.
  const runWorkflow = useCallback((name: string) => {
    const msg = `Run workflow: ${name}`
    beginTask(msg, 'chat')
    void window.openui.chat(msg, tier).catch(() => {})
    setShowWorkflows(false)
  }, [beginTask, tier])

  // Replay the starter prompt chosen in First Run exactly once, through the same
  // pipeline, so it lands as a live run row the moment the console mounts.
  const replayedRef = useRef(false)
  useEffect(() => {
    const msg = initialMessage?.trim()
    if (!msg || replayedRef.current) return
    replayedRef.current = true
    beginTask(msg, 'chat')
    void window.openui.chat(msg, tier).catch(() => {})
  }, [initialMessage, beginTask, tier])

  const effGuard = (runId: string | undefined, key: GuardKey): boolean => {
    const override = runId ? perRunGuards[runId]?.[key] : undefined
    return override ?? globalGuards[key]
  }
  const toggleGuard = (runId: string, key: GuardKey): void => {
    setPerRunGuards((m) => ({ ...m, [runId]: { ...m[runId], [key]: !effGuard(runId, key) } }))
  }

  return (
    <div className="ou-rc">
      {/* ── Sidebar ─────────────────────────────────────────────────────── */}
      <aside className="ou-rc-sidebar">
        <button type="button" className="ou-rc-newrun" onClick={newRun}>
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 2v10M2 7h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          <span>New run</span>
          <span className="ou-rc-kbd">⌘N</span>
        </button>

        <div className="ou-rc-group">
          <div className="ou-rc-group-label">RUNS</div>
          <QueueRow label="Active" count={runningCount} dot="running" active={filter === 'running'} onClick={() => setFilter('running')} />
          <QueueRow label="Needs you" count={waitingCount} dot="waiting" active={filter === 'waiting'} onClick={() => setFilter('waiting')} />
          <QueueRow label="Scheduled" count={workflows.length} dot="scheduled" active={false} onClick={() => setShowHistory(false)} />
          <QueueRow label="Finished" count={finishedCount} dot="finished" active={filter === 'done'} onClick={() => setFilter('done')} />
        </div>

        <div className="ou-rc-group">
          <div className="ou-rc-group-label ou-rc-group-label-row">
            <span>CONNECTED</span>
            <button type="button" className="ou-rc-add" onClick={() => setShowConnect(true)}>+ ADD</button>
          </div>
          {conns.map((app) => {
            const on = app.state === 'connected'
            return (
              <div key={app.id} className="ou-rc-conn">
                <span className="ou-rc-badge" aria-hidden="true">{BADGE[app.kind] ?? app.name.slice(0, 2).toUpperCase()}</span>
                <span className="ou-rc-conn-name">{app.name}</span>
                <span className={`ou-rc-conn-state ${on ? 'on' : 'off'}`} aria-label={`${app.name} ${on ? 'connected' : 'not connected'}`}>
                  {on && <span className="ou-rc-conn-dot" />}
                  {on ? 'ON' : 'OFF'}
                </span>
              </div>
            )
          })}
        </div>

        <div className="ou-rc-sidebar-footer">
          <button type="button" className="ou-rc-foot-row" onClick={() => setShowSettings(true)}>
            <svg width="15" height="15" viewBox="0 0 15 15" aria-hidden="true"><path d="M2 4h11M2 7.5h11M2 11h11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
            <span>Settings</span>
          </button>
          <button type="button" className="ou-rc-account" onClick={() => setShowHistory(true)} title="Workspace history">
            <span className="ou-rc-avatar" aria-hidden="true">{(user?.name ?? user?.email ?? 'You').slice(0, 1).toUpperCase()}</span>
            <span className="ou-rc-account-body">
              <span className="ou-rc-account-name">{user?.name ?? user?.email ?? 'Guest'}</span>
              <span className="ou-rc-account-sub">LOCAL · OLLAMA</span>
            </span>
          </button>
        </div>
      </aside>

      {/* ── Content (composer + ledger) ─────────────────────────────────── */}
      <div className="ou-rc-content">
        <div className="ou-rc-composer-wrap">
          <div className="ou-rc-composer">
            <div className="ou-rc-composer-row1">
              <span className="ou-rc-check" aria-hidden="true">
                <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 6.2l2.6 2.6L10 3" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </span>
              <input
                className="ou-rc-input"
                value={input}
                placeholder="Describe a task, or ask a question. @ to attach context"
                aria-label="Describe a task or ask a question"
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) startRun() }}
              />
              <div className="ou-rc-seg" role="radiogroup" aria-label="Run mode">
                <button type="button" role="radio" aria-checked={mode === 'ask'} className={`ou-rc-seg-btn${mode === 'ask' ? ' on' : ''}`} onClick={() => setMode('ask')}>Answer</button>
                <button type="button" role="radio" aria-checked={mode === 'do'} className={`ou-rc-seg-btn${mode === 'do' ? ' on' : ''}`} onClick={() => setMode('do')}>Act</button>
              </div>
            </div>
            <div className="ou-rc-cantouch">
              <span className="ou-rc-cantouch-label">CAN TOUCH</span>
              {connected.length === 0 && <span className="ou-rc-cantouch-empty">Nothing connected yet</span>}
              {connected.map((app) => (
                <span key={app.id} className="ou-rc-pill">
                  <span className="ou-rc-pill-badge" aria-hidden="true">{BADGE[app.kind] ?? app.name.slice(0, 2).toUpperCase()}</span>
                  <span className="ou-rc-pill-name">{app.name}</span>
                  <span className="ou-rc-pill-perm">{app.kind === 'browser' ? 'browse' : 'read/write'}</span>
                </span>
              ))}
              <button type="button" className="ou-rc-pill-add" onClick={() => setShowConnect(true)}>+ scope</button>
              <div className="ou-rc-cantouch-right">
                <span className="ou-rc-model">llama-3.3-70b</span>
                <div className="ou-rc-cantouch-div" />
                <button type="button" className="ou-rc-startrun" onClick={startRun} disabled={!input.trim()}>
                  Start run <span className="ou-rc-kbd ou-rc-kbd-on">⌘↵</span>
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="ou-rc-ledger">
          <div className="ou-rc-ledger-head">
            <span className="ou-rc-ledger-title">Run ledger</span>
            <span className="ou-rc-ledger-meta">today · {runs.length} run{runs.length === 1 ? '' : 's'}</span>
            <div className="ou-rc-filters">
              {(['all', 'running', 'waiting', 'done'] as Filter[]).map((f) => (
                <button key={f} type="button" className={`ou-rc-filter${filter === f ? ' on' : ''}`} onClick={() => setFilter(f)}>
                  {f === 'all' ? 'All' : f === 'running' ? 'Running' : f === 'waiting' ? 'Needs you' : 'Finished'}
                </button>
              ))}
            </div>
          </div>

          {filtered.length === 0 ? (
            <div className="ou-rc-empty">
              <div className="ou-rc-empty-title">No runs yet</div>
              <div className="ou-rc-empty-sub">Describe a task above and press Start run — it appears here live.</div>
            </div>
          ) : (
            filtered.map((run) => (
              <RunRow key={run.id} run={run} selected={selected?.id === run.id} onSelect={() => focusTask(run.id)} approval={approvalFor(run)} />
            ))
          )}

          <div className="ou-rc-wf-head-row">
            <span className="ou-rc-wf-head">Saved workflows</span>
            <button type="button" className="ou-rc-add" onClick={() => setShowWorkflows(true)}>MANAGE</button>
          </div>
          {workflows.length === 0 ? (
            <div className="ou-rc-empty-sub">No saved workflows yet — import one from Manage.</div>
          ) : (
            <div className="ou-rc-wf-grid">
              {workflows.map((wf) => (
                <button key={wf.name} type="button" className="ou-rc-wf-card" onClick={() => runWorkflow(wf.name)} title={`Run “${wf.name}”`}>
                  <div className="ou-rc-wf-name">{wf.name}</div>
                  <div className="ou-rc-wf-trigger">{wf.trigger || 'manual'}</div>
                  <div className="ou-rc-wf-foot">{wf.steps.length} step{wf.steps.length === 1 ? '' : 's'}</div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Inspector ───────────────────────────────────────────────────── */}
      {inspectorOpen && (
        <Inspector
          run={selected}
          onClose={() => setInspectorManual(false)}
          guardValue={(k) => effGuard(selected?.id, k)}
          onToggleGuard={(k) => selected && toggleGuard(selected.id, k)}
        />
      )}
      {!inspectorOpen && (
        <button type="button" className="ou-rc-inspector-tab" onClick={() => setInspectorManual(true)} aria-label="Open inspector">
          ‹
        </button>
      )}

      {showWorkflows && <WorkflowsUI onClose={() => setShowWorkflows(false)} onRunWorkflow={runWorkflow} />}
      {showConnect && <ConnectAppsModal onClose={() => setShowConnect(false)} />}
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
          <div className="ou-rc-history-scrim" onClick={() => setShowHistory(false)} />
          <div className="ou-rc-history-panel">
            {/* Conversation/run coexistence (Step 8): browse + resume full threads
                here while the ledger shows runs. Resuming reloads that thread's
                context via the same resumeConversation IPC used today. */}
            <ConversationList
              onSelect={(id) => { void window.openui.resumeConversation(id); setShowHistory(false) }}
            />
          </div>
        </div>
      )}
    </div>
  )
}

// ── Sidebar queue row ─────────────────────────────────────────────────────────
function QueueRow({ label, count, dot, active, onClick }: { label: string; count: number; dot: string; active: boolean; onClick: () => void }): JSX.Element {
  return (
    <button type="button" className={`ou-rc-queue${active ? ' active' : ''}`} onClick={onClick}>
      <span className={`ou-rc-queue-dot ${dot}`} aria-hidden="true" />
      <span className="ou-rc-queue-label">{label}</span>
      <span className="ou-rc-queue-count">{count}</span>
    </button>
  )
}

// ── Run row ───────────────────────────────────────────────────────────────────
interface ApprovalCallout {
  title: string
  detail: string
  onApprove: () => void
  onDeny: () => void
}

function RunRow({ run, selected, onSelect, approval }: { run: TaskCard; selected: boolean; onSelect: () => void; approval?: ApprovalCallout | null }): JSX.Element {
  const token = statusToken(run)
  const running = run.status === 'in_progress'
  const trace = run.steps.slice(-3)
  const totalSteps = run.steps.length
  const doneSteps = run.steps.filter((s) => s.status === 'done').length

  return (
    <div
      className={`ou-rc-run ${token.cls}${selected ? ' selected' : ''}`}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') onSelect() }}
    >
      <div className={`ou-rc-run-tile ${token.cls}${running ? ' live' : ''}`} aria-hidden="true">
        <span className="ou-rc-run-tile-dot" />
      </div>
      <div className="ou-rc-run-body">
        <div className="ou-rc-run-head">
          <span className="ou-rc-run-title">{run.title}</span>
          <span className={`ou-rc-run-token ${token.cls}`}>{token.label}</span>
        </div>
        <div className="ou-rc-run-meta">
          <span className="ou-rc-run-elapsed">{durationLabel(run)}</span>
          {totalSteps > 0 && (<><span className="ou-rc-run-sep">|</span><span>step {Math.min(doneSteps + (running ? 1 : 0), totalSteps)} of {totalSteps}</span></>)}
          {run.currentApp && (<><span className="ou-rc-run-sep">|</span><span className="ou-rc-run-chip"><span className="ou-rc-run-chip-badge">{BADGE[run.currentApp]}</span>{APP_LABEL[run.currentApp]}</span></>)}
        </div>
        {trace.length > 0 && (
          <div className="ou-rc-run-trace">
            {trace.map((s) => (
              <div key={s.id} className={`ou-rc-trace-row ${s.status}`}>
                <span className="ou-rc-trace-glyph">{s.status === 'done' ? '✓' : s.status === 'error' ? '✕' : '▸'}</span>
                <span className="ou-rc-trace-label">{s.label}</span>
              </div>
            ))}
          </div>
        )}
        {approval && (
          <div className="ou-rc-callout" onClick={(e) => e.stopPropagation()}>
            <svg className="ou-rc-callout-icon" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 1.5l5.5 10H1.5L7 1.5z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /><path d="M7 5.5v3M7 10.2v.1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
            <div className="ou-rc-callout-body">
              <div className="ou-rc-callout-title">{approval.title}</div>
              <div className="ou-rc-callout-detail">{approval.detail}</div>
              <div className="ou-rc-callout-actions">
                <button type="button" className="ou-rc-callout-approve" onClick={approval.onApprove}>Approve</button>
                <button type="button" className="ou-rc-callout-deny" onClick={approval.onDeny}>Deny</button>
              </div>
            </div>
          </div>
        )}
        {run.status !== 'in_progress' && run.answer && (
          <p className="ou-rc-run-answer">{run.answer}</p>
        )}
        {running && run.answer && !trace.length && (
          <p className="ou-rc-run-answer streaming">{run.answer}</p>
        )}
      </div>
    </div>
  )
}

// ── Inspector ─────────────────────────────────────────────────────────────────
function Inspector({
  run,
  onClose,
  guardValue,
  onToggleGuard
}: {
  run: TaskCard | null
  onClose: () => void
  guardValue: (k: GuardKey) => boolean
  onToggleGuard: (k: GuardKey) => void
}): JSX.Element {
  const total = run?.steps.length ?? 0
  const done = run?.steps.filter((s) => s.status === 'done').length ?? 0
  const touched: TouchedResource[] = run?.touched ?? []

  // Live screen feed: stream the real display while the selected run is active,
  // so you can watch the automation happen (WhatsApp opening, clicks, typing).
  const live = run?.status === 'in_progress'
  const liveThumb = useScreenThumbnail(!!live)

  return (
    <aside className="ou-rc-inspector">
      <div className="ou-rc-insp-head">
        <div className="ou-rc-insp-head-top">
          <span className="ou-rc-insp-kicker">INSPECTOR</span>
          <button type="button" className="ou-rc-insp-close" onClick={onClose} aria-label="Close inspector">✕</button>
        </div>
        <div className="ou-rc-insp-title">{run?.title ?? 'No run selected'}</div>
        {run && (
          <div className="ou-rc-insp-meta">
            <span className={`ou-rc-insp-status ${statusToken(run).cls}`}>{statusToken(run).label}</span>
            <span className="ou-rc-run-sep">|</span>
            <span>{durationLabel(run)}</span>
          </div>
        )}
      </div>

      <div className="ou-rc-insp-body">
        {live && (
          <section className="ou-rc-insp-live-sec">
            <div className="ou-rc-insp-section">
              <span className="ou-rc-insp-label">LIVE VIEW</span>
              <span className="ou-rc-insp-live-tag"><span className="ou-rc-insp-live-dot" />LIVE</span>
            </div>
            <div className="ou-rc-insp-live">
              {liveThumb ? (
                <img className="ou-rc-insp-live-img" src={liveThumb} alt="Live screen preview" />
              ) : (
                <div className="ou-rc-insp-live-wait">Waiting for screen…</div>
              )}
            </div>
          </section>
        )}

        <section>
          <div className="ou-rc-insp-section">
            <span className="ou-rc-insp-label">PLAN</span>
            <span className="ou-rc-insp-progress">{done} / {total}</span>
          </div>
          {total === 0 && <div className="ou-rc-insp-empty">No steps yet.</div>}
          <div className="ou-rc-plan">
            {run?.steps.map((s) => (
              <div key={s.id} className={`ou-rc-plan-row ${s.status}`}>
                <span className="ou-rc-plan-ring" aria-hidden="true">{s.status === 'done' ? '✓' : ''}</span>
                <span className="ou-rc-plan-text">{s.label}</span>
              </div>
            ))}
          </div>
        </section>

        <section>
          <div className="ou-rc-insp-section"><span className="ou-rc-insp-label">TOUCHED</span></div>
          {touched.length === 0 && <div className="ou-rc-insp-empty">Nothing touched yet.</div>}
          {touched.map((t, i) => (
            <div key={i} className="ou-rc-touched">
              <span className="ou-rc-badge" aria-hidden="true">{BADGE[t.app]}</span>
              <span className="ou-rc-touched-res">{t.resource}</span>
              <span className={`ou-rc-touched-op ${t.operation.toLowerCase()}`}>{t.operation}</span>
            </div>
          ))}
        </section>

        <section>
          <div className="ou-rc-insp-section"><span className="ou-rc-insp-label">GUARDRAILS</span></div>
          {GUARD_META.map(({ key, label }) => (
            <div key={key} className="ou-rc-guard-row">
              <span className="ou-rc-guard-label">{label}</span>
              <button
                type="button"
                role="switch"
                aria-checked={guardValue(key)}
                aria-label={label}
                className={`ou-fr-switch${guardValue(key) ? ' on' : ''}`}
                onClick={() => onToggleGuard(key)}
                disabled={!run}
              >
                <span className="ou-fr-switch-knob" />
              </button>
            </div>
          ))}
        </section>
      </div>

      <div className="ou-rc-insp-foot">
        <span className="ou-rc-insp-foot-label">EVERYTHING RUNS LOCALLY</span>
        <button type="button" className="ou-rc-insp-foot-link">View full log</button>
      </div>
    </aside>
  )
}
