/// <reference types="vite/client" />

/** Which OS permission needs to be granted before the tool can proceed. */
export type PermissionTarget = 'accessibility' | 'microphone'

export type Tier = 'free' | 'pro' | 'enterprise'

export interface User {
  id: string
  email: string | null
  name: string | null
  avatar_url: string | null
  tier: Tier
}

export interface TierUpgradePayload {
  requestedTier: Tier
  effectiveTier: Tier
  currentTier: Tier
}

export interface ConversationSummary {
  id: string
  title: string
  created_at: number
}

export interface ToolCallPayload {
  tool: string
  args: Record<string, unknown>
}

export interface ChatDonePayload {
  text: string
  toolCall: ToolCallPayload | null
}

export type TaskStatus = 'pending' | 'working' | 'done' | 'error'

export interface TaskUpdatePayload {
  id: string
  label: string
  status: TaskStatus
  detail?: string
}

/** Where the autonomous agent pulls its tasks from. */
export type TaskSource = 'todo' | 'github'

/** Status of the background Autonomous Coding agent (Phase 8). */
export interface AutonomousStatus {
  active: boolean
  state: 'disabled' | 'monitoring' | 'working' | 'paused'
  currentTask?: string
  detail?: string
}

// ── Phase 12: AI Interviewer types ──────────────────────────────────────────

export type InterviewState = 'idle' | 'asking' | 'listening' | 'evaluating' | 'complete'

export interface InterviewQuestionPayload {
  text: string
  audioBase64: string
  questionNumber: number
}

export interface InterviewTranscriptPayload {
  speaker: 'interviewer' | 'candidate'
  text: string
}

export interface InterviewStatusPayload {
  state: InterviewState
  detail?: string
}

/** A single entry in the live interview conversation transcript. */
export interface InterviewEntry {
  speaker: 'interviewer' | 'candidate'
  text: string
  id: number
}

/** Signed-in user profile, as returned/pushed by the main auth layer. */
export interface AuthUser {
  id: string
  email: string | null
  display_name: string | null
  avatar_url: string | null
  tier: string
}

export interface OpenUIApi {
  // Window
  hide: () => void
  quit: () => void

  // Chat
  chat: (message: string, tier: Tier) => Promise<void>
  clearHistory: () => void
  onChunk: (cb: (chunk: string) => void) => () => void
  onToolCall: (cb: (tool: ToolCallPayload) => void) => () => void
  onDone: (cb: (result: ChatDonePayload) => void) => () => void
  onError: (cb: (error: string) => void) => () => void
  onTask: (cb: (task: TaskUpdatePayload) => void) => () => void
  onTaskReset: (cb: () => void) => () => void

  // Voice
  transcribeAndChat: (audio: ArrayBuffer, mimeType: string, tier: Tier) => Promise<void>
  onTranscript: (cb: (text: string) => void) => () => void

  // OS Permissions
  onPermissionDenied: (cb: (permission: PermissionTarget) => void) => () => void
  openSettings: (permission: PermissionTarget) => void
  // Phase 8 — Autonomous Coding Mode.
  setAutonomousEnabled: (enabled: boolean, tier?: 'free' | 'pro' | 'enterprise', source?: TaskSource) => void
  setBusy: (busy: boolean) => void
  getAutonomousStatus: () => Promise<AutonomousStatus>
  onAutonomousStatus: (cb: (status: AutonomousStatus) => void) => () => void
  // Phase 12 — AI Interviewer.
  startInterview: (resume: string, jobDescription: string, tier: 'free' | 'pro' | 'enterprise') => Promise<void>
  sendInterviewAnswer: (audio: ArrayBuffer, mimeType: string) => Promise<void>
  stopInterview: () => void
  onInterviewQuestion: (cb: (data: InterviewQuestionPayload) => void) => () => void
  onInterviewTranscript: (cb: (data: InterviewTranscriptPayload) => void) => () => void
  onInterviewStatus: (cb: (data: InterviewStatusPayload) => void) => () => void
  onInterviewError: (cb: (msg: string) => void) => () => void
  // Authentication (Google OAuth via Supabase).
  login: () => Promise<boolean>
  logout: () => Promise<void>
  getUser: () => Promise<AuthUser | null>
  getTier: () => Promise<string>
  onAuthSuccess: (cb: (user: AuthUser) => void) => () => void
  onAuthError: (cb: (error: { message: string }) => void) => () => void
  onAuthLogout: (cb: () => void) => () => void
  // Subscriptions / Stripe.
  checkout: (priceId: string) => Promise<void>
  openPortal: () => Promise<void>
  syncSubscription: () => Promise<'free' | 'pro' | 'enterprise'>
  onTierChanged: (cb: (tier: 'free' | 'pro' | 'enterprise') => void) => () => void
  onPaymentSuccess: (cb: () => void) => () => void
  onPaymentCancelled: (cb: () => void) => () => void
  // Tier upgrade notifications.
  onTierUpgradeNeeded: (cb: (payload: TierUpgradePayload) => void) => () => void
  // Conversation history.
  getConversations: () => Promise<ConversationSummary[]>
  loadConversation: (id: string) => Promise<Array<{ role: string; content: string; created_at: number }>>
  // Telemetry.
  setTelemetryOptOut: (optOut: boolean) => Promise<void>
  getTelemetryStatus: () => Promise<boolean>
}

declare global {
  interface Window {
    openui: OpenUIApi
  }
}

export {}
