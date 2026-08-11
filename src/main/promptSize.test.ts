/**
 * promptSize.test.ts — the system prompt's token budget, measured against the
 * REAL tool registry.
 *
 * WHY A SEPARATE FILE. agent.test.ts mocks './tools' down to a single stub
 * schema so the loop tests stay deterministic. That is right for those tests,
 * but it silently defeated the size guard living there: the "real general-agent
 * system prompt fits in the window it gets" assertion was building its prompt
 * from ONE tool and could never fail, no matter how far the surface grew. The
 * guard that exists to catch tool-surface growth has to see the real surface, so
 * it lives here, where ./tools is genuinely imported.
 *
 * These numbers are the before/after evidence for the prompt-shrink work — see
 * toolGroups.ts for why the schema payload is trimmed per turn at all.
 */
import { describe, it, expect, vi } from 'vitest'
import { homedir } from 'node:os'

vi.mock('electron', () => ({
  app: { getPath: () => homedir(), getName: () => 'OpenUI', getVersion: () => '0.0.0' },
  ipcMain: { on: () => {}, handle: () => {} },
  desktopCapturer: {},
  clipboard: {},
  shell: { openPath: vi.fn(async () => ''), trashItem: vi.fn(async () => undefined) },
  systemPreferences: {
    getMediaAccessStatus: () => 'granted',
    isTrustedAccessibilityClient: () => true
  },
  dialog: {},
  BrowserWindow: class {},
  Notification: class {},
  screen: { getPrimaryDisplay: () => ({ size: { width: 1920, height: 1080 } }) },
  nativeImage: { createFromPath: () => ({}) }
}))
vi.mock('./telemetry/posthog', () => ({ trackEvent: () => {} }))
// No SQLite in a unit test: every setting reads as absent, which is also the
// first-run state we most want the prompt measured in.
vi.mock('./database', () => ({
  database: {
    settings: { getSetting: () => undefined, setSetting: () => {} },
    messages: { addMessage: () => {} },
    trajectories: { listGood: () => [] }
  }
}))
// These three decide how many schemas reach the prompt, so they are pinned or the
// numbers below are not reproducible. getGithubToken/getFigmaToken read the ENV
// first, and CI legitimately has a GITHUB_TOKEN — which would silently add 9
// schemas and could push a case over the 8192 boundary on the runner but not
// locally. MCP is pinned for the same reason: a machine with a connected server
// contributes extra schemas.
vi.mock('./github', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./github')>()),
  getGithubToken: () => ''
}))
vi.mock('./figma', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./figma')>()),
  getFigmaToken: () => ''
}))
vi.mock('./mcp-client', () => ({ getMcpToolSchemas: () => [], callMcpTool: async () => ({ ok: true }) }))

import { buildDefaultSystemPrompt, resolveNumCtx, retargetToolSection } from './agent'
import { toolSchemas } from './tools'
import { selectToolGroups, ALL_GROUPS, type ToolGroup } from './toolGroups'

/** ~4 chars/token — the same conservative estimate callOllama sizes num_ctx with. */
const tokens = (s: string): number => Math.ceil(s.length / 4)

/** The prompt the interactive loop would build for a given user message. */
const promptFor = (text: string): string => buildDefaultSystemPrompt(selectToolGroups(text))

describe('the full (ungrouped) prompt — the "before" baseline', () => {
  it('is the ~15k-token payload the shrink exists to fix', () => {
    const full = buildDefaultSystemPrompt(new Set(ALL_GROUPS))
    // Recorded so a future change that re-inflates the default is visible in a
    // diff rather than only in latency. Captured from the running app at
    // 61,101 chars / 124 schema lines (GitHub trimmed, no token configured).
    expect(full.length).toBeGreaterThan(40_000)
    expect(toolSchemas.length).toBeGreaterThanOrEqual(130)
  })
})

describe('grouped prompts fit the SMALL context window', () => {
  // The real prize. Before the shrink every automation turn needed num_ctx
  // 32768, and at that window the KV cache stops fitting beside the weights on
  // an 8 GB card. Fitting under CHAT_NUM_CTX (8192) with headroom means the
  // window never has to grow, so the model stays fully resident in VRAM.
  const realistic: Array<[string, string]> = [
    ['gmail', "draft an email to priya@example.com about tomorrow's demo"],
    ['gmail-read', 'check my latest email'],
    ['calendar', 'schedule a meeting tomorrow at 3pm called Design Review'],
    ['whatsapp', "message Ashu on WhatsApp that I'll be 10 minutes late"],
    ['files', 'open my Downloads folder'],
    ['github', 'list the open pull requests on my repo'],
    ['browser', 'go to github.com in my browser'],
    ['research', 'look up the current price of the RTX 4060 online'],
    ['slides', 'make me a powerpoint deck about Q3 results'],
    ['spreadsheet', 'read the budget spreadsheet and total column C'],
    ['knowledge', 'what is the difference between a LoRA and a full fine-tune?'],
    // The classifier's "no opinion" path — the widest prompt the app can build.
    ['fallback', 'thanks, that is all for now']
  ]

  for (const [label, text] of realistic) {
    it(`${label}: fits in 8192 with room for conversation`, () => {
      const prompt = promptFor(text)
      // resolveNumCtx must not have to grow past the small chat floor…
      expect(resolveNumCtx(false, prompt.length)).toBe(8192)
      // …and the prompt itself must leave real room for history + tool results.
      expect(tokens(prompt)).toBeLessThan(6000)
    })
  }

  it('cuts the full prompt by more than half on a focused request', () => {
    const full = buildDefaultSystemPrompt(new Set(ALL_GROUPS))
    const focused = promptFor('check my latest email')
    expect(focused.length).toBeLessThan(full.length / 2)
  })

  // The measured headline for this change, pinned so a regression is a red test
  // rather than a slow app: 13,298 tokens / num_ctx 32768 before, ~3.2k–5.8k
  // tokens / num_ctx 8192 after, across all 44 eval prompts.
  it('never needs a window bigger than the 8192 floor on any eval prompt', () => {
    const evalPrompts: string[] = (
      require('../../scripts/finetune/eval/evalset.json') as { cases: Array<{ prompt: string }> }
    ).cases.map((c) => c.prompt)
    expect(evalPrompts.length).toBe(44)
    for (const p of evalPrompts) {
      const built = promptFor(p)
      expect(resolveNumCtx(false, built.length), `grew the window for: ${p}`).toBe(8192)
    }
  })
})

describe('safety text survives trimming', () => {
  // Trimming must never drop a rule. These are the lines that stop the model
  // fabricating results, obeying page content, or sending without confirmation —
  // they are not "browser workflow" and must appear on every turn.
  const invariants = [
    'NEVER write a line that starts with "TOOL RESULT"',
    'UNTRUSTED CONTENT',
    'Sensitive actions',
    'Academic work',
    'NEVER invent or describe results you have not received'
  ]

  const surfaces = [
    'check my latest email',
    'open my Downloads folder',
    'what is the capital of France?',
    'make me a deck',
    ''
  ]

  for (const text of surfaces) {
    it(`keeps every hard rule for ${JSON.stringify(text.slice(0, 30) || '(empty)')}`, () => {
      const prompt = promptFor(text)
      for (const rule of invariants) expect(prompt).toContain(rule)
    })
  }
})

/**
 * The prose workflow blocks are ~32% of the payload — gating only the schemas
 * would have left half the win on the table. These assert the blocks actually
 * appear and disappear with their group, since a mis-nested template literal
 * would silently emit them always (or never) and still typecheck.
 */
describe('prose blocks are gated with their group', () => {
  it('includes the deck/document section only for those surfaces', () => {
    expect(promptFor('make me a powerpoint deck about Q3')).toContain('Presentations and documents')
    expect(promptFor('turn this docx into a pdf')).toContain('Presentations and documents')
    expect(promptFor('check my latest email')).not.toContain('Presentations and documents')
    expect(promptFor('open Spotify')).not.toContain('Presentations and documents')
  })

  it('includes the browser workflow only for browser turns', () => {
    expect(promptFor('go to github.com in my browser')).toContain('Browser automation workflow')
    expect(promptFor('check my latest email')).not.toContain('Browser automation workflow')
  })

  it('includes the web-research block only for research turns', () => {
    expect(promptFor('look up the price of the RTX 4060 online')).toContain('Web research')
    expect(promptFor('open my Downloads folder')).not.toContain('Web research')
  })

  it('includes the manual screen primitives only when asked for', () => {
    expect(promptFor('click the button at the top right of the screen')).toContain(
      'Manual screen control'
    )
    expect(promptFor('check my latest email')).not.toContain('Manual screen control')
  })

  // The HARD LIMITATION paragraph belongs to the office section; if the template
  // nesting were wrong it would orphan itself and appear with no context.
  it('keeps the office HARD LIMITATION note with its section', () => {
    const deck = promptFor('make me a powerpoint deck about Q3')
    expect(deck).toContain('HARD LIMITATION')
    expect(promptFor('open Spotify')).not.toContain('HARD LIMITATION')
  })

  it('leaves no stray blank-line runs where a block was gated out', () => {
    for (const text of ['open Spotify', 'check my latest email', 'make me a deck']) {
      expect(promptFor(text)).not.toMatch(/\n{3,}/)
    }
  })
})

describe('capability honesty', () => {
  it('names the trimmed-away surfaces so the assistant does not deny them', () => {
    const prompt = promptFor('check my latest email')
    expect(prompt).toContain('Also available')
    expect(prompt).toContain('slides')
  })

  it('never lists a tool it did not load, and always loads what it advertises', () => {
    const groups = selectToolGroups('make me a powerpoint deck about Q3')
    const prompt = buildDefaultSystemPrompt(groups)
    // Every "- name(" line in the tool block must be a real registered tool.
    const listed = [...prompt.matchAll(/^- ([a-z0-9_]+)\(/gm)].map((m) => m[1])
    const registered = new Set(toolSchemas.map((s) => s.name))
    for (const name of listed) expect(registered.has(name), `${name} is not registered`).toBe(true)
    expect(listed).toContain('add_slide')
  })
})

describe('retargetToolSection — the refined-prompt path', () => {
  const groups = new Set<ToolGroup>(['core', 'email'])

  it('replaces a stale full tool list with the grouped one', () => {
    const stale = buildDefaultSystemPrompt(new Set(ALL_GROUPS))
    const out = retargetToolSection(stale, groups)
    expect(out.length).toBeLessThan(stale.length)
    expect(out).toContain('send_email(')
    // A slides tool must be gone from the tool BLOCK (the capability index may
    // still mention the group by name, which is the point of that line).
    const block = out.slice(out.indexOf('Available tools:'))
    const listed = [...block.matchAll(/^- ([a-z0-9_]+)\(/gm)].map((m) => m[1])
    expect(listed).not.toContain('add_slide')
  })

  it('appends a list when the refiner dropped the section entirely', () => {
    const out = retargetToolSection('You are OpenUI. Be helpful.', groups)
    expect(out).toContain('Available tools:')
    expect(out).toContain('send_email(')
  })

  it('preserves the surrounding prose it was given', () => {
    const prompt = `Intro line.\n\nAvailable tools:\n- old_tool(x: string) — gone\n\nClosing line.`
    const out = retargetToolSection(prompt, groups)
    expect(out).toContain('Intro line.')
    expect(out).toContain('Closing line.')
    expect(out).not.toContain('old_tool')
  })
})
