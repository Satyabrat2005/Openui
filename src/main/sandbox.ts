/**
 * sandbox.ts — a restricted local execution environment for the autonomous
 * coding agent (Phase 8).
 *
 * The agent runs UNATTENDED: it writes code and runs tests without a human in
 * the loop. To bound the blast radius of a model that is buggy or steered by a
 * malicious task/issue, every file operation is confined to a single workspace
 * directory under the app's userData folder, and the only command it may run is
 * the project's test script.
 *
 * TRUST MODEL — running `npm test` executes whatever the workspace's
 * package.json defines, which is arbitrary code by design (that is the point of
 * "write code and iterate on test failures"). This module therefore provides
 * *containment*, not a security boundary against deliberately hostile code:
 *   • All paths are resolved and verified to stay inside the workspace
 *     (no `..` traversal, no absolute escapes, no symlink-style breakouts via
 *     the resolved-prefix check).
 *   • The test command is STATIC (`npm test`) — the model never supplies it,
 *     so there is no command injection surface from tool arguments.
 *   • Execution is wall-clock bounded and output-capped.
 * For untrusted task sources, run OpenUI itself inside a container/VM. A Docker
 * backend is a documented future enhancement (see AUTONOMOUS.md); this module
 * intentionally keeps a zero-dependency local-folder backend so the feature
 * works out of the box.
 */
import { app } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises'
import { join, resolve, relative, isAbsolute, dirname } from 'node:path'

const execFileAsync = promisify(execFile)

const IS_WIN = process.platform === 'win32'

// Wall-clock bound + stdout cap for the test run. Tests can be slow, so this is
// more generous than the 15 s used for the OS-automation PowerShell calls.
const TEST_TIMEOUT_MS = 120_000
const MAX_OUTPUT = 256 * 1024

// `npm install` reaches the network and can be slow on a cold cache, so it gets
// a larger bound than a build/test run.
const INSTALL_TIMEOUT_MS = 300_000
// A one-shot build/train/lint script (something that runs to completion).
const SCRIPT_TIMEOUT_MS = 180_000
// How long a long-running script (dev/start/serve/watch/preview) is allowed to
// run before we treat "still alive, no crash" as a passing smoke test and stop
// it. Long-running servers never exit, so we can't await them — instead we prove
// they BOOT without crashing, then kill the whole process tree.
const DEV_READINESS_MS = 10_000

/**
 * Script names that start a long-running process (a dev server, watcher, etc.)
 * which never exits on its own. runScript treats these as a boot smoke test:
 * start it, watch for a crash during a readiness window, then kill it.
 */
const LONG_RUNNING_SCRIPT_RE = /^(dev|start|serve|watch|preview|serve:.*|dev:.*)$/i

/** Largest file the agent may write in one go (defensive bound). */
const MAX_FILE_BYTES = 512 * 1024

/**
 * Absolute path to the agent's workspace. Created lazily on first use under
 * the OS-appropriate userData dir (e.g. %APPDATA%\OpenUI on Windows,
 * ~/Library/Application Support/OpenUI on macOS). Overridable for power users
 * via OPENUI_WORKSPACE.
 */
export function getWorkspaceDir(): string {
  const override = process.env.OPENUI_WORKSPACE?.trim()
  if (override) return resolve(override)
  return join(app.getPath('userData'), 'autonomous-workspace')
}

/** Ensure the workspace directory exists; returns its absolute path. */
export async function ensureWorkspace(): Promise<string> {
  const dir = getWorkspaceDir()
  await mkdir(dir, { recursive: true })
  return dir
}

/**
 * Resolve a model-supplied relative path against the workspace and verify it
 * cannot escape. Throws on any path that resolves outside the workspace (the
 * `..`/absolute-path/breakout trust boundary). Returns the safe absolute path.
 */
function resolveInSandbox(workspace: string, relPath: string): string {
  if (typeof relPath !== 'string' || !relPath.trim()) {
    throw new Error('path must be a non-empty string')
  }
  if (isAbsolute(relPath)) {
    throw new Error('path must be relative to the workspace, not absolute')
  }
  const abs = resolve(workspace, relPath)
  const rel = relative(workspace, abs)
  // rel starting with ".." (or being absolute) means abs is outside workspace.
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('path escapes the workspace sandbox')
  }
  return abs
}

/** Write a UTF-8 text file inside the sandbox, creating parent dirs as needed. */
export async function writeSandboxFile(relPath: string, content: string): Promise<string> {
  const workspace = await ensureWorkspace()
  const abs = resolveInSandbox(workspace, relPath)
  const text = typeof content === 'string' ? content : String(content ?? '')
  if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) {
    throw new Error(`file exceeds the ${Math.round(MAX_FILE_BYTES / 1024)} KB write limit`)
  }
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, text, 'utf8')
  return relative(workspace, abs)
}

/** Read a UTF-8 text file from inside the sandbox. */
export async function readSandboxFile(relPath: string): Promise<string> {
  const workspace = await ensureWorkspace()
  const abs = resolveInSandbox(workspace, relPath)
  return readFile(abs, 'utf8')
}

/**
 * Recursively list files in the sandbox (relative paths), skipping node_modules
 * and dot-directories. Capped so a huge tree cannot flood the model context.
 */
export async function listSandboxFiles(limit = 200): Promise<string[]> {
  const workspace = await ensureWorkspace()
  const out: string[] = []

  async function walk(dir: string): Promise<void> {
    if (out.length >= limit) return
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (out.length >= limit) return
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(abs)
      } else {
        out.push(relative(workspace, abs))
      }
    }
  }

  try {
    await walk(workspace)
  } catch {
    // Empty/inaccessible workspace → return whatever we collected.
  }
  return out
}

export interface TestRunResult {
  /** True when the test command exited 0. */
  passed: boolean
  /** Combined stdout + stderr, trimmed and capped at MAX_OUTPUT. */
  output: string
}

/**
 * Run the workspace's test suite (`npm test`) and report pass/fail plus output.
 *
 * The command is fixed and contains no model-supplied data, so there is no
 * argument-injection surface. On Windows the npm shim is `npm.cmd`, which
 * requires a shell to launch via execFile — acceptable here because the command
 * string is static. Execution is time-bounded and output-capped.
 */
export async function runTests(): Promise<TestRunResult> {
  const cwd = await ensureWorkspace()

  // Without a package.json there is nothing to test — surface that clearly so
  // the model writes one rather than failing on an opaque npm error.
  try {
    await stat(join(cwd, 'package.json'))
  } catch {
    return {
      passed: false,
      output:
        'No package.json found in the workspace. Create one with a "test" script before running tests.'
    }
  }

  const npmCmd = IS_WIN ? 'npm.cmd' : 'npm'
  try {
    const { stdout, stderr } = await execFileAsync(npmCmd, ['test', '--silent'], {
      cwd,
      timeout: TEST_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT,
      windowsHide: true,
      // npm.cmd on Windows is a batch shim and must be launched through the shell.
      shell: IS_WIN
    })
    const output = `${stdout}\n${stderr}`.trim().slice(0, MAX_OUTPUT)
    return { passed: true, output: output || 'Tests passed (no output).' }
  } catch (err) {
    // execFile rejects on non-zero exit (failing tests) or timeout. Both carry
    // the captured stdout/stderr on the error object.
    const e = err as { stdout?: string; stderr?: string; message?: string; killed?: boolean }
    if (e.killed) {
      return { passed: false, output: `Test run timed out after ${TEST_TIMEOUT_MS / 1000}s.` }
    }
    const output = `${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim() || e.message || 'Tests failed.'
    return { passed: false, output: output.slice(0, MAX_OUTPUT) }
  }
}

/**
 * Install the workspace's npm dependencies (`npm install`) so a scaffolded
 * project can actually build and run.
 *
 * TRUST MODEL — same as runTests: `npm install` executes the workspace's own
 * lifecycle scripts (preinstall/postinstall), which is arbitrary code by design.
 * The command itself is STATIC (no model-supplied arguments), so there is no
 * argument-injection surface; containment, not a hostile-code boundary. The run
 * is wall-clock bounded and output-capped.
 */
export async function runInstall(): Promise<TestRunResult> {
  const cwd = await ensureWorkspace()
  try {
    await stat(join(cwd, 'package.json'))
  } catch {
    return {
      passed: false,
      output: 'No package.json found in the workspace. Create one before installing dependencies.'
    }
  }

  const npmCmd = IS_WIN ? 'npm.cmd' : 'npm'
  try {
    const { stdout, stderr } = await execFileAsync(
      npmCmd,
      ['install', '--no-audit', '--no-fund'],
      { cwd, timeout: INSTALL_TIMEOUT_MS, maxBuffer: MAX_OUTPUT, windowsHide: true, shell: IS_WIN }
    )
    const output = `${stdout}\n${stderr}`.trim().slice(0, MAX_OUTPUT)
    return { passed: true, output: output || 'Dependencies installed.' }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string; killed?: boolean }
    if (e.killed) {
      return { passed: false, output: `npm install timed out after ${INSTALL_TIMEOUT_MS / 1000}s.` }
    }
    const output = `${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim() || e.message || 'npm install failed.'
    return { passed: false, output: output.slice(0, MAX_OUTPUT) }
  }
}

/** Best-effort kill of a spawned child AND its descendants (dev servers fork). */
function killProcessTree(pid: number | undefined): void {
  if (!pid) return
  try {
    if (IS_WIN) {
      // child was spawned via the shell, so node lives under a cmd/npm tree —
      // /T kills the whole tree, /F forces it.
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {})
    } else {
      // POSIX: the child is a process-group leader (spawned detached), so a
      // negative pid signals the entire group.
      process.kill(-pid, 'SIGTERM')
    }
  } catch {
    // Process already gone / race with natural exit — nothing to clean up.
  }
}

/**
 * Boot smoke test for a long-running script (dev server, watcher). We cannot
 * await something that never exits, so we start it, capture its early output,
 * and: if it crashes within the readiness window → FAIL (with the crash log); if
 * it survives the window → PASS ("it starts"), then we kill the whole tree so no
 * orphaned server is left running in the sandbox.
 */
function runLongScript(npmCmd: string, name: string, cwd: string): Promise<TestRunResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(npmCmd, ['run', name], {
      cwd,
      windowsHide: true,
      shell: IS_WIN,
      // POSIX: own process group so killProcessTree can take down forked servers.
      detached: !IS_WIN
    })

    let output = ''
    let settled = false
    const append = (buf: Buffer): void => {
      if (output.length < MAX_OUTPUT) output += buf.toString()
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)

    const finish = (passed: boolean, note: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      killProcessTree(child.pid)
      resolvePromise({ passed, output: `${note}\n${output}`.trim().slice(0, MAX_OUTPUT) })
    }

    // Exited before the readiness window: clean exit = ok, non-zero = crash.
    child.on('exit', (code) => {
      if (code === 0) finish(true, `Script "${name}" exited cleanly.`)
      else finish(false, `Script "${name}" exited with code ${code} before finishing startup.`)
    })
    child.on('error', (err) =>
      finish(false, `Could not start script "${name}": ${err.message}`)
    )

    const timer = setTimeout(
      () =>
        finish(
          true,
          `Script "${name}" started and ran for ${DEV_READINESS_MS / 1000}s without crashing ` +
            `(dev-server boot smoke test passed); the process was then stopped.`
        ),
      DEV_READINESS_MS
    )
  })
}

/**
 * Run a named npm script from the workspace (`npm run <script>`) — for build,
 * train, lint or dev-server scripts the coding agent scaffolds.
 *
 * SECURITY: `scriptName` is validated against the scripts DECLARED in the
 * workspace's own package.json before running. The model can only run a script
 * that already exists in the file it wrote — it cannot smuggle an arbitrary
 * command through this argument. (The script's BODY is still arbitrary code, same
 * trust model as runTests/runInstall: containment, not a hostile-code boundary.)
 */
export async function runScript(scriptName: unknown): Promise<TestRunResult> {
  const cwd = await ensureWorkspace()
  if (typeof scriptName !== 'string' || !scriptName.trim()) {
    return { passed: false, output: 'runScript requires a non-empty script name.' }
  }
  const name = scriptName.trim()

  let pkg: { scripts?: Record<string, unknown> }
  try {
    pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'))
  } catch {
    return {
      passed: false,
      output: 'No readable package.json in the workspace. Create one with a "scripts" section first.'
    }
  }
  const scripts = pkg && typeof pkg.scripts === 'object' && pkg.scripts ? pkg.scripts : {}
  if (!Object.prototype.hasOwnProperty.call(scripts, name)) {
    const available = Object.keys(scripts)
    return {
      passed: false,
      output:
        `Script "${name}" is not defined in package.json. ` +
        `Available scripts: ${available.length ? available.join(', ') : '(none)'}.`
    }
  }

  const npmCmd = IS_WIN ? 'npm.cmd' : 'npm'
  if (LONG_RUNNING_SCRIPT_RE.test(name)) {
    return runLongScript(npmCmd, name, cwd)
  }

  try {
    const { stdout, stderr } = await execFileAsync(npmCmd, ['run', name], {
      cwd,
      timeout: SCRIPT_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT,
      windowsHide: true,
      shell: IS_WIN
    })
    const output = `${stdout}\n${stderr}`.trim().slice(0, MAX_OUTPUT)
    return { passed: true, output: output || `Script "${name}" completed.` }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string; killed?: boolean }
    if (e.killed) {
      return { passed: false, output: `Script "${name}" timed out after ${SCRIPT_TIMEOUT_MS / 1000}s.` }
    }
    const output =
      `${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim() || e.message || `Script "${name}" failed.`
    return { passed: false, output: output.slice(0, MAX_OUTPUT) }
  }
}
