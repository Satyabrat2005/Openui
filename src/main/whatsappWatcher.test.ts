import { describe, it, expect, vi } from 'vitest'
import { WhatsAppWatcher, type WatcherDeps, type DraftReply } from './whatsappWatcher'
import { DEFAULT_AUTO_REPLY_CONFIG, type AutoReplyConfig } from './whatsappAutoReply'

/** A config with the feature on and one allowlisted contact, for tick tests. */
function enabledConfig(overrides: Partial<AutoReplyConfig> = {}): AutoReplyConfig {
  return {
    ...DEFAULT_AUTO_REPLY_CONFIG,
    enabled: true,
    allowlist: [{ name: 'Ashu', instruction: 'keep it short' }],
    ...overrides
  }
}

/**
 * Fake deps that record what the watcher tried to do. `unread` is a mutable ref
 * so a test can change the current unread-sender set between tick() calls, the
 * way real polls would see the chat list change.
 */
function makeDeps(
  unread: { value: string[] },
  overrides: Partial<WatcherDeps> = {}
): {
  deps: WatcherDeps
  drafts: DraftReply[]
  audits: DraftReply[]
  composeSpy: ReturnType<typeof vi.fn>
} {
  const drafts: DraftReply[] = []
  const audits: DraftReply[] = []
  const composeSpy = vi.fn(async () => 'Sure, on my way!')
  const deps: WatcherDeps = {
    captureUnreadSenders: async () => unread.value,
    readChat: async () => ({ fullText: 'are you coming?', recentContext: [] }),
    compose: composeSpy,
    onDraft: (d) => drafts.push(d),
    onAudit: (d) => audits.push(d),
    ...overrides
  }
  return { deps, drafts, audits, composeSpy }
}

describe('WhatsAppWatcher.tick', () => {
  it('the first poll only baselines — it never drafts, even for an allowlisted sender', async () => {
    const unread = { value: ['Mom'] }
    const { deps, drafts, composeSpy } = makeDeps(unread)
    const w = new WhatsAppWatcher(deps, () => enabledConfig())

    await w.tick() // baseline only
    expect(drafts).toHaveLength(0)
    expect(composeSpy).not.toHaveBeenCalled()

    // Ashu newly enters the unread set on the next poll → draft.
    unread.value = ['Mom', 'Ashu']
    await w.tick()
    expect(composeSpy).toHaveBeenCalledTimes(1)
    expect(drafts).toHaveLength(1)
    expect(drafts[0]).toMatchObject({ contact: 'Ashu', draftText: 'Sure, on my way!' })
  })

  it('never sends — the deps surface is review-only, with no send method', () => {
    const { deps } = makeDeps({ value: [] })
    expect('send' in deps).toBe(false)
    expect(Object.keys(deps)).not.toContain('sendMessage')
  })

  it('does not draft for a sender who is not on the allowlist', async () => {
    const unread = { value: ['Stranger'] }
    const { deps, drafts, composeSpy } = makeDeps(unread)
    const w = new WhatsAppWatcher(deps, () => enabledConfig())
    await w.tick() // baseline
    unread.value = ['Stranger', 'Random Person']
    await w.tick()
    expect(composeSpy).not.toHaveBeenCalled()
    expect(drafts).toHaveLength(0)
  })

  it('respects the per-contact rate limit across polls', async () => {
    const unread = { value: ['x'] }
    const { deps, drafts } = makeDeps(unread)
    const w = new WhatsAppWatcher(deps, () => enabledConfig({ perContactHourlyCap: 1 }))
    await w.tick() // baseline: {x}
    unread.value = ['x', 'Ashu']
    await w.tick() // Ashu new → draft #1
    unread.value = ['x'] // Ashu read
    await w.tick()
    unread.value = ['x', 'Ashu'] // Ashu unread again → new arrival, but cap is 1
    await w.tick()
    expect(drafts).toHaveLength(1)
  })

  it('does not consume rate budget when compose returns empty', async () => {
    const unread = { value: ['x'] }
    const composeSpy = vi.fn(async () => '   ')
    const { deps, drafts } = makeDeps(unread, { compose: composeSpy })
    const w = new WhatsAppWatcher(deps, () => enabledConfig({ perContactHourlyCap: 1 }))
    await w.tick() // baseline
    unread.value = ['x', 'Ashu']
    await w.tick() // compose blank → no draft, budget untouched
    expect(drafts).toHaveLength(0)

    unread.value = ['x'] // Ashu read
    await w.tick()
    composeSpy.mockResolvedValueOnce('On my way')
    unread.value = ['x', 'Ashu'] // Ashu unread again → real reply now allowed
    await w.tick()
    expect(drafts).toHaveLength(1)
  })

  it('stops itself when the config flips to disabled between polls', async () => {
    let cfg = enabledConfig()
    const { deps } = makeDeps({ value: ['Ashu'] })
    const activeChanges: boolean[] = []
    const w = new WhatsAppWatcher({ ...deps, onActiveChange: (a) => activeChanges.push(a) }, () => cfg)
    w.start()
    expect(w.isActive()).toBe(true)
    cfg = enabledConfig({ enabled: false })
    await w.tick()
    expect(w.isActive()).toBe(false)
    expect(activeChanges).toEqual([true, false])
  })

  it('start() is inert while disabled or the allowlist is empty', () => {
    const { deps } = makeDeps({ value: [] })
    const wDisabled = new WhatsAppWatcher(deps, () => enabledConfig({ enabled: false }))
    wDisabled.start()
    expect(wDisabled.isActive()).toBe(false)

    const wEmpty = new WhatsAppWatcher(deps, () => enabledConfig({ allowlist: [] }))
    wEmpty.start()
    expect(wEmpty.isActive()).toBe(false)
  })

  it('emits every composed draft to the audit sink as well as the UI sink', async () => {
    const unread = { value: ['seed'] }
    const { deps, drafts, audits } = makeDeps(unread)
    const w = new WhatsAppWatcher(deps, () => enabledConfig())
    await w.tick() // baseline
    unread.value = ['seed', 'Ashu']
    await w.tick()
    expect(drafts).toHaveLength(1)
    expect(audits).toHaveLength(1)
    expect(audits[0]).toEqual(drafts[0])
  })
})
