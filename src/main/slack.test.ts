import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  slackRegistry,
  slackToolSchemas,
  looksLikeChannelId,
  normalizeChannelName,
  explainSlackError,
  isSlackConnected
} from './slack'

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
