/**
 * serverClient.ts — WebSocket transport to the OpenUI backend server.
 *
 * When VITE_SERVER_URL is set, all cloud chat turns are routed here instead of
 * the Supabase Edge Function.  The persistent WebSocket connection handles
 * streaming events and maps them onto the same IPC channels the renderer already
 * listens to, so zero renderer changes are needed.
 *
 * Resilience layers:
 *   1. Exponential backoff reconnect (1 s → 2 s → 4 s → 8 s → 30 s max)
 *   2. After WS_FAILURE_THRESHOLD consecutive send failures, fall back to the
 *      server's non-streaming HTTP POST /chat endpoint for the remainder of the
 *      session (or until a WS send succeeds again).
 *   3. If VITE_SERVER_URL is unset, callers should use callCloudProxy() (Supabase)
 *      directly — this module simply throws in that case.
 */
import type { BrowserWindow } from 'electron'
import type { Message } from './agent'
import type { Tier } from './tools'
import { getCurrentUserId } from './stripe/subscriptionSync'
import { database } from './database'
import { refreshSession } from './auth/sessionManager'

// Backoff schedule: index = attempt number, capped at last entry (30 s).
const BACKOFF_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 30_000]

// Switch to HTTP fallback after this many consecutive WS failures.
const WS_FAILURE_THRESHOLD = 3

// ─── types ───────────────────────────────────────────────────────────────────

interface ServerEvent {
  type: 'chunk' | 'done' | 'error' | 'tool_start' | 'routing' | 'usage_update' | 'screenshot'
  delta?: string
  msg?: string
  task?: unknown
  img?: unknown
  [key: string]: unknown
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function send(win: BrowserWindow, channel: string, ...args: unknown[]): void {
  if (!win.isDestroyed()) win.webContents.send(channel, ...args)
}

// ─── ServerClient class ───────────────────────────────────────────────────────

class ServerClient {
  private ws: WebSocket | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  private consecutiveFailures = 0

  // State scoped to the currently in-flight sendMessage() call.
  private pendingResolve: ((text: string) => void) | null = null
  private pendingReject: ((err: Error) => void) | null = null
  private pendingWin: BrowserWindow | null = null
  // Sink for streamed tokens of the in-flight call. Set per send; the agent loop
  // supplies a StreamGate so tool-call JSON is withheld from the renderer.
  private pendingOnDelta: ((delta: string) => void) | null = null
  private accumulated = ''

  // ── configuration ───────────────────────────────────────────────────────────

  private serverUrl(): string | null {
    return process.env.VITE_SERVER_URL ?? null
  }

  private async accessToken(userId: string): Promise<string | null> {
    const cached = database.users.getValidToken(userId)
    if (cached) return cached
    const ok = await refreshSession()
    return ok ? database.users.getValidToken(userId) : null
  }

  private wsUrl(baseUrl: string, userId: string, token: string): string {
    const ws = baseUrl.replace(/\/$/, '').replace(/^http/, 'ws')
    return `${ws}/ws/${userId}?token=${encodeURIComponent(token)}`
  }

  // ── pending-message helpers ─────────────────────────────────────────────────

  private clearPending(): void {
    this.pendingResolve = null
    this.pendingReject = null
    this.pendingWin = null
    this.pendingOnDelta = null
    this.accumulated = ''
  }

  // ── WebSocket event dispatch ────────────────────────────────────────────────

  private handleRaw(raw: string): void {
    let event: ServerEvent
    try {
      event = JSON.parse(raw) as ServerEvent
    } catch {
      return // ignore malformed frames
    }

    const win = this.pendingWin
    if (!win) return

    switch (event.type) {
      case 'chunk': {
        const delta = typeof event.delta === 'string' ? event.delta : ''
        if (delta) {
          this.accumulated += delta
          // Route through the gate (when set) so tool JSON is withheld; fall back
          // to a direct push for any non-agent caller.
          if (this.pendingOnDelta) this.pendingOnDelta(delta)
          else send(win, 'openui:chat:chunk', delta)
        }
        break
      }
      case 'done': {
        const text = this.accumulated
        const resolve = this.pendingResolve
        this.clearPending()
        resolve?.(text)
        break
      }
      case 'error': {
        const msg = typeof event.msg === 'string' ? event.msg : 'An error occurred.'
        send(win, 'openui:chat:error', msg)
        const reject = this.pendingReject
        this.clearPending()
        reject?.(new Error(msg))
        break
      }
      case 'tool_start':
        send(win, 'openui:task', event.task)
        break
      case 'routing':
        console.log('[serverClient] routing:', event)
        break
      case 'usage_update':
        send(win, 'openui:usage-update', event)
        break
      case 'screenshot':
        send(win, 'openui:screenshot', event.img)
        break
    }
  }

  // ── reconnect ───────────────────────────────────────────────────────────────

  private scheduleReconnect(win: BrowserWindow): void {
    if (this.reconnectTimer !== null) return
    const delay = BACKOFF_DELAYS_MS[Math.min(this.reconnectAttempts, BACKOFF_DELAYS_MS.length - 1)]
    this.reconnectAttempts++
    const timer = setTimeout(() => {
      this.reconnectTimer = null
      void this.ensureConnected(win)
    }, delay)
    // Don't hold the event loop open just for a reconnect.
    ;(timer as NodeJS.Timeout).unref?.()
    this.reconnectTimer = timer
  }

  // ── connection management ───────────────────────────────────────────────────

  private ensureConnected(win: BrowserWindow): Promise<boolean> {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve(true)

    const serverUrl = this.serverUrl()
    if (!serverUrl) return Promise.resolve(false)

    const userId = getCurrentUserId()
    if (!userId) return Promise.resolve(false)

    return this.accessToken(userId).then((token) => {
      if (!token) return false

      return new Promise<boolean>((resolve) => {
        let settled = false
        const settle = (ok: boolean): void => {
          if (settled) return
          settled = true
          resolve(ok)
        }

        const ws = new WebSocket(this.wsUrl(serverUrl, userId, token))

        ws.onopen = (): void => {
          this.ws = ws
          this.reconnectAttempts = 0
          settle(true)
        }

        ws.onmessage = (evt: MessageEvent): void => {
          this.handleRaw(typeof evt.data === 'string' ? evt.data : String(evt.data))
        }

        ws.onerror = (): void => {
          // onclose fires immediately after; handle rejection there.
        }

        ws.onclose = (): void => {
          if (this.ws === ws) this.ws = null

          // Reject any in-flight message so the caller can retry/fallback.
          if (this.pendingReject) {
            const reject = this.pendingReject
            this.clearPending()
            reject(new Error('WebSocket closed unexpectedly'))
          }

          settle(false)
          this.scheduleReconnect(win)
        }
      })
    })
  }

  // ── send over open WebSocket ────────────────────────────────────────────────

  private sendOverWs(
    win: BrowserWindow,
    tier: Tier,
    messages: Message[],
    systemPrompt: string,
    modelKey: string,
    onDelta: (delta: string) => void
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.pendingResolve = (text) => {
        this.consecutiveFailures = 0
        resolve(text)
      }
      this.pendingReject = (err) => {
        this.consecutiveFailures++
        reject(err)
      }
      this.pendingWin = win
      this.pendingOnDelta = onDelta
      this.accumulated = ''

      try {
        this.ws!.send(
          JSON.stringify({
            messages: messages.map((m) => ({ role: m.role, content: m.content })),
            system: systemPrompt,
            modelKey,
            tier
          })
        )
      } catch (err) {
        const rej = this.pendingReject
        this.clearPending()
        this.consecutiveFailures++
        rej?.(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  // ── HTTP fallback (non-streaming) ───────────────────────────────────────────

  private async httpFallback(
    win: BrowserWindow,
    tier: Tier,
    messages: Message[],
    systemPrompt: string,
    modelKey: string,
    onDelta: (delta: string) => void
  ): Promise<string> {
    const serverUrl = this.serverUrl()
    if (!serverUrl) throw new Error('No VITE_SERVER_URL configured')

    const userId = getCurrentUserId()
    if (!userId) throw new Error('Not authenticated')

    const token = await this.accessToken(userId)
    if (!token) throw new Error('Session expired — please sign in again')

    const response = await fetch(`${serverUrl.replace(/\/$/, '')}/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        system: systemPrompt,
        modelKey,
        tier
      })
    })

    if (!response.ok) {
      throw new Error(`Server HTTP fallback returned ${response.status}`)
    }

    const data = (await response.json()) as { text?: string; content?: string }
    const text = data.text ?? data.content ?? ''
    onDelta(text)
    return text
  }

  // ── public API ──────────────────────────────────────────────────────────────

  async sendMessage(
    win: BrowserWindow,
    tier: Tier,
    messages: Message[],
    systemPrompt: string,
    modelKey: string,
    onDelta: (delta: string) => void = (delta) => send(win, 'openui:chat:chunk', delta)
  ): Promise<string> {
    if (!this.serverUrl()) {
      throw new Error('VITE_SERVER_URL is not set — use callCloudProxy() instead')
    }

    // Attempt the WebSocket path unless we've exceeded the failure threshold.
    if (this.consecutiveFailures < WS_FAILURE_THRESHOLD) {
      try {
        const connected = await this.ensureConnected(win)
        if (connected && this.ws?.readyState === WebSocket.OPEN) {
          return await this.sendOverWs(win, tier, messages, systemPrompt, modelKey, onDelta)
        }
      } catch {
        // fall through to HTTP below
      }
    }

    return this.httpFallback(win, tier, messages, systemPrompt, modelKey, onDelta)
  }
}

// ─── module-level singleton & export ─────────────────────────────────────────

export const serverClient = new ServerClient()

/**
 * Drop-in replacement for callCloudProxy() when VITE_SERVER_URL is configured.
 * Same signature, same streaming IPC channels, different transport.
 */
export function sendMessage(
  win: BrowserWindow,
  tier: Tier,
  messages: Message[],
  systemPrompt: string,
  modelKey: string,
  onDelta?: (delta: string) => void
): Promise<string> {
  return serverClient.sendMessage(win, tier, messages, systemPrompt, modelKey, onDelta)
}
