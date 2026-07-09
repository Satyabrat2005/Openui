import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

// sandbox.ts imports electron's `app` at module load; stub it so the module can
// be evaluated under vitest's node environment. The workspace itself is driven
// by the OPENUI_WORKSPACE override below, not by app.getPath.
vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getName: () => 'OpenUI' } }))

import { runInteractivePython, memCapBootstrap, writeSandboxFile } from './sandbox'

const workspace = mkdtempSync(join(tmpdir(), 'openui-runpy-'))

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

describe('memCapBootstrap', () => {
  it('emits a RLIMIT_AS setrlimit with the given byte cap and runs the target as __main__', () => {
    const s = memCapBootstrap(123_456)
    expect(s).toContain('RLIMIT_AS')
    expect(s).toContain('123456')
    expect(s).toContain("runpy.run_path(t, run_name='__main__')")
  })
})

describe('runInteractivePython — path validation (no interpreter needed)', () => {
  it('rejects a non-.py file', async () => {
    const r = await runInteractivePython('notes.txt')
    expect(r.passed).toBe(false)
    expect(r.output).toMatch(/not a \.py/)
  })

  it('rejects a script that does not exist yet', async () => {
    const r = await runInteractivePython('ghost.py')
    expect(r.passed).toBe(false)
    expect(r.output).toMatch(/does not exist/)
  })

  it('rejects path traversal outside the sandbox', async () => {
    const r = await runInteractivePython('../escape.py')
    expect(r.passed).toBe(false)
  })
})

describe.skipIf(!hasPython)('runInteractivePython — real execution', () => {
  it('runs an inline script and captures stdout + forwarded args', async () => {
    await writeSandboxFile('hello.py', 'import sys\nprint("HELLO_FROM_SANDBOX", sys.argv[1:])')
    const r = await runInteractivePython('hello.py', ['alpha'])
    expect(r.passed).toBe(true)
    expect(r.output).toContain('HELLO_FROM_SANDBOX')
    expect(r.output).toContain('alpha')
  })

  it('reports a non-zero exit as passed:false', async () => {
    await writeSandboxFile('boom.py', 'import sys\nsys.exit(3)')
    const r = await runInteractivePython('boom.py')
    expect(r.passed).toBe(false)
  })
})
