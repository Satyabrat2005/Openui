import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TaskCard, TouchedResource, Workflow, AppKind } from '../types'
import { useTaskActivity } from '../context/WebTaskActivityContext'
import { useAuth } from '../context/WebAuthContext'
import { queueOf, statusToken, resolveInspectorOpen, connectedScope } from '../lib/runQueue'
import { getConnections, subscribeConnections, refreshConnections, setLocalConnection, type ConnectableApp } from '../context/connections'
import { getWorkflows, setToken as setAuthToken } from '../api'

/**
 * RunConsole (WEB port) — byte-for-byte the same three-column markup and class
 * names as the desktop component (sidebar 246px · content · inspector 352px), so
 * it renders against the copied index.css with identical computed styles. ONLY
 * the data layer differs: every window.openui.* IPC call is swapped for a web
 * context method (useTaskActivity / useAuth) or a REST fetch. The desktop
 * LIVE VIEW (desktopCapturer screen feed) is intentionally removed — screen
 * capture is architecturally desktop-only.
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

const BADGE: Record<AppKind, string> = {
  browser: 'WB', github: 'GH', figma: 'FI', files: 'FS', clipboard: 'CB',
  calendar: 'CA', screen: 'SC', whatsapp: 'WA', messaging: 'MS', app: 'AP', thinking: '··'
}
const APP_LABEL: Record<AppKind, string> = {
  browser: 'Web', github: 'GitHub', figma: 'Figma', files: 'Files', clipboard: 'Clipboard',
  calendar: 'Calendar', screen: 'Screen', whatsapp: 'WhatsApp', messaging: 'Messaging', app: 'App', thinking: 'Thinking'
}

function durationLabel(card: TaskCard): string {
  const end = card.endedAt ?? Date.now()
  const ms = end - card.startedAt
  if (ms < 1000) return '0:00'
  const s = Math.round(ms / 1000)
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

const GH_TOKEN_KEY = 'openui_web_gh'
function ghToken(): string {
  return localStorage.getItem(GH_TOKEN_KEY) || ''
}
function toolConnections(): Record<string, string> {
  const g = ghToken()
  return g ? { github: g } : {}
}

/** Act-mode intent → a real web tool call. Gated tools (write_spreadsheet,
 *  create_repo) route through the confirmation gate → inline approval. */
function matchTool(text: string): { name: string; args: unknown } | null {
  const t = text.toLowerCase()
  if (/\b(spreadsheet|xlsx|excel|workbook)\b/.test(t))
    return { name: 'write_spreadsheet', args: { title: 'Report', sheets: [{ name: 'Data', headers: ['Metric', 'Value'], rows: [['Users', 1200], ['Signups', 340]] }] } }
  if (/\b(repo|repository|github)\b/.test(t))
    return { name: 'create_repo', args: { name: 'openui-web-demo', description: text, private: true } }
  if (/\b(doc|document|word|report|memo)\b/.test(t)) return { name: 'create_document', args: { title: 'Document', paragraphs: [text] } }
  if (/\b(paper|papers|arxiv|research)\b/.test(t)) return { name: 'search_papers', args: { query: text, max_results: 4 } }
  return null
}

interface RunConsoleProps {
  initialMessage?: string | null
  historyOpen?: boolean
  onHistoryChange?: (open: boolean) => void
}

export default function RunConsole({ initialMessage, historyOpen = false, onHistoryChange }: RunConsoleProps): JSX.Element {
  const {
    tasks, beginTask, focusedId, focusTask, runningCount, waitingCount,
    sendChat, requestTool, pendingApproval, approvePending, denyPending, clearRuns
  } = useTaskActivity()
  const { user } = useAuth()

  const [mode, setMode] = useState<Mode>('do')
  const [filter, setFilter] = useState<Filter>('all')
  const [input, setInput] = useState('')
  const [showConnect, setShowConnect] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const setShowHistory = (open: boolean): void => onHistoryChange?.(open)

  const [conns, setConns] = useState<ConnectableApp[]>(getConnections())
  useEffect(() => {
    void refreshConnections()
    return subscribeConnections(() => setConns(getConnections()))
  }, [])
  const connected = useMemo(() => connectedScope(conns), [conns])

  const [workflows, setWorkflows] = useState<Workflow[]>([])
  useEffect(() => {
    getWorkflows().then(setWorkflows).catch(() => setWorkflows([]))
  }, [])

  // Guardrails: global defaults from localStorage (web replacement for getSetting).
  const [globalGuards, setGlobalGuards] = useState<Record<GuardKey, boolean>>({
    confirm_send: true, never_delete: true, redact_cards: true, block_paid: true
  })
  useEffect(() => {
    GUARD_META.forEach(({ key }) => {
      const v = localStorage.getItem(GUARD_SETTING[key])
      if (v === 'true' || v === 'false') setGlobalGuards((g) => ({ ...g, [key]: v === 'true' }))
    })
  }, [])
  const [perRunGuards, setPerRunGuards] = useState<Record<string, Partial<Record<GuardKey, boolean>>>>({})

  const [narrow, setNarrow] = useState(() => window.innerWidth < 1180)
  const [inspectorManual, setInspectorManual] = useState<boolean | null>(null)
  useEffect(() => {
    const onResize = (): void => setNarrow(window.innerWidth < 1180)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const inspectorOpen = resolveInspectorOpen(inspectorManual, narrow)

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

  // Inline approval sourced from the web confirmation gate (replaces HITL props).
  const approvalFor = (run: TaskCard): ApprovalCallout | null => {
    if (!pendingApproval || run.id !== pendingApproval.targetId) return null
    return {
      title: 'Approve this action',
      detail: pendingApproval.request.label,
      onApprove: () => void approvePending(),
      onDeny: () => denyPending()
    }
  }

  const startRun = useCallback(() => {
    const text = input.trim()
    if (!text) return
    if (mode === 'do') {
      const tool = matchTool(text)
      if (tool) {
        void requestTool(tool.name, tool.args, toolConnections())
        setInput('')
        return
      }
    }
    beginTask(text, 'chat')
    void sendChat(text)
    setInput('')
  }, [input, mode, beginTask, sendChat, requestTool])

  const newRun = useCallback(() => {
    clearRuns()
    focusTask(null)
    setInput('')
  }, [clearRuns, focusTask])

  const replayedRef = useRef(false)
  useEffect(() => {
    const msg = initialMessage?.trim()
    if (!msg || replayedRef.current) return
    replayedRef.current = true
    beginTask(msg, 'chat')
    void sendChat(msg)
  }, [initialMessage, beginTask, sendChat])

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
          {conns.length === 0 && <div className="ou-rc-empty-sub">Nothing connected yet — + ADD.</div>}
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
              <span className="ou-rc-account-sub">CLOUD · SUPABASE</span>
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
            <button type="button" className="ou-rc-add" onClick={() => setShowConnect(false)}>MANAGE</button>
          </div>
          {workflows.length === 0 ? (
            <div className="ou-rc-empty-sub">No saved workflows yet — import one from Manage.</div>
          ) : (
            <div className="ou-rc-wf-grid">
              {workflows.map((wf) => (
                <button key={wf.name} type="button" className="ou-rc-wf-card" onClick={() => { beginTask(`Run workflow: ${wf.name}`, 'chat'); void sendChat(`Run workflow: ${wf.name}`) }} title={`Run “${wf.name}”`}>
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

      {showConnect && <ConnectModal onClose={() => setShowConnect(false)} />}
      {showSettings && <SettingsStub onClose={() => setShowSettings(false)} />}
      {historyOpen && (
        <div className="ou-rc-history-drawer">
          <div className="ou-rc-history-scrim" onClick={() => setShowHistory(false)} />
          <div className="ou-rc-history-panel">
            <div className="ou-rc-empty" style={{ padding: 24 }}>
              <div className="ou-rc-empty-title">Workspace history</div>
              <div className="ou-rc-empty-sub">Run history syncs to your account. (Web port: thread resume is a next-phase item.)</div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Sidebar queue row (verbatim) ────────────────────────────────────────────
function QueueRow({ label, count, dot, active, onClick }: { label: string; count: number; dot: string; active: boolean; onClick: () => void }): JSX.Element {
  return (
    <button type="button" className={`ou-rc-queue${active ? ' active' : ''}`} onClick={onClick}>
      <span className={`ou-rc-queue-dot ${dot}`} aria-hidden="true" />
      <span className="ou-rc-queue-label">{label}</span>
      <span className="ou-rc-queue-count">{count}</span>
    </button>
  )
}

// ── Run row (verbatim markup) ───────────────────────────────────────────────
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

// ── Inspector (verbatim markup, LIVE VIEW removed — desktop-only) ────────────
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
        <span className="ou-rc-insp-foot-label">RUNS IN YOUR BROWSER</span>
        <button type="button" className="ou-rc-insp-foot-link">View full log</button>
      </div>
    </aside>
  )
}

// ── Minimal web modals (the desktop ConnectAppsModal/SettingsModal are heavy;
//    these keep the buttons functional using the same token classes). ─────────
function ConnectModal({ onClose }: { onClose: () => void }): JSX.Element {
  const [pat, setPat] = useState(ghToken())
  const save = (): void => {
    localStorage.setItem(GH_TOKEN_KEY, pat)
    setLocalConnection('github', 'GitHub', 'github', pat ? 'connected' : 'disconnected')
    onClose()
  }
  return (
    <div className="ou-rc-history-drawer">
      <div className="ou-rc-history-scrim" onClick={onClose} />
      <div className="ou-rc-history-panel" style={{ padding: 24, maxWidth: 420 }}>
        <div className="ou-rc-insp-kicker">CONNECT</div>
        <div className="ou-rc-insp-title" style={{ marginBottom: 12 }}>GitHub (personal access token)</div>
        <input className="ou-rc-input" value={pat} placeholder="ghp_…" onChange={(e) => setPat(e.target.value)} style={{ width: '100%', marginBottom: 12 }} />
        <button type="button" className="ou-rc-startrun" onClick={save}>Save connection</button>
      </div>
    </div>
  )
}

function SettingsStub({ onClose }: { onClose: () => void }): JSX.Element {
  const [token, setTok] = useState('')
  return (
    <div className="ou-rc-history-drawer">
      <div className="ou-rc-history-scrim" onClick={onClose} />
      <div className="ou-rc-history-panel" style={{ padding: 24, maxWidth: 420 }}>
        <div className="ou-rc-insp-kicker">SETTINGS</div>
        <div className="ou-rc-insp-title" style={{ marginBottom: 12 }}>Session token</div>
        <div className="ou-rc-empty-sub" style={{ marginBottom: 12 }}>Paste a Supabase access token, or <code>dev:me</code> in stub mode.</div>
        <input className="ou-rc-input" value={token} placeholder="dev:me" onChange={(e) => setTok(e.target.value)} style={{ width: '100%', marginBottom: 12 }} />
        <button type="button" className="ou-rc-startrun" onClick={() => { setAuthToken(token || 'dev:me'); onClose() }}>Save & reload token</button>
      </div>
    </div>
  )
}
