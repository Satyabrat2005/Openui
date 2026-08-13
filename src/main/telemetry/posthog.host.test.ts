import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Same stubs as posthog.scrub.test.ts: posthog.ts eager-imports electron,
// posthog-node and (via ./consent) the settings repo / native sqlite binding.
vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getName: () => 'OpenUI' } }))
vi.mock('posthog-node', () => ({ PostHog: class {} }))
vi.mock('../database/repositories/settingsRepo', () => ({
  getSetting: () => undefined,
  setSetting: () => {}
}))

import { normalizePostHogHost, DEFAULT_POSTHOG_HOST } from './posthog'

// Regression cover for the telemetry outage shipped in v7.2.0: the
// VITE_POSTHOG_HOST secret held the PostHog PROJECT URL (the page you log into)
// rather than the ingest host the SDK posts to. Every flush went to
// us.posthog.com/project/…/batch/ and 403'd, silently, so the release reported
// zero usage data while looking perfectly healthy.
describe('normalizePostHogHost', () => {
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => warn.mockRestore())

  it('rewrites the exact shape that broke v7.2.0', () => {
    expect(normalizePostHogHost('https://us.posthog.com/project/12345')).toBe('https://us.i.posthog.com')
  })

  it('rewrites a deep project URL, path and query included', () => {
    expect(
      normalizePostHogHost('https://us.posthog.com/project/12345/replay/recent?filter=all#x')
    ).toBe('https://us.i.posthog.com')
  })

  it('maps the EU and legacy app hostnames to their ingest hosts', () => {
    expect(normalizePostHogHost('https://eu.posthog.com/project/9')).toBe('https://eu.i.posthog.com')
    expect(normalizePostHogHost('https://app.posthog.com')).toBe('https://us.i.posthog.com')
  })

  it('leaves a correct ingest host untouched', () => {
    expect(normalizePostHogHost('https://us.i.posthog.com')).toBe('https://us.i.posthog.com')
    expect(normalizePostHogHost('https://eu.i.posthog.com')).toBe('https://eu.i.posthog.com')
    expect(warn).not.toHaveBeenCalled()
  })

  it('passes a self-hosted PostHog through unchanged', () => {
    // The normalisation must not "correct" a host it does not recognise, or a
    // self-hoster's telemetry would be silently redirected to PostHog Cloud.
    expect(normalizePostHogHost('https://telemetry.internal.example.com')).toBe(
      'https://telemetry.internal.example.com'
    )
    expect(normalizePostHogHost('http://localhost:8000')).toBe('http://localhost:8000')
  })

  it('still strips a path from a self-hosted host (ingest hosts have none)', () => {
    expect(normalizePostHogHost('https://ph.example.com/project/3')).toBe('https://ph.example.com')
  })

  it('falls back to the default for empty, malformed, or non-http values', () => {
    for (const bad of ['', '   ', undefined, 'not a url', 'ftp://us.i.posthog.com']) {
      expect(normalizePostHogHost(bad)).toBe(DEFAULT_POSTHOG_HOST)
    }
  })

  it('warns when it corrects a host, so a misconfiguration is visible in logs', () => {
    normalizePostHogHost('https://us.posthog.com/project/12345')
    expect(warn).toHaveBeenCalled()
    expect(String(warn.mock.calls[0][0])).toMatch(/project URL/i)
  })
})
