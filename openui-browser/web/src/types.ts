// Types ported verbatim from the desktop renderer's env.d.ts (the subset the
// Run Console + runQueue + the web data layer consume). Keeping the shapes
// identical is what lets RunConsole.tsx and runQueue.ts port without edits.

export type StepStatus = 'pending' | 'working' | 'done' | 'error'
export type TaskStatus = StepStatus
export type TouchedOperation = 'READ' | 'WRITE' | 'DRAFT' | 'POST' | 'HELD'
export type RunQueue = 'active' | 'waiting' | 'done'

export interface TaskUpdatePayload {
  id: string
  label: string
  status: TaskStatus
  detail?: string
}

export interface TouchedResource {
  app: AppKind
  resource: string
  operation: TouchedOperation
}

export interface SubagentRow {
  subId: string
  title: string
  app?: AppKind
  model: string
  modelLabel: string
  status: StepStatus
  currentTool?: string
  summary?: string
}

export interface ParallelGroup {
  groupId: string
  status: StepStatus
  subs: SubagentRow[]
}

export interface TaskCard {
  id: string
  title: string
  status: 'in_progress' | 'done' | 'failed'
  kind: 'chat' | 'assigned'
  queue?: RunQueue
  conversationId?: string | null
  steps: TaskUpdatePayload[]
  groups: ParallelGroup[]
  model?: string
  modelLabel?: string
  currentApp?: AppKind
  touched?: TouchedResource[]
  answer?: string
  startedAt: number
  endedAt?: number
}

export interface WorkflowStep {
  tool?: string
  [k: string]: unknown
}
export interface Workflow {
  name: string
  trigger?: string
  steps: WorkflowStep[]
}

// Approval payloads (desktop HITL/plan) — reused for the web confirmation gate.
export interface HitlRequestPayload {
  id: string
  tool: string
  args: Record<string, unknown>
  label: string
  choices?: string[]
}
export interface PlanStep {
  id: string
  title: string
}
export interface PlanRequestPayload {
  id: string
  summary: string
  steps: PlanStep[]
}

// Auth (desktop User/Tier).
export type Tier = 'free' | 'pro' | 'enterprise'
export interface User {
  id: string
  email?: string
  name?: string
  avatar_url?: string
  tier: Tier
}

// ── AppKind (from lib/appKind.ts) ───────────────────────────────────────────
export type AppKind =
  | 'browser' | 'github' | 'figma' | 'files' | 'clipboard'
  | 'calendar' | 'screen' | 'whatsapp' | 'messaging' | 'app' | 'thinking'
