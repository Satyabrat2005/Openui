import { describe, it, expect } from 'vitest'
import {
  normalizeAllowlist,
  normalizeAutoReplyConfig,
  matchAllowlist,
  AutoReplyRateLimiter,
  decideAutoReply,
  buildAutoReplyPrompt,
  newSenderCandidates,
  DEFAULT_AUTO_REPLY_CONFIG,
  DEFAULT_POLL_MS,
  MIN_POLL_MS,
  MAX_POLL_MS,
  MAX_ALLOWLIST_ENTRIES,
  RATE_WINDOW_MS,
  type AutoReplyConfig,
  type AllowlistEntry
} from './whatsappAutoReply'

// ── normalizeAllowlist — sanitising the stored/IPC allowlist value ────────────
describe('normalizeAllowlist', () => {
  it('accepts bare name strings and object entries alike', () => {
    const r = normalizeAllowlist(['Ashu', { name: 'Mom', instruction: 'keep it short' }])
    expect(r).toEqual([{ name: 'Ashu' }, { name: 'Mom', instruction: 'keep it short' }])
  })

  it('returns [] for non-array input (fail closed)', () => {
    expect(normalizeAllowlist('Ashu')).toEqual([])
    expect(normalizeAllowlist(null)).toEqual([])
    expect(normalizeAllowlist(undefined)).toEqual([])
  })

  it('drops blanks and de-duplicates case-insensitively', () => {
    const r = normalizeAllowlist(['Ashu', '  ', 'ashu', { name: 'Mom' }])
    expect(r).toEqual([{ name: 'Ashu' }, { name: 'Mom' }])
  })

  it('strips control chars from names and instructions', () => {
    const r = normalizeAllowlist([{ name: 'Ashu\n', instruction: 'be\tbrief' }])
    expect(r).toEqual([{ name: 'Ashu', instruction: 'be brief' }])
  })

  it('drops entries with no usable name', () => {
    expect(normalizeAllowlist([{ instruction: 'orphan' }, 42, {}])).toEqual([])
  })

  it('caps the list length', () => {
    const many = Array.from({ length: MAX_ALLOWLIST_ENTRIES + 10 }, (_, i) => `Person ${i}`)
    expect(normalizeAllowlist(many)).toHaveLength(MAX_ALLOWLIST_ENTRIES)
  })
})

// ── normalizeAutoReplyConfig — clamping + fail-safe enable ────────────────────
describe('normalizeAutoReplyConfig', () => {
  it('resolves a missing/garbage config to the all-off default', () => {
    expect(normalizeAutoReplyConfig(undefined)).toEqual(DEFAULT_AUTO_REPLY_CONFIG)
    expect(normalizeAutoReplyConfig('nonsense')).toEqual(DEFAULT_AUTO_REPLY_CONFIG)
    expect(normalizeAutoReplyConfig(DEFAULT_AUTO_REPLY_CONFIG).enabled).toBe(false)
  })

  it('only a literal true enables the feature (fail safe)', () => {
    expect(normalizeAutoReplyConfig({ enabled: true }).enabled).toBe(true)
    expect(normalizeAutoReplyConfig({ enabled: 1 }).enabled).toBe(false)
    expect(normalizeAutoReplyConfig({ enabled: 'true' }).enabled).toBe(false)
  })

  it('clamps the poll interval into the allowed band', () => {
    expect(normalizeAutoReplyConfig({ pollIntervalMs: 1000 }).pollIntervalMs).toBe(MIN_POLL_MS)
    expect(normalizeAutoReplyConfig({ pollIntervalMs: 10 * 60 * 1000 }).pollIntervalMs).toBe(MAX_POLL_MS)
    expect(normalizeAutoReplyConfig({ pollIntervalMs: DEFAULT_POLL_MS }).pollIntervalMs).toBe(DEFAULT_POLL_MS)
    expect(normalizeAutoReplyConfig({ pollIntervalMs: 'x' }).pollIntervalMs).toBe(DEFAULT_POLL_MS)
  })

  it('clamps the rate caps to sane minimums', () => {
    const c = normalizeAutoReplyConfig({ perContactHourlyCap: 0, globalHourlyCap: -5 })
    expect(c.perContactHourlyCap).toBeGreaterThanOrEqual(1)
    expect(c.globalHourlyCap).toBeGreaterThanOrEqual(1)
  })
})

// ── matchAllowlist — fail-closed unattended sender matching ────────────────────
describe('matchAllowlist', () => {
  const allow: AllowlistEntry[] = [{ name: 'Ashu Kumar' }, { name: 'Mom' }, { name: 'Work Group' }]

  it('matches an exact (case/spacing-insensitive) sender', () => {
    expect(matchAllowlist('ashu kumar', allow)?.name).toBe('Ashu Kumar')
    expect(matchAllowlist('MOM', allow)?.name).toBe('Mom')
  })

  it('returns null for a sender not on the allowlist', () => {
    expect(matchAllowlist('Random Stranger', allow)).toBeNull()
  })

  it('returns null when the sender is empty', () => {
    expect(matchAllowlist('', allow)).toBeNull()
    expect(matchAllowlist('   ', allow)).toBeNull()
  })

  it('does not match a near-miss when a confusable entry is also present', () => {
    // "John A" vs "John B" — neither should confidently win, so no unattended action.
    const twoJohns: AllowlistEntry[] = [{ name: 'John A' }, { name: 'John B' }]
    expect(matchAllowlist('John', twoJohns)).toBeNull()
  })

  it('returns null against an empty allowlist', () => {
    expect(matchAllowlist('Ashu', [])).toBeNull()
  })
})

// ── AutoReplyRateLimiter — per-contact + global sliding windows ────────────────
describe('AutoReplyRateLimiter', () => {
  it('enforces the per-contact hourly cap', () => {
    const rl = new AutoReplyRateLimiter(2, 100)
    const t = 1_000_000
    expect(rl.tryConsume('Ashu', t)).toBe(true)
    expect(rl.tryConsume('Ashu', t + 1)).toBe(true)
    expect(rl.tryConsume('Ashu', t + 2)).toBe(false) // 3rd within the hour blocked
    // A different contact is unaffected by Ashu's cap.
    expect(rl.tryConsume('Mom', t + 3)).toBe(true)
  })

  it('enforces the global hourly cap across contacts', () => {
    const rl = new AutoReplyRateLimiter(100, 2)
    const t = 2_000_000
    expect(rl.tryConsume('Ashu', t)).toBe(true)
    expect(rl.tryConsume('Mom', t + 1)).toBe(true)
    expect(rl.tryConsume('Ravi', t + 2)).toBe(false) // global cap hit
  })

  it('is case/space-insensitive per contact', () => {
    const rl = new AutoReplyRateLimiter(1, 100)
    const t = 3_000_000
    expect(rl.tryConsume(' Ashu ', t)).toBe(true)
    expect(rl.tryConsume('ashu', t + 1)).toBe(false)
  })

  it('lets the window slide: old events expire and free up budget', () => {
    const rl = new AutoReplyRateLimiter(1, 100)
    const t = 4_000_000
    expect(rl.tryConsume('Ashu', t)).toBe(true)
    expect(rl.allow('Ashu', t + 1000)).toBe(false)
    // Just past the one-hour window, the earlier event no longer counts.
    expect(rl.allow('Ashu', t + RATE_WINDOW_MS + 1)).toBe(true)
  })

  it('allow() does not consume budget; record() does', () => {
    const rl = new AutoReplyRateLimiter(1, 100)
    const t = 5_000_000
    expect(rl.allow('Ashu', t)).toBe(true)
    expect(rl.allow('Ashu', t)).toBe(true) // still allowed — allow() is side-effect free
    rl.record('Ashu', t)
    expect(rl.allow('Ashu', t)).toBe(false)
  })
})

// ── decideAutoReply — the ordered OFF-switches ────────────────────────────────
describe('decideAutoReply', () => {
  const enabled: AutoReplyConfig = {
    ...DEFAULT_AUTO_REPLY_CONFIG,
    enabled: true,
    allowlist: [{ name: 'Ashu', instruction: 'keep it short' }]
  }

  it('skips when disabled, even if the sender is allowlisted', () => {
    const d = decideAutoReply('Ashu', { ...enabled, enabled: false }, new AutoReplyRateLimiter(3, 15))
    expect(d).toMatchObject({ action: 'skip' })
  })

  it('skips when the allowlist is empty', () => {
    const d = decideAutoReply('Ashu', { ...enabled, allowlist: [] }, new AutoReplyRateLimiter(3, 15))
    expect(d).toMatchObject({ action: 'skip' })
  })

  it('skips a sender not on the allowlist', () => {
    const d = decideAutoReply('Stranger', enabled, new AutoReplyRateLimiter(3, 15))
    expect(d).toMatchObject({ action: 'skip' })
  })

  it('drafts for an allowlisted sender under the caps, returning the entry', () => {
    const d = decideAutoReply('Ashu', enabled, new AutoReplyRateLimiter(3, 15))
    expect(d.action).toBe('draft')
    if (d.action === 'draft') expect(d.entry.instruction).toBe('keep it short')
  })

  it('skips when the rate limit for the matched contact is exhausted', () => {
    const rl = new AutoReplyRateLimiter(1, 15)
    const t = 9_000_000
    rl.record('Ashu', t)
    const d = decideAutoReply('Ashu', enabled, rl, t + 1)
    expect(d).toMatchObject({ action: 'skip' })
  })
})

// ── buildAutoReplyPrompt — prompt shape ────────────────────────────────────────
describe('buildAutoReplyPrompt', () => {
  it('includes the per-contact instruction and the incoming text', () => {
    const { system, user } = buildAutoReplyPrompt(
      { sender: 'Ashu', preview: 'are you coming?', fullText: 'Hey, are you coming tonight?' },
      { name: 'Ashu', instruction: 'reply as if busy' }
    )
    expect(system).toMatch(/reply as if busy/)
    expect(system).toMatch(/only a suggestion/i)
    expect(user).toMatch(/are you coming tonight/)
    expect(user).toMatch(/Ashu/)
  })

  it('folds in recent context when present, and works without an instruction', () => {
    const { system, user } = buildAutoReplyPrompt(
      { sender: 'Mom', preview: 'call me', recentContext: ['Mom: dinner?', 'You: maybe'] },
      { name: 'Mom' }
    )
    expect(system).not.toMatch(/standing instruction/)
    expect(user).toMatch(/Recent conversation/)
    expect(user).toMatch(/call me/)
  })
})

// ── newSenderCandidates — narrowing OCR diff to plausible chat names ───────────
describe('newSenderCandidates', () => {
  it('returns only newly-appeared name-like lines', () => {
    const before = ['Ashu', '10:30 AM']
    const after = ['Ashu', 'Mom', '10:31 AM', 'Work Group']
    const r = newSenderCandidates(before, after)
    expect(r).toContain('Mom')
    expect(r).toContain('Work Group')
    expect(r).not.toContain('Ashu') // not newly appeared
  })

  it('drops lines with no letters and de-duplicates', () => {
    const r = newSenderCandidates([], ['12:00', 'Mom', 'Mom', '  '])
    expect(r).toEqual(['Mom'])
  })
})
