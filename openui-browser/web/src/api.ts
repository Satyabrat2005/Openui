// The web data layer. Every desktop `window.openui.*` IPC call the Run Console
// used maps to one function here: REST for one-shot fetches, an SSE reader for
// the live chat/answer stream. This is the ONLY file that knows about HTTP —
// the ported RunConsole/contexts call these, not fetch directly.

import type { Workflow, Tier, User } from './types'

const TOKEN_KEY = 'openui_web_token'
export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) || ''
}
export function setToken(t: string): void {
  localStorage.setItem(TOKEN_KEY, t)
}
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/json' }
}

export interface MeResponse {
  user: User | null
  tier: Tier
}
export async function getMe(): Promise<MeResponse> {
  const res = await fetch('/api/me', { headers: authHeaders() })
  if (!res.ok) return { user: null, tier: 'free' }
  return res.json()
}

export interface ConnectionRow {
  id: string
  name: string
  kind: string
  state: 'connected' | 'disconnected'
}
export async function getConnectionsRemote(): Promise<ConnectionRow[]> {
  try {
    const res = await fetch('/api/connections', { headers: authHeaders() })
    if (!res.ok) return []
    return (await res.json()).connections ?? []
  } catch {
    return []
  }
}

export async function getWorkflows(): Promise<Workflow[]> {
  try {
    const res = await fetch('/api/workflows', { headers: authHeaders() })
    if (!res.ok) return []
    return (await res.json()).workflows ?? []
  } catch {
    return []
  }
}

// ── Chat SSE — the live answer stream (replaces window.openui.onChunk/onDone) ──
export interface ChatHandlers {
  onDelta: (text: string) => void
  onDone: (full: string) => void
  onError: (msg: string) => void
}
export async function streamChat(message: string, h: ChatHandlers): Promise<void> {
  let full = ''

  // (1) Reaching OUR server. A throw here means the request never got an HTTP
  // answer (offline, server down) — a distinct failure from a server error.
  let res: Response
  try {
    res = await fetch('/api/chat', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ messages: [{ role: 'user', content: message }], stream: true })
    })
  } catch {
    h.onError("Can't reach the server. Check your connection and try again.")
    return
  }

  // (2) Server answered non-2xx. It returns JSON `{ error, message }` with a
  // specific, honest reason (misconfig / auth / rate-limit / upstream) — surface
  // that real message, never a generic `chat_error_<status>` bucket.
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string; error?: string } | null
    h.onError(body?.message || body?.error || `Chat failed (HTTP ${res.status}).`)
    return
  }
  if (!res.body) {
    h.onError('The chat service returned an empty response.')
    return
  }

  // (3) Success: read the SSE answer stream.
  try {
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const t = line.trim()
        if (!t.startsWith('data:')) continue
        const data = t.slice(5).trim()
        if (!data || data === '[DONE]') continue
        try {
          const j = JSON.parse(data)
          if (j.delta) {
            full += j.delta
            h.onDelta(j.delta)
          }
        } catch {
          /* keepalive */
        }
      }
    }
    h.onDone(full)
  } catch (err) {
    h.onError(err instanceof Error ? `Chat stream interrupted: ${err.message}` : String(err))
  }
}

// ── Tool execution through the confirmation gate (Step 3/4) ──────────────────
export interface ToolResponse {
  needsConfirmation?: boolean
  confirmation?: { token: string; name: string; destructive: boolean; summary: string; args: unknown }
  ok?: boolean
  summary?: string
  files?: { name: string; url: string; bytes: number }[]
  data?: unknown
  error?: string
}
export async function runTool(
  name: string,
  args: unknown,
  confirmationToken?: string,
  connections?: Record<string, string>
): Promise<ToolResponse> {
  const res = await fetch('/api/tool', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ name, args, confirmationToken, connections })
  })
  return res.json()
}
