import { describe, it, expect, vi, afterEach } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp, rm, stat } from 'node:fs/promises'

// tools.ts statically imports `electron` (and, transitively, permissions.ts and
// workflows.ts do too) plus the telemetry client. Neither is available in the
// plain-node vitest environment, so we mock them at the module boundary. Every
// heavy native dep in tools.ts (nut-js, playwright, ollama, pdf-parse) is loaded
// lazily via require(), so it is never touched by these pure-logic tests.
vi.mock('electron', () => ({
  app: { getPath: () => homedir(), getName: () => 'OpenUI' },
  desktopCapturer: {},
  clipboard: {},
  shell: { openPath: vi.fn(async () => ''), trashItem: vi.fn(async () => undefined) },
  systemPreferences: {},
  dialog: {},
  BrowserWindow: class {}
}))
vi.mock('./telemetry/posthog', () => ({ trackEvent: () => {} }))

import {
  executeTool,
  parseDuckDuckGoResults,
  scoreContactCandidates,
  STATE_CHANGING_TOOLS,
  DESTRUCTIVE_TOOLS,
  TIER_TOOL_REQUIREMENTS
} from './tools'

const IS_WIN = process.platform === 'win32'
const IS_MAC = process.platform === 'darwin'

// Track temp dirs created inside $HOME so the mutating-path happy path can clean
// up after itself.
const createdTempDirs: string[] = []
afterEach(async () => {
  while (createdTempDirs.length) {
    const dir = createdTempDirs.pop()!
    await rm(dir, { recursive: true, force: true })
  }
})

// ── The HITL approval gate (the merge/destructive safety boundary) ────────────
describe('executeTool — HITL approval gate', () => {
  it('returns pending_approval for EVERY state-changing tool when bypassHitl is unset', async () => {
    // enterprise tier satisfies every per-tool tier gate, so the HITL gate — not
    // an insufficient-tier denial — is what each tool hits here. (A tool that is
    // both state-changing AND tier-gated, e.g. computer_use, is denied by the
    // tier gate first at a lower tier; that ordering is covered separately below.)
    for (const name of STATE_CHANGING_TOOLS) {
      const r = await executeTool(name, {}, { tier: 'enterprise' })
      expect(r, `${name} must pause for approval`).toMatchObject({
        status: 'pending_approval',
        tool: name
      })
    }
  })

  it('applies the tier gate BEFORE the HITL gate for a tier-gated state-changing tool', async () => {
    // computer_use is both state-changing and Pro-gated. At free tier the user
    // is told they need to upgrade up front, rather than being prompted to
    // approve an action they could not actually run.
    expect(STATE_CHANGING_TOOLS.has('computer_use')).toBe(true)
    expect(TIER_TOOL_REQUIREMENTS.computer_use).toBe('pro')
    const denied = await executeTool('computer_use', { goal: 'x' }, { tier: 'free' })
    expect(denied).toMatchObject({ ok: false })
    expect((denied as { error: string }).error).toMatch(/requires a pro subscription/i)
    // At a sufficient tier it reaches the HITL gate and pauses for approval.
    const gated = await executeTool('computer_use', { goal: 'x' }, { tier: 'pro' })
    expect(gated).toMatchObject({ status: 'pending_approval', tool: 'computer_use' })
  })

  it('gates create_folder before it can touch the filesystem', async () => {
    // No bypass → must not run, even for an otherwise-valid path.
    const r = await executeTool('create_folder', { path: join(homedir(), 'nope') }, { tier: 'free' })
    expect(r).toMatchObject({ status: 'pending_approval', tool: 'create_folder' })
  })

  it('classifies open_pull_request and delete_file as always-confirm destructive tools', () => {
    // agent.ts refuses to auto-bypass anything in DESTRUCTIVE_TOOLS, so a PR can
    // never be opened (and a file never deleted) without a human click — even
    // under approve-plan / full-auto autonomy.
    expect(DESTRUCTIVE_TOOLS.has('open_pull_request')).toBe(true)
    expect(DESTRUCTIVE_TOOLS.has('delete_file')).toBe(true)
    // Every destructive tool is also state-changing (so the gate fires at all).
    for (const name of DESTRUCTIVE_TOOLS) {
      expect(STATE_CHANGING_TOOLS.has(name), `${name} must also be state-changing`).toBe(true)
    }
  })
})

// ── create_folder → pathSafety boundary ───────────────────────────────────────
// Exercised through executeTool with bypassHitl so we test the real dispatch
// path (schema validation + executor), matching how the agent loop calls it
// after the user clicks Allow.
describe('create_folder — filesystem trust boundary', () => {
  it('rejects a credential/secret directory (SENSITIVE_PATH_RE)', async () => {
    const r = await executeTool(
      'create_folder',
      { path: '~/.ssh/evil' },
      { tier: 'free', bypassHitl: true }
    )
    expect(r).toMatchObject({ ok: false })
    expect((r as { error: string }).error).toMatch(/off-limits/)
  })

  it('rejects a mutating path outside the home tree', async () => {
    const outside = IS_WIN ? 'C:\\OpenUITestOutsideHome' : '/OpenUITestOutsideHome'
    const r = await executeTool(
      'create_folder',
      { path: outside },
      { tier: 'free', bypassHitl: true }
    )
    expect(r).toMatchObject({ ok: false })
    expect((r as { error: string }).error).toMatch(/home folder/)
  })

  it('rejects a missing path argument', async () => {
    const r = await executeTool('create_folder', {}, { tier: 'free', bypassHitl: true })
    expect(r).toMatchObject({ ok: false })
    expect((r as { error: string }).error).toMatch(/path/i)
  })

  it('creates a nested folder inside the home tree', async () => {
    const base = await mkdtemp(join(homedir(), 'openui-tools-test-'))
    createdTempDirs.push(base)
    const target = join(base, 'a', 'b', 'c')
    const r = await executeTool(
      'create_folder',
      { path: target },
      { tier: 'free', bypassHitl: true }
    )
    expect(r).toMatchObject({ ok: true })
    expect((await stat(target)).isDirectory()).toBe(true)
  })
})

// ── open_app — app-name validation + shell/terminal blocklist ─────────────────
// open_app is the non-fs launch boundary: it does NOT go through pathSafety
// (it launches apps, it doesn't write files), so it enforces its own blocklist.
describe('open_app — launch boundary', () => {
  it('rejects an empty application name', async () => {
    const r = await executeTool(
      'open_app',
      { appName: '   ' },
      { tier: 'free', bypassHitl: true }
    )
    expect(r).toMatchObject({ ok: false })
    expect((r as { error: string }).error).toMatch(/requires a string "appName"/)
  })

  it('rejects an application name with shell metacharacters', async () => {
    const r = await executeTool(
      'open_app',
      { appName: 'evil; rm -rf ~' },
      { tier: 'free', bypassHitl: true }
    )
    expect(r).toMatchObject({ ok: false })
    expect((r as { error: string }).error).toMatch(/invalid application name/)
  })

  it('opens filesystem paths instead of validating them as app names', async () => {
    const dir = await mkdtemp(join(homedir(), 'openui-open-path-'))
    createdTempDirs.push(dir)
    const r = await executeTool(
      'open_app',
      { appName: dir },
      { tier: 'free', bypassHitl: true }
    )
    expect(r).toMatchObject({ ok: true })
    expect((r as { output: string }).output).toMatch(/Opened/)
  })

  it.runIf(IS_WIN)('refuses to launch shells/registry tools on Windows', async () => {
    for (const blocked of ['cmd', 'powershell', 'reg']) {
      const r = await executeTool(
        'open_app',
        { appName: blocked },
        { tier: 'free', bypassHitl: true }
      )
      expect(r, `${blocked} must be blocked`).toMatchObject({ ok: false })
      expect((r as { error: string }).error).toMatch(/blocked for safety/)
    }
  })

  it.runIf(IS_MAC)('refuses to launch Terminal on macOS', async () => {
    const r = await executeTool(
      'open_app',
      { appName: 'Terminal' },
      { tier: 'free', bypassHitl: true }
    )
    expect(r).toMatchObject({ ok: false })
    expect((r as { error: string }).error).toMatch(/blocked for safety/)
  })
})

// ── executeTool — misc guardrails ─────────────────────────────────────────────
describe('executeTool — dispatch guardrails', () => {
  it('reports an unknown tool without throwing', async () => {
    const r = await executeTool('no_such_tool', {}, { tier: 'free', bypassHitl: true })
    expect(r).toMatchObject({ ok: false })
    expect((r as { error: string }).error).toMatch(/Unknown tool/)
  })
})

// ── browser tools — connect-first + fail-closed trust boundary ────────────────
// The consent/sensitive gates that need a live page are covered by the
// browser/consent + browser/sanitizer unit tests; here we pin the parts that
// must hold BEFORE any browser exists: nothing auto-launches, and every
// browser tool fails closed until connect_browser is approved and run.
describe('browser tools — require an approved connect_browser first', () => {
  const needsConnect = [
    ['browser_navigate', { url: 'https://example.com' }],
    ['browser_click', { selector: '#pay' }],
    ['browser_fill_input', { selector: '#q', text: 'hi' }],
    ['browser_extract_text', {}],
    ['browser_vision_act', { goal: 'dismiss the cookie banner' }],
    ['research_web', { query: 'weather in tokyo' }]
  ] as const

  for (const [name, args] of needsConnect) {
    it(`${name} refuses to run without a connected session`, async () => {
      const r = await executeTool(name, { ...args }, { tier: 'enterprise', bypassHitl: true })
      expect(r).toMatchObject({ ok: false })
      expect((r as { error: string }).error).toMatch(/connect_browser/)
    })
  }

  it('browser_vision_act is tier-gated to pro before anything else', async () => {
    const r = await executeTool('browser_vision_act', { goal: 'x' }, { tier: 'free', bypassHitl: true })
    expect(r).toMatchObject({ ok: false })
    expect((r as { error: string }).error).toMatch(/pro subscription/i)
  })

  it('connect_browser is state-changing: pending approval without bypassHitl', async () => {
    const r = await executeTool('connect_browser', {}, { tier: 'free' })
    expect(r).toMatchObject({ status: 'pending_approval', tool: 'connect_browser' })
  })

  it('research_web runs on the free tier (no cloud vision / no API key)', () => {
    // Read-only web research must NOT be Pro-gated — it powers the Ollama-only
    // launch. It is state-changing (one approval) but never tier-restricted.
    expect(TIER_TOOL_REQUIREMENTS.research_web).toBeUndefined()
    expect(STATE_CHANGING_TOOLS.has('research_web')).toBe(true)
    expect(DESTRUCTIVE_TOOLS.has('research_web')).toBe(false)
  })
})

// ── send_whatsapp_message — outward-facing message send ───────────────────────
describe('send_whatsapp_message', () => {
  it('is state-changing AND destructive (always confirms, never auto-runs)', () => {
    expect(STATE_CHANGING_TOOLS.has('send_whatsapp_message')).toBe(true)
    expect(DESTRUCTIVE_TOOLS.has('send_whatsapp_message')).toBe(true)
    // Runs on the local/free tier — messaging is not behind a paywall.
    expect(TIER_TOOL_REQUIREMENTS.send_whatsapp_message).toBeUndefined()
  })

  it('rejects a call with no message before any keyboard automation runs', async () => {
    // bypassHitl skips the approval gate; validation must still block a send with
    // a missing "message" (required arg) so we never open a chat and send nothing.
    const r = await executeTool('send_whatsapp_message', { contact: 'Ashu' }, { tier: 'free', bypassHitl: true })
    expect(r).toMatchObject({ ok: false })
    expect((r as { error: string }).error).toMatch(/message/i)
  })
})

// ── scoreContactCandidates — OCR candidate scoring for the two-phase WhatsApp
// contact resolution (fail-closed: only a clearly-best, well-separated match
// auto-resolves; anything else surfaces every plausible candidate instead) ──
describe('scoreContactCandidates', () => {
  it('resolves an exact (case/spacing-insensitive) match outright', () => {
    const r = scoreContactCandidates('ashu', ['Ashu', 'Ashutosh Kumar', 'Random Group'])
    expect(r.resolved).toBe('Ashu')
  })

  it('resolves a single confident match that is well clear of the runner-up', () => {
    const r = scoreContactCandidates('ashu kumar', ['Ashu Kumar Verma', 'Unrelated Chat'])
    expect(r.resolved).toBe('Ashu Kumar Verma')
  })

  it('refuses to guess between two similarly-plausible candidates (fails closed)', () => {
    const r = scoreContactCandidates('john', ['John Smith', 'John Doe', 'Weekend Trip'])
    expect(r.resolved).toBeNull()
    expect(r.candidates).toContain('John Smith')
    expect(r.candidates).toContain('John Doe')
  })

  it('returns no resolution and no candidates when nothing on screen matches', () => {
    const r = scoreContactCandidates('zzznonexistent', ['Family Group', 'Work Chat', '10:32 AM'])
    expect(r.resolved).toBeNull()
    expect(r.candidates).toEqual([])
  })

  it('caps candidates at 5, best-scoring first', () => {
    const lines = ['Ashu A', 'Ashu B', 'Ashu C', 'Ashu D', 'Ashu E', 'Ashu F', 'Ashu G']
    const r = scoreContactCandidates('ashu', lines)
    expect(r.candidates.length).toBe(5)
  })
})

// ── research_web — DuckDuckGo result parsing (pure, browser-free) ──────────────
describe('parseDuckDuckGoResults', () => {
  it('decodes uddg redirect targets and preserves titles', () => {
    const raw = [
      {
        href: 'https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=x',
        title: 'Example A'
      }
    ]
    expect(parseDuckDuckGoResults(raw, 5)).toEqual([{ url: 'https://example.com/a', title: 'Example A' }])
  })

  it('drops DuckDuckGo-internal links, non-http schemes, and duplicates, and honours the cap', () => {
    const raw = [
      { href: 'https://duckduckgo.com/l/?uddg=https%3A%2F%2Fduckduckgo.com%2Fabout', title: 'DDG self' },
      { href: 'https://duckduckgo.com/l/?uddg=javascript%3Aalert(1)', title: 'xss' },
      { href: 'https://duckduckgo.com/l/?uddg=https%3A%2F%2Fone.com%2F', title: 'One' },
      { href: 'https://duckduckgo.com/l/?uddg=https%3A%2F%2Fone.com%2F', title: 'One dup' },
      { href: 'https://duckduckgo.com/l/?uddg=https%3A%2F%2Ftwo.com%2F', title: 'Two' },
      { href: 'https://duckduckgo.com/l/?uddg=https%3A%2F%2Fthree.com%2F', title: 'Three' }
    ]
    const out = parseDuckDuckGoResults(raw, 2)
    expect(out).toEqual([
      { url: 'https://one.com/', title: 'One' },
      { url: 'https://two.com/', title: 'Two' }
    ])
  })

  it('falls back to the URL as the title when no title text is present', () => {
    const raw = [{ href: 'https://duckduckgo.com/l/?uddg=https%3A%2F%2Fnotitle.com%2F', title: '' }]
    expect(parseDuckDuckGoResults(raw, 5)).toEqual([
      { url: 'https://notitle.com/', title: 'https://notitle.com/' }
    ])
  })
})

// ── run_python — interactive execution guardrails ─────────────────────────────
describe('run_python — HITL gating and arg validation', () => {
  it('is gated as both state-changing and destructive (confirm even under autopilot)', () => {
    expect(STATE_CHANGING_TOOLS.has('run_python')).toBe(true)
    expect(DESTRUCTIVE_TOOLS.has('run_python')).toBe(true)
  })

  it('returns pending approval without bypassHitl', async () => {
    const r = await executeTool('run_python', { code: 'print(1)' }, { tier: 'enterprise' })
    expect(r).toMatchObject({ status: 'pending_approval', tool: 'run_python' })
  })

  it('requires either "code" or "path"', async () => {
    const r = await executeTool('run_python', {}, { tier: 'enterprise', bypassHitl: true })
    expect(r).toMatchObject({ ok: false })
    expect((r as { error: string }).error).toMatch(/requires "code"|path/)
  })
})
