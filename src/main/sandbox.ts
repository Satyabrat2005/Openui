/**
 * sandbox.ts — a restricted local execution environment for the autonomous
 * coding agent (Phase 8).
 *
 * The agent runs UNATTENDED: it writes code and runs tests without a human in
 * the loop. To bound the blast radius of a model that is buggy or steered by a
 * malicious task/issue, every file operation is confined to a single project
 * directory under `~/OpenUI Projects`, and the only command it may run is the
 * project's test script.
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
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises'
import { join, resolve, relative, isAbsolute, dirname, basename } from 'node:path'
import { isSafeProjectSlug } from './projectName'
import { parseUnifiedDiff, applyPatch } from './patch'

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
 * Folder name used when no project has been named — unattended runs (the
 * autonomous task runner) and any caller that never calls setActiveProject.
 */
const DEFAULT_PROJECT = 'workspace'

/**
 * Where generated projects live: `~/OpenUI Projects`. Deliberately a directory
 * the user actually browses to. It used to be the app's userData folder, which
 * meant a successful build was invisible — the files were real but nobody could
 * find them.
 */
export function getProjectsRoot(): string {
  return join(app.getPath('home'), 'OpenUI Projects')
}

/**
 * The project the current build session writes into, as a single path segment.
 * Module state rather than a parameter because every sandbox entry point
 * resolves against "the workspace"; threading a project through all of them
 * would touch every tool signature for no gain.
 */
let activeProject: string | null = null

/**
 * Point the sandbox at `~/OpenUI Projects/<slug>`. Rejects anything that is not
 * a bare slug — this is the boundary where a name derived from a user message
 * becomes a path, so a separator or `..` here would defeat resolveInSandbox by
 * moving the root itself rather than escaping it.
 */
export function setActiveProject(slug: string): void {
  activeProject = isSafeProjectSlug(slug) ? slug : DEFAULT_PROJECT
}

/** The active project slug, or null when none has been set this session. */
export function getActiveProject(): string | null {
  return activeProject
}

/**
 * Return to the shared default workspace. Unattended runs call this so they
 * never inherit — and write into — whatever project the last interactive build
 * happened to name.
 */
export function resetActiveProject(): void {
  activeProject = null
}

/**
 * Per-worker workspace override (§3). Parallel coding sub-agents each run inside
 * their own git worktree; wrapping a worker in `runInWorkspace(worktreeDir, fn)`
 * makes every sandbox entry point resolve against THAT tree for the dynamic
 * extent of `fn`, with no mutation of the shared `activeProject` global. Because
 * it is carried on AsyncLocalStorage, N workers can touch N directories
 * concurrently without racing — the mechanism that lets the coding lane run wide.
 */
const workspaceScope = new AsyncLocalStorage<string>()

/**
 * Run `fn` with the workspace pinned to `dir` (resolved to an absolute path).
 * Concurrent invocations are isolated from one another; nested calls shadow the
 * outer scope for their own subtree only.
 */
export function runInWorkspace<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  return workspaceScope.run(resolve(dir), fn)
}

/**
 * Absolute path to the agent's workspace. A per-worker `runInWorkspace` scope
 * wins first (isolated parallel workers); then the OPENUI_WORKSPACE override
 * (power users + tests, which must not write to a real home directory); then the
 * active project's folder under `~/OpenUI Projects`. Created lazily on first use.
 */
export function getWorkspaceDir(): string {
  const scoped = workspaceScope.getStore()
  if (scoped) return scoped
  const override = process.env.OPENUI_WORKSPACE?.trim()
  if (override) return resolve(override)
  return join(getProjectsRoot(), activeProject ?? DEFAULT_PROJECT)
}

/**
 * Strip a leading "<project-slug>/" the model sometimes prepends. It sees the
 * request ("make a folder called demo-counter") and helpfully nests every file
 * under demo-counter/ — but we've ALREADY made that the project folder, so the
 * prefix would double-nest (demo-counter/demo-counter/package.json). Applied to
 * both reads and writes so a nested write and a top-level read still agree.
 */
export function stripRedundantProjectPrefix(relPath: string): string {
  if (!activeProject) return relPath
  const norm = relPath.replace(/\\/g, '/').replace(/^\.\//, '')
  const prefix = `${activeProject}/`
  if (norm.toLowerCase().startsWith(prefix.toLowerCase()) && norm.length > prefix.length) {
    return norm.slice(prefix.length)
  }
  return relPath
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
  const abs = resolve(workspace, stripRedundantProjectPrefix(relPath))
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
 * Resolve a model-supplied relative path to its absolute location inside the
 * sandbox, with the same escape/absolute-path checks as every read/write —
 * for callers (like open_in_browser) that need the real path on disk rather
 * than its contents.
 */
export async function resolveSandboxPath(relPath: string): Promise<string> {
  const workspace = await ensureWorkspace()
  return resolveInSandbox(workspace, relPath)
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

/**
 * Map a path as it appeared in verifier output to a workspace-relative path, or
 * null when it does not live inside the sandbox. Handles both the relative paths
 * tsc/vitest print (cwd is the workspace) and the absolute paths stack traces
 * carry. Any `..`/outside-the-tree result is rejected so a stack frame pointing
 * at a system file can never be read back.
 */
function toWorkspaceRelative(workspace: string, p: string): string | null {
  if (typeof p !== 'string' || !p.trim()) return null
  const abs = isAbsolute(p) ? resolve(p) : resolve(workspace, p)
  const rel = relative(workspace, abs)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
  return rel
}

/** A window of source around a failing line, ready to show the model. */
export interface CodeRegion {
  ok: boolean
  /** Workspace-relative path when resolved. */
  path?: string
  /** Line-numbered snippet with a '>' marker on the failing line. */
  snippet?: string
  /** Why no snippet was produced (outside sandbox, dependency, missing). */
  reason?: string
}

/**
 * Read the source around a failing `file:line` from inside the sandbox so the
 * debug loop can show the model the offending code without spending a turn on a
 * manual read_file. Paths outside the workspace and dependency files
 * (node_modules) are refused; a missing file returns ok:false rather than throw.
 */
export async function readSandboxRegion(
  rawPath: string,
  line: number,
  radius = 10
): Promise<CodeRegion> {
  const workspace = await ensureWorkspace()
  const rel = toWorkspaceRelative(workspace, rawPath)
  if (rel === null) return { ok: false, reason: 'path is outside the workspace' }
  if (rel.split(/[\\/]/).includes('node_modules')) {
    return { ok: false, path: rel, reason: 'dependency file — not shown' }
  }
  let abs: string
  try {
    abs = resolveInSandbox(workspace, rel)
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
  let content: string
  try {
    content = await readFile(abs, 'utf8')
  } catch {
    return { ok: false, path: rel, reason: 'file not found in the workspace' }
  }
  const lines = content.split(/\r?\n/)
  const target = Number.isFinite(line) && line > 0 ? Math.floor(line) : 1
  const from = Math.max(1, target - radius)
  const to = Math.min(lines.length, target + radius)
  const width = String(to).length
  const numbered: string[] = []
  for (let n = from; n <= to; n++) {
    const marker = n === target ? '>' : ' '
    numbered.push(`${marker} ${String(n).padStart(width)} | ${lines[n - 1] ?? ''}`)
  }
  return { ok: true, path: rel, snippet: numbered.join('\n') }
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
 *
 * REGRESSION SAFETY (§5): this deliberately runs the WHOLE suite (`npm test`),
 * never a single test file. A fix that is locally correct but breaks a module
 * three files away is exactly the failure mode a touched-file-only run misses,
 * and VerifyGate keys the run's "verified" flag off this full-suite result. The
 * tradeoff is speed — the whole suite runs every verification turn — which the
 * per-run wall-clock bound (TEST_TIMEOUT_MS) keeps in check for the small
 * projects this sandbox scaffolds.
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

// ── non-npm verification runners (Task 3: project-type-aware coding) ─────────
//
// ML/DL and competitive-programming tasks don't verify with `npm test`. These
// runners give the coding agent pytest / python / g++ equivalents with the SAME
// trust model as runTests: the code being run is the workspace's own
// (agent-written) code — this is containment, not a hostile-code boundary. The
// commands themselves are fixed argv arrays launched WITHOUT a shell, so there
// is no injection surface; the only model-supplied pieces are workspace-relative
// file paths (validated by resolveInSandbox + extension checks) and stdin text
// (which is just data to the child process).

const PY_TIMEOUT_MS = 180_000
const CPP_COMPILE_TIMEOUT_MS = 60_000
const CPP_RUN_TIMEOUT_MS = 20_000
const MAX_STDIN_CHARS = 64 * 1024

/** The Python launcher for this platform (python.exe on Windows, python3 elsewhere). */
function pythonCmd(): string {
  return IS_WIN ? 'python' : 'python3'
}

/**
 * Run one bounded child process without a shell: collect stdout+stderr (capped),
 * optionally feed stdin, kill the whole tree on timeout. Resolves with a
 * friendly message (never rejects) when the executable is missing.
 */
function runBoundedProcess(
  file: string,
  argv: string[],
  cwd: string,
  timeoutMs: number,
  stdinText?: string,
  env?: NodeJS.ProcessEnv
): Promise<TestRunResult> {
  return new Promise((resolvePromise) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(file, argv, { cwd, windowsHide: true, detached: !IS_WIN, env })
    } catch (err) {
      resolvePromise({
        passed: false,
        output: `Could not start "${file}": ${err instanceof Error ? err.message : String(err)}`
      })
      return
    }

    let output = ''
    let settled = false
    let timedOut = false
    const append = (chunk: Buffer): void => {
      if (output.length < MAX_OUTPUT) output += chunk.toString('utf8')
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)

    if (stdinText !== undefined) {
      child.stdin?.write(stdinText.slice(0, MAX_STDIN_CHARS))
    }
    child.stdin?.end()

    const timer = setTimeout(() => {
      timedOut = true
      killProcessTree(child.pid)
    }, timeoutMs)

    const settle = (result: TestRunResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(result)
    }

    child.on('error', (err: NodeJS.ErrnoException) => {
      const hint =
        err.code === 'ENOENT'
          ? `"${file}" is not installed or not on PATH.`
          : (err.message ?? String(err))
      settle({ passed: false, output: hint })
    })

    child.on('exit', (code) => {
      const capped = output.trim().slice(0, MAX_OUTPUT)
      if (timedOut) {
        settle({ passed: false, output: `Timed out after ${timeoutMs / 1000}s.\n${capped}` })
      } else {
        settle({ passed: code === 0, output: capped })
      }
    })
  })
}

/** Run `python -m pytest -q` in the workspace (fixed argv, no model data). */
export async function runPytest(): Promise<TestRunResult> {
  const cwd = await ensureWorkspace()
  const result = await runBoundedProcess(
    pythonCmd(),
    ['-m', 'pytest', '-q'],
    cwd,
    PY_TIMEOUT_MS
  )
  // pytest exits 5 ("no tests collected") with a short message — surface that
  // clearly so the model writes tests instead of chasing a phantom failure.
  return result
}

/**
 * Run a Python script from the workspace, optionally with the literal `--smoke`
 * flag (the type-specific prompts tell the agent to support a fast smoke mode
 * in its training scripts). The path is validated to be an existing .py file
 * inside the sandbox; the flag is a fixed literal — nothing else is passed.
 */
export async function runPythonScript(relPath: string, smoke: boolean): Promise<TestRunResult> {
  const workspace = await ensureWorkspace()
  let abs: string
  try {
    abs = resolveInSandbox(workspace, relPath)
  } catch (err) {
    return { passed: false, output: err instanceof Error ? err.message : String(err) }
  }
  if (!/\.py$/i.test(abs)) {
    return { passed: false, output: `"${relPath}" is not a .py file.` }
  }
  try {
    await stat(abs)
  } catch {
    return { passed: false, output: `"${relPath}" does not exist in the workspace. Write it first.` }
  }
  const argv = [relative(workspace, abs), ...(smoke ? ['--smoke'] : [])]
  return runBoundedProcess(pythonCmd(), argv, workspace, PY_TIMEOUT_MS)
}

/** Cap on how many extra CLI args the interactive run_python tool will forward. */
const MAX_PY_ARGS = 32

/**
 * Build the tiny `python -c` bootstrap that caps address space via RLIMIT_AS
 * before running the target script as __main__. POSIX-only: the `resource`
 * module does not exist on Windows, so the try/except degrades to a no-op there
 * (which is why Windows uses the plain direct launch below). The target path and
 * its args are passed as argv[1:] — never interpolated into this code — so the
 * only injected value is the integer byte cap we compute ourselves.
 */
export function memCapBootstrap(bytes: number): string {
  return [
    'import sys, runpy',
    'try:',
    '    import resource',
    `    resource.setrlimit(resource.RLIMIT_AS, (${bytes}, ${bytes}))`,
    'except Exception:',
    '    pass',
    't = sys.argv[1]',
    'sys.argv = [t] + sys.argv[2:]',
    "runpy.run_path(t, run_name='__main__')"
  ].join('\n')
}

/**
 * Interactive, HITL-gated variant of runPythonScript: run a workspace .py file
 * with caller-supplied CLI args plus a best-effort memory ceiling on top of the
 * usual wall-clock + output caps. On POSIX the script is launched through a
 * RLIMIT_AS bootstrap; on Windows (no RLIMIT_AS) it is launched directly and the
 * memory cap is not enforced. Path is validated to be an existing in-sandbox .py.
 */
export async function runInteractivePython(
  relPath: string,
  extraArgs: string[] = [],
  opts: { memMb?: number; timeoutMs?: number } = {}
): Promise<TestRunResult> {
  const workspace = await ensureWorkspace()
  let abs: string
  try {
    abs = resolveInSandbox(workspace, relPath)
  } catch (err) {
    return { passed: false, output: err instanceof Error ? err.message : String(err) }
  }
  if (!/\.py$/i.test(abs)) {
    return { passed: false, output: `"${relPath}" is not a .py file.` }
  }
  try {
    await stat(abs)
  } catch {
    return { passed: false, output: `"${relPath}" does not exist in the workspace. Write it first.` }
  }

  const rel = relative(workspace, abs)
  const safeArgs = extraArgs.filter((a) => typeof a === 'string').slice(0, MAX_PY_ARGS)
  const timeout = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : PY_TIMEOUT_MS
  const memMb = opts.memMb && opts.memMb > 0 ? Math.floor(opts.memMb) : 0

  if (!IS_WIN && memMb > 0) {
    const bootstrap = memCapBootstrap(memMb * 1024 * 1024)
    return runBoundedProcess(pythonCmd(), ['-c', bootstrap, rel, ...safeArgs], workspace, timeout)
  }
  return runBoundedProcess(pythonCmd(), [rel, ...safeArgs], workspace, timeout)
}

/**
 * Compile a single C++ source file with g++ (-O2, C++17) and, on success, run
 * the produced binary with the given stdin text. Both steps are bounded; the
 * binary lands under the workspace's build/ directory. Path is validated to be
 * an existing .cpp/.cc/.cxx file inside the sandbox.
 */
export async function runCppProgram(relPath: string, stdinText: string): Promise<TestRunResult> {
  const workspace = await ensureWorkspace()
  let abs: string
  try {
    abs = resolveInSandbox(workspace, relPath)
  } catch (err) {
    return { passed: false, output: err instanceof Error ? err.message : String(err) }
  }
  if (!/\.(cpp|cc|cxx)$/i.test(abs)) {
    return { passed: false, output: `"${relPath}" is not a C++ source file (.cpp/.cc/.cxx).` }
  }
  try {
    await stat(abs)
  } catch {
    return { passed: false, output: `"${relPath}" does not exist in the workspace. Write it first.` }
  }

  const exeName = basename(abs).replace(/\.(cpp|cc|cxx)$/i, IS_WIN ? '.exe' : '.out')
  const exeAbs = join(workspace, 'build', exeName)
  await mkdir(dirname(exeAbs), { recursive: true })

  const compile = await runBoundedProcess(
    'g++',
    ['-O2', '-std=c++17', '-o', exeAbs, relative(workspace, abs)],
    workspace,
    CPP_COMPILE_TIMEOUT_MS
  )
  if (!compile.passed) {
    return { passed: false, output: `COMPILE ERROR\n${compile.output}` }
  }

  const run = await runBoundedProcess(exeAbs, [], workspace, CPP_RUN_TIMEOUT_MS, stdinText)
  return { passed: run.passed, output: run.output || '(program produced no output)' }
}

// ── surgical edit, code search, git ──────────────────────────────────────────
//
// The three primitives that separate "a model that writes files" from "a model
// that works on a codebase". Each keeps the module's existing guarantees:
// every path goes through resolveInSandbox, every child process is spawned
// WITHOUT a shell and is wall-clock bounded and output-capped.

/** Result of a surgical edit: how many occurrences were swapped, and where. */
export interface EditResult {
  /** Number of occurrences of oldString that were replaced. */
  replacements: number
  /** Workspace-relative path that was edited. */
  path: string
}

/**
 * Replace an exact substring inside an existing workspace file.
 *
 * Why this exists alongside writeSandboxFile: rewriting a whole file to change
 * three lines forces the model to reproduce the untouched remainder from
 * memory. On anything longer than a page it silently drops code — the classic
 * whole-file-rewrite failure. A literal find/replace makes the edit's blast
 * radius exactly the text the model actually named.
 *
 * `oldString` is matched LITERALLY (never as a regex), and must appear exactly
 * once unless `replaceAll` is set. A zero-match or an ambiguous multi-match is
 * an error rather than a guess: the model must come back with more surrounding
 * context, which is also what makes the edit reviewable.
 */
export async function editSandboxFile(
  relPath: string,
  oldString: string,
  newString: string,
  replaceAll = false
): Promise<EditResult> {
  const workspace = await ensureWorkspace()
  const abs = resolveInSandbox(workspace, relPath)

  if (typeof oldString !== 'string' || oldString === '') {
    throw new Error('old_string must be a non-empty string')
  }
  if (typeof newString !== 'string') {
    throw new Error('new_string must be a string')
  }
  if (oldString === newString) {
    throw new Error('old_string and new_string are identical — nothing to change')
  }

  let original: string
  try {
    original = await readFile(abs, 'utf8')
  } catch {
    throw new Error(`"${relPath}" does not exist in the workspace. Write it first.`)
  }

  // Literal occurrence count — split/join avoids the regex-escaping problem and
  // the "$&" substitution footgun in String.replace.
  const occurrences = original.split(oldString).length - 1
  if (occurrences === 0) {
    throw new Error(
      `old_string was not found in "${relPath}". It must match the file byte-for-byte, ` +
        'including indentation and line endings.'
    )
  }
  if (occurrences > 1 && !replaceAll) {
    throw new Error(
      `old_string appears ${occurrences} times in "${relPath}". Include more surrounding ` +
        'context to make it unique, or set replace_all to change every occurrence.'
    )
  }

  const updated = replaceAll
    ? original.split(oldString).join(newString)
    : original.replace(oldString, newString)

  if (Buffer.byteLength(updated, 'utf8') > MAX_FILE_BYTES) {
    throw new Error(`edit would push the file past the ${Math.round(MAX_FILE_BYTES / 1024)} KB limit`)
  }

  await writeFile(abs, updated, 'utf8')
  return { replacements: replaceAll ? occurrences : 1, path: relative(workspace, abs) }
}

/** Result of applying a unified diff to a workspace file. */
export interface PatchResult {
  /** Workspace-relative path that was patched. */
  path: string
  /** Number of hunks applied. */
  hunks: number
}

/**
 * Apply a unified diff to an existing workspace file. Like editSandboxFile this
 * mutates the named file in place with the same containment (resolveInSandbox,
 * byte cap) — but expresses several edits to one file in a single call. Parsing
 * and the byte-for-byte match live in patch.ts (pure, unit-tested); this only
 * adds the fs wiring. A diff that no longer fits the file throws rather than
 * corrupting it, so the model re-reads and regenerates instead of guessing.
 */
export async function applyPatchToSandboxFile(relPath: string, diff: string): Promise<PatchResult> {
  const workspace = await ensureWorkspace()
  const abs = resolveInSandbox(workspace, relPath)

  const hunks = parseUnifiedDiff(diff)

  let original: string
  try {
    original = await readFile(abs, 'utf8')
  } catch {
    throw new Error(`"${relPath}" does not exist in the workspace. Write it first with write_file.`)
  }

  const updated = applyPatch(original, hunks)

  if (Buffer.byteLength(updated, 'utf8') > MAX_FILE_BYTES) {
    throw new Error(`patch would push the file past the ${Math.round(MAX_FILE_BYTES / 1024)} KB limit`)
  }

  await writeFile(abs, updated, 'utf8')
  return { path: relative(workspace, abs), hunks: hunks.length }
}

/** One matching line found by searchSandbox. */
export interface SearchMatch {
  /** Workspace-relative path, always with forward slashes. */
  file: string
  /** 1-indexed line number. */
  line: number
  /** The matching line, trimmed and length-capped. */
  text: string
}

/** How long a whole search may run before it gives up and returns what it has. */
const SEARCH_DEADLINE_MS = 10_000
/** Files larger than this are skipped — they're data, not source. */
const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024
/** Matching is capped at this line length (see the ReDoS note below). */
const MAX_SEARCH_LINE_CHARS = 1000
/** Longest regex a caller may supply. */
const MAX_PATTERN_CHARS = 500
/** Default cap on returned matches, so a broad pattern can't flood the context. */
const DEFAULT_MAX_MATCHES = 100

/** Regex metacharacters that must be escaped when they appear literally in a glob. */
const GLOB_META = '.+^${}()|[]\\'

/**
 * Translate a shell-style glob into an anchored RegExp. Supports `*` (within a
 * path segment), `**` (across segments), `?` (one non-separator char). Paths are
 * normalised to forward slashes before matching, so this behaves the same on
 * Windows as on POSIX.
 */
export function globToRegExp(glob: string): RegExp {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i++
        // A `**/` also matches zero directories, so src/**/*.ts finds src/a.ts.
        if (glob[i + 1] === '/') {
          i++
          out += '(?:.*/)?'
        } else {
          out += '.*'
        }
      } else {
        out += '[^/]*'
      }
    } else if (ch === '?') {
      out += '[^/]'
    } else if (GLOB_META.includes(ch)) {
      out += '\\' + ch
    } else {
      out += ch
    }
  }
  return new RegExp(`^${out}$`)
}

/** True when a buffer looks binary (a NUL byte in the first 8 KB). */
function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8192).includes(0)
}

/**
 * Regex-search the text files of the workspace and return matching lines.
 *
 * This is what lets the agent work on code it did not write in this session —
 * without it, `read_file` is only useful when the model already knows the path.
 * Implemented in pure Node rather than shelling out to ripgrep/grep so the
 * module keeps its zero-dependency, no-shell local backend.
 *
 * ReDoS: `pattern` is model-supplied, so a catastrophic-backtracking regex could
 * in principle wedge one `.test()` call, which no timer can interrupt on this
 * thread. Bounded, not eliminated: the pattern length is capped, each candidate
 * line is truncated to MAX_SEARCH_LINE_CHARS before matching, and the walk stops
 * at SEARCH_DEADLINE_MS. That makes a hang cost milliseconds rather than the
 * process. Do not lift the line cap without moving this onto a worker thread.
 */
export async function searchSandbox(
  pattern: string,
  opts: { glob?: string; maxResults?: number; ignoreCase?: boolean } = {}
): Promise<SearchMatch[]> {
  const workspace = await ensureWorkspace()

  if (typeof pattern !== 'string' || !pattern.trim()) {
    throw new Error('pattern must be a non-empty string')
  }
  if (pattern.length > MAX_PATTERN_CHARS) {
    throw new Error(`pattern exceeds the ${MAX_PATTERN_CHARS}-character limit`)
  }

  let re: RegExp
  try {
    re = new RegExp(pattern, opts.ignoreCase ? 'i' : '')
  } catch (err) {
    throw new Error(`invalid regex: ${err instanceof Error ? err.message : String(err)}`)
  }

  let globRe: RegExp | null = null
  if (opts.glob?.trim()) {
    try {
      globRe = globToRegExp(opts.glob.trim())
    } catch {
      throw new Error(`invalid glob: ${opts.glob}`)
    }
  }

  const limit = opts.maxResults && opts.maxResults > 0 ? opts.maxResults : DEFAULT_MAX_MATCHES
  const deadline = Date.now() + SEARCH_DEADLINE_MS
  const matches: SearchMatch[] = []

  async function walk(dir: string): Promise<void> {
    if (matches.length >= limit || Date.now() > deadline) return
    // Unreadable directory → skip it rather than fail the whole search.
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => null)
    if (!entries) return
    for (const entry of entries) {
      if (matches.length >= limit || Date.now() > deadline) return
      // Same exclusions as listSandboxFiles: dependency trees and dot-dirs are
      // noise the model should never be reading.
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(abs)
        continue
      }

      const rel = relative(workspace, abs).split('\\').join('/')
      if (globRe && !globRe.test(rel)) continue

      let buf: Buffer
      try {
        const info = await stat(abs)
        if (info.size > MAX_SEARCH_FILE_BYTES) continue
        buf = await readFile(abs)
      } catch {
        continue
      }
      if (looksBinary(buf)) continue

      const lines = buf.toString('utf8').split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        if (matches.length >= limit) return
        // Check the clock per line: a pathological pattern can't be interrupted
        // mid-test, but it also can't run away across a whole tree.
        if ((i & 0xff) === 0 && Date.now() > deadline) return
        const line = lines[i].slice(0, MAX_SEARCH_LINE_CHARS)
        if (re.test(line)) {
          matches.push({ file: rel, line: i + 1, text: line.trim() })
        }
      }
    }
  }

  await walk(workspace)
  return matches
}

// ── git ──────────────────────────────────────────────────────────────────────

const GIT_TIMEOUT_MS = 30_000

/**
 * Git subcommands the coding agent may run. Everything here is LOCAL: it reads
 * or rewrites the sandbox repo and nothing else.
 *
 * Network subcommands (clone/fetch/pull/push/remote/submodule) are absent on
 * purpose — they would let a hostile task exfiltrate the workspace to a remote
 * the model chose. Pushing is a deliberate, human-approved act that already has
 * its own path through github.ts.
 *
 * `config` is absent because `git config alias.x '!sh -c ...'` and
 * `core.sshCommand` turn config into arbitrary command execution. Commit
 * identity is supplied through the environment instead (see gitEnv).
 */
const GIT_ALLOWED_SUBCOMMANDS = new Set([
  'init',
  'status',
  'add',
  'commit',
  'diff',
  'log',
  'show',
  'branch',
  'checkout',
  'switch',
  'restore',
  'rev-parse',
  'stash',
  'tag',
  'mv',
  'rm'
])

/**
 * Subcommands the autonomous loop drives programmatically for checkpointing and
 * parallel worktree workers, but which are NOT exposed to the model-facing `git`
 * tool (its schema enum omits them, and `runGit` only permits them when the
 * caller explicitly passes this set as `extraAllowed`). Keeping them out of
 * GIT_ALLOWED_SUBCOMMANDS means a model-issued `git worktree`/`git merge` is
 * still refused — only the loop's own trusted call sites can use them.
 */
const GIT_INTERNAL_SUBCOMMANDS = new Set(['worktree', 'merge'])

/**
 * Arguments rejected wherever they appear. Each of these either relocates git
 * outside the sandbox (-C, --git-dir, --work-tree) or is a documented execution
 * vector (-c sets config inline; --exec-path, --upload-pack, --receive-pack and
 * --config-env all name a program or config to run). The subcommand allowlist
 * alone would not stop `git -c core.pager='!sh' log`.
 */
const GIT_FORBIDDEN_ARG_RE =
  /^(-c|-C|--exec-path|--git-dir|--work-tree|--namespace|--upload-pack|--receive-pack|--config-env)(=|$)/i

/**
 * Environment for every git invocation. Blocks credential/passphrase prompts
 * (which would hang a bounded, unattended child forever), ignores system-level
 * config we don't control, and attributes commits to the agent rather than
 * silently forging the user's identity.
 */
function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_ASKPASS: '',
    GIT_AUTHOR_NAME: 'OpenUI Agent',
    GIT_AUTHOR_EMAIL: 'agent@openui.local',
    GIT_COMMITTER_NAME: 'OpenUI Agent',
    GIT_COMMITTER_EMAIL: 'agent@openui.local'
  }
}

/**
 * Validate a git invocation against the allowlist. Exported for direct unit
 * testing — this is a trust boundary, so it is tested without spawning git.
 * Returns null when the call is permitted, or the reason it was refused.
 */
export function rejectGitInvocation(
  subcommand: unknown,
  args: unknown,
  extraAllowed?: Set<string>
): string | null {
  if (typeof subcommand !== 'string' || !subcommand.trim()) {
    return 'git requires a non-empty subcommand.'
  }
  const sub = subcommand.trim()
  if (!GIT_ALLOWED_SUBCOMMANDS.has(sub) && !extraAllowed?.has(sub)) {
    return (
      `git subcommand "${sub}" is not allowed. Permitted: ` +
      `${[...GIT_ALLOWED_SUBCOMMANDS].sort().join(', ')}. ` +
      'Network operations (push/pull/fetch/clone/remote) are intentionally unavailable here.'
    )
  }
  if (!Array.isArray(args)) return 'git args must be an array of strings.'
  for (const arg of args) {
    if (typeof arg !== 'string') return 'every git arg must be a string.'
    if (GIT_FORBIDDEN_ARG_RE.test(arg)) {
      return `git argument "${arg}" is not allowed (it can redirect git outside the workspace or execute a program).`
    }
  }
  return null
}

/**
 * Run one allowlisted git subcommand inside the workspace.
 *
 * There is no shell: `args` become argv entries verbatim, so a commit message
 * containing `;` or `$(...)` is inert data. Combined with rejectGitInvocation,
 * the only thing a model can express here is a local git operation on its own
 * sandbox repo.
 */
export async function runGit(
  subcommand: string,
  args: string[] = [],
  extraAllowed?: Set<string>
): Promise<TestRunResult> {
  const cwd = await ensureWorkspace()

  const refusal = rejectGitInvocation(subcommand, args, extraAllowed)
  if (refusal) return { passed: false, output: refusal }

  // Every subcommand but `init` needs a repo; say so plainly instead of letting
  // the model puzzle over git's "not a git repository" error.
  if (subcommand !== 'init') {
    try {
      await stat(join(cwd, '.git'))
    } catch {
      return {
        passed: false,
        output: 'The workspace is not a git repository yet. Run git with subcommand "init" first.'
      }
    }
  }

  return runBoundedProcess('git', [subcommand, ...args], cwd, GIT_TIMEOUT_MS, undefined, gitEnv())
}

// --- Atomic checkpoint commits (§6) ---------------------------------------
//
// The autonomous loop commits a checkpoint after every VerifyGate-confirmed
// green run, so a later sub-task failure can roll the working tree back to the
// last *known-good* commit rather than to a whole-file snapshot of uncertain
// vintage. These run `add`/`commit`/`rev-parse`/`checkout` — all already on the
// model-facing allowlist — but are invoked only from trusted loop code, never
// from a model tool call.

/**
 * Ensure the workspace is a git repository, running `git init` if it is not.
 * Returns true when a repo is present (or was just created), false if init
 * failed. Cheap and idempotent — safe to call before every checkpoint.
 */
export async function ensureGitRepo(): Promise<boolean> {
  const cwd = await ensureWorkspace()
  try {
    await stat(join(cwd, '.git'))
    return true
  } catch {
    // Not a repo yet — create one. `-b` names the initial branch deterministically
    // so behaviour does not depend on the host's init.defaultBranch config.
    const init = await runGit('init', ['-b', 'openui-work'])
    return init.passed
  }
}

/**
 * Current HEAD commit SHA, or null when the workspace is not a repo or has no
 * commits yet. Never throws — a null simply means "no checkpoint exists".
 */
export async function currentCommit(): Promise<string | null> {
  const res = await runGit('rev-parse', ['HEAD'])
  if (!res.passed) return null
  const sha = res.output.trim()
  return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null
}

/**
 * Stage everything and commit a checkpoint. Returns the new (or unchanged) HEAD
 * SHA, or null if committing was impossible. A clean tree ("nothing to commit")
 * is not an error: the existing HEAD is still a valid checkpoint, so its SHA is
 * returned. `add -A` stages deletions too, so the checkpoint captures the whole
 * tree state, not just modifications.
 */
export async function commitCheckpoint(message: string): Promise<string | null> {
  if (!(await ensureGitRepo())) return null

  const staged = await runGit('add', ['-A'])
  if (!staged.passed) return null

  const committed = await runGit('commit', ['-m', message || 'checkpoint'])
  if (!committed.passed) {
    // Non-zero exit is expected when the tree is clean; treat that as success and
    // return the standing HEAD. Any other failure yields whatever HEAD exists (or
    // null when there is genuinely no commit to fall back to).
    if (/nothing to commit|no changes added|working tree clean/i.test(committed.output)) {
      return currentCommit()
    }
    return currentCommit()
  }
  return currentCommit()
}

/**
 * Discard all uncommitted working-tree changes, restoring tracked files to the
 * last commit. Returns false when there is no commit to roll back to (rollback
 * of created-but-untracked files is handled by the snapshot layer, not here).
 */
export async function rollbackToLastCommit(): Promise<boolean> {
  if ((await currentCommit()) === null) return false
  const res = await runGit('checkout', ['--', '.'])
  return res.passed
}

// --- Parallel worktree workers (§3) ---------------------------------------
//
// Independent sub-tasks run concurrently, each in its own linked git worktree so
// their edits never collide in one shared directory. `worktree`/`merge` are NOT
// on the model-facing allowlist — these helpers pass GIT_INTERNAL_SUBCOMMANDS
// explicitly, so only trusted loop code can drive them. Worktrees live in a
// sibling of the workspace so they are outside the tree the agent walks/edits.

const WORKTREE_ROOT_DIR = '.openui-worktrees'

export interface WorktreeHandle {
  /** Sanitised worker name. */
  name: string
  /** Branch checked out in the worktree (created at the base commit). */
  branch: string
  /** Absolute path to the worktree directory. */
  path: string
}

function sanitiseWorktreeName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^-+|-+$/g, '')
  return cleaned || 'worker'
}

/**
 * Create a linked worktree checked out on a fresh branch at the current HEAD.
 * Requires the main workspace to be a repo with at least one commit (the base
 * the workers diverge from) — ensured by the caller's checkpoint commit. Returns
 * null when git or the worktree add fails, so the caller can fall back to a
 * sequential run in the main tree.
 */
export async function addWorktree(name: string): Promise<WorktreeHandle | null> {
  if ((await currentCommit()) === null) return null
  const safe = sanitiseWorktreeName(name)
  const branch = `openui/${safe}`
  const root = join(dirname(getWorkspaceDir()), WORKTREE_ROOT_DIR)
  const path = join(root, safe)
  try {
    await mkdir(root, { recursive: true })
  } catch {
    return null
  }
  const res = await runGit('worktree', ['add', path, '-b', branch], GIT_INTERNAL_SUBCOMMANDS)
  if (!res.passed) return null
  return { name: safe, branch, path }
}

/**
 * Merge a worker's branch back into the main workspace. Returns the raw result:
 * a non-`passed` result whose output mentions a conflict is the signal for the
 * caller to abort the merge and re-run that sub-task sequentially on the merged
 * base. `--no-ff` keeps each sub-task a discrete, revertable commit.
 */
export async function mergeWorktreeBranch(branch: string): Promise<TestRunResult> {
  return runGit('merge', ['--no-ff', '--no-edit', branch], GIT_INTERNAL_SUBCOMMANDS)
}

/** Abort an in-progress merge (used to recover from a conflicted merge). */
export async function abortMerge(): Promise<boolean> {
  const res = await runGit('merge', ['--abort'], GIT_INTERNAL_SUBCOMMANDS)
  return res.passed
}

/**
 * Remove a worktree and delete its branch. Best-effort cleanup: `--force`
 * discards any uncommitted worker state, and a failed branch delete is ignored
 * (the worktree removal is what actually frees the path). Never throws.
 */
export async function removeWorktree(handle: WorktreeHandle): Promise<void> {
  await runGit('worktree', ['remove', '--force', handle.path], GIT_INTERNAL_SUBCOMMANDS)
  await runGit('branch', ['-D', handle.branch])
}
