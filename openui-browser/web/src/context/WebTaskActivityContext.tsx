// Web port of TaskActivityContext — the single source of truth for the run
// ledger. Desktop folded a stream of window.openui.on* IPC events into TaskCards;
// the web app folds its REAL sources into the SAME TaskCard shape:
//
//   • chat run   → beginTask() opens a card; streamChat() SSE fills card.answer
//                  (replaces onChunk/onDone).
//   • tool run   → requestTool() opens a card and hits the /api/tool gate; a
//                  gated tool returns needsConfirmation → the card enters the
//                  'waiting' queue with a pending approval (the web equivalent of
//                  onHitlRequest). Approve → re-run with the token → real step +
//                  touched row + answer; Deny → the run is held (failed).
//
// The Run Console component consumes useTaskActivity() unchanged.

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import type { HitlRequestPayload, TaskCard, TouchedResource } from '../types'
import { appKindForTool } from '../lib/appKind'
import { deriveCounts } from '../lib/runQueue'
import { runTool, streamChat, runAgent as apiRunAgent, resumeAgent as apiResumeAgent, type ToolResponse, type AgentResponse, type AgentStep, type AgentMessage } from '../api'

interface PendingApproval {
  targetId: string
  request: HitlRequestPayload
  toolName: string
  args: unknown
  token: string
  connections?: Record<string, string>
  // Set when the pending approval belongs to a model-driven agent run: approving
  // resumes the server-side loop (with the transcript) rather than re-POSTing a
  // single /api/tool call. This is what lets the gated-tool the MODEL picked flow
  // through the very same inline Approve/Deny callout the regex path used.
  agent?: { transcript: AgentMessage[] }
}

interface TaskActivityValue {
  tasks: TaskCard[]
  runningCount: number
  waitingCount: number
  focusedId: string | null
  beginTask: (title: string, kind: 'chat' | 'assigned') => string
  focusTask: (id: string | null) => void
  // web-specific run drivers (replace window.openui.chat + the HITL props):
  sendChat: (text: string) => Promise<void>
  requestTool: (name: string, args: unknown, connections?: Record<string, string>) => Promise<void>
  // Act mode: the model decides which tool(s) to run (replaces the keyword regex).
  runAgent: (text: string, connections?: Record<string, string>) => Promise<void>
  pendingApproval: PendingApproval | null
  approvePending: () => Promise<void>
  denyPending: () => void
  clearRuns: () => void
}

const Ctx = createContext<TaskActivityValue | null>(null)

function newId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  }
}

export function WebTaskActivityProvider({ children }: { children: ReactNode }): JSX.Element {
  const [tasks, setTasks] = useState<TaskCard[]>([])
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null)
  const currentIdRef = useRef<string | null>(null)

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
      queue: 'active',
      steps: [],
      groups: [],
      touched: [],
      startedAt: Date.now()
    }
    currentIdRef.current = id
    setTasks((prev) => [...prev, card])
    setFocusedId(id)
    return id
  }, [])

  const finalize = useCallback(
    (id: string, status: 'done' | 'failed'): void => {
      patchCard(id, (c) => ({
        ...c,
        status: status === 'failed' || c.steps.some((s) => s.status === 'error') ? 'failed' : 'done',
        queue: 'done',
        endedAt: Date.now()
      }))
      if (currentIdRef.current === id) currentIdRef.current = null
    },
    [patchCard]
  )

  // ── chat run (replaces window.openui.chat + onChunk/onDone) ────────────────
  const sendChat = useCallback(
    async (text: string): Promise<void> => {
      const id = currentIdRef.current ?? beginTask(text, 'chat')
      // A live step row so the ledger/inspector show progress while streaming.
      patchCard(id, (c) => ({ ...c, steps: [{ id: 'answer', label: 'Answering', status: 'working' }] }))
      await streamChat(text, {
        onDelta: (delta) => patchCard(id, (c) => ({ ...c, answer: (c.answer ?? '') + delta })),
        onDone: (full) => {
          patchCard(id, (c) => ({
            ...c,
            answer: full || c.answer,
            steps: [{ id: 'answer', label: 'Answered', status: 'done' }]
          }))
          finalize(id, 'done')
        },
        onError: (msg) => {
          patchCard(id, (c) => ({ ...c, answer: msg, steps: [{ id: 'answer', label: 'Failed', status: 'error' }] }))
          finalize(id, 'failed')
        }
      })
    },
    [beginTask, patchCard, finalize]
  )

  // ── tool run through the confirmation gate (replaces onHitlRequest) ────────
  const applyToolResult = useCallback(
    (id: string, name: string, res: ToolResponse): void => {
      if (res.ok) {
        const touched: TouchedResource[] = (res.files ?? []).map((f) => ({
          app: appKindForTool(name),
          resource: f.name,
          operation: 'WRITE'
        }))
        patchCard(id, (c) => ({
          ...c,
          steps: [{ id: name, label: res.summary ?? `Ran ${name}`, status: 'done' }],
          touched: [...(c.touched ?? []), ...touched],
          currentApp: appKindForTool(name),
          answer: res.summary ?? c.answer
        }))
        finalize(id, 'done')
      } else {
        patchCard(id, (c) => ({
          ...c,
          steps: [{ id: name, label: res.error ?? `Failed ${name}`, status: 'error' }],
          answer: res.error
        }))
        finalize(id, 'failed')
      }
    },
    [patchCard, finalize]
  )

  const requestTool = useCallback(
    async (name: string, args: unknown, connections?: Record<string, string>): Promise<void> => {
      const id = beginTask(`${name}`, 'assigned')
      patchCard(id, (c) => ({ ...c, currentApp: appKindForTool(name) }))
      const res = await runTool(name, args, undefined, connections)
      if (res.needsConfirmation && res.confirmation) {
        // Move the run into the "waiting on you" queue and surface an inline
        // approval — the web equivalent of the desktop HITL request.
        patchCard(id, (c) => ({ ...c, queue: 'waiting' }))
        setPendingApproval({
          targetId: id,
          toolName: name,
          args,
          token: res.confirmation.token,
          connections,
          request: {
            id: res.confirmation.token,
            tool: name,
            args: (args as Record<string, unknown>) ?? {},
            label: res.confirmation.summary
          }
        })
        return
      }
      applyToolResult(id, name, res)
    },
    [beginTask, patchCard, applyToolResult]
  )

  // ── agent run (Act mode): the model chooses the tool(s) ────────────────────
  const applyAgentResponse = useCallback(
    (id: string, res: AgentResponse, connections?: Record<string, string>): void => {
      if (res.kind === 'error') {
        patchCard(id, (c) => ({ ...c, answer: res.message, steps: [{ id: 'agent', label: 'Failed', status: 'error' }] }))
        finalize(id, 'failed')
        return
      }
      if (res.kind === 'needs_confirmation') {
        // A gated tool the model picked — surface the SAME inline approval callout,
        // but approving resumes the server loop with the transcript.
        patchCard(id, (c) => ({ ...c, queue: 'waiting', currentApp: appKindForTool(res.name) }))
        setPendingApproval({
          targetId: id,
          toolName: res.name,
          args: res.args,
          token: res.confirmation.token,
          connections,
          agent: { transcript: res.transcript },
          request: { id: res.confirmation.token, tool: res.name, args: (res.args as Record<string, unknown>) ?? {}, label: res.confirmation.summary }
        })
        return
      }
      // kind === 'reply': the loop finished. Fold every executed step + its files.
      const steps = res.steps.map((s: AgentStep) => ({ id: s.name, label: s.summary, status: (s.ok ? 'done' : 'error') as 'done' | 'error' }))
      const touched: TouchedResource[] = res.files.map((f) => ({ app: appKindForTool(res.steps.find((s) => s.files?.some((x) => x.name === f.name))?.name ?? 'app'), resource: f.name, operation: 'WRITE' }))
      const lastApp = res.steps.length ? appKindForTool(res.steps[res.steps.length - 1].name) : undefined
      patchCard(id, (c) => ({
        ...c,
        steps: steps.length ? steps : [{ id: 'agent', label: 'Answered', status: 'done' }],
        touched: [...(c.touched ?? []), ...touched],
        currentApp: lastApp ?? c.currentApp,
        answer: res.reply || c.answer,
        queue: 'active'
      }))
      finalize(id, res.steps.some((s) => !s.ok) ? 'failed' : 'done')
    },
    [patchCard, finalize]
  )

  const runAgent = useCallback(
    async (text: string, connections?: Record<string, string>): Promise<void> => {
      const id = currentIdRef.current ?? beginTask(text, 'chat')
      patchCard(id, (c) => ({ ...c, steps: [{ id: 'agent', label: 'Thinking', status: 'working' }] }))
      const res = await apiRunAgent(text, connections)
      applyAgentResponse(id, res, connections)
    },
    [beginTask, patchCard, applyAgentResponse]
  )

  const approvePending = useCallback(async (): Promise<void> => {
    const p = pendingApproval
    if (!p) return
    setPendingApproval(null)
    // Clear the waiting flag the moment the run resumes (matches desktop: fresh
    // activity moves a run out of the waiting queue).
    patchCard(p.targetId, (c) => ({ ...c, queue: 'active', steps: [{ id: p.toolName, label: `Running ${p.toolName}`, status: 'working' }] }))
    if (p.agent) {
      const res = await apiResumeAgent({ transcript: p.agent.transcript, name: p.toolName, args: (p.args as Record<string, unknown>) ?? {}, confirmationToken: p.token, approved: true, connections: p.connections })
      applyAgentResponse(p.targetId, res, p.connections)
      return
    }
    const res = await runTool(p.toolName, p.args, p.token, p.connections)
    applyToolResult(p.targetId, p.toolName, res)
  }, [pendingApproval, patchCard, applyToolResult, applyAgentResponse])

  const denyPending = useCallback((): void => {
    const p = pendingApproval
    if (!p) return
    setPendingApproval(null)
    if (p.agent) {
      // Tell the loop the user denied — it concludes honestly (nothing ran).
      patchCard(p.targetId, (c) => ({ ...c, queue: 'active', steps: [{ id: p.toolName, label: `Denied ${p.toolName}`, status: 'error' }], touched: [...(c.touched ?? []), { app: appKindForTool(p.toolName), resource: p.toolName, operation: 'HELD' }] }))
      void apiResumeAgent({ transcript: p.agent.transcript, name: p.toolName, args: (p.args as Record<string, unknown>) ?? {}, confirmationToken: p.token, approved: false, connections: p.connections }).then((res) => applyAgentResponse(p.targetId, res, p.connections))
      return
    }
    patchCard(p.targetId, (c) => ({
      ...c,
      steps: [{ id: p.toolName, label: `Denied ${p.toolName}`, status: 'error' }],
      touched: [...(c.touched ?? []), { app: appKindForTool(p.toolName), resource: p.toolName, operation: 'HELD' }],
      answer: 'Denied — nothing ran.'
    }))
    finalize(p.targetId, 'failed')
  }, [pendingApproval, patchCard, finalize, applyAgentResponse])

  const clearRuns = useCallback((): void => {
    currentIdRef.current = null
    setFocusedId(null)
    setPendingApproval(null)
  }, [])

  const { running: runningCount, waiting: waitingCount } = deriveCounts(tasks)

  const value = useMemo<TaskActivityValue>(
    () => ({
      tasks,
      runningCount,
      waitingCount,
      focusedId,
      beginTask,
      focusTask: setFocusedId,
      sendChat,
      requestTool,
      runAgent,
      pendingApproval,
      approvePending,
      denyPending,
      clearRuns
    }),
    [tasks, runningCount, waitingCount, focusedId, beginTask, sendChat, requestTool, runAgent, pendingApproval, approvePending, denyPending, clearRuns]
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useTaskActivity(): TaskActivityValue {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useTaskActivity must be used within WebTaskActivityProvider')
  return ctx
}
