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
  shell: {},
  systemPreferences: {},
  dialog: {},
  BrowserWindow: class {}
}))
vi.mock('./telemetry/posthog', () => ({ trackEvent: () => {} }))

import {
  executeTool,
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
