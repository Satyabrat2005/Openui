import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  slackRegistry,
  slackToolSchemas,
  looksLikeChannelId,
  normalizeChannelName,
  explainSlackError,
  isSlackConnected
} from './slack'

// node:https is mocked so the pagination tests can drive a multi-page
// conversations.list without touching the network (mirrors figma.test.ts).
// Every other test in this file fails validation or the token gate first.
const { httpsRequestMock } = vi.hoisted(() => ({ httpsRequestMock: vi.fn() }))
vi.mock('node:https', () => ({
  request: (...args: unknown[]) => httpsRequestMock(...args)
}))

// Ensure no ambient token leaks in from the environment, so the "not connected"
// paths are deterministic (mirrors how gmail.test isolates its config).
let savedToken: string | undefined
beforeAll(() => {
  savedToken = process.env.SLACK_TOKEN
  delete process.env.SLACK_TOKEN
})
afterAll(() => {
  if (savedToken !== undefined) process.env.SLACK_TOKEN = savedToken
})

describe('slack pure helpers', () => {
  it('recognises channel IDs vs names', () => {
    expect(looksLikeChannelId('C0123ABCD')).toBe(true)
    expect(looksLikeChannelId('G07AB12CD34')).toBe(true)
    expect(looksLikeChannelId('general')).toBe(false)
    expect(looksLikeChannelId('#general')).toBe(false)
  })

  it('normalises channel names', () => {
    expect(normalizeChannelName('#general')).toBe('general')
    expect(normalizeChannelName('  eng  ')).toBe('eng')
  })

  it('explains the common Slack error codes', () => {
    expect(explainSlackError('channel_not_found')).toMatch(/channel/i)
    expect(explainSlackError('not_allowed_token_type')).toMatch(/user token/i)
    expect(explainSlackError('invalid_auth')).toMatch(/token/i)
  })

  it('reports not connected with no token', () => {
    expect(isSlackConnected()).toBe(false)
  })
})

describe('slack tools without a token', () => {
  it('validates arguments before any network call', async () => {
    const noChannel = await slackRegistry.send_slack_message({ text: 'hi' })
    expect(noChannel.ok).toBe(false)
    expect(noChannel.error).toMatch(/channel/i)

    const noText = await slackRegistry.send_slack_message({ channel: '#general', text: '   ' })
    expect(noText.ok).toBe(false)
    expect(noText.error).toMatch(/text/i)

    const noQuery = await slackRegistry.search_slack({ query: '' })
    expect(noQuery.ok).toBe(false)
  })

  it('fails cleanly (no throw) when no token is configured', async () => {
    const r = await slackRegistry.list_slack_channels({})
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/token|Settings/i)

    const s = await slackRegistry.send_slack_message({ channel: '#general', text: 'hi' })
    expect(s.ok).toBe(false)
    expect(s.error).toMatch(/token|Settings/i)
  })

  it('exposes exactly the four slack schemas', () => {
    const names = slackToolSchemas.map((s) => s.name).sort()
    expect(names).toEqual(['list_slack_channels', 'read_slack_channel', 'search_slack', 'send_slack_message'])
  })
})

// ── conversations.list pagination ────────────────────────────────────────────
//
// Regression guard for a defect the pure tests cannot see: conversations.list is
// cursor-paginated and does NOT promise to return `limit` results in one page.
// The old code made a single call and treated its result as the whole workspace,
// so a channel on the second page resolved to "no channel named #x found" — a
// confident wrong answer that sends the user hunting for a typo that isn't there,
// and blocks send_slack_message against a channel that genuinely exists.

describe('slack channel pagination', () => {
  /**
   * Serve a queued sequence of JSON bodies, one per https.request call, and
   * record the query string of each so cursor propagation can be asserted.
   */
  function queue(bodies: string[]): { paths: string[] } {
    const paths: string[] = []
    let i = 0
    httpsRequestMock.mockImplementation(
      (opts: { path?: string }, cb: (res: EventEmitter) => void) => {
        paths.push(opts.path ?? '')
        const body = bodies[Math.min(i, bodies.length - 1)]
        i += 1
        const req = Object.assign(new EventEmitter(), {
          write: (): void => {},
          destroy: (): void => {},
          setTimeout: (): void => {},
          end: (): void => {
            setImmediate(() => {
              const res = Object.assign(new EventEmitter(), { statusCode: 200, headers: {} })
              cb(res)
              setImmediate(() => {
                res.emit('data', Buffer.from(body))
                res.emit('end')
              })
            })
          }
        })
        return req
      }
    )
    return { paths }
  }

  const page1 = JSON.stringify({
    ok: true,
    channels: [{ id: 'C111', name: 'general' }],
    response_metadata: { next_cursor: 'CURSOR2' }
  })
  const page2 = JSON.stringify({
    ok: true,
    channels: [{ id: 'C222', name: 'eng' }],
    response_metadata: { next_cursor: '' }
  })

  beforeEach(() => {
    httpsRequestMock.mockReset()
    process.env.SLACK_TOKEN = 'xoxb-test-token'
  })

  it('follows next_cursor and finds a channel on the SECOND page', async () => {
    const { paths } = queue([page1, page2])
    const r = await slackRegistry.send_slack_message({ channel: '#eng', text: 'hi' })
    // Resolution succeeded, so the failure is (at worst) later — not "not found".
    expect(r.error ?? '').not.toMatch(/no channel named/)
    // Two list pages, and the second carried the cursor from the first.
    const listCalls = paths.filter((p) => p.includes('conversations.list'))
    expect(listCalls).toHaveLength(2)
    expect(listCalls[1]).toContain('cursor=CURSOR2')
  })

  it('list_slack_channels merges every page', async () => {
    queue([page1, page2])
    const r = await slackRegistry.list_slack_channels({})
    expect(r.ok).toBe(true)
    expect(r.output).toContain('#general')
    expect(r.output).toContain('#eng')
    expect(r.output).toMatch(/2 channel\(s\)/)
  })

  it('says the list is partial instead of claiming a channel is absent', async () => {
    // Every page reports another cursor, so the page cap is hit and the walk stops.
    const endless = JSON.stringify({
      ok: true,
      channels: [{ id: 'C999', name: 'noise' }],
      response_metadata: { next_cursor: 'MORE' }
    })
    queue([endless])
    const r = await slackRegistry.send_slack_message({ channel: '#missing', text: 'hi' })
    expect(r.ok).toBe(false)
    // The distinction that matters: "I ran out of pages", not "it does not exist".
    expect(r.error).toMatch(/more than that|Pass the channel ID/)
  })

  it('does not paginate at all when given a channel ID directly', async () => {
    const { paths } = queue([JSON.stringify({ ok: true, ts: '1.2' })])
    await slackRegistry.send_slack_message({ channel: 'C0123ABCD', text: 'hi' })
    expect(paths.filter((p) => p.includes('conversations.list'))).toHaveLength(0)
    expect(paths.some((p) => p.includes('chat.postMessage'))).toBe(true)
  })
})
