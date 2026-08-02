import { describe, it, expect, vi } from 'vitest'

// posthog.ts eager-imports electron + posthog-node and (transitively, via
// ./consent) the settings repo, which pulls in the native better-sqlite3
// binding. Stub all three so importing the module under test never touches
// Electron, the network, or a real database — we are unit-testing the pure
// egress scrubber, nothing else. ./sentry (where scrubText lives) is left REAL:
// it has no eager imports and is the exact filter we want to prove runs.
vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getName: () => 'OpenUI' } }))
vi.mock('posthog-node', () => ({ PostHog: class {} }))
vi.mock('../database/repositories/settingsRepo', () => ({
  getSetting: () => undefined,
  setSetting: () => {}
}))

import { scrubProperties } from './posthog'

describe('scrubProperties — PostHog payload egress filter', () => {
  it('redacts the OS username from a crash stack frame (app_crash.frame)', () => {
    const out = scrubProperties({
      kind: 'uncaughtException',
      frame: 'at handler (C:\\Users\\jane\\AppData\\Local\\Programs\\openui\\index.js:42)'
    })
    expect(out.frame).not.toContain('jane')
    expect(out.frame).toContain('[user]')
    expect(out.kind).toBe('uncaughtException') // controlled values pass through
  })

  it('redacts the home dir from a renderer_error source filename', () => {
    const out = scrubProperties({
      message: 'TypeError: x is undefined',
      source: 'file:///Users/ashu/dev/openui/renderer.js'
    })
    expect(out.source).toContain('/Users/[user]/')
    expect(out.source).not.toContain('ashu')
  })

  it('redacts secrets and emails that slip into a message', () => {
    const out = scrubProperties({
      message: 'auth failed for jane@example.com with token ghp_abcDEF1234567890abcDEF12'
    })
    expect(out.message).not.toContain('jane@example.com')
    expect(out.message).not.toContain('ghp_abcDEF1234567890abcDEF12')
  })

  it('leaves non-string values (counts, flags, latencies) untouched', () => {
    const out = scrubProperties({ token_count: 1234, has_voice: true, tier: 'pro' })
    expect(out).toEqual({ token_count: 1234, has_voice: true, tier: 'pro' })
  })

  it('returns an empty bag for undefined properties', () => {
    expect(scrubProperties(undefined)).toEqual({})
  })
})
