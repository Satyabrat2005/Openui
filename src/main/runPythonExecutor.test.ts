import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { homedir, tmpdir } from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

// Same electron stub tools.test uses; run_python's sandbox writes are steered by
// OPENUI_WORKSPACE (set below), not by app.getPath.
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

import { executeTool, toolSchemas } from './tools'

const RUN = { tier: 'free' as const, bypassHitl: true }

const workspace = mkdtempSync(join(tmpdir(), 'openui-runpy-exec-'))
beforeAll(() => {
  process.env.OPENUI_WORKSPACE = workspace
})
afterAll(() => {
  delete process.env.OPENUI_WORKSPACE
  rmSync(workspace, { recursive: true, force: true })
})

function pythonAvailable(): boolean {
  for (const cmd of ['python', 'python3']) {
    try {
      execFileSync(cmd, ['--version'], { stdio: 'ignore' })
      return true
    } catch {
      /* try next */
    }
  }
  return false
}
const hasPython = pythonAvailable()

describe('run_python — arg + gate validation (no interpreter needed)', () => {
  it('requires either "code" or "path"', async () => {
    const r = await executeTool('run_python', {}, RUN)
    expect(r).toMatchObject({ ok: false })
    expect((r as { error: string }).error).toMatch(/requires "code".*or "path"/)
  })

  it('pauses for approval when HITL is not bypassed (never runs silently)', async () => {
    const r = await executeTool('run_python', { code: 'print(1)' }, { tier: 'free' })
    expect(r).toMatchObject({ status: 'pending_approval', tool: 'run_python' })
  })

  // Regression: the "args" param was declared type:'object', which validateArgs
  // rejects for an array value — so any run_python call carrying CLI args was
  // silently refused as "invalid arguments" before it could run. It must be an
  // array so the model's ["--flag", "x"] passes validation and reaches the script.
  it('declares "args" as an array so CLI args are not rejected by validation', () => {
    const schema = toolSchemas.find((s) => s.name === 'run_python')!
    expect(schema.parameters.properties.args.type).toBe('array')
  })

  it('accepts an array of CLI args past validation (no "invalid arguments" refusal)', async () => {
    const r = await executeTool('run_python', { code: 'print(1)', args: ['--flag', 'x'] }, { tier: 'free' })
    // With the bug present this returned { ok:false, error:'…"args" must be an object' };
    // now it reaches the HITL gate instead.
    expect(r).toMatchObject({ status: 'pending_approval', tool: 'run_python' })
  })
})

// The full executor path (write sandbox file → run interpreter → wrap in the
// PYTHON RUN OK/FAILED marker) — real interpreter, skipped cleanly if absent.
describe.skipIf(!hasPython)('run_python — real end-to-end execution', () => {
  it('runs inline code and captures stdout under a PYTHON RUN OK marker', async () => {
    const r = await executeTool(
      'run_python',
      { code: 'print("hello from openui")' },
      RUN
    )
    expect(r).toMatchObject({ ok: true })
    const out = (r as { output: string }).output
    expect(out).toMatch(/PYTHON RUN OK/)
    expect(out).toMatch(/hello from openui/)
  })

  it('forwards CLI args to the script', async () => {
    const r = await executeTool(
      'run_python',
      { code: 'import sys\nprint("ARGV", sys.argv[1])', args: ['alpha'] },
      RUN
    )
    expect(r).toMatchObject({ ok: true })
    expect((r as { output: string }).output).toMatch(/ARGV alpha/)
  })

  it('a non-zero exit is reported as PYTHON RUN FAILED, not a tool error', async () => {
    const r = await executeTool(
      'run_python',
      { code: 'import sys\nsys.exit(3)' },
      RUN
    )
    // Convention: run failures stay ok:true so the model reads the log + iterates.
    expect(r).toMatchObject({ ok: true })
    expect((r as { output: string }).output).toMatch(/PYTHON RUN FAILED/)
  })
})
