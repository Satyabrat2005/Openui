import { describe, it, expect, vi } from 'vitest'

// Mock Electron's Notification so the success path can be exercised in plain Node.
const shown: Array<{ title: string; body?: string }> = []
vi.mock('electron', () => ({
  Notification: class {
    opts: { title: string; body?: string }
    static isSupported(): boolean {
      return true
    }
    constructor(opts: { title: string; body?: string }) {
      this.opts = opts
    }
    show(): void {
      shown.push(this.opts)
    }
  }
}))

import {
  notificationRegistry,
  notificationToolSchemas,
  makeRateLimiter,
  NOTIFY_MAX_PER_WINDOW
} from './notifications'

describe('makeRateLimiter (pure)', () => {
  it('permits up to `max` per window then blocks with a retry hint', () => {
    const rl = makeRateLimiter(3, 1000)
    expect(rl.tryAcquire(0).allowed).toBe(true)
    expect(rl.tryAcquire(100).allowed).toBe(true)
    expect(rl.tryAcquire(200).allowed).toBe(true)
    const blocked = rl.tryAcquire(300)
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfterMs).toBeGreaterThan(0)
    // Once the window slides past the first hit, a slot frees up.
    expect(rl.tryAcquire(1001).allowed).toBe(true)
  })
})

describe('notify_user', () => {
  it('validates title/body before doing anything', async () => {
    const empty = await notificationRegistry.notify_user({ body: 'no title' })
    expect(empty.ok).toBe(false)
    const longTitle = await notificationRegistry.notify_user({ title: 'x'.repeat(200) })
    expect(longTitle.ok).toBe(false)
  })

  it('shows a notification then rate-limits a burst', async () => {
    const results = []
    for (let i = 0; i < NOTIFY_MAX_PER_WINDOW + 1; i++) {
      results.push(await notificationRegistry.notify_user({ title: `ping ${i}` }))
    }
    // The first NOTIFY_MAX_PER_WINDOW succeed and reach Notification.show().
    expect(results.slice(0, NOTIFY_MAX_PER_WINDOW).every((r) => r.ok)).toBe(true)
    expect(shown.length).toBe(NOTIFY_MAX_PER_WINDOW)
    // The one past the limit is refused with a rate-limit message.
    const last = results[NOTIFY_MAX_PER_WINDOW]
    expect(last.ok).toBe(false)
    expect(last.error).toMatch(/rate limit/i)
  })

  it('exposes exactly the notify_user schema', () => {
    expect(notificationToolSchemas.map((s) => s.name)).toEqual(['notify_user'])
  })
})
