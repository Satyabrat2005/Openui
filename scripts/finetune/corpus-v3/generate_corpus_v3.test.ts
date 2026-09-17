/**
 * generate_corpus_v3.test.ts — renders the Splen-4B corpus exactly as the app would.
 *
 * Not a test: a generator. It is the safety gate's generator
 * (safety-gate/v2/generate_prompts_v2.test.ts) pointed at corpus.json, so a
 * training row and a gate case go through the same prompt builder, tool
 * routing and message formatters. v2 trained on a compact prompt the app never
 * sends; this is the fix.
 *
 * Output (gitignored, machine-local): scripts/finetune/data/<SPLEN_CORPUS_OUT, default splen-v3>/
 *   train.jsonl / holdout.jsonl   {"messages": [system, ...turns, assistant target], "id", "family"}
 *   train.jsonl.meta.json         read by train_qlora.py (commercial: synthetic only)
 *
 *   python scripts/finetune/corpus-v3/author_corpus.py
 *   SPLEN_CORPUS_OUT=splen-v3.2 npx vitest run --config scripts/finetune/corpus-v3/vitest.corpus.config.ts
 *
 * A row with `memory` gets the app's cross-channel memory block appended to the
 * system prompt, rendered by channelMemory.renderMemoryBlock — as agent.ts does.
 */
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(HERE, '..', 'data', process.env.SPLEN_CORPUS_OUT ?? 'splen-v3')

vi.mock('electron', () => ({
  ipcMain: { on: () => {}, handle: () => {} },
  BrowserWindow: class {},
  app: { getVersion: () => '0.0.0', getPath: () => HERE, getAppPath: () => HERE },
  shell: {},
  dialog: {},
  desktopCapturer: {},
  systemPreferences: {},
  Notification: class {},
  clipboard: {},
  nativeImage: { createFromPath: () => ({}) },
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 0, height: 0 } }) },
  safeStorage: { isEncryptionAvailable: () => false }
}))

// Slack's executor talks to node:https; route its two calls to canned bodies.
const { https } = vi.hoisted(() => ({ https: { bodies: {} as Record<string, string> } }))
vi.mock('node:https', () => ({
  request: (opts: { path?: string }, cb: (res: EventEmitter) => void) => {
    const path = opts.path ?? ''
    const key = Object.keys(https.bodies).find((m) => path.includes(m))
    const body = key ? https.bodies[key] : JSON.stringify({ ok: false, error: 'unknown_method' })
    return Object.assign(new EventEmitter(), {
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
  }
}))

// Gmail search is mocked at the module boundary; the executor's formatting is real.
const { gmailState } = vi.hoisted(() => ({
  gmailState: { candidates: [] as Array<Record<string, string>> }
}))
vi.mock('../../../src/main/gmail', async (orig) => {
  const real = (await orig()) as Record<string, unknown>
  const { defangIncoming } = await import('../../../src/main/untrustedMessages')
  return {
    ...real,
    isGmailConnected: () => true,
    findEmailThread: async () => ({
      ok: true,
      candidates: gmailState.candidates.map((c) => ({
        threadId: c.threadId,
        messageId: c.messageId,
        subject: defangIncoming(c.subject),
        to: defangIncoming(c.to),
        date: c.date,
        from: defangIncoming(c.from ?? ''),
        snippet: defangIncoming(c.snippet ?? '')
      }))
    })
  }
})

interface Incoming {
  sender?: string
  text?: string
  channel?: string
  source?: string
  subject?: string
  to?: string
}
interface Read {
  tool: string
  args: Record<string, unknown>
  render: 'telegram' | 'slack' | 'gmail_threads' | 'inbox' | 'web' | 'raw'
  incoming?: Incoming[]
  chat?: string
  channel?: string
  origin?: string
  text?: string
  ok?: boolean
  output?: string
}
interface Turn {
  role: 'user' | 'assistant'
  content: string
}
interface Case {
  id: string
  family: string
  split: 'train' | 'holdout'
  prompt: string
  history?: Turn[]
  read?: Read
  followup?: Turn[]
  memory?: Array<{ channel: string; subject: string; summary: string; age_seconds: number }>
  target: string
}

describe('Splen-4B corpus v3 — render rows through the app', () => {
  it('writes train and holdout rows with the real system prompt', async () => {
    const spec = JSON.parse(readFileSync(join(HERE, 'corpus.json'), 'utf-8')) as { cases: Case[] }
    process.env.SLACK_TOKEN = 'xoxb-gate-generator-not-a-real-token'
    const { buildDefaultSystemPrompt } = await import('../../../src/main/agent')
    const { renderMemoryBlock, normalizeSubject } = await import('../../../src/main/channelMemory')
    const { selectToolGroups } = await import('../../../src/main/toolGroups')
    const { formatMessages } = await import('../../../src/main/telegram')
    const { slackRegistry } = await import('../../../src/main/slack')
    const { renderSummary } = await import('../../../src/main/inboxSummary')
    const { sanitizePageText } = await import('../../../src/main/browser/sanitizer')
    const { defangIncoming } = await import('../../../src/main/untrustedMessages')
    const { executeTool, toolSchemas } = await import('../../../src/main/tools')

    const registered = new Set(toolSchemas.map((s) => s.name))
    const frame = (tool: string, ok: boolean, body: string): string =>
      `TOOL RESULT [${tool}] ${ok ? 'success' : 'error'}: ${body}`

    async function renderRead(r: Read): Promise<string> {
      const inc = r.incoming ?? []
      switch (r.render) {
        case 'telegram': {
          const chatId = Number(r.chat)
          const updates = inc.map((m, i) => ({
            update_id: 1000 + i,
            message: {
              message_id: 70 + i,
              date: 1_760_000_000 + i * 60,
              chat: chatId < 0
                ? { id: chatId, type: 'group', title: 'Family' }
                : { id: chatId, type: 'private', first_name: m.sender },
              from: { id: 900 + i, first_name: m.sender ?? 'Unknown' },
              text: m.text
            }
          }))
          return frame(r.tool, true, formatMessages(updates as never, String(r.chat), 10))
        }
        case 'slack': {
          const name = String(r.channel).replace(/^#/, '')
          https.bodies = {
            'conversations.list': JSON.stringify({
              ok: true,
              channels: [{ id: 'C0GATE01', name, is_member: true }],
              response_metadata: { next_cursor: '' }
            }),
            'conversations.history': JSON.stringify({
              ok: true,
              messages: inc.map((m) => ({ username: m.sender, text: m.text })).reverse()
            })
          }
          const res = await slackRegistry.read_slack_channel({ channel: r.channel })
          if (!res.ok) throw new Error(`slack render failed for ${r.channel}: ${res.error}`)
          return frame(r.tool, true, res.output ?? '')
        }
        case 'gmail_threads': {
          gmailState.candidates = inc.map((m, i) => ({
            threadId: `t${i}`,
            messageId: `m${i}`,
            subject: m.subject ?? '',
            to: m.to ?? '',
            date: 'Mon, 8 Sep 2026 09:00:00 +0530'
          }))
          const res = await executeTool(r.tool, r.args, { tier: 'enterprise' })
          if (!('ok' in res) || !res.ok) throw new Error(`gmail render failed: ${JSON.stringify(res)}`)
          return frame(r.tool, true, res.output ?? '')
        }
        case 'inbox': {
          const wanted = (r.args.channels as string[] | undefined) ?? ['whatsapp', 'telegram', 'slack', 'gmail']
          const channels = ['whatsapp', 'telegram', 'slack', 'gmail'].map((ch) => {
            const items = inc
              .filter((m) => m.channel === ch)
              .map((m) => ({
                channel: ch,
                source: defangIncoming(m.source ?? ''),
                from: defangIncoming(m.sender ?? ''),
                preview: defangIncoming(m.text ?? '')
              }))
            return {
              channel: ch,
              status: wanted.includes(ch) ? 'ok' : 'not_requested',
              confidence: ch === 'whatsapp' ? 'best-effort' : 'api',
              items
            }
          })
          const data = {
            scope: r.args.contact ? 'contact' : 'everything',
            ...(r.args.contact ? { contact: { name: String(r.args.contact), handles: [] } } : {}),
            channels,
            totals: {
              items: inc.length,
              channelsRead: wanted.length,
              channelsUnavailable: 0
            }
          }
          return frame(r.tool, true, renderSummary(data as never))
        }
        case 'web':
          return frame(r.tool, true, sanitizePageText(r.text ?? '', r.origin ?? 'unknown origin'))
        case 'raw':
          return frame(r.tool, r.ok !== false, r.output ?? '')
      }
    }

    rmSync(OUT_DIR, { recursive: true, force: true })
    mkdirSync(OUT_DIR, { recursive: true })
    const out: Record<string, string[]> = { train: [], holdout: [] }
    const promptChars: number[] = []
    const unrouted: string[] = []

    for (const c of spec.cases) {
      const turns: Turn[] = [...(c.history ?? []), { role: 'user', content: c.prompt }]
      if (c.read) {
        turns.push({ role: 'assistant', content: JSON.stringify({ tool: c.read.tool, args: c.read.args }) })
        turns.push({ role: 'user', content: await renderRead(c.read) })
      }
      turns.push(...(c.followup ?? []))
      expect(turns[turns.length - 1].role, `${c.id}: last turn must be the user's`).toBe('user')
      for (let i = 1; i < turns.length; i++) {
        expect(turns[i].role, `${c.id}: turns must alternate at ${i}`).not.toBe(turns[i - 1].role)
      }

      // Route and build the prompt exactly as the gate does for its cases.
      const groups = selectToolGroups(turns.map((t) => t.content).join('\n'))
      const now = Math.floor(Date.now() / 1000)
      const memoryBlock = c.memory
        ? renderMemoryBlock(
            c.memory.map((m, i) => ({
              id: `${c.id}-m${i}`,
              subject_key: normalizeSubject(m.subject),
              subject_label: m.subject,
              channel: m.channel,
              action: 'corpus',
              direction: 'sent',
              summary: m.summary,
              created_at: now - m.age_seconds
            })) as never,
            now
          )
        : ''
      const base = buildDefaultSystemPrompt(groups)
      const system = base + memoryBlock
      const routed = [...base.matchAll(/^- ([a-z_0-9]+)\(/gm)].map((m) => m[1])

      // A target that calls a tool the prompt does not offer would teach the
      // model to call tools it cannot see.
      const m = c.target.match(/^\{"tool": "([a-z_0-9]+)"/)
      if (m) {
        expect(registered.has(m[1]), `${c.id}: target uses unknown tool ${m[1]}`).toBe(true)
        if (!routed.includes(m[1])) {
          // Dropped, and listed: each is either a phrasing to fix here or a
          // routing gap in the app (toolGroups.ts) worth fixing there.
          unrouted.push(`${c.id}: "${c.prompt}" wants ${m[1]}, routed ${[...groups].sort().join(' ')}`)
          continue
        }
      }
      promptChars.push(system.length + turns.reduce((n, t) => n + t.content.length, 0))
      const messages = [{ role: 'system', content: system }, ...turns, { role: 'assistant', content: c.target }]
      out[c.split].push(JSON.stringify({ id: c.id, family: c.family, messages }))
    }

    writeFileSync(join(OUT_DIR, 'train.jsonl'), out.train.join('\n') + '\n', 'utf-8')
    writeFileSync(join(OUT_DIR, 'holdout.jsonl'), out.holdout.join('\n') + '\n', 'utf-8')
    writeFileSync(
      join(OUT_DIR, 'train.jsonl.meta.json'),
      JSON.stringify(
        {
          commercial: true,
          real_rows: 0,
          synthetic_rows: spec.cases.length,
          corpus: process.env.SPLEN_CORPUS_OUT ?? 'v3',
          generated: new Date().toISOString()
        },
        null,
        2
      ),
      'utf-8'
    )
    writeFileSync(join(OUT_DIR, 'unrouted.txt'), unrouted.join('\n') + '\n', 'utf-8')
    // A handful is a phrasing problem; many means the corpus and the app disagree.
    expect(unrouted.length, `unrouted targets:\n${unrouted.slice(0, 20).join('\n')}`).toBeLessThan(spec.cases.length * 0.05)
    promptChars.sort((a, b) => a - b)
    const q = (p: number): number => promptChars[Math.floor(p * (promptChars.length - 1))]
    // eslint-disable-next-line no-console
    console.log(`\nrendered ${out.train.length} train / ${out.holdout.length} holdout rows; prompt chars p50 ${q(0.5)} p90 ${q(0.9)} max ${q(1)}`)
  })
})
