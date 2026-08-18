/**
 * The Slack "skipped channel" signal has to survive the trip from slack.ts to the
 * text the model actually reads. slack.ts's own tests prove readSlackInbox reports
 * an unreadable channel; this proves the summary layer does not quietly discard
 * that and hand back a detail line that reads as a complete view.
 *
 * The real slack module is mocked (not node:https) because the seam under test is
 * inboxSummary's default reader, not the transport.
 */
import { describe, it, expect, vi } from 'vitest'

const slackStub = vi.hoisted(() => ({
  result: {} as Record<string, unknown>
}))

vi.mock('./database/init', () => ({ getDb: () => null, initDb: () => null }))
vi.mock('./slack', () => ({
  isSlackConnected: () => true,
  readSlackInbox: async () => slackStub.result,
  SLACK_TOKEN_SETTING_KEY: 'slack_token'
}))

import { defaultInboxDeps } from './inboxSummary'

const noWhatsApp = {
  readChat: async () => ({ recentContext: [] as string[] }),
  listUnread: async () => [] as Array<{ name: string; preview: string }>
}

function slackReader() {
  return defaultInboxDeps(noWhatsApp as never).slack
}

describe('slack reader surfaces unreadable channels in the summary detail', () => {
  it('states the skipped channel AND that its silence is not evidence', async () => {
    slackStub.result = {
      ok: true,
      messages: [],
      channelsRead: ['#general'],
      skipped: [{ channel: '#eng', reason: 'Slack rate-limited the request; try again shortly.' }],
      truncated: false
    }

    const report = await slackReader()({ limit: 10 } as never)
    expect(report.status).toBe('ok')
    expect(report.detail).toContain('#general')
    // The channel that failed is named rather than omitted…
    expect(report.detail).toContain('#eng')
    expect(report.detail).toMatch(/rate-limited/i)
    // …and the summary explicitly refuses to let its absence read as "empty".
    expect(report.detail).toMatch(/not evidence/i)
  })

  it('says nothing about skipped channels when none were skipped', async () => {
    slackStub.result = {
      ok: true,
      messages: [],
      channelsRead: ['#general'],
      skipped: [],
      truncated: false
    }

    const report = await slackReader()({ limit: 10 } as never)
    expect(report.detail).not.toMatch(/could NOT read/i)
    expect(report.detail).not.toMatch(/not evidence/i)
  })
})
