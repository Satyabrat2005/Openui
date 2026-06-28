/// <reference types="vite/client" />

/** Which OS permission needs to be granted before the tool can proceed. */
export type PermissionTarget = 'accessibility' | 'microphone'

/** Privacy consent state for anonymous usage analytics. */
export type ConsentStatus = 'unknown' | 'granted' | 'denied'

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

/** Daily cloud-message usage, pushed after each turn for the live counter. */
export interface UsageUpdatePayload {
  tier: Tier
  /** Daily cap, or null when unlimited (Enterprise / local AI). */
  limit: number | null
  /** Messages remaining today, or null when unlimited. */
  remaining: number | null
  /** True when this turn is not metered — the counter hides the number. */
  unlimited: boolean
}

export interface ConversationSummary {
  id: string
  title: string
  created_at: number
}

/** Emitted when a newer version is found on the update feed. */
export interface UpdateAvailablePayload {
  version: string
  /** false on unsigned macOS — the UI offers a browser download instead. */
  canAutoUpdate: boolean
}

/** Per-chunk progress while an update downloads. */
export interface UpdateProgressPayload {
  percent: number
  bytesPerSecond: number
  transferred: number
  total: number
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

/** Payload emitted when the agent loop needs user approval before running a tool. */
export interface HitlRequestPayload {
  id: string
  tool: string
  args: Record<string, unknown>
  /** Human-readable label from describeToolCall, e.g. "Open Safari" */
  label: string
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

/** Result of a `joinWaitlist` call. */
export type WaitlistResult =
  | { ok: true; alreadySubscribed?: boolean }
  | { ok: false; error: string }

// ── Team / Shared Workflows ───────────────────────────────────────────────────

export interface WorkflowStep {
  tool: string
  args: Record<string, unknown>
}

export interface Workflow {
  name: string
  description: string
  trigger: string
  steps: WorkflowStep[]
}

export type WorkflowResult = { ok: boolean; error?: string }
export type WorkflowImportResult = { ok: boolean; workflow?: Workflow; error?: string }

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
  // Pro-tier waitlist (Mailchimp proxy via Edge Function).
  joinWaitlist: (email: string) => Promise<WaitlistResult>
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
  // Daily cloud-message usage counter.
  onUsageUpdate: (cb: (usage: UsageUpdatePayload) => void) => () => void
  // Conversation history.
  getConversations: () => Promise<ConversationSummary[]>
  loadConversation: (id: string) => Promise<Array<{ role: string; content: string; created_at: number }>>
  resumeConversation: (id: string) => Promise<Array<{ role: string; content: string | null; created_at: number }>>
  // Telemetry.
  setTelemetryOptOut: (optOut: boolean) => Promise<void>
  getTelemetryStatus: () => Promise<boolean>
  // Privacy consent — first-launch ConsentModal + Settings analytics toggle.
  grantConsent: () => Promise<ConsentStatus>
  denyConsent: () => Promise<ConsentStatus>
  getConsentStatus: () => Promise<ConsentStatus>
  onConsentUpdated: (cb: (status: ConsentStatus) => void) => () => void
  // Auto-update (electron-updater). No-ops in dev; events stay silent there.
  getAppVersion: () => Promise<string>
  checkForUpdates: () => Promise<{ currentVersion: string }>
  downloadUpdate: () => Promise<void>
  installUpdateAndRestart: () => Promise<void>
  openReleasesPage: () => Promise<void>
  onUpdateAvailable: (cb: (info: UpdateAvailablePayload) => void) => () => void
  onUpdateNotAvailable: (cb: (info: { version: string }) => void) => () => void
  onUpdateDownloadProgress: (cb: (p: UpdateProgressPayload) => void) => () => void
  onUpdateDownloaded: (cb: (info: { version: string }) => void) => () => void
  onUpdateError: (cb: (e: { message: string }) => void) => () => void
  // App settings (key/value persisted in SQLite).
  getSetting: (key: string) => Promise<unknown>
  setSetting: (key: string, value: unknown) => Promise<void>
  // Team / Shared Workflows.
  listWorkflows: () => Promise<Workflow[]>
  exportWorkflow: (workflow: Workflow) => Promise<WorkflowResult>
  importWorkflow: () => Promise<WorkflowImportResult>
  deleteWorkflow: (name: string) => Promise<WorkflowResult>
  // HITL (Human-in-the-Loop) confirmation.
  onHitlRequest: (cb: (payload: HitlRequestPayload) => void) => () => void
  respondHitl: (id: string, approved: boolean) => void
  // Local AI / Ollama.
  checkOllama: () => Promise<{ installed: boolean; running: boolean }>
  installOllama: () => Promise<void>
  startOllama: () => Promise<boolean>
  dismissOllamaPrompt: (permanent: boolean) => Promise<void>
  pullModel: (modelName: string) => Promise<boolean>
  onLocalAIAvailable: (cb: () => void) => () => void
  onOllamaSuggestion: (cb: () => void) => () => void
  // Action Recorder / Macros.
  recorderStart: () => Promise<void>
  recorderStop: () => Promise<RecorderAction[]>
  recorderPlay: (actions: RecorderAction[]) => Promise<void>
  recorderRecordClick: (x: number, y: number, button?: 'left' | 'right') => Promise<void>
  recorderRecordKeypress: (text: string) => Promise<void>
  recorderGetMacros: () => Promise<RecorderMacro[]>
  recorderSaveMacro: (name: string, actions: RecorderAction[]) => Promise<RecorderMacro>
  recorderDeleteMacro: (name: string) => Promise<boolean>
  recorderIsRecording: () => Promise<boolean>
}

declare global {
  type RecorderAction =
    | { type: 'mousemove'; x: number; y: number; window: string; timestamp: number }
    | { type: 'mouseclick'; x: number; y: number; button: 'left' | 'right'; window: string; timestamp: number }
    | { type: 'keypress'; text: string; timestamp: number }
    | { type: 'delay'; ms: number; timestamp: number }

  type RecorderMacro = { name: string; actions: RecorderAction[]; createdAt: string }

  interface Window {
    openui: OpenUIApi
  }
}

export {}
