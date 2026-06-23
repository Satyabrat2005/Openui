import { contextBridge, ipcRenderer } from 'electron'

type Tier = 'free' | 'pro' | 'enterprise'
type PermissionTarget = 'accessibility' | 'microphone'
type IpcListener = Parameters<typeof ipcRenderer.on>[1]
type TaskUpdate = {
  id: string
  label: string
  status: 'pending' | 'working' | 'done' | 'error'
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

  // Ask the main process to open the macOS System Settings pane for the
  // given permission (accessibility | microphone).
  openSettings: (permission: PermissionTarget): void => {
    ipcRenderer.send('openui:permission:open-settings', permission)
  }
}

export type OpenUIApi = typeof api

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('openui', api)
} else {
  window.openui = api
}
