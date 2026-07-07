import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { TaskCard, TaskUpdatePayload, ParallelGroup, SubagentRow, StepStatus } from '../env'
import { appKindForTool, appKindForName, type AppKind } from '../lib/appKind'

/**
 * TaskActivityContext — the single source of truth for the center timeline (#1),
 * the parallel sub-agent groups (#2), the live activity panel (#5) and the
 * three-zone layout switch (#6). It folds the agent's per-turn IPC events into
 * task *cards*:
 *
 *   • `beginTask(title, kind)` — the chat UI opens a card for a new turn.
 *   • `openui:task:update` — one step (tool call or plan row) of the current card.
 *   • `openui:chat:tool`  — which app the agent is driving right now (for the tile).
 *   • `openui:chat:model` — the REAL model the backend is using this turn.
 *   • `openui:subagent:*` — real concurrent sub-agents fanned out this turn.
 *   • `openui:chat:done` / `openui:chat:error` — finalize the current card.
 *
 * Turns started outside the chat UI (autonomous mode, workflow runs) never call
 * `beginTask`; for those a card is created lazily on the first event so nothing
 * is lost.
 */
interface TaskActivityValue {
  tasks: TaskCard[]
  /** App currently being driven, or null when idle — powers the activity tile. */
  activeApp: AppKind | null
  /** Name of the tool running right now, or null — powers the thinking status. */
  activeTool: string | null
  /** Real model the backend is using this turn, or null when idle. */
  activeModel: string | null
  /** True while any card is in progress — expands the UI into the task view (#6). */
  taskViewActive: boolean
  /** Card the user clicked in the left rail to focus, or null. */
  focusedId: string | null
  /** Open a new task card for a turn about to be sent. Returns the card id. */
  beginTask: (title: string, kind: 'chat' | 'assigned') => string
  /** Focus a card's timeline (left-rail click). */
  focusTask: (id: string | null) => void
}

const TaskActivityContext = createContext<TaskActivityValue | null>(null)

function newId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  }
}

/** A concise, honest label for a raw model id (e.g. "llama3:8b" → "Llama 3 8B"). */
function labelForModel(model: string): string {
  const base = model.split(':')[0].replace(/[-_]/g, ' ')
  const tag = model.includes(':') ? model.split(':')[1] : ''
  const size = tag && tag !== 'latest' ? ` ${tag.toUpperCase()}` : ''
  return base.replace(/([a-z])(\d)/gi, '$1 $2').replace(/\b\w/g, (c) => c.toUpperCase()) + size
}

export function TaskActivityProvider({ children }: { children: ReactNode }): JSX.Element {
  const [tasks, setTasks] = useState<TaskCard[]>([])
  const [activeApp, setActiveApp] = useState<AppKind | null>(null)
  const [activeTool, setActiveTool] = useState<string | null>(null)
  const [activeModel, setActiveModel] = useState<string | null>(null)
  const [focusedId, setFocusedId] = useState<string | null>(null)

  // Id of the card currently accepting events. A ref so IPC callbacks (registered
  // once) always read the latest value without re-subscribing.
  const currentIdRef = useRef<string | null>(null)

  /** Patch the card with `id`, leaving the rest of the list untouched. */
  const patchCard = useCallback((id: string, patch: (c: TaskCard) => TaskCard): void => {
    setTasks((prev) => {
      const i = prev.findIndex((c) => c.id === id)
      if (i === -1) return prev
      const next = prev.slice()
      next[i] = patch(next[i])
      return next
    })
  }, [])

  const beginTask = useCallback((title: string, kind: 'chat' | 'assigned'): string => {
    const id = newId()
    const card: TaskCard = {
      id,
      title: title.trim() || 'New task',
      status: 'in_progress',
      kind,
      steps: [],
      groups: [],
      startedAt: Date.now()
    }
    currentIdRef.current = id
    setTasks((prev) => [...prev, card])
    setFocusedId(id)
    setActiveApp(null)
    setActiveTool(null)
    return id
  }, [])

  /** Ensure there's a current card (lazily create one for external turns). */
  const ensureCard = useCallback((): string => {
    if (currentIdRef.current) return currentIdRef.current
    const id = newId()
    currentIdRef.current = id
    setTasks((prev) => [
      ...prev,
      { id, title: 'Background task', status: 'in_progress', kind: 'chat', steps: [], groups: [], startedAt: Date.now() }
    ])
    return id
  }, [])

  /** Patch one sub-agent row inside a group on the current card. */
  const patchSub = useCallback(
    (groupId: string, subId: string, patch: (s: SubagentRow) => SubagentRow): void => {
      const id = currentIdRef.current
      if (!id) return
      patchCard(id, (c) => ({
        ...c,
        groups: c.groups.map((g) =>
          g.groupId !== groupId ? g : { ...g, subs: g.subs.map((s) => (s.subId === subId ? patch(s) : s)) }
        )
      }))
    },
    [patchCard]
  )

  useEffect(() => {
    // A step of the current card. Upsert by step id so status transitions
    // (pending → working → done/error) update the same row.
    const offTask = window.openui.onTask((step: TaskUpdatePayload) => {
      const cardId = ensureCard()
      patchCard(cardId, (c) => {
        const i = c.steps.findIndex((s) => s.id === step.id)
        const steps = c.steps.slice()
        if (i === -1) steps.push(step)
        else steps[i] = { ...steps[i], ...step }
        return { ...c, steps }
      })
    })

    // Which app is being driven right now — sets the card's icon and the tile.
    const offTool = window.openui.onToolCall(({ tool }) => {
      const kind = appKindForTool(tool)
      const cardId = ensureCard()
      patchCard(cardId, (c) => ({ ...c, currentApp: kind }))
      setActiveApp(kind)
      setActiveTool(tool)
    })

    // The real model the backend is using this turn — recorded on the card so the
    // timeline/tag never shows a model the backend isn't actually running.
    const offModel = window.openui.onChatModel(({ model }) => {
      const cardId = ensureCard()
      patchCard(cardId, (c) => ({ ...c, model, modelLabel: labelForModel(model) }))
      setActiveModel(model)
    })

    // ── Parallel sub-agents ─────────────────────────────────────────────────
    const offSubGroup = window.openui.onSubagentGroup((g) => {
      const cardId = ensureCard()
      const group: ParallelGroup = {
        groupId: g.groupId,
        status: 'working',
        subs: g.subs.map((s) => ({
          subId: s.subId,
          title: s.title,
          app: appKindForName(s.app),
          model: s.model,
          modelLabel: s.modelLabel,
          status: 'working' as StepStatus
        }))
      }
      patchCard(cardId, (c) => ({ ...c, groups: [...c.groups, group] }))
    })
    const offSubTool = window.openui.onSubagentTool(({ groupId, subId, tool }) => {
      const kind = appKindForTool(tool)
      patchSub(groupId, subId, (s) => ({ ...s, currentTool: tool, app: kind }))
      setActiveApp(kind)
      setActiveTool(tool)
    })
    const offSubStatus = window.openui.onSubagentStatus(({ groupId, subId, status }) => {
      patchSub(groupId, subId, (s) => ({ ...s, status: status as StepStatus }))
    })
    const offSubDone = window.openui.onSubagentDone(({ groupId, subId, status, summary }) => {
      patchSub(groupId, subId, (s) => ({ ...s, status: status as StepStatus, summary, currentTool: undefined }))
    })
    const offSubGroupDone = window.openui.onSubagentGroupDone(({ groupId, status }) => {
      const id = currentIdRef.current
      if (!id) return
      patchCard(id, (c) => ({
        ...c,
        groups: c.groups.map((g) => (g.groupId === groupId ? { ...g, status: status as StepStatus } : g))
      }))
    })

    const finalize = (status: 'done' | 'failed'): void => {
      const id = currentIdRef.current
      if (id) {
        patchCard(id, (c) => ({
          ...c,
          // A card with a failed step is a failed task even if the turn "completes".
          status: status === 'failed' || c.steps.some((s) => s.status === 'error') ? 'failed' : 'done',
          endedAt: Date.now()
        }))
      }
      currentIdRef.current = null
      setActiveApp(null)
      setActiveTool(null)
      setActiveModel(null)
    }

    const offDone = window.openui.onDone(() => finalize('done'))
    const offError = window.openui.onError(() => finalize('failed'))
    // Turn boundary — the active-app tile should go idle between turns.
    const offReset = window.openui.onTaskReset(() => {
      setActiveApp(null)
      setActiveTool(null)
    })

    return () => {
      offTask()
      offTool()
      offModel()
      offSubGroup()
      offSubTool()
      offSubStatus()
      offSubDone()
      offSubGroupDone()
      offDone()
      offError()
      offReset()
    }
  }, [ensureCard, patchCard, patchSub])

  const taskViewActive = tasks.some((t) => t.status === 'in_progress')

  // Grow the OS window into the expanded task view while a task is running, and
  // shrink it back to the compact footprint when idle. Only fires on the edge;
  // the main process ignores a no-op mode change, so this never thrashes.
  const lastModeRef = useRef<'compact' | 'expanded' | null>(null)
  useEffect(() => {
    const mode = taskViewActive ? 'expanded' : 'compact'
    if (lastModeRef.current === mode) return
    lastModeRef.current = mode
    window.openui.setWindowMode(mode)
  }, [taskViewActive])

  return (
    <TaskActivityContext.Provider
      value={{ tasks, activeApp, activeTool, activeModel, taskViewActive, focusedId, beginTask, focusTask: setFocusedId }}
    >
      {children}
    </TaskActivityContext.Provider>
  )
}

export function useTaskActivity(): TaskActivityValue {
  const ctx = useContext(TaskActivityContext)
  if (!ctx) throw new Error('useTaskActivity must be used within a TaskActivityProvider')
  return ctx
}
