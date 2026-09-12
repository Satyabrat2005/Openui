import { describe, it, expect, afterEach } from 'vitest'

import {
  CODING_DISABLED_MESSAGE,
  CODING_TOOLS,
  CODING_TOOL_GROUPS,
  isCodingEnabled,
  isCodingTool
} from './capabilities'

afterEach(() => {
  delete process.env.OPENUI_ENABLE_CODING
})

describe('isCodingEnabled', () => {
  it('is off when the variable is unset — the shipped default', () => {
    expect(isCodingEnabled()).toBe(false)
  })

  it('is on only for exactly "1"', () => {
    // A flag that accepted "0" or "false" as truthy would be the worst kind of
    // bug here: the surface would be live in production while every test and
    // every reviewer read it as off.
    for (const v of ['0', 'false', 'no', 'true', 'yes', '', 'on']) {
      process.env.OPENUI_ENABLE_CODING = v
      expect(isCodingEnabled(), `value ${JSON.stringify(v)}`).toBe(false)
    }
    process.env.OPENUI_ENABLE_CODING = '1'
    expect(isCodingEnabled()).toBe(true)
  })

  it('is read at call time, not captured at import', () => {
    // Captured-at-import would make the flag untestable and would also mean a
    // value set after startup silently did nothing.
    expect(isCodingEnabled()).toBe(false)
    process.env.OPENUI_ENABLE_CODING = '1'
    expect(isCodingEnabled()).toBe(true)
    delete process.env.OPENUI_ENABLE_CODING
    expect(isCodingEnabled()).toBe(false)
  })
})

describe('the coding surface definition', () => {
  it('names the developer groups and nothing else', () => {
    expect([...CODING_TOOL_GROUPS].sort()).toEqual(['figma', 'github', 'python'])
  })

  it('does NOT claim the document groups', () => {
    // "summarise this thread and put it in a doc" is a messaging request that
    // happens to end in a file. Cutting docs/slides/spreadsheet/drive with the
    // coding surface would remove things the product actually sells.
    const off = new Set<string>(CODING_TOOL_GROUPS)
    for (const keep of ['docs', 'slides', 'spreadsheet', 'drive', 'media', 'archive', 'print']) {
      expect(off.has(keep), `${keep} must stay in the product`).toBe(false)
    }
  })

  it('recognises its tools by name', () => {
    for (const t of CODING_TOOLS) expect(isCodingTool(t)).toBe(true)
  })

  it('does not claim a messaging tool', () => {
    for (const t of [
      'send_whatsapp_message',
      'summarize_inbox',
      'broadcast_message',
      'send_email',
      'control_calendar',
      'send_telegram_message',
      'send_slack_message',
      'link_contact'
    ]) {
      expect(isCodingTool(t), t).toBe(false)
    }
  })
})

describe('CODING_DISABLED_MESSAGE', () => {
  it('says what the product IS, not that something broke', () => {
    // An error that reads like a fault invites a bug report, and invites the
    // model to retry the same call.
    expect(CODING_DISABLED_MESSAGE).toMatch(/messaging/i)
    expect(CODING_DISABLED_MESSAGE).not.toMatch(/error|failed|unavailable|not implemented/i)
  })

  it('does not offer an upgrade as the way round it', () => {
    // This is a scope decision, not a paywall. Implying money unlocks it would
    // be a false promise about what a subscription buys.
    expect(CODING_DISABLED_MESSAGE).not.toMatch(/upgrade|subscription|\bpro\b|enterprise/i)
  })

  it('never sends the user to a terminal', () => {
    // Same boundary the model-download path holds; see terminalBoundary.test.ts.
    expect(CODING_DISABLED_MESSAGE).not.toMatch(/terminal|command line|shell|npm |python /i)
  })
})
