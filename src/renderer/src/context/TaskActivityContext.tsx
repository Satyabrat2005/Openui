import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AgentStagePayload, ScreenPreviewPayload, TaskUpdatePayload } from '../env'

/**
 * TaskActivityContext — the single source of truth for live agent activity in the
 * renderer. It owns ONE subscription each to the task, stage and screen-preview
 * IPC channels so every consumer (the task panel, the thinking indicator, the
 * live-preview panel and the window-mode driver) reads the same state instead of
 * each re-subscribing. It also drives the compact↔expanded window resize off real
 * activity, so the window only grows while a task is actually running.
 */
interface TaskActivity {
  /** Every task/tool row for the current turn, in arrival order. */
  tasks: TaskUpdatePayload[]
  /** The latest agent stage, or null when idle/never-started. */
  stage: AgentStagePayload | null
  /** Recent live screen thumbnails, newest first (bounded). */
  previews: ScreenPreviewPayload[]
  /** True while the agent is mid-turn (a stage other than idle, or a working task). */
  running: boolean
}

const MAX_PREVIEWS = 8

const TaskActivityCtx = createContext<TaskActivity | null>(null)

export function TaskActivityProvider({ children }: { children: ReactNode }): JSX.Element {
  const [tasks, setTasks] = useState<TaskUpdatePayload[]>([])
  const [stage, setStage] = useState<AgentStagePayload | null>(null)
  const [previews, setPreviews] = useState<ScreenPreviewPayload[]>([])

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
    const offStage = window.openui.onAgentStage((s) => setStage(s))
    const offPreview = window.openui.onScreenPreview((p) => {
      setPreviews((prev) => [p, ...prev].slice(0, MAX_PREVIEWS))
    })
    return () => {
      offReset()
      offTask()
      offStage()
      offPreview()
    }
  }, [])

  const running = useMemo(() => {
    const stageActive = stage !== null && stage.stage !== 'idle'
    const taskActive = tasks.some((t) => t.status === 'working')
    return stageActive || taskActive
  }, [stage, tasks])

  // Grow the window while a task runs; shrink back to the compact overlay when it
  // finishes. Only fires on the running→idle edge, and the main process ignores a
  // no-op mode change, so this never thrashes the geometry.
  const lastMode = useRef<'compact' | 'expanded' | null>(null)
  useEffect(() => {
    const mode = running ? 'expanded' : 'compact'
    if (lastMode.current === mode) return
    lastMode.current = mode
    window.openui.setWindowMode(mode)
  }, [running])

  const value = useMemo<TaskActivity>(
    () => ({ tasks, stage, previews, running }),
    [tasks, stage, previews, running]
  )

  return <TaskActivityCtx.Provider value={value}>{children}</TaskActivityCtx.Provider>
}

export function useTaskActivity(): TaskActivity {
  const ctx = useContext(TaskActivityCtx)
  if (!ctx) throw new Error('useTaskActivity must be used within a TaskActivityProvider')
  return ctx
}
