/**
 * TaskListPopup — a React port of `#task-popup` from design.html, now driven by
 * live agent state. It subscribes to the main process's task events
 * (`onTask` / `onTaskReset`) and renders one row per tool the agent runs,
 * reflecting its 'pending' | 'working' | 'done' | 'error' status. The entrance
 * animation for `#task-popup` is still played by `useAssistantAnimations`; the
 * spinner and the "workflow complete" banner are now driven by CSS + state.
 */
import { useEffect, useState } from 'react'
import type { TaskStatus, TaskUpdatePayload } from '../env'

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

export default function TaskListPopup(): JSX.Element {
  const [tasks, setTasks] = useState<TaskUpdatePayload[]>([])

  useEffect(() => {
    const offReset = window.openui.onTaskReset(() => setTasks([]))
    const offTask = window.openui.onTask((task) => {
      setTasks((prev) => {
        const i = prev.findIndex((t) => t.id === task.id)
        if (i === -1) return [...prev, task]
        const next = prev.slice()
        next[i] = { ...next[i], ...task }
        return next
      })
    })
    return () => {
      offReset()
      offTask()
    }
  }, [])

  const doneCount = tasks.filter((t) => t.status === 'done').length
  const settled = tasks.length > 0 && tasks.every((t) => t.status === 'done' || t.status === 'error')
  const allDone = settled && tasks.every((t) => t.status === 'done')

  return (
    <div id="task-popup" className="mac-window">
      <div className="task-popup-header">
        <div className="task-popup-title-row">
          <div className="task-icon-badge">
            <CheckIcon />
          </div>
          <span
            style={{ fontSize: 12, fontWeight: 600, color: '#1c1c1e', fontFamily: '-apple-system, sans-serif' }}
          >
            Workflow Status
          </span>
        </div>
        <span
          style={{ fontSize: 11, color: '#aeaeb2', fontWeight: 500, fontFamily: '-apple-system, sans-serif' }}
        >
          {tasks.length === 0 ? 'Idle' : `${doneCount} / ${tasks.length} done`}
        </span>
      </div>

      {/* Task list */}
      <div>
        {tasks.length === 0 ? (
          <div className="task-row">
            <div className="task-check pending" />
            <span className="task-label pending">No active tasks</span>
          </div>
        ) : (
          tasks.map((task) => (
            <div
              key={task.id}
              className="task-row"
              style={task.status === 'working' ? { background: '#f0f7ff' } : undefined}
            >
              <TaskCheck status={task.status} />
              <div>
                <div className={`task-label ${task.status}`}>{task.label}</div>
                {task.detail && (task.status === 'working' || task.status === 'error') && (
                  <div className={`task-sublabel ${task.status === 'error' ? 'error' : ''}`}>{task.detail}</div>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {/* ✓ Workflow complete banner — shown once every task has finished. */}
      {settled && (
        <div
          id="workflow-complete"
          className="workflow-complete-enter"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '10px 14px',
            borderTop: allDone ? '0.5px solid #d1fae5' : '0.5px solid #fde2e1',
            background: allDone ? '#f0fdf4' : '#fef2f2'
          }}
        >
          <div
            style={{
              width: 18,
              height: 18,
              borderRadius: '50%',
              background: allDone ? '#34c759' : '#ff3b30',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0
            }}
          >
            <CheckIcon />
          </div>
          <span
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: allDone ? '#15803d' : '#b91c1c',
              fontFamily: '-apple-system, sans-serif'
            }}
          >
            {allDone ? 'Workflow complete' : 'Workflow finished with errors'}
          </span>
        </div>
      )}

      <div className="task-popup-footer">
        <div className="footer-dot" />
        <span style={{ fontSize: 10, color: '#aeaeb2', fontFamily: '-apple-system, sans-serif' }}>
          Llama 3 · Running locally · 0 cloud calls
        </span>
      </div>
    </div>
  )
}
