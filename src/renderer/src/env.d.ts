/// <reference types="vite/client" />

/** Which OS permission needs to be granted before the tool can proceed. */
export type PermissionTarget = 'accessibility' | 'microphone'

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

export interface OpenUIApi {
  hide: () => void
  quit: () => void
  chat: (message: string, tier: 'free' | 'pro' | 'enterprise') => Promise<void>
  clearHistory: () => void
  onChunk: (cb: (chunk: string) => void) => () => void
  onToolCall: (cb: (tool: ToolCallPayload) => void) => () => void
  onDone: (cb: (result: ChatDonePayload) => void) => () => void
  onError: (cb: (error: string) => void) => () => void
  onTask: (cb: (task: TaskUpdatePayload) => void) => () => void
  onTaskReset: (cb: () => void) => () => void
  transcribeAndChat: (audio: ArrayBuffer, mimeType: string, tier: 'free' | 'pro' | 'enterprise') => Promise<void>
  onTranscript: (cb: (text: string) => void) => () => void
  // Permission prompts — fired by main when a tool detects a missing OS permission.
  onPermissionDenied: (cb: (permission: PermissionTarget) => void) => () => void
  // Ask main to open the System Settings pane for the given permission.
  openSettings: (permission: PermissionTarget) => void
}

declare global {
  interface Window {
    openui: OpenUIApi
  }
}

export {}
