import { contextBridge, ipcRenderer } from 'electron'

type Tier = 'free' | 'pro' | 'enterprise'
type PermissionTarget = 'accessibility' | 'microphone'
type TaskSource = 'todo' | 'github'
type IpcListener = Parameters<typeof ipcRenderer.on>[1]
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

  // Live task-list updates pushed by the agent loop as tools execute.
  onTask: (cb: (task: TaskUpdate) => void): (() => void) => {
    const fn = wrap<TaskUpdate>(cb)
    ipcRenderer.on('openui:task:update', fn)
    return (): void => { ipcRenderer.removeListener('openui:task:update', fn) }
  },

  // Fired at the start of each turn to clear the previous run's tasks.
  onTaskReset: (cb: () => void): (() => void) => {
    const fn = (() => cb()) as IpcListener
    ipcRenderer.on('openui:task:reset', fn)
    return (): void => { ipcRenderer.removeListener('openui:task:reset', fn) }
  },

  // Transcribe audio via Whisper and feed the text into the agent router.
  // The audio ArrayBuffer is converted to Uint8Array for IPC transfer.
  transcribeAndChat: (audio: ArrayBuffer, mimeType: string, tier: Tier): Promise<void> =>
    ipcRenderer.invoke('openui:voice', { audio: new Uint8Array(audio), mimeType, tier }),

  // Fires once per voice turn, immediately after Whisper returns and before
  // the agent begins streaming. Use it to display the transcript in the UI.
  onTranscript: (cb: (text: string) => void): (() => void) => {
    const fn = wrap<string>(cb)
    ipcRenderer.on('openui:voice:transcript', fn)
    return (): void => { ipcRenderer.removeListener('openui:voice:transcript', fn) }
  },

  // Fired by main when a tool detects a missing OS permission (e.g. Accessibility
  // for nut.js, Microphone for voice). The renderer should show a modal.
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

  // ── Phase 12: AI Interviewer ──────────────────────────────────────────────
  // Start an interview session with a resume and job description.
  startInterview: (resume: string, jobDescription: string, tier: Tier): Promise<void> =>
    ipcRenderer.invoke('openui:interview:start', { resume, jobDescription, tier }),

  // Send the candidate's recorded audio answer.
  sendInterviewAnswer: (audio: ArrayBuffer, mimeType: string): Promise<void> =>
    ipcRenderer.invoke('openui:interview:answer', { audio: new Uint8Array(audio), mimeType }),

  // Terminate the active interview session.
  stopInterview: (): void => ipcRenderer.send('openui:interview:stop'),

  // New question from the interviewer (includes base64 MP3 for TTS playback).
  onInterviewQuestion: (
    cb: (data: { text: string; audioBase64: string; questionNumber: number }) => void
  ): (() => void) => {
    const fn = wrap<{ text: string; audioBase64: string; questionNumber: number }>(cb)
    ipcRenderer.on('openui:interview:question', fn)
    return (): void => { ipcRenderer.removeListener('openui:interview:question', fn) }
  },

  // Transcript update — fired for both interviewer questions and candidate answers.
  onInterviewTranscript: (
    cb: (data: { speaker: 'interviewer' | 'candidate'; text: string }) => void
  ): (() => void) => {
    const fn = wrap<{ speaker: 'interviewer' | 'candidate'; text: string }>(cb)
    ipcRenderer.on('openui:interview:transcript', fn)
    return (): void => { ipcRenderer.removeListener('openui:interview:transcript', fn) }
  },

  // State-machine status updates (asking / listening / evaluating / complete).
  onInterviewStatus: (
    cb: (data: { state: string; detail?: string }) => void
  ): (() => void) => {
    const fn = wrap<{ state: string; detail?: string }>(cb)
    ipcRenderer.on('openui:interview:status', fn)
    return (): void => { ipcRenderer.removeListener('openui:interview:status', fn) }
  },

  // Error events from the interviewer backend.
  onInterviewError: (cb: (msg: string) => void): (() => void) => {
    const fn = wrap<string>(cb)
    ipcRenderer.on('openui:interview:error', fn)
    return (): void => { ipcRenderer.removeListener('openui:interview:error', fn) }
  },

  // ── Phase 8: Autonomous Coding Mode ──────────────────────────────────────
  // Enable/disable background autonomous coding. The optional tier + source ride
  // along so the UI can choose the model and where tasks come from.
  setAutonomousEnabled: (enabled: boolean, tier?: Tier, source?: TaskSource): void => {
    ipcRenderer.send('openui:autonomous:set-enabled', { enabled, tier, source })
  },

  // Manual "I'm busy" toggle — treat the user as away regardless of idle time.
  setBusy: (busy: boolean): void => {
    ipcRenderer.send('openui:autonomous:set-busy', busy)
  },

  // Fetch the current autonomous status once (e.g. on component mount).
  getAutonomousStatus: (): Promise<AutonomousStatus> =>
    ipcRenderer.invoke('openui:autonomous:get-status'),

  // Subscribe to autonomous status changes (drives the "Background Agent" UI).
  onAutonomousStatus: (cb: (status: AutonomousStatus) => void): (() => void) => {
    const fn = wrap<AutonomousStatus>(cb)
    ipcRenderer.on('openui:autonomous:status', fn)
    return (): void => { ipcRenderer.removeListener('openui:autonomous:status', fn) }
  }
}

export type OpenUIApi = typeof api

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('openui', api)
} else {
  window.openui = api
}
