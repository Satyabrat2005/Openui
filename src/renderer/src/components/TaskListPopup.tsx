/**
 * TaskListPopup — the top-right, clickable task panel. It renders the live agent
 * task list from TaskActivityContext: one row per plan step or tool call. A plan
 * step expands to reveal the individual tool-call steps that ran under it
 * (parentId). When two or more top-level tasks are genuinely working at the same
 * instant they are grouped under a collapsible "Running N tasks in parallel"
 * header — this reflects REAL concurrency only (the interactive and autonomous
 * loops run one tool at a time today, so it stays dormant until concurrent
 * execution is introduced; it is never simulated). The header is clickable to
 * collapse the whole panel. Autonomous-mode controls are preserved.
 */
import { useEffect, useMemo, useState } from 'react'
import type { AutonomousStatus, TaskStatus, TaskUpdatePayload } from '../env'
import { useTaskActivity } from '../context/TaskActivityContext'

function CheckIcon(): JSX.Element {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none">
      <path d="M20 6L9 17l-5-5" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function TaskCheck({ status }: { status: TaskStatus }): JSX.Element {
  if (status === 'done') {
    return (
      <div className="task-check done">
        <CheckIcon />
      </div>
    )
  }
  if (status === 'working') {
    return (
      <div className="task-check working">
        <div className="task-spinner" />
      </div>
    )
  }
  if (status === 'error') {
    return (
      <div className="task-check error">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none">
          <path d="M18 6L6 18M6 6l12 12" stroke="white" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
      </div>
    )
  }
  return <div className="task-check pending" />
}

/** Small pill toggle used for the Autonomous / I'm-busy switches. */
function Toggle({
  label,
  on,
  onClick
}: {
  label: string
  on: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button type="button" className={`auto-toggle ${on ? 'on' : ''}`} onClick={onClick}>
      <span className="auto-toggle-track">
        <span className="auto-toggle-thumb" />
      </span>
      <span className="auto-toggle-label">{label}</span>
    </button>
  )
}

/** Human-readable line describing what the background agent is doing. */
function autonomousLine(status: AutonomousStatus): string {
  switch (status.state) {
    case 'working':
      return status.currentTask
        ? `Background Agent Working… — ${status.currentTask}`
        : 'Background Agent Working…'
    case 'monitoring':
      return status.detail ?? 'Monitoring — will work while you are away'
    case 'paused':
      return 'Paused — welcome back'
    default:
      return 'Autonomous mode off'
  }
}

/** A single task row; a parent with children can be expanded. */
function TaskRow({
  task,
  children,
  expanded,
  onToggle
}: {
  task: TaskUpdatePayload
  children: TaskUpdatePayload[]
  expanded: boolean
  onToggle: () => void
}): JSX.Element {
  const hasChildren = children.length > 0
  return (
    <div className={`task-group${task.parentId ? ' child' : ''}`}>
      <div
        className="task-row"
        style={task.status === 'working' ? { background: 'var(--ou-accent-soft)' } : undefined}
        onClick={hasChildren ? onToggle : undefined}
        role={hasChildren ? 'button' : undefined}
      >
        {hasChildren && (
          <span className={`task-caret${expanded ? ' open' : ''}`} aria-hidden="true">
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none">
              <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        )}
        <TaskCheck status={task.status} />
        <div className="task-row-body">
          <div className={`task-label ${task.status}`}>{task.label}</div>
          {task.detail && (task.status === 'working' || task.status === 'error') && (
            <div className={`task-sublabel ${task.status === 'error' ? 'error' : ''}`}>{task.detail}</div>
          )}
        </div>
        {hasChildren && <span className="task-count">{children.length}</span>}
      </div>
      {hasChildren && expanded && (
        <div className="task-children">
          {children.map((c) => (
            <div key={c.id} className="task-row child-row">
              <TaskCheck status={c.status} />
              <div className="task-row-body">
                <div className={`task-label ${c.status}`}>{c.label}</div>
                {c.detail && c.status === 'error' && <div className="task-sublabel error">{c.detail}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function TaskListPopup(): JSX.Element {
  const { tasks } = useTaskActivity()
  const [enabled, setEnabled] = useState(false)
  const [busy, setBusy] = useState(false)
  const [auto, setAuto] = useState<AutonomousStatus>({ active: false, state: 'disabled' })
  const [collapsed, setCollapsed] = useState(false)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [modelLabel, setModelLabel] = useState('')

  // Autonomous Coding Mode: hydrate current status, then subscribe to updates.
  useEffect(() => {
    let live = true
    window.openui
      .getAutonomousStatus()
      .then((s) => {
        if (live) {
          setAuto(s)
          setEnabled(s.active)
        }
      })
      .catch(() => {})
    const off = window.openui.onAutonomousStatus((s) => {
      setAuto(s)
      setEnabled(s.active)
    })
    return () => {
      live = false
      off()
    }
  }, [])

  // The REAL model tag for the footer: refreshed on mount and whenever the
  // verified tier changes. Never a hardcoded/decorative label.
  useEffect(() => {
    window.openui.getModelLabel().then(setModelLabel).catch(() => {})
    return window.openui.onTierChanged(() => {
      window.openui.getModelLabel().then(setModelLabel).catch(() => {})
    })
  }, [])

  const toggleEnabled = (): void => {
    const next = !enabled
    setEnabled(next)
    if (!next) setBusy(false)
    window.openui.setAutonomousEnabled(next)
  }

  const toggleBusy = (): void => {
    const next = !busy
    setBusy(next)
    window.openui.setBusy(next)
  }

  const toggleExpanded = (id: string): void => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const working = auto.active && auto.state === 'working'

  // Split into top-level tasks (plan steps / standalone tools) and their nested
  // tool-call children.
  const { parents, childrenByParent } = useMemo(() => {
    const parents: TaskUpdatePayload[] = []
    const childrenByParent = new Map<string, TaskUpdatePayload[]>()
    for (const t of tasks) {
      if (t.parentId) {
        const list = childrenByParent.get(t.parentId) ?? []
        list.push(t)
        childrenByParent.set(t.parentId, list)
      } else {
        parents.push(t)
      }
    }
    return { parents, childrenByParent }
  }, [tasks])

  // Genuine concurrency only: two or more top-level tasks in the 'working' state
  // at the same time. Sequential loops never produce this, so the group stays
  // hidden rather than being faked.
  const parallel = useMemo(() => parents.filter((p) => p.status === 'working'), [parents])
  const isParallel = parallel.length >= 2
  const parallelIds = useMemo(
    () => (isParallel ? new Set(parallel.map((p) => p.id)) : new Set<string>()),
    [isParallel, parallel]
  )

  const doneCount = tasks.filter((t) => t.status === 'done').length
  const settled = tasks.length > 0 && tasks.every((t) => t.status === 'done' || t.status === 'error')
  const allDone = settled && tasks.every((t) => t.status === 'done')

  const renderParent = (task: TaskUpdatePayload): JSX.Element => (
    <TaskRow
      key={task.id}
      task={task}
      children={childrenByParent.get(task.id) ?? []}
      expanded={expandedIds.has(task.id)}
      onToggle={() => toggleExpanded(task.id)}
    />
  )

  return (
    <div id="task-popup" className="mac-window ou-taskpanel">
      <div
        className="task-popup-header"
        role="button"
        onClick={() => setCollapsed((c) => !c)}
        title={collapsed ? 'Expand' : 'Collapse'}
      >
        <div className="task-popup-title-row">
          <div className="task-icon-badge">
            <CheckIcon />
          </div>
          <span className="ou-taskpanel-title">Tasks</span>
        </div>
        <span className="ou-taskpanel-count">
          {tasks.length === 0 ? 'Idle' : `${doneCount} / ${tasks.length} done`}
        </span>
      </div>

      {!collapsed && (
        <>
          {/* Background Agent banner — visible whenever Autonomous Coding Mode is on. */}
          {auto.active && (
            <div className={`autonomous-banner ${auto.state}`}>
              {working ? <div className="autonomous-pulse" /> : <div className="autonomous-dot" />}
              <div className="autonomous-text">
                <div className="autonomous-line">{autonomousLine(auto)}</div>
                {auto.detail && auto.state === 'working' && (
                  <div className="autonomous-detail">{auto.detail}</div>
                )}
              </div>
            </div>
          )}

          {/* Task list */}
          <div className="ou-taskpanel-body">
            {tasks.length === 0 ? (
              <div className="task-row">
                <div className="task-check pending" />
                <span className="task-label pending">No active tasks</span>
              </div>
            ) : (
              <>
                {isParallel && (
                  <div className="task-parallel">
                    <div className="task-parallel-head">Running {parallel.length} tasks in parallel</div>
                    {parallel.map(renderParent)}
                  </div>
                )}
                {parents.filter((p) => !parallelIds.has(p.id)).map(renderParent)}
              </>
            )}
          </div>

          {/* ✓ Workflow complete banner — shown once every task has finished. */}
          {settled && (
            <div className={`ou-workflow-complete ${allDone ? 'ok' : 'err'}`}>
              <div className="ou-workflow-complete-badge">
                <CheckIcon />
              </div>
              <span>{allDone ? 'Workflow complete' : 'Workflow finished with errors'}</span>
            </div>
          )}

          {/* Autonomous-mode controls: master switch + manual "I'm busy" override. */}
          <div className="autonomous-controls">
            <Toggle label="Autonomous" on={enabled} onClick={toggleEnabled} />
            <Toggle label="I'm busy" on={busy} onClick={toggleBusy} />
          </div>

          <div className="task-popup-footer">
            <div className="footer-dot" />
            <span className="ou-taskpanel-model">{modelLabel || 'Local model'}</span>
          </div>
        </>
      )}
    </div>
  )
}
