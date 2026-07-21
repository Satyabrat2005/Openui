/**
 * notifications.ts — native OS notification tool for the OpenUI agent (Part 6.5).
 *
 * Self-contained tool module (schema + registry). One tool:
 *   notify_user(title, body)  — raise a native OS notification.
 *
 * This is the agent's only channel for proactively alerting the user OUTSIDE the
 * app window — "your autonomous task finished", "I need your input to continue".
 *
 * NO NEW DEPENDENCY: Electron already ships a cross-platform Notification API
 * (backed by the OS notification centre on macOS/Windows/Linux), so this needs
 * nothing beyond `electron` — imported lazily inside the executor so the module
 * still loads in the plain-Node unit-test environment (mirrors gmail.ts).
 *
 * NOT filesystem/OS-mutating, so — per the design note in the task — it is NOT
 * in STATE_CHANGING_TOOLS: an alert doesn't change disk or app state. But it CAN
 * reach the user's attention, so a misbehaving/looping agent must not be able to
 * spam the notification centre. A simple sliding-window RATE LIMIT (max N per
 * minute) is the guard; the limiter is a pure, exported, unit-tested function.
 */

import type { ExecutorContext, ToolResult, ToolSchema } from './tools'

const MAX_TITLE_CHARS = 120
const MAX_BODY_CHARS = 500
// Sliding-window rate limit: at most this many notifications per window.
export const NOTIFY_MAX_PER_WINDOW = 5
export const NOTIFY_WINDOW_MS = 60_000

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * A pure sliding-window rate limiter. `tryAcquire(now)` returns whether a call
 * is permitted at time `now` and, when not, how long until the window frees up.
 * Exported so the limit logic is unit-tested without touching Electron.
 */
export function makeRateLimiter(max: number, windowMs: number): {
  tryAcquire: (now: number) => { allowed: boolean; retryAfterMs: number }
} {
  let hits: number[] = []
  return {
    tryAcquire(now: number) {
      hits = hits.filter((t) => now - t < windowMs)
      if (hits.length >= max) {
        const oldest = hits[0]
        return { allowed: false, retryAfterMs: Math.max(0, windowMs - (now - oldest)) }
      }
      hits.push(now)
      return { allowed: true, retryAfterMs: 0 }
    }
  }
}

// Module-level limiter shared across all notify_user calls in this process.
const limiter = makeRateLimiter(NOTIFY_MAX_PER_WINDOW, NOTIFY_WINDOW_MS)

async function notify_user(args: Record<string, unknown>): Promise<ToolResult> {
  const title = typeof args.title === 'string' ? args.title.trim() : ''
  const body = typeof args.body === 'string' ? args.body.trim() : ''
  if (!title) return { ok: false, error: 'notify_user requires a non-empty "title".' }
  if (title.length > MAX_TITLE_CHARS) return { ok: false, error: `notify_user: "title" exceeds ${MAX_TITLE_CHARS} characters.` }
  if (body.length > MAX_BODY_CHARS) return { ok: false, error: `notify_user: "body" exceeds ${MAX_BODY_CHARS} characters.` }

  const { allowed, retryAfterMs } = limiter.tryAcquire(Date.now())
  if (!allowed) {
    return {
      ok: false,
      error: `notify_user: rate limit reached (max ${NOTIFY_MAX_PER_WINDOW} per minute). Try again in ${Math.ceil(retryAfterMs / 1000)}s.`
    }
  }

  try {
    const { Notification } = await import('electron')
    if (!Notification || typeof Notification.isSupported !== 'function' || !Notification.isSupported()) {
      return { ok: false, error: 'notify_user: native notifications are not supported on this system.' }
    }
    const n = new Notification({ title, body: body || undefined })
    n.show()
    return { ok: true, output: `Notified: "${title}"${body ? ` — ${body}` : ''}.` }
  } catch (e) {
    return { ok: false, error: `notify_user failed: ${errText(e)}` }
  }
}

// ── schema + registry ────────────────────────────────────────────────────────

export const notificationToolSchemas: ToolSchema[] = [
  {
    name: 'notify_user',
    description:
      'Show a native OS notification to get the user\'s attention outside the OpenUI window — e.g. when an ' +
      'autonomous/long-running task finishes, or when you need their input to continue. Use sparingly ' +
      '(there is a per-minute rate limit). Do NOT use it for normal replies — just answer in chat for those.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short notification title (e.g. "Task complete").' },
        body: { type: 'string', description: 'Optional longer line of detail shown under the title.' }
      },
      required: ['title']
    }
  }
]

export const notificationRegistry: Record<
  string,
  (args: Record<string, unknown>, context?: ExecutorContext) => Promise<ToolResult>
> = {
  notify_user
}
