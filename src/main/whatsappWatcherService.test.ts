import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The auto-reply drafts an answer to someone's private WhatsApp chat. With the
// cloud tier off (the shipped default) that text must stay on this computer:
// it used to go to chat-proxy regardless.

const H = vi.hoisted(() => ({
  callChatProxyText: vi.fn(async () => 'cloud draft'),
  generateSplen: vi.fn(async () => 'local draft')
}))

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('./edgeFunctions', () => ({ callChatProxyText: H.callChatProxyText }))
vi.mock('./splen/runtime', () => ({ generateSplen: H.generateSplen }))
vi.mock('./agent', () => ({ resolveNumCtx: () => 8192 }))
vi.mock('./tools', () => ({
  readWhatsAppUnreadSenders: vi.fn(),
  readWhatsAppChatText: vi.fn(),
  executeTool: vi.fn()
}))
vi.mock('./whatsappAutoReplyConfig', () => ({
  getAutoReplyConfig: vi.fn(),
  setAutoReplyConfig: vi.fn(),
  auditDraftedReply: vi.fn()
}))

import { composeDraft } from './whatsappWatcherService'

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.unstubAllEnvs())

describe('composeDraft', () => {
  it('writes the draft on this computer when the cloud tier is off', async () => {
    vi.stubEnv('OPENUI_ENABLE_CLOUD', '')
    await expect(composeDraft('Reply briefly.', 'Ashu: are we still on for 6?')).resolves.toBe('local draft')
    expect(H.callChatProxyText).not.toHaveBeenCalled()
    expect(H.generateSplen).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: 'Reply briefly.',
        turns: [{ role: 'user', content: 'Ashu: are we still on for 6?' }]
      })
    )
  })

  it('uses chat-proxy only when the cloud tier is switched on', async () => {
    vi.stubEnv('OPENUI_ENABLE_CLOUD', '1')
    await expect(composeDraft('Reply briefly.', 'hi')).resolves.toBe('cloud draft')
    expect(H.generateSplen).not.toHaveBeenCalled()
  })
})
