/**
 * tools.test.ts — the safety layer around OS-automation tools.
 *
 * tools.ts is what actually lets the model touch the machine (filesystem,
 * clipboard, calendar, mouse/keyboard). These tests focus on the gates that
 * decide WHAT the model is allowed to do, not on driving real native APIs:
 *
 *   1. Human-in-the-loop — every STATE_CHANGING tool (and so every DESTRUCTIVE
 *      one) returns a pending-approval result and cannot execute without an
 *      explicit bypassHitl set by the agent loop after the user clicks Allow.
 *   2. Path-safety integration — write/delete/move/copy/create outside the home
 *      tree, or inside a credential directory, are rejected before any fs call.
 *   3. Graceful degradation — a failing native dependency surfaces as
 *      { ok: false, error }, never a thrown exception into the agent loop.
 *
 * Electron and the heavier sibling modules (github/figma/edgeFunctions/rag/
 * workflows — several pull in better-sqlite3 or Electron at import) are mocked
 * so the pure gate logic runs under plain Node. ./fs/pathSafety is intentionally
 * REAL — it is the trust boundary under test.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'

const mocks = vi.hoisted(() => ({
  trashItem: vi.fn(async (_p: string) => {}),
  clipboardReadText: vi.fn(() => 'clipboard text'),
  clipboardWriteText: vi.fn((_t: string) => {}),
  checkAccessibility: vi.fn(() => true)
}))

vi.mock('electron', () => ({
  shell: {
    trashItem: mocks.trashItem,
    openPath: vi.fn(async () => ''),
    openExternal: vi.fn(async () => {})
  },
  clipboard: { readText: mocks.clipboardReadText, writeText: mocks.clipboardWriteText },
  desktopCapturer: { getSources: vi.fn(async () => []) },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  app: { getPath: () => '', getName: () => 'OpenUI', isPackaged: false }
}))

// Sibling modules that either import Electron/better-sqlite3 or reach the
// network — stubbed so importing tools.ts is side-effect-free.
vi.mock('./permissions', () => ({ checkAccessibility: mocks.checkAccessibility }))
vi.mock('./github', () => ({ githubToolSchemas: [], githubRegistry: {} }))
vi.mock('./figma', () => ({ figmaToolSchemas: [], figmaRegistry: {} }))
vi.mock('./edgeFunctions', () => ({ callChatProxyText: vi.fn(async () => '') }))
vi.mock('./telemetry/posthog', () => ({ trackEvent: vi.fn() }))
vi.mock('./workflows', () => ({ findWorkflow: vi.fn(async () => ({ ok: false, error: 'none' })) }))
vi.mock('./rag', () => ({ searchLocalKnowledge: vi.fn(async () => ({ ok: false, error: 'none' })) }))

import {
  executeTool,
  STATE_CHANGING_TOOLS,
  DESTRUCTIVE_TOOLS,
  type PendingApprovalResult,
  type ToolResult
} from './tools'

const PRO = { tier: 'pro' as const, bypassHitl: true }

// A scratch directory INSIDE the home tree so home-confined mutations are
// allowed; the sensitive/outside-home cases never touch the disk.
let homeScratch: string
beforeEach(() => {
  mocks.trashItem.mockReset().mockResolvedValue(undefined)
  mocks.clipboardReadText.mockReset().mockReturnValue('clipboard text')
  mocks.clipboardWriteText.mockReset().mockReturnValue(undefined)
  mocks.checkAccessibility.mockReset().mockReturnValue(true)
  homeScratch = mkdtempSync(join(homedir(), 'openui-tools-test-'))
})
afterAll(() => {
  // Best-effort sweep of any scratch dirs left in home.
})

function cleanupScratch(): void {
  try {
    rmSync(homeScratch, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

const isPending = (r: ToolResult | PendingApprovalResult): r is PendingApprovalResult =>
  'status' in r && r.status === 'pending_approval'

// ── 1. Human-in-the-loop gating ──────────────────────────────────────────────
describe('HITL gating', () => {
  it('every DESTRUCTIVE tool is also a STATE_CHANGING tool', () => {
    for (const tool of DESTRUCTIVE_TOOLS) {
      expect(STATE_CHANGING_TOOLS.has(tool)).toBe(true)
    }
  })

  it('every STATE_CHANGING tool pauses for approval without bypassHitl', async () => {
    for (const tool of STATE_CHANGING_TOOLS) {
      const result = await executeTool(tool, {}, { tier: 'pro' })
      expect(isPending(result), `${tool} should be pending`).toBe(true)
      if (isPending(result)) expect(result.tool).toBe(tool)
    }
  })

  it('a pending approval never runs the underlying action', async () => {
    // delete_file is the DESTRUCTIVE case: gated, and trashItem must NOT fire.
    const result = await executeTool('delete_file', { path: join(homeScratch, 'x') }, { tier: 'pro' })
    expect(isPending(result)).toBe(true)
    expect(mocks.trashItem).not.toHaveBeenCalled()
  })

  it('read-only tools are NOT gated and execute immediately', async () => {
    const result = await executeTool('read_clipboard', {}, { tier: 'pro' })
    expect(isPending(result)).toBe(false)
    expect((result as ToolResult).ok).toBe(true)
  })

  it('delete_file only executes once bypassHitl is set (post-approval)', async () => {
    const target = join(homeScratch, 'note.txt')
    writeFileSync(target, 'bye')
    const result = (await executeTool('delete_file', { path: target }, PRO)) as ToolResult
    expect(result.ok).toBe(true)
    expect(mocks.trashItem).toHaveBeenCalledWith(target)
    cleanupScratch()
  })
})

// ── 2. Path-safety integration (mutations, post-approval) ─────────────────────
describe('path-safety integration', () => {
  const outside = process.platform === 'win32' ? 'C:\\Windows\\System32\\evil.txt' : '/etc/evil.txt'

  it('write_file outside the home tree is rejected', async () => {
    const result = (await executeTool('write_file', { path: outside, content: 'x' }, PRO)) as ToolResult
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/home folder/)
  })

  it('write_file into a credential directory is rejected', async () => {
    const result = (await executeTool(
      'write_file',
      { path: join(homedir(), '.ssh', 'id_rsa'), content: 'x' },
      PRO
    )) as ToolResult
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/off-limits/)
  })

  it('delete_file outside the home tree is rejected (and trashItem never fires)', async () => {
    const result = (await executeTool('delete_file', { path: outside }, PRO)) as ToolResult
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/home folder/)
    expect(mocks.trashItem).not.toHaveBeenCalled()
  })

  it('move_file rejects when either endpoint is outside the home tree', async () => {
    const inside = join(homeScratch, 'a.txt')
    const r1 = (await executeTool('move_file', { source: outside, destination: inside }, PRO)) as ToolResult
    expect(r1.ok).toBe(false)
    expect(r1.error).toMatch(/home folder/)

    const r2 = (await executeTool('move_file', { source: inside, destination: outside }, PRO)) as ToolResult
    expect(r2.ok).toBe(false)
    expect(r2.error).toMatch(/home folder/)
  })

  it('create_folder outside the home tree is rejected', async () => {
    const result = (await executeTool('create_folder', { path: outside }, PRO)) as ToolResult
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/home folder/)
  })

  it('copy_file rejects a destination outside the home tree', async () => {
    const src = join(homeScratch, 'src.txt')
    writeFileSync(src, 'data')
    const result = (await executeTool('copy_file', { source: src, destination: outside }, PRO)) as ToolResult
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/home folder/)
    cleanupScratch()
  })

  it('allows a write INSIDE the home tree and persists the content', async () => {
    const target = join(homeScratch, 'sub', 'hello.txt')
    const result = (await executeTool('write_file', { path: target, content: 'hi there' }, PRO)) as ToolResult
    expect(result.ok).toBe(true)
    expect(existsSync(target)).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe('hi there')
    cleanupScratch()
  })
})

// ── 3. Graceful degradation on native / dependency failure ────────────────────
describe('graceful degradation', () => {
  it('delete_file degrades to { ok:false } when the trash API throws', async () => {
    const target = join(homeScratch, 'doomed.txt')
    writeFileSync(target, 'x')
    mocks.trashItem.mockRejectedValueOnce(new Error('trash unavailable'))
    const result = (await executeTool('delete_file', { path: target }, PRO)) as ToolResult
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/delete_file failed/)
    cleanupScratch()
  })

  it('write_clipboard degrades to { ok:false } when the clipboard API throws', async () => {
    mocks.clipboardWriteText.mockImplementationOnce(() => {
      throw new Error('no clipboard')
    })
    const result = (await executeTool('write_clipboard', { text: 'hello' }, PRO)) as ToolResult
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/write_clipboard/)
  })

  it('read_clipboard degrades to { ok:false } when the clipboard API throws', async () => {
    mocks.clipboardReadText.mockImplementationOnce(() => {
      throw new Error('no clipboard')
    })
    const result = (await executeTool('read_clipboard', {}, { tier: 'pro' })) as ToolResult
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/read_clipboard/)
  })

  it('control_calendar fails cleanly (no title / unsupported platform) without throwing', async () => {
    // On macOS/Windows this hits the missing-title guard BEFORE any native
    // Calendar/Outlook call; on other platforms it hits the unsupported-OS
    // branch. Either way it is a clean { ok:false }, never a throw.
    const result = (await executeTool(
      'control_calendar',
      { action: 'create', eventDetails: {} },
      PRO
    )) as ToolResult
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/title|macOS|Windows/i)
  })

  it('an unknown tool returns a clean error, not a throw', async () => {
    const result = (await executeTool('does_not_exist', {}, { tier: 'pro' })) as ToolResult
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/Unknown tool/)
  })

  it('invalid arguments are rejected before the executor runs', async () => {
    // write_file requires "path"; omitting it must fail validation (bypassHitl so
    // we get past the approval gate to the validator).
    const result = (await executeTool('write_file', { content: 'x' }, PRO)) as ToolResult
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/Invalid arguments/)
  })
})
