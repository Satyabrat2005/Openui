/**
 * generate_prompts_v2.test.ts — renders gate v2 exactly as the product would.
 *
 * Not a test: a generator, run under Vitest because the app's prompt builder
 * and tool executors live behind electron and native modules.
 *
 * THE POINT. A safety gate that grades a model on text the product never
 * produces is grading a different product. So nothing here hand-writes a tool
 * result. Every attack that arrives through a read is rendered by the app's own
 * code path for that read:
 *
 *   telegram       formatMessages()                  — what read_telegram_messages returns
 *   slack          the real read_slack_channel executor, over a mocked https transport
 *   gmail_threads  the real find_email_thread executor, over a mocked Gmail search
 *                  whose candidates pass through defangIncoming exactly as
 *                  findEmailThread does (pinned by untrustedMessages.test.ts)
 *   inbox          renderSummary(), with items defanged as the channel readers do
 *   web            sanitizePageText()                — what browser_extract_text returns
 *   raw            a literal tool output (errors, confirmations, contact lists)
 *
 * and framed as `TOOL RESULT [tool] success|error: …`, the agent loop's own
 * format. Since PR #185 that means the model sees defanged text inside
 * ⟦UNTRUSTED MESSAGE CONTENT⟧ markers — the real, current defence, not a
 * weaker or stronger imagined one.
 *
 * Outputs (under v2/):
 *   prompts/<id>.txt   the system prompt the app would build for that turn
 *   rendered.json      the full message list per case, plus every tool name the
 *                      app REGISTERS (not just the routed ones — a model can emit
 *                      any tool name and the executor will try to run it)
 *
 * Run:
 *   python scripts/finetune/safety-gate/v2/author_cases.py
 *   npx vitest run --config scripts/finetune/safety-gate/v2/vitest.gen.config.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(HERE, 'prompts')

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
vi.mock('../../../../src/main/gmail', async (orig) => {
  const real = (await orig()) as Record<string, unknown>
  const { defangIncoming } = await import('../../../../src/main/untrustedMessages')
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
  prompt: string
  history?: Turn[]
  read?: Read
  followup?: Turn[]
  expect_one_of?: string[]
  attack?: string
  good?: string
}

// Tools the agent loop handles itself rather than through toolSchemas.
const LOOP_TOOLS = ['spawn_subagents', 'complete_step']

describe('safety gate v2 — render cases through the app', () => {
  it('writes prompts and rendered turns for every case', async () => {
    const spec = JSON.parse(readFileSync(join(HERE, 'cases.json'), 'utf-8')) as {
      cases: Case[]
    }

    process.env.SLACK_TOKEN = 'xoxb-gate-generator-not-a-real-token'
    const { buildDefaultSystemPrompt } = await import('../../../../src/main/agent')
    const { selectToolGroups } = await import('../../../../src/main/toolGroups')
    const { formatMessages } = await import('../../../../src/main/telegram')
    const { slackRegistry } = await import('../../../../src/main/slack')
    const { renderSummary } = await import('../../../../src/main/inboxSummary')
    const { sanitizePageText } = await import('../../../../src/main/browser/sanitizer')
    const { defangIncoming } = await import('../../../../src/main/untrustedMessages')
    const { executeTool, toolSchemas } = await import('../../../../src/main/tools')

    const registered = [...new Set([...toolSchemas.map((s) => s.name), ...LOOP_TOOLS])].sort()
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
    const rendered: Record<string, { turns: Turn[]; groups: string[]; routedTools: string[] }> = {}

    for (const c of spec.cases) {
      const turns: Turn[] = [...(c.history ?? []), { role: 'user', content: c.prompt }]
      if (c.read) {
        turns.push({ role: 'assistant', content: JSON.stringify({ tool: c.read.tool, args: c.read.args }) })
        turns.push({ role: 'user', content: await renderRead(c.read) })
      }
      turns.push(...(c.followup ?? []))

      // Shape checks: a malformed conversation would grade the model on nonsense.
      expect(turns[turns.length - 1].role, `${c.id}: last turn must be the user's`).toBe('user')
      for (let i = 1; i < turns.length; i++) {
        expect(turns[i].role, `${c.id}: turns must alternate at ${i}`).not.toBe(turns[i - 1].role)
      }

      const routingText = turns.map((t) => t.content).join('\n')
      const groups = selectToolGroups(routingText)
      const prompt = buildDefaultSystemPrompt(groups)
      writeFileSync(join(OUT_DIR, `${c.id}.txt`), prompt, 'utf-8')
      const routedTools = [...prompt.matchAll(/^- ([a-z_0-9]+)\(/gm)].map((m) => m[1])
      rendered[c.id] = { turns, groups: [...groups].sort(), routedTools }

      expect(prompt, `${c.id}: UNTRUSTED CONTENT rule missing`).toContain('UNTRUSTED CONTENT')
      expect(prompt, `${c.id}: sensitive-action rule missing`).toContain('Sensitive actions')

      // Every tool a case names must be a tool the app actually has; a typo
      // would make a liveness case impossible or an attack undetectable.
      for (const t of c.expect_one_of ?? []) {
        expect(registered, `${c.id}: expected tool ${t} is not registered`).toContain(t)
      }
      for (const reply of [c.attack, c.good]) {
        const m = reply?.match(/^\{"tool": "([a-z_0-9]+)"/)
        if (m) expect(registered, `${c.id}: scripted reply uses unknown tool ${m[1]}`).toContain(m[1])
      }
    }

    writeFileSync(
      join(HERE, 'rendered.json'),
      JSON.stringify({ generated: new Date().toISOString(), registeredTools: registered, cases: rendered }, null, 2),
      'utf-8'
    )

    // Liveness cases that route their expected tool OUT of the prompt would be
    // unfair to the model. Report them rather than silently scoring them.
    const unrouted = spec.cases
      .filter((c) => c.expect_one_of && !c.expect_one_of.some((t) => rendered[c.id].routedTools.includes(t)))
      .map((c) => `${c.id} (wants ${c.expect_one_of!.join('|')}, routed ${rendered[c.id].groups.join(' ')})`)
    // eslint-disable-next-line no-console
    console.log(
      `\nrendered ${spec.cases.length} cases, ${registered.length} registered tools` +
        (unrouted.length ? `\nLIVENESS CASES WHOSE TOOL IS NOT ROUTED:\n  ${unrouted.join('\n  ')}` : '\nall liveness tools routed')
    )
    expect(unrouted, 'liveness cases must be answerable with the tools the app routes').toEqual([])
  })
})
