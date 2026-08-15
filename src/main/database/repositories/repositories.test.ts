/**
 * Repository-layer tests — the persistence tier for users, conversations,
 * messages, settings, subscriptions, feedback and the training store.
 *
 * Each `describe` is the suite for one repository. Every test runs against its
 * OWN temp-file SQLite database (created in beforeEach, deleted in afterEach) so
 * the suites are fully isolated and order-independent. The real production
 * `schema.ts` + `migrations.ts` are applied to that database, so create/read/
 * update paths AND the schema's declared constraints (PRIMARY KEY uniqueness,
 * CHECK enumerations, foreign keys) are what's exercised.
 *
 * better-sqlite3 is native and compiled for Electron's ABI, so it can't load
 * under a plain-Node Vitest runner. We therefore mock `../init` to hand every
 * repository a `node:sqlite`-backed handle with the same surface — see
 * ./__support__/tempDb.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTempDb, type TempDb } from './__support__/tempDb'

// Shared mutable handle the mocked getDb() returns. vi.hoisted so the vi.mock
// factory (hoisted above the imports) can safely close over it.
const holder = vi.hoisted(() => ({ current: null as unknown }))

vi.mock('../init', () => ({
  getDb: () => holder.current,
  initDb: () => holder.current
}))

import { applySchema } from '../schema'
import { runMigrations } from '../migrations'
import * as users from './userRepo'
import * as conversations from './conversationRepo'
import * as messages from './messageRepo'
import * as settings from './settingsRepo'
import * as subscriptions from './subscriptionRepo'
import * as feedback from './feedbackRepo'
import * as training from './trainingRepo'
import * as memory from './memoryRepo'

let temp: TempDb

beforeEach(() => {
  temp = createTempDb()
  holder.current = temp.db
  applySchema()
  runMigrations()
})

afterEach(() => {
  temp.cleanup()
  holder.current = null
})

// ── userRepo ───────────────────────────────────────────────────────────────
describe('userRepo', () => {
  it('upserts and reads a user back', () => {
    users.upsertUser({ id: 'u1', email: 'a@b.com', displayName: 'Ann', tier: 'pro' })
    const row = users.getUserById('u1')
    expect(row).not.toBeNull()
    expect(row?.email).toBe('a@b.com')
    expect(row?.display_name).toBe('Ann')
    expect(row?.tier).toBe('pro')
  })

  it('upsert updates an existing row rather than inserting a duplicate', () => {
    users.upsertUser({ id: 'u1', email: 'a@b.com', tier: 'free' })
    users.upsertUser({ id: 'u1', email: 'new@b.com', tier: 'enterprise' })
    const row = users.getUserById('u1')
    expect(row?.email).toBe('new@b.com')
    expect(row?.tier).toBe('enterprise')
  })

  it('defaults tier to free when unspecified', () => {
    users.upsertUser({ id: 'u2' })
    expect(users.getUserById('u2')?.tier).toBe('free')
  })

  it('updateUserTier changes only the tier', () => {
    users.upsertUser({ id: 'u1', email: 'a@b.com', tier: 'free' })
    users.updateUserTier('u1', 'pro')
    const row = users.getUserById('u1')
    expect(row?.tier).toBe('pro')
    expect(row?.email).toBe('a@b.com')
  })

  it('getValidToken returns the token only while unexpired', () => {
    users.upsertUser({ id: 'u1' })
    const future = Math.floor(Date.now() / 1000) + 3600
    users.updateAuthTokens('u1', 'access-tok', 'refresh-tok', future)
    expect(users.getValidToken('u1')).toBe('access-tok')

    const past = Math.floor(Date.now() / 1000) - 10
    users.updateAuthTokens('u1', 'access-tok', 'refresh-tok', past)
    expect(users.getValidToken('u1')).toBeNull()
  })

  it('getUserById returns null for an unknown id', () => {
    expect(users.getUserById('nope')).toBeNull()
  })

  it('rejects a duplicate primary key on a raw insert (constraint)', () => {
    users.upsertUser({ id: 'u1' })
    expect(() =>
      temp.db.prepare('INSERT INTO users (id) VALUES (?)').run('u1')
    ).toThrow()
  })
})

// ── conversationRepo ─────────────────────────────────────────────────────────
describe('conversationRepo', () => {
  beforeEach(() => {
    users.upsertUser({ id: 'owner' })
  })

  it('creates a conversation and reads it back by id', () => {
    const id = conversations.createConversation('owner', 'Trip planning')
    const row = conversations.getConversationById(id)
    expect(row?.title).toBe('Trip planning')
    expect(row?.user_id).toBe('owner')
  })

  it('defaults the title to "New Chat"', () => {
    const id = conversations.createConversation('owner')
    expect(conversations.getConversationById(id)?.title).toBe('New Chat')
  })

  it('lists a user\'s conversations and updates a title', () => {
    const id = conversations.createConversation('owner', 'first')
    conversations.createConversation('owner', 'second')
    expect(conversations.getConversationsByUser('owner')).toHaveLength(2)

    conversations.updateConversationTitle(id, 'renamed')
    expect(conversations.getConversationById(id)?.title).toBe('renamed')
  })

  it('deleteConversation removes the row', () => {
    const id = conversations.createConversation('owner', 'x')
    conversations.deleteConversation(id)
    expect(conversations.getConversationById(id)).toBeNull()
  })

  it('rejects a conversation whose user_id has no matching user (foreign key)', () => {
    expect(() => conversations.createConversation('ghost-user', 'x')).toThrow()
  })
})

// ── messageRepo ──────────────────────────────────────────────────────────────
describe('messageRepo', () => {
  let convId: string
  beforeEach(() => {
    users.upsertUser({ id: 'owner' })
    convId = conversations.createConversation('owner', 'chat')
  })

  it('adds messages and returns them in chronological order', () => {
    messages.addMessage(convId, 'user', 'hello')
    messages.addMessage(convId, 'assistant', 'hi there', 'llama3:8b')
    const rows = messages.getMessagesByConversation(convId)
    expect(rows.map((m) => m.content)).toEqual(['hello', 'hi there'])
    expect(rows[1].role).toBe('assistant')
    expect(rows[1].model).toBe('llama3:8b')
  })

  it('serialises tool calls / results as JSON', () => {
    messages.addMessage(convId, 'tool', '', undefined, { tool: 'open_app' }, { ok: true })
    const row = messages.getMessagesByConversation(convId)[0]
    expect(JSON.parse(row.tool_calls as string)).toEqual({ tool: 'open_app' })
    expect(JSON.parse(row.tool_results as string)).toEqual({ ok: true })
  })

  it('deleteMessage removes a single message', () => {
    const id = messages.addMessage(convId, 'user', 'to delete')
    messages.deleteMessage(id)
    expect(messages.getMessagesByConversation(convId)).toHaveLength(0)
  })

  it('rejects a role outside the allowed set (CHECK constraint)', () => {
    // @ts-expect-error — deliberately passing an invalid role to hit the CHECK.
    expect(() => messages.addMessage(convId, 'robot', 'nope')).toThrow()
  })
})

// ── settingsRepo ─────────────────────────────────────────────────────────────
describe('settingsRepo', () => {
  it('round-trips a JSON value', () => {
    settings.setSetting('autonomy_level', 'full-auto')
    expect(settings.getSetting('autonomy_level')).toBe('full-auto')

    settings.setSetting('prefs', { theme: 'dark', n: 3 })
    expect(settings.getSetting('prefs')).toEqual({ theme: 'dark', n: 3 })
  })

  it('setSetting upserts (updates in place) on a repeated key', () => {
    settings.setSetting('k', 'one')
    settings.setSetting('k', 'two')
    expect(settings.getSetting('k')).toBe('two')
    const count = temp.db
      .prepare('SELECT COUNT(*) AS n FROM settings WHERE key = ?')
      .get('k') as { n: number }
    expect(count.n).toBe(1)
  })

  it('returns null for an unknown key', () => {
    expect(settings.getSetting('missing')).toBeNull()
  })

  it('deleteSetting removes the key', () => {
    settings.setSetting('k', 'v')
    settings.deleteSetting('k')
    expect(settings.getSetting('k')).toBeNull()
  })

  it('rejects a duplicate key on a raw insert (PRIMARY KEY constraint)', () => {
    const insert = temp.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
    insert.run('dup', 'one')
    expect(() => insert.run('dup', 'two')).toThrow()
  })
})

// ── subscriptionRepo ─────────────────────────────────────────────────────────
describe('subscriptionRepo', () => {
  beforeEach(() => {
    users.upsertUser({ id: 'u1' })
  })

  it('caches and reads back a subscription', () => {
    const end = Math.floor(Date.now() / 1000) + 86400
    subscriptions.cacheSubscription('u1', 'pro', 'active', end)
    const row = subscriptions.getCachedSubscription('u1')
    expect(row?.tier).toBe('pro')
    expect(row?.stripe_status).toBe('active')
    expect(row?.current_period_end).toBe(end)
  })

  it('cacheSubscription upserts on the same user', () => {
    subscriptions.cacheSubscription('u1', 'pro', 'active', 100)
    subscriptions.cacheSubscription('u1', 'free', 'canceled', 200)
    const row = subscriptions.getCachedSubscription('u1')
    expect(row?.tier).toBe('free')
    expect(row?.stripe_status).toBe('canceled')
  })

  it('isSubscriptionActive reflects status and period end', () => {
    const future = Math.floor(Date.now() / 1000) + 86400
    const past = Math.floor(Date.now() / 1000) - 86400
    subscriptions.cacheSubscription('u1', 'pro', 'active', future)
    expect(subscriptions.isSubscriptionActive('u1')).toBe(true)

    subscriptions.cacheSubscription('u1', 'pro', 'active', past)
    expect(subscriptions.isSubscriptionActive('u1')).toBe(false)

    subscriptions.cacheSubscription('u1', 'pro', 'canceled', future)
    expect(subscriptions.isSubscriptionActive('u1')).toBe(false)
  })

  it('isSubscriptionActive is false when nothing is cached', () => {
    expect(subscriptions.isSubscriptionActive('unknown')).toBe(false)
  })

  it('rejects a cache row for a non-existent user (foreign key)', () => {
    expect(() => subscriptions.cacheSubscription('ghost', 'pro', 'active', 1)).toThrow()
  })
})

// ── feedbackRepo ─────────────────────────────────────────────────────────────
describe('feedbackRepo', () => {
  it('records a turn at the neutral rating', () => {
    recordAndExpectNeutral()
  })

  function recordAndExpectNeutral(): void {
    feedback.recordTurn('c1', 'do X', 'did X')
    expect(feedback.countFeedback()).toBe(1)
  }

  it('applySignalToLast re-scores the most recent turn in a conversation', () => {
    feedback.recordTurn('c1', 'do X', 'did X')
    feedback.applySignalToLast('c1', 'negative')
    const failing = feedback.getFailingTurnsSince(0)
    expect(failing).toHaveLength(1)
    expect(failing[0].implicit_rating).toBe(1)
  })

  it('a positive signal keeps a turn out of the failing set', () => {
    feedback.recordTurn('c1', 'do X', 'did X')
    feedback.applySignalToLast('c1', 'positive')
    expect(feedback.getFailingTurnsSince(0)).toHaveLength(0)
  })

  it('applySignalToLast is a no-op when there is nothing to score', () => {
    expect(() => feedback.applySignalToLast('c1', 'negative')).not.toThrow()
    expect(feedback.getFailingTurnsSince(0)).toHaveLength(0)
  })

  it('setExplicitRatingOnLast marks a 👎 turn as failing and returns its id', () => {
    feedback.recordTurn('c1', 'do X', 'did X')
    const id = feedback.setExplicitRatingOnLast(1)
    expect(id).not.toBeNull()
    expect(feedback.getFailingTurnsSince(0)).toHaveLength(1)
  })

  it('setExplicitRatingOnLast returns null when there is nothing to rate', () => {
    expect(feedback.setExplicitRatingOnLast(5)).toBeNull()
  })

  it('scopes a signal to its own conversation', () => {
    feedback.recordTurn('c1', 'x', 'x')
    feedback.recordTurn('c2', 'y', 'y')
    feedback.applySignalToLast('c1', 'negative')
    // Only c1's turn should now be failing; c2 stays neutral.
    const failing = feedback.getFailingTurnsSince(0)
    expect(failing).toHaveLength(1)
    expect(failing[0].conversation_id).toBe('c1')
  })
})

// ── trainingRepo ─────────────────────────────────────────────────────────────
describe('trainingRepo', () => {
  function baseExample(overrides: Partial<training.TrainingExampleInput> = {}): training.TrainingExampleInput {
    return {
      conversationId: 'c1',
      userId: 'u1',
      instruction: 'open the notes app',
      finalResponse: 'done',
      outcome: 'success',
      qualityScore: 5,
      model: 'llama3:8b',
      tier: 'free',
      durationMs: 1200,
      steps: [
        { reasoning: 'open it', toolName: 'open_app', toolArgs: { name: 'Notes' }, status: 'success', durationMs: 50 }
      ],
      ...overrides
    }
  }

  it('saves an example with its ordered steps in one transaction', () => {
    const id = training.saveExample(
      baseExample({
        steps: [
          { toolName: 'a', status: 'success' },
          { toolName: 'b', status: 'success' },
          { reasoning: 'no tool here', status: 'success' }
        ]
      })
    )
    const loaded = training.getExampleWithSteps(id)
    expect(loaded).not.toBeNull()
    expect(loaded?.example.step_count).toBe(3)
    expect(loaded?.steps.map((s) => s.step_index)).toEqual([0, 1, 2])
    // tool_sequence captures only the steps that named a tool.
    expect(JSON.parse(loaded?.example.tool_sequence as string)).toEqual(['a', 'b'])
  })

  it('getExampleWithSteps returns null for an unknown id', () => {
    expect(training.getExampleWithSteps('nope')).toBeNull()
  })

  it('updateQualityForLastInConversation re-scores the latest example', () => {
    training.saveExample(baseExample({ qualityScore: 3 }))
    training.updateQualityForLastInConversation('c1', 5)
    const stats = training.getStats()
    expect(stats.highQuality).toBe(1)
  })

  it('getTopExemplars returns only high-quality successful examples', () => {
    training.saveExample(baseExample({ instruction: 'good task', qualityScore: 5, outcome: 'success' }))
    training.saveExample(baseExample({ instruction: 'bad task', qualityScore: 2, outcome: 'error' }))
    const top = training.getTopExemplars(3, 4)
    expect(top).toHaveLength(1)
    expect(top[0].example.instruction).toBe('good task')
  })

  it('getExamplesForExport filters by minimum quality', () => {
    training.saveExample(baseExample({ instruction: 'keep', qualityScore: 5 }))
    training.saveExample(baseExample({ instruction: 'drop', qualityScore: 1 }))
    expect(training.getExamplesForExport(4)).toHaveLength(1)
    expect(training.getExamplesForExport(1)).toHaveLength(2)
  })

  it('getStats aggregates totals, outcomes and average steps', () => {
    training.saveExample(baseExample({ outcome: 'success', steps: [{ toolName: 'a' }, { toolName: 'b' }] }))
    training.saveExample(baseExample({ outcome: 'error', steps: [{ toolName: 'a' }] }))
    const stats = training.getStats()
    expect(stats.total).toBe(2)
    expect(stats.byOutcome.success).toBe(1)
    expect(stats.byOutcome.error).toBe(1)
    expect(stats.avgSteps).toBeCloseTo(1.5)
  })

  it('rejects an example with an outcome outside the allowed set (CHECK constraint)', () => {
    expect(() =>
      // @ts-expect-error — deliberately invalid outcome to hit the CHECK.
      training.saveExample(baseExample({ outcome: 'maybe' }))
    ).toThrow()
    // The failed transaction must leave nothing behind.
    expect(training.getStats().total).toBe(0)
  })
})

describe('memoryRepo — cross-channel memory', () => {
  /** A memory input with sensible defaults; override what the test cares about. */
  const input = (over: Partial<Parameters<typeof memory.recordMemory>[0]> = {}): Parameters<
    typeof memory.recordMemory
  >[0] => ({
    subjectKey: 'ashu',
    subjectLabel: 'Ashu',
    channel: 'whatsapp',
    action: 'send_whatsapp_message',
    direction: 'sent',
    summary: 'Sent a WhatsApp message to Ashu: "design review moved to Thursday 4pm"',
    ...over
  })

  it('records a memory and reads it back', () => {
    const id = memory.recordMemory(input())
    expect(id).toBeTruthy()
    const rows = memory.listMemories()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id,
      subject_key: 'ashu',
      subject_label: 'Ashu',
      channel: 'whatsapp',
      direction: 'sent'
    })
    // created_at is defaulted by SQLite, not passed in.
    expect(rows[0].created_at).toBeGreaterThan(0)
  })

  it('collapses an identical repeat inside the dedup window', () => {
    const first = memory.recordMemory(input())
    const second = memory.recordMemory(input())
    expect(second).toBe(first)
    expect(memory.countMemories()).toBe(1)
  })

  it('treats a different summary under the same subject as a new memory', () => {
    memory.recordMemory(input())
    memory.recordMemory(input({ summary: 'Sent a WhatsApp message to Ashu: "on my way"' }))
    expect(memory.countMemories()).toBe(2)
  })

  it('findMemories returns rows for a requested subject key', () => {
    memory.recordMemory(input())
    memory.recordMemory(input({ subjectKey: 'eng', subjectLabel: '#eng', channel: 'slack', summary: 'Posted in Slack #eng: "standup at 10"' }))
    const found = memory.findMemories(['eng'])
    expect(found.some((r) => r.subject_key === 'eng')).toBe(true)
  })

  it('findMemories still returns the recent tail when no key matches', () => {
    memory.recordMemory(input())
    // A topic question naming no known subject must still get candidates to rank.
    expect(memory.findMemories(['nobody-by-this-name'])).toHaveLength(1)
  })

  it('listMemories returns newest first', () => {
    memory.recordMemory(input({ summary: 'first' }))
    memory.recordMemory(input({ summary: 'second' }))
    // Same-second inserts tie on created_at; the repo breaks the tie on rowid.
    expect(memory.listMemories()[0].summary).toBe('second')
  })

  it('deletes one memory', () => {
    const id = memory.recordMemory(input())
    expect(memory.deleteMemory(id)).toBe(true)
    expect(memory.countMemories()).toBe(0)
    // Deleting again reports that nothing was removed.
    expect(memory.deleteMemory(id)).toBe(false)
  })

  it('clears every memory for one subject, leaving others intact', () => {
    memory.recordMemory(input())
    memory.recordMemory(input({ summary: 'Sent a WhatsApp message to Ashu: "on my way"' }))
    memory.recordMemory(input({ subjectKey: 'mom', subjectLabel: 'Mom', summary: 'Sent a WhatsApp message to Mom: "running late"' }))
    expect(memory.clearSubject('ashu')).toBe(2)
    expect(memory.countMemories()).toBe(1)
    expect(memory.listMemories()[0].subject_key).toBe('mom')
  })

  it('clears everything', () => {
    memory.recordMemory(input())
    memory.recordMemory(input({ subjectKey: 'mom', summary: 'Sent a WhatsApp message to Mom: "hi"' }))
    expect(memory.clearAllMemories()).toBe(2)
    expect(memory.listMemories()).toEqual([])
  })

  it('prunes a subject past MAX_ROWS_PER_SUBJECT, keeping the newest', () => {
    for (let i = 0; i < memory.MAX_ROWS_PER_SUBJECT + 5; i++) {
      memory.recordMemory(input({ summary: `message number ${i}` }))
    }
    expect(memory.countMemories()).toBe(memory.MAX_ROWS_PER_SUBJECT)
    // The most recent write survived; the first ones did not.
    const summaries = memory.listMemories().map((r) => r.summary)
    expect(summaries).toContain(`message number ${memory.MAX_ROWS_PER_SUBJECT + 4}`)
    expect(summaries).not.toContain('message number 0')
  })
})
