import { contextBridge, ipcRenderer } from 'electron'

type Tier = 'free' | 'pro' | 'enterprise'
type PermissionTarget = 'accessibility' | 'microphone'
type ConsentStatus = 'unknown' | 'granted' | 'denied'
type TaskSource = 'todo' | 'github'
type InterviewState = 'idle' | 'asking' | 'listening' | 'evaluating' | 'complete'
type IpcListener = Parameters<typeof ipcRenderer.on>[1]

/** Signed-in user profile pushed/returned by the main auth layer. */
type AuthUser = {
  id: string
  email: string | null
  display_name: string | null
  avatar_url: string | null
  tier: string
}
type TaskUpdate = {
  id: string
  label: string
  status: 'pending' | 'working' | 'done' | 'error'
  detail?: string
}
type AutonomousStatus = {
  active: boolean
  state: 'disabled' | 'monitoring' | 'working' | 'paused'
  currentTask?: string
  detail?: string
}
type User = {
  id: string
  email: string | null
  name: string | null
  avatar_url: string | null
  tier: Tier
}
type TierUpgradePayload = {
  requestedTier: Tier
  effectiveTier: Tier
  currentTier: Tier
}
type UsageUpdatePayload = {
  tier: Tier
  limit: number | null
  remaining: number | null
  unlimited: boolean
}
type ConversationSummary = {
  id: string
  title: string
  created_at: number
}
type WaitlistResult =
  | { ok: true; alreadySubscribed?: boolean }
  | { ok: false; error: string }

type HitlRequestPayload = {
  id: string
  tool: string
  args: Record<string, unknown>
  label: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const wrap = <T>(cb: (data: T) => void): IpcListener => ((_: any, data: T) => cb(data)) as IpcListener

const api = {
  hide: (): void => ipcRenderer.send('openui:hide'),
  quit: (): void => ipcRenderer.send('openui:quit'),

  chat: (message: string, tier: Tier): Promise<void> =>
    ipcRenderer.invoke('openui:chat', { message, tier }),

  clearHistory: (): void => ipcRenderer.send('openui:clear-history'),

  onChunk: (cb: (chunk: string) => void): (() => void) => {
    const fn = wrap<string>(cb)
    ipcRenderer.on('openui:chat:chunk', fn)
    return (): void => { ipcRenderer.removeListener('openui:chat:chunk', fn) }
  },

  onToolCall: (cb: (tool: { tool: string; args: Record<string, unknown> }) => void): (() => void) => {
    const fn = wrap<{ tool: string; args: Record<string, unknown> }>(cb)
    ipcRenderer.on('openui:chat:tool', fn)
    return (): void => { ipcRenderer.removeListener('openui:chat:tool', fn) }
  },

  onDone: (cb: (result: { text: string; toolCall: { tool: string; args: Record<string, unknown> } | null }) => void): (() => void) => {
    const fn = wrap<{ text: string; toolCall: { tool: string; args: Record<string, unknown> } | null }>(cb)
    ipcRenderer.on('openui:chat:done', fn)
    return (): void => { ipcRenderer.removeListener('openui:chat:done', fn) }
  },

  onError: (cb: (error: string) => void): (() => void) => {
    const fn = wrap<string>(cb)
    ipcRenderer.on('openui:chat:error', fn)
    return (): void => { ipcRenderer.removeListener('openui:chat:error', fn) }
  },

  onTask: (cb: (task: TaskUpdate) => void): (() => void) => {
    const fn = wrap<TaskUpdate>(cb)
    ipcRenderer.on('openui:task:update', fn)
    return (): void => { ipcRenderer.removeListener('openui:task:update', fn) }
  },

  onTaskReset: (cb: () => void): (() => void) => {
    const fn = (() => cb()) as IpcListener
    ipcRenderer.on('openui:task:reset', fn)
    return (): void => { ipcRenderer.removeListener('openui:task:reset', fn) }
  },

  transcribeAndChat: (audio: ArrayBuffer, mimeType: string, tier: Tier): Promise<void> =>
    ipcRenderer.invoke('openui:voice', { audio: new Uint8Array(audio), mimeType, tier }),

  onTranscript: (cb: (text: string) => void): (() => void) => {
    const fn = wrap<string>(cb)
    ipcRenderer.on('openui:voice:transcript', fn)
    return (): void => { ipcRenderer.removeListener('openui:voice:transcript', fn) }
  },

  onPermissionDenied: (cb: (permission: PermissionTarget) => void): (() => void) => {
    const fn = wrap<PermissionTarget>(cb)
    ipcRenderer.on('openui:permission:denied', fn)
    return (): void => { ipcRenderer.removeListener('openui:permission:denied', fn) }
  },

  // Ask the main process to open the OS settings pane for the given permission
  // (accessibility | microphone): macOS System Settings or Windows ms-settings:.
  openSettings: (permission: PermissionTarget): void => {
    ipcRenderer.send('openui:permission:open-settings', permission)
  },

  // ── subscriptions / Stripe ──────────────────────────────────────────────────

  // Start Stripe Checkout for the given price id (opens a payment window in
  // main). The current user is resolved in the main process — never trusted
  // from here.
  checkout: (priceId: string): Promise<void> => ipcRenderer.invoke('openui:checkout', { priceId }),

  // Open the Stripe billing portal (manage/upgrade/downgrade/cancel/invoices).
  openPortal: (): Promise<void> => ipcRenderer.invoke('openui:portal'),

  // Force an immediate subscription sync; resolves to the verified current tier.
  syncSubscription: (): Promise<Tier> => ipcRenderer.invoke('openui:sync-subscription'),

  // Fired when the verified tier changes (after a sync, webhook, or payment).
  onTierChanged: (cb: (tier: Tier) => void): (() => void) => {
    const fn = wrap<Tier>(cb)
    ipcRenderer.on('openui:tier-changed', fn)
    return (): void => { ipcRenderer.removeListener('openui:tier-changed', fn) }
  },

  // Fired after a checkout completes successfully (post forced-sync).
  onPaymentSuccess: (cb: () => void): (() => void) => {
    const fn = (() => cb()) as IpcListener
    ipcRenderer.on('openui:payment-success', fn)
    return (): void => { ipcRenderer.removeListener('openui:payment-success', fn) }
  },

  // Fired when the user closes/cancels checkout without paying.
  onPaymentCancelled: (cb: () => void): (() => void) => {
    const fn = (() => cb()) as IpcListener
    ipcRenderer.on('openui:payment-cancelled', fn)
    return (): void => { ipcRenderer.removeListener('openui:payment-cancelled', fn) }
  },

  // ── Phase 12: AI Interviewer ──────────────────────────────────────────────
  startInterview: (resume: string, jobDescription: string, tier: Tier): Promise<void> =>
    ipcRenderer.invoke('openui:interview:start', { resume, jobDescription, tier }),

  sendInterviewAnswer: (audio: ArrayBuffer, mimeType: string): Promise<void> =>
    ipcRenderer.invoke('openui:interview:answer', { audio: new Uint8Array(audio), mimeType }),

  stopInterview: (): void => ipcRenderer.send('openui:interview:stop'),

  onInterviewQuestion: (
    cb: (data: { text: string; audioBase64: string; questionNumber: number }) => void
  ): (() => void) => {
    const fn = wrap<{ text: string; audioBase64: string; questionNumber: number }>(cb)
    ipcRenderer.on('openui:interview:question', fn)
    return (): void => { ipcRenderer.removeListener('openui:interview:question', fn) }
  },

  onInterviewTranscript: (
    cb: (data: { speaker: 'interviewer' | 'candidate'; text: string }) => void
  ): (() => void) => {
    const fn = wrap<{ speaker: 'interviewer' | 'candidate'; text: string }>(cb)
    ipcRenderer.on('openui:interview:transcript', fn)
    return (): void => { ipcRenderer.removeListener('openui:interview:transcript', fn) }
  },

  onInterviewStatus: (
    cb: (data: { state: InterviewState; detail?: string }) => void
  ): (() => void) => {
    const fn = wrap<{ state: InterviewState; detail?: string }>(cb)
    ipcRenderer.on('openui:interview:status', fn)
    return (): void => { ipcRenderer.removeListener('openui:interview:status', fn) }
  },

  onInterviewError: (cb: (msg: string) => void): (() => void) => {
    const fn = wrap<string>(cb)
    ipcRenderer.on('openui:interview:error', fn)
    return (): void => { ipcRenderer.removeListener('openui:interview:error', fn) }
  },

  // ── Phase 8: Autonomous Coding Mode ──────────────────────────────────────
  setAutonomousEnabled: (enabled: boolean, tier?: Tier, source?: TaskSource): void => {
    ipcRenderer.send('openui:autonomous:set-enabled', { enabled, tier, source })
  },

  setBusy: (busy: boolean): void => {
    ipcRenderer.send('openui:autonomous:set-busy', busy)
  },

  getAutonomousStatus: (): Promise<AutonomousStatus> =>
    ipcRenderer.invoke('openui:autonomous:get-status'),

  onAutonomousStatus: (cb: (status: AutonomousStatus) => void): (() => void) => {
    const fn = wrap<AutonomousStatus>(cb)
    ipcRenderer.on('openui:autonomous:status', fn)
    return (): void => { ipcRenderer.removeListener('openui:autonomous:status', fn) }
  },

  // ── Authentication (Google OAuth via Supabase) ─────────────────────────────
  login: (): Promise<boolean> => ipcRenderer.invoke('openui:login'),
  logout: (): Promise<void> => ipcRenderer.invoke('openui:logout'),
  getUser: (): Promise<AuthUser | null> => ipcRenderer.invoke('openui:get-user'),
  getTier: (): Promise<string> => ipcRenderer.invoke('openui:get-tier'),

  // Join the Pro-tier waitlist (proxied to Mailchimp via the waitlist Edge
  // Function). Resolves to { ok, alreadySubscribed?, error? }.
  joinWaitlist: (email: string): Promise<WaitlistResult> =>
    ipcRenderer.invoke('openui:join-waitlist', email),

  onAuthSuccess: (cb: (user: AuthUser) => void): (() => void) => {
    const fn = wrap<AuthUser>(cb)
    ipcRenderer.on('openui:auth-success', fn)
    return (): void => { ipcRenderer.removeListener('openui:auth-success', fn) }
  },

  onAuthError: (cb: (error: { message: string }) => void): (() => void) => {
    const fn = wrap<{ message: string }>(cb)
    ipcRenderer.on('openui:auth-error', fn)
    return (): void => { ipcRenderer.removeListener('openui:auth-error', fn) }
  },

  onAuthLogout: (cb: () => void): (() => void) => {
    const fn = (() => cb()) as IpcListener
    ipcRenderer.on('openui:auth-logout', fn)
    return (): void => { ipcRenderer.removeListener('openui:auth-logout', fn) }
  },

  // ── Tier upgrade notifications ────────────────────────────────────────────
  onTierUpgradeNeeded: (cb: (payload: TierUpgradePayload) => void): (() => void) => {
    const fn = wrap<TierUpgradePayload>(cb)
    ipcRenderer.on('openui:tier-upgrade-needed', fn)
    return (): void => { ipcRenderer.removeListener('openui:tier-upgrade-needed', fn) }
  },

  // ── Daily cloud-message usage counter ─────────────────────────────────────
  // Fired after each cloud-proxy turn (and on local turns) so the renderer can
  // show "15/20 messages today". `unlimited` hides the number (Enterprise/local).
  onUsageUpdate: (cb: (usage: UsageUpdatePayload) => void): (() => void) => {
    const fn = wrap<UsageUpdatePayload>(cb)
    ipcRenderer.on('openui:usage-update', fn)
    return (): void => { ipcRenderer.removeListener('openui:usage-update', fn) }
  },

  // ── Conversations ─────────────────────────────────────────────────────────
  getConversations: (): Promise<ConversationSummary[]> =>
    ipcRenderer.invoke('openui:get-conversations'),

  loadConversation: (id: string): Promise<Array<{ role: string; content: string; created_at: number }>> =>
    ipcRenderer.invoke('openui:load-conversation', id),

  // ── Telemetry ────────────────────────────────────────────────────────────────
  setTelemetryOptOut: (optOut: boolean): Promise<void> =>
    ipcRenderer.invoke('openui:set-telemetry-opt-out', optOut),

  getTelemetryStatus: (): Promise<boolean> =>
    ipcRenderer.invoke('openui:get-telemetry-status'),

  // Privacy consent — first-launch ConsentModal + the Settings analytics toggle.
  grantConsent: (): Promise<ConsentStatus> => ipcRenderer.invoke('openui:grant-consent'),
  denyConsent: (): Promise<ConsentStatus> => ipcRenderer.invoke('openui:deny-consent'),
  getConsentStatus: (): Promise<ConsentStatus> => ipcRenderer.invoke('openui:get-consent-status'),

  onConsentUpdated: (cb: (status: ConsentStatus) => void): (() => void) => {
    const fn = wrap<ConsentStatus>(cb)
    ipcRenderer.on('openui:consent-updated', fn)
    return (): void => { ipcRenderer.removeListener('openui:consent-updated', fn) }
  },

  // ── Auto-update (electron-updater) ──────────────────────────────────────────
  // Invokers are no-ops in dev (autoUpdater only runs packaged); the on* event
  // streams stay silent there too. Driven by the UpdateBanner component.
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('openui:get-app-version'),
  checkForUpdates: (): Promise<{ currentVersion: string }> =>
    ipcRenderer.invoke('openui:check-for-updates'),
  downloadUpdate: (): Promise<void> => ipcRenderer.invoke('openui:download-update'),
  installUpdateAndRestart: (): Promise<void> => ipcRenderer.invoke('openui:install-update-restart'),
  openReleasesPage: (): Promise<void> => ipcRenderer.invoke('openui:open-releases-page'),

  onUpdateAvailable: (cb: (info: { version: string; canAutoUpdate: boolean }) => void): (() => void) => {
    const fn = wrap<{ version: string; canAutoUpdate: boolean }>(cb)
    ipcRenderer.on('openui:update-available', fn)
    return (): void => { ipcRenderer.removeListener('openui:update-available', fn) }
  },

  onUpdateNotAvailable: (cb: (info: { version: string }) => void): (() => void) => {
    const fn = wrap<{ version: string }>(cb)
    ipcRenderer.on('openui:update-not-available', fn)
    return (): void => { ipcRenderer.removeListener('openui:update-not-available', fn) }
  },

  onUpdateDownloadProgress: (
    cb: (p: { percent: number; bytesPerSecond: number; transferred: number; total: number }) => void
  ): (() => void) => {
    const fn = wrap<{ percent: number; bytesPerSecond: number; transferred: number; total: number }>(cb)
    ipcRenderer.on('openui:update-download-progress', fn)
    return (): void => { ipcRenderer.removeListener('openui:update-download-progress', fn) }
  },

  onUpdateDownloaded: (cb: (info: { version: string }) => void): (() => void) => {
    const fn = wrap<{ version: string }>(cb)
    ipcRenderer.on('openui:update-downloaded', fn)
    return (): void => { ipcRenderer.removeListener('openui:update-downloaded', fn) }
  },

  onUpdateError: (cb: (e: { message: string }) => void): (() => void) => {
    const fn = wrap<{ message: string }>(cb)
    ipcRenderer.on('openui:update-error', fn)
    return (): void => { ipcRenderer.removeListener('openui:update-error', fn) }
  },

  // ── App settings (key/value persisted in the SQLite settings table) ─────────
  getSetting: (key: string): Promise<unknown> => ipcRenderer.invoke('openui:get-setting', key),
  setSetting: (key: string, value: unknown): Promise<void> =>
    ipcRenderer.invoke('openui:set-setting', { key, value }),

  // ── HITL (Human-in-the-Loop) confirmation ────────────────────────────────────
  // Main process emits openui:hitl:request when a state-changing tool needs
  // user approval. The renderer shows HitlModal and calls respondHitl with the
  // user's decision, which unblocks the agent loop.
  onHitlRequest: (cb: (payload: HitlRequestPayload) => void): (() => void) => {
    const fn = wrap<HitlRequestPayload>(cb)
    ipcRenderer.on('openui:hitl:request', fn)
    return (): void => { ipcRenderer.removeListener('openui:hitl:request', fn) }
  },

  respondHitl: (id: string, approved: boolean): void => {
    ipcRenderer.send('openui:hitl:response', { id, approved })
  }
}

export type OpenUIApi = typeof api

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('openui', api)
} else {
  window.openui = api
}
