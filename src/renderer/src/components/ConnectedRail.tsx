/**
 * ConnectedRail (#5 left rail) — the left column of the task view. Mirrors the
 * reference's left rail: a list of connected apps (with live connection status)
 * and the recent/active tasks, each clickable to focus that task's timeline in
 * the center. It also hosts the Autonomous "Background Agent" controls and an
 * HONEST footer showing the real model the backend is running right now.
 *
 * Connection state is read from ConnectAppsModal's shared store; the task list
 * and active model come from TaskActivityContext.
 */
import { useEffect, useState } from 'react'
import type { AutonomousStatus, TaskCard } from '../env'
import { useTaskActivity } from '../context/TaskActivityContext'
import ConnectAppsModal, { getConnections, subscribeConnections, type ConnectableApp } from './ConnectAppsModal'
import AppIcon from './AppIcon'

function Toggle({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }): JSX.Element {
  return (
    <button type="button" className={`auto-toggle ${on ? 'on' : ''}`} onClick={onClick}>
      <span className="auto-toggle-track">
        <span className="auto-toggle-thumb" />
      </span>
      <span className="auto-toggle-label">{label}</span>
    </button>
  )
}

function autonomousLine(status: AutonomousStatus): string {
  switch (status.state) {
    case 'working':
      return status.currentTask ? `Working — ${status.currentTask}` : 'Working…'
    case 'monitoring':
      return status.detail ?? 'Monitoring — will work while you are away'
    case 'paused':
      return 'Paused — welcome back'
    default:
      return 'Autonomous mode off'
  }
}

function taskStatusText(status: TaskCard['status']): string {
  if (status === 'in_progress') return 'In progress'
  if (status === 'done') return 'Done'
  return 'Failed'
}

function ConnRow({ app }: { app: ConnectableApp }): JSX.Element {
  return (
    <div className="ou-rail-conn">
      <span className={`ou-rail-conn-icon ${app.kind}`}>
        <AppIcon kind={app.kind} size={15} />
      </span>
      <span className="ou-rail-conn-name">{app.name}</span>
      <span className={`ou-rail-conn-dot ${app.state}`} title={app.message ?? app.state} aria-hidden="true" />
    </div>
  )
}

export default function ConnectedRail(): JSX.Element {
  const { tasks, focusedId, focusTask } = useTaskActivity()
  const [showConnect, setShowConnect] = useState(false)
  const [conns, setConns] = useState<ConnectableApp[]>(getConnections())

  const [enabled, setEnabled] = useState(false)
  const [busy, setBusy] = useState(false)
  const [auto, setAuto] = useState<AutonomousStatus>({ active: false, state: 'disabled' })

  // Live connection status from the shared store.
  useEffect(() => subscribeConnections(() => setConns(getConnections())), [])

  // Autonomous Coding Mode: hydrate then subscribe.
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

  const connected = conns.filter((c) => c.state === 'connected')
  const railApps = connected.length > 0 ? connected : conns
  const railTasks = tasks
    .filter((c) => c.steps.length > 0 || c.groups.length > 0 || c.kind === 'assigned')
    .slice()
    .reverse()
  const working = auto.active && auto.state === 'working'

  return (
    <aside className="ou-rail" aria-label="Connected apps and tasks">
      <div className="ou-rail-section">
        <div className="ou-rail-head">
          <span className="ou-rail-title">Connected apps</span>
          <button type="button" className="ou-rail-add" onClick={() => setShowConnect(true)} title="Connect an app">
            +
          </button>
        </div>
        <div className="ou-rail-conns">
          {railApps.map((app) => (
            <ConnRow key={app.id} app={app} />
          ))}
        </div>
      </div>

      <div className="ou-rail-section ou-rail-tasks">
        <div className="ou-rail-head">
          <span className="ou-rail-title">Tasks</span>
          <span className="ou-rail-count">{railTasks.length || ''}</span>
        </div>
        <div className="ou-rail-tasklist">
          {railTasks.length === 0 ? (
            <div className="ou-rail-empty">No tasks yet.</div>
          ) : (
            railTasks.map((card) => (
              <button
                key={card.id}
                type="button"
                className={`ou-rail-task ${card.status} ${focusedId === card.id ? 'focused' : ''}`}
                onClick={() => focusTask(card.id)}
              >
                <span className={`ou-rail-task-dot ${card.status}`} aria-hidden="true" />
                <span className="ou-rail-task-title">{card.title}</span>
                <span className={`ou-rail-task-status ${card.status}`}>{taskStatusText(card.status)}</span>
              </button>
            ))
          )}
        </div>
      </div>

      {auto.active && (
        <div className={`autonomous-banner ${auto.state}`}>
          {working ? <div className="autonomous-pulse" /> : <div className="autonomous-dot" />}
          <div className="autonomous-text">
            <div className="autonomous-line">{autonomousLine(auto)}</div>
          </div>
        </div>
      )}

      <div className="ou-rail-controls">
        <Toggle label="Autonomous" on={enabled} onClick={toggleEnabled} />
        <Toggle label="I'm busy" on={busy} onClick={toggleBusy} />
      </div>

      {showConnect && <ConnectAppsModal onClose={() => setShowConnect(false)} />}
    </aside>
  )
}
