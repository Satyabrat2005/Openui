import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// sandbox.ts statically imports `electron` for app.getPath. Mock it so the module
// graph loads under plain-node vitest. Every test below points the sandbox at a
// throwaway temp dir via OPENUI_WORKSPACE, so nothing touches a real home dir.
vi.mock('electron', () => ({
  app: { getPath: () => process.cwd() }
}))

import {
  editSandboxFile,
  searchSandbox,
  globToRegExp,
  rejectGitInvocation,
  runGit,
  readSandboxFile,
  writeSandboxFile,
  ensureGitRepo,
  currentCommit,
  commitCheckpoint,
  rollbackToLastCommit,
  runInWorkspace,
  getWorkspaceDir,
  addWorktree,
  mergeWorktreeBranch,
  removeWorktree,
  setActiveProject,
  resetActiveProject,
  stripRedundantProjectPrefix,
  runTests,
  runScript
} from './sandbox'
import { resolve, dirname, basename } from 'node:path'

let ws: string

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'openui-sandbox-'))
  process.env.OPENUI_WORKSPACE = ws
})

afterEach(async () => {
  resetActiveProject()
  delete process.env.OPENUI_WORKSPACE
  await rm(ws, { recursive: true, force: true })
})

describe('stripRedundantProjectPrefix', () => {
  it('strips a leading "<project>/" so the model cannot double-nest', () => {
    setActiveProject('demo-counter')
    expect(stripRedundantProjectPrefix('demo-counter/package.json')).toBe('package.json')
    expect(stripRedundantProjectPrefix('demo-counter/src/App.jsx')).toBe('src/App.jsx')
    expect(stripRedundantProjectPrefix('demo-counter\\src\\App.jsx')).toBe('src/App.jsx')
    expect(stripRedundantProjectPrefix('package.json')).toBe('package.json')
    expect(stripRedundantProjectPrefix('src/demo-counter/x.js')).toBe('src/demo-counter/x.js')
  })

  it('is a no-op when no project is active', () => {
    resetActiveProject()
    expect(stripRedundantProjectPrefix('demo-counter/package.json')).toBe('demo-counter/package.json')
  })
})

describe('globToRegExp', () => {
  it('confines a single * to one path segment', () => {
    expect(globToRegExp('*.ts').test('a.ts')).toBe(true)
    expect(globToRegExp('*.ts').test('src/a.ts')).toBe(false)
  })

  it('lets ** cross segments, including zero of them', () => {
    const re = globToRegExp('src/**/*.ts')
    expect(re.test('src/a.ts')).toBe(true)
    expect(re.test('src/x/y/a.ts')).toBe(true)
    expect(re.test('lib/a.ts')).toBe(false)
  })

  it('treats ? as exactly one non-separator character', () => {
    expect(globToRegExp('?.ts').test('a.ts')).toBe(true)
    expect(globToRegExp('?.ts').test('ab.ts')).toBe(false)
  })

  it('escapes regex metacharacters so a dot is a literal dot', () => {
    expect(globToRegExp('a.ts').test('axts')).toBe(false)
    expect(globToRegExp('a+b.ts').test('a+b.ts')).toBe(true)
  })
})

describe('editSandboxFile', () => {
  it('replaces a unique occurrence and leaves the rest of the file intact', async () => {
    await writeSandboxFile('a.js', 'const a = 1\nconst b = 2\nconst c = 3\n')
    const result = await editSandboxFile('a.js', 'const b = 2', 'const b = 99')
    expect(result.replacements).toBe(1)
    expect(await readSandboxFile('a.js')).toBe('const a = 1\nconst b = 99\nconst c = 3\n')
  })

  it('deletes the matched text when new_string is empty', async () => {
    await writeSandboxFile('a.js', 'keep\ndrop\n')
    await editSandboxFile('a.js', 'drop\n', '')
    expect(await readSandboxFile('a.js')).toBe('keep\n')
  })

  it('refuses an ambiguous match rather than guessing which one to change', async () => {
    await writeSandboxFile('a.js', 'x = 1\nx = 1\n')
    await expect(editSandboxFile('a.js', 'x = 1', 'x = 2')).rejects.toThrow(/appears 2 times/)
  })

  it('replaces every occurrence when replaceAll is set', async () => {
    await writeSandboxFile('a.js', 'x = 1\nx = 1\n')
    const result = await editSandboxFile('a.js', 'x = 1', 'x = 2', true)
    expect(result.replacements).toBe(2)
    expect(await readSandboxFile('a.js')).toBe('x = 2\nx = 2\n')
  })

  it('reports a miss instead of silently writing nothing', async () => {
    await writeSandboxFile('a.js', 'hello\n')
    await expect(editSandboxFile('a.js', 'goodbye', 'hi')).rejects.toThrow(/was not found/)
  })

  it('treats old_string literally, not as a regex', async () => {
    await writeSandboxFile('a.js', 'value = a.b\n')
    // "a.b" as a regex would also match "axb"; as a literal it matches only "a.b".
    await expect(editSandboxFile('a.js', 'axb', 'z')).rejects.toThrow(/was not found/)
    const result = await editSandboxFile('a.js', 'a.b', 'z')
    expect(result.replacements).toBe(1)
  })

  it('rejects an identical replacement', async () => {
    await writeSandboxFile('a.js', 'same\n')
    await expect(editSandboxFile('a.js', 'same', 'same')).rejects.toThrow(/identical/)
  })

  it('rejects an edit to a file that does not exist yet', async () => {
    await expect(editSandboxFile('nope.js', 'a', 'b')).rejects.toThrow(/does not exist/)
  })

  it('cannot escape the workspace via ..', async () => {
    await expect(editSandboxFile('../outside.js', 'a', 'b')).rejects.toThrow(/escapes the workspace/)
  })
})

describe('searchSandbox', () => {
  beforeEach(async () => {
    await mkdir(join(ws, 'src'), { recursive: true })
    await mkdir(join(ws, 'node_modules', 'dep'), { recursive: true })
    await writeFile(join(ws, 'src', 'a.ts'), 'export function createUser() {}\n// TODO: later\n')
    await writeFile(join(ws, 'src', 'b.py'), 'def create_user():\n    pass\n')
    await writeFile(join(ws, 'node_modules', 'dep', 'i.ts'), 'export function createUser() {}\n')
  })

  it('finds a match and reports its file and 1-indexed line', async () => {
    const matches = await searchSandbox('createUser')
    expect(matches).toHaveLength(1)
    expect(matches[0].file).toBe('src/a.ts')
    expect(matches[0].line).toBe(1)
    expect(matches[0].text).toContain('createUser')
  })

  it('never searches node_modules', async () => {
    const matches = await searchSandbox('createUser')
    expect(matches.every((m) => !m.file.includes('node_modules'))).toBe(true)
  })

  it('filters by glob', async () => {
    expect(await searchSandbox('create', { glob: '**/*.py' })).toHaveLength(1)
    expect(await searchSandbox('create_user', { glob: '**/*.ts' })).toHaveLength(0)
  })

  it('honours ignoreCase', async () => {
    expect(await searchSandbox('CREATEUSER')).toHaveLength(0)
    expect(await searchSandbox('CREATEUSER', { ignoreCase: true })).toHaveLength(1)
  })

  it('caps results at maxResults', async () => {
    expect(await searchSandbox('.', { maxResults: 2 })).toHaveLength(2)
  })

  it('surfaces an invalid regex as a clear error', async () => {
    await expect(searchSandbox('[unclosed')).rejects.toThrow(/invalid regex/)
  })

  it('rejects an over-long pattern', async () => {
    await expect(searchSandbox('a'.repeat(501))).rejects.toThrow(/character limit/)
  })
})

// The git allowlist is a trust boundary: a task description or GitHub issue body
// is what ultimately steers this agent. These assertions run entirely in-process,
// with no git binary involved, so they hold even where git is not installed.
describe('rejectGitInvocation', () => {
  it('permits local read and write subcommands', () => {
    expect(rejectGitInvocation('status', [])).toBeNull()
    expect(rejectGitInvocation('init', [])).toBeNull()
    expect(rejectGitInvocation('commit', ['-m', 'Add login'])).toBeNull()
    expect(rejectGitInvocation('log', ['--oneline', '-n', '10'])).toBeNull()
  })

  it.each(['push', 'pull', 'fetch', 'clone', 'remote', 'submodule'])(
    'refuses the network subcommand %s',
    (sub) => {
      expect(rejectGitInvocation(sub, [])).toMatch(/not allowed/)
    }
  )

  it('refuses config, which is an arbitrary-execution vector via aliases', () => {
    expect(rejectGitInvocation('config', ['alias.x', '!sh'])).toMatch(/not allowed/)
  })

  it('refuses -c, which sets config inline and can name a pager to execute', () => {
    expect(rejectGitInvocation('log', ['-c', 'core.pager=!sh'])).toMatch(/not allowed/)
  })

  it('refuses flags that relocate git outside the workspace', () => {
    expect(rejectGitInvocation('status', ['-C', '/etc'])).toMatch(/not allowed/)
    expect(rejectGitInvocation('status', ['--git-dir=/etc/.git'])).toMatch(/not allowed/)
    expect(rejectGitInvocation('status', ['--work-tree', '/'])).toMatch(/not allowed/)
  })

  it('refuses flags that name a program to run', () => {
    expect(rejectGitInvocation('log', ['--exec-path=/tmp/evil'])).toMatch(/not allowed/)
    expect(rejectGitInvocation('log', ['--upload-pack', 'sh'])).toMatch(/not allowed/)
  })

  it('does not confuse a legitimate long flag with a banned short one', () => {
    // "--cached" begins with "-c" but must not trip the -c rule.
    expect(rejectGitInvocation('rm', ['--cached', 'f.txt'])).toBeNull()
    expect(rejectGitInvocation('diff', ['--color'])).toBeNull()
  })

  it('rejects malformed argument shapes', () => {
    expect(rejectGitInvocation('', [])).toMatch(/non-empty subcommand/)
    expect(rejectGitInvocation('status', 'oops')).toMatch(/must be an array/)
    expect(rejectGitInvocation('status', [1])).toMatch(/must be a string/)
  })

  it('keeps internal-only subcommands off the model-facing allowlist', () => {
    // The model path calls rejectGitInvocation with no extraAllowed set, so the
    // §3 worktree/merge machinery is refused when a model tries to reach it.
    expect(rejectGitInvocation('worktree', ['list'])).toMatch(/not allowed/)
    expect(rejectGitInvocation('merge', ['branch'])).toMatch(/not allowed/)
  })

  it('permits internal subcommands only when the trusted caller opts in', () => {
    const internal = new Set(['worktree', 'merge'])
    expect(rejectGitInvocation('worktree', ['list'], internal)).toBeNull()
    expect(rejectGitInvocation('merge', ['feature'], internal)).toBeNull()
    // Opting worktree in does not smuggle a still-forbidden flag past the arg check.
    expect(rejectGitInvocation('worktree', ['-C', '/etc'], internal)).toMatch(/not allowed/)
  })
})

describe('runGit', () => {
  it('refuses a denied subcommand before spawning anything', async () => {
    const result = await runGit('push', ['origin', 'main'])
    expect(result.passed).toBe(false)
    expect(result.output).toMatch(/not allowed/)
  })

  it('explains that the workspace is not a repository yet', async () => {
    const result = await runGit('status', [])
    expect(result.passed).toBe(false)
    expect(result.output).toMatch(/not a git repository/)
  })
})

// Live git integration (§6). Uses the real `git` binary against the throwaway
// OPENUI_WORKSPACE repo created per test — the checkpoint helpers are the
// rollback foundation, so they are exercised end-to-end rather than stubbed.
describe('git checkpoints', () => {
  it('initialises a repository on demand and is idempotent', async () => {
    expect(await ensureGitRepo()).toBe(true)
    expect(await ensureGitRepo()).toBe(true)
  })

  it('reports no commit before the first checkpoint, then the HEAD sha', async () => {
    await ensureGitRepo()
    expect(await currentCommit()).toBeNull()

    await writeFile(join(ws, 'a.txt'), 'hello\n')
    const sha = await commitCheckpoint('first checkpoint')
    expect(sha).toMatch(/^[0-9a-f]{7,40}$/)
    expect(await currentCommit()).toBe(sha)
  })

  it('treats a clean tree as success and returns the standing HEAD', async () => {
    await writeFile(join(ws, 'a.txt'), 'hello\n')
    const first = await commitCheckpoint('first')
    // Nothing changed since the last checkpoint — git exits non-zero, but the
    // helper must still report the existing known-good commit, not null.
    const second = await commitCheckpoint('noop')
    expect(second).toBe(first)
  })

  it('rolls the working tree back to the last checkpoint', async () => {
    await writeFile(join(ws, 'a.txt'), 'good\n')
    await commitCheckpoint('good state')

    await writeFile(join(ws, 'a.txt'), 'broken\n')
    expect(await rollbackToLastCommit()).toBe(true)
    expect(await readSandboxFile('a.txt')).toBe('good\n')
  })

  it('cannot roll back when no checkpoint exists yet', async () => {
    await ensureGitRepo()
    expect(await rollbackToLastCommit()).toBe(false)
  })
})

// §3 workspace isolation. A per-worker runInWorkspace scope must win over the
// OPENUI_WORKSPACE global, and concurrent scopes must not bleed into each other
// (the whole basis for running coding workers in parallel worktrees).
describe('runInWorkspace / getWorkspaceDir', () => {
  it('pins the workspace to the scoped dir, then restores the default after', async () => {
    const scoped = join(ws, 'nested-worker')
    expect(getWorkspaceDir()).toBe(resolve(ws))
    await runInWorkspace(scoped, async () => {
      expect(getWorkspaceDir()).toBe(resolve(scoped))
    })
    expect(getWorkspaceDir()).toBe(resolve(ws))
  })

  it('isolates concurrent scopes from one another', async () => {
    const seen: Record<string, string> = {}
    const dirA = join(ws, 'A')
    const dirB = join(ws, 'B')
    await Promise.all([
      runInWorkspace(dirA, async () => {
        await new Promise((r) => setTimeout(r, 5))
        seen.a = getWorkspaceDir()
      }),
      runInWorkspace(dirB, async () => {
        seen.b = getWorkspaceDir()
        await new Promise((r) => setTimeout(r, 10))
        // Still B after the other scope has come and gone.
        seen.aAfter = getWorkspaceDir()
      })
    ])
    expect(seen.a).toBe(resolve(dirA))
    expect(seen.b).toBe(resolve(dirB))
    expect(seen.aAfter).toBe(resolve(dirB))
  })
})

// Live git worktree round-trip (§3): a worker's isolated tree, committed on its
// own branch, merges back into the main workspace. Uses the real git binary.
describe('git worktrees', () => {
  it('creates a worktree, commits in it, and merges the work back into main', async () => {
    // Base commit in main so the worktree has something to branch from.
    await writeFile(join(ws, 'base.txt'), 'base\n')
    expect(await commitCheckpoint('base')).toMatch(/^[0-9a-f]{7,40}$/)

    const name = basename(ws) // unique per test run — avoids stale-worktree collisions
    const handle = await addWorktree(name)
    expect(handle).not.toBeNull()
    if (!handle) return

    // Do the worker's work inside its own tree, committed on its branch.
    await runInWorkspace(handle.path, async () => {
      await writeFile(join(handle.path, 'feature.txt'), 'from worker\n')
      await commitCheckpoint('worker feature')
    })

    // The feature does not exist in main until we merge the branch.
    expect(await readSandboxFile('feature.txt').catch(() => null)).toBeNull()

    const merge = await mergeWorktreeBranch(handle.branch)
    expect(merge.passed).toBe(true)
    expect(await readSandboxFile('feature.txt')).toBe('from worker\n')

    await removeWorktree(handle)
    // Cleanup: remove the sibling worktree root so /tmp does not accumulate.
    await rm(join(dirname(ws), '.openui-worktrees'), { recursive: true, force: true })
  })
})

// ── runTests failure diagnostics ────────────────────────────────────────────
// Regression cover for a builder failure seen on merged main: the model wrote a
// package.json missing its closing brace, and `npm test --silent` printed
// NOTHING (--silent suppresses npm's own errors too), so the only feedback the
// model got was execFile's generic "Command failed: npm.cmd test --silent". With
// no cause to act on it guessed, and burned 12 consecutive edit_file/run_tests
// turns rewriting a test.js that was correct the whole time.
describe('runTests — surfaces npm failure diagnostics', () => {
  it('reports the real npm error when --silent produced no output', async () => {
    // package.json missing its closing brace — npm fails before running anything.
    await writeFile(
      join(ws, 'package.json'),
      '{\n  "name": "x",\n  "scripts": {\n    "test": "node test.js"\n}\n'
    )
    await writeFile(join(ws, 'test.js'), 'console.log("hi")\n')

    const result = await runTests()

    expect(result.passed).toBe(false)
    // The actionable part: npm's parse error names the real problem and offset,
    // instead of the opaque "Command failed" the model used to receive.
    expect(result.output).toMatch(/EJSONPARSE|JSON\.parse|Invalid package\.json/i)
    expect(result.output).not.toBe('Tests failed.')
  }, 120_000)

  it('still reports a plain failing test suite from its own output', async () => {
    await writeFile(
      join(ws, 'package.json'),
      '{"name":"x","version":"1.0.0","scripts":{"test":"node test.js"}}'
    )
    await writeFile(
      join(ws, 'test.js'),
      'console.error("ASSERTION_FAILED: 1 !== 2"); process.exit(1)\n'
    )

    const result = await runTests()

    expect(result.passed).toBe(false)
    expect(result.output).toContain('ASSERTION_FAILED')
  }, 120_000)

  it('passes a suite that exits zero', async () => {
    await writeFile(
      join(ws, 'package.json'),
      '{"name":"x","version":"1.0.0","scripts":{"test":"node test.js"}}'
    )
    await writeFile(join(ws, 'test.js'), 'console.log("all good")\n')

    const result = await runTests()

    expect(result.passed).toBe(true)
  }, 120_000)
})

// ── runTests: "nothing to test" is not a failure ────────────────────────────
// Regression cover for the false GIVE UP on finished static-site builds. A plain
// HTML/CSS/JS site has no suite; `npm test` exits 1 either way (measured: with no
// "test" script, `npm test --silent` exits 1 having printed NOTHING), which read
// as TESTS FAILED. VerifyGate never saw a pass, and since no amount of editing
// can make a non-existent suite go green, the model spent its nudges and quit on
// completed work. These pin the three shapes apart.
describe('runTests — distinguishes "nothing to test" from a failure', () => {
  it('skips (does not fail) a static site with no package.json', async () => {
    await writeFile(join(ws, 'index.html'), '<!doctype html><h1>hi</h1>\n')

    const result = await runTests()

    expect(result.skipped).toBe(true)
    // Points at the verifier a static site CAN satisfy, rather than demanding a
    // package.json the site does not need.
    expect(result.output).toMatch(/list_files/)
    expect(result.output).toMatch(/static site/i)
  }, 120_000)

  it('skips a package.json with no test script and nothing else runnable', async () => {
    await writeFile(join(ws, 'package.json'), '{"name":"site","version":"1.0.0"}')

    const result = await runTests()

    expect(result.skipped).toBe(true)
    expect(result.output).toMatch(/list_files/)
  }, 120_000)

  it('treats npm init\'s placeholder test script as no test script', async () => {
    await writeFile(
      join(ws, 'package.json'),
      JSON.stringify({
        name: 'site',
        version: '1.0.0',
        scripts: { test: 'echo "Error: no test specified" && exit 1' }
      })
    )

    const result = await runTests()

    expect(result.skipped).toBe(true)
  }, 120_000)

  it('does NOT skip when another script is runnable — steers to run_script', async () => {
    // A site with a build step should be BUILT, not waved through as "nothing to
    // test". This stays a failure, but one that names the tool that can verify it.
    await writeFile(
      join(ws, 'package.json'),
      JSON.stringify({ name: 'site', version: '1.0.0', scripts: { build: 'echo building' } })
    )

    const result = await runTests()

    expect(result.skipped).toBeFalsy()
    expect(result.passed).toBe(false)
    expect(result.output).toMatch(/run_script/)
    expect(result.output).toMatch(/build/)
  }, 120_000)

  it('runScript skips when there is no package.json at all', async () => {
    // Seen live: the model called run_script "dev" on a finished static site,
    // got a hard failure, and gave up looking for a build system that will
    // never exist.
    await writeFile(join(ws, 'index.html'), '<!doctype html><h1>hi</h1>\n')
    const result = await runScript('dev')
    expect(result.skipped).toBe(true)
    expect(result.output).toMatch(/list_files/)
  }, 120_000)

  it('runScript skips when package.json defines no scripts at all', async () => {
    await writeFile(join(ws, 'package.json'), '{"name":"site","version":"1.0.0"}')
    const result = await runScript('dev')
    expect(result.skipped).toBe(true)
  }, 120_000)

  it('runScript still FAILS when scripts exist but the named one does not', async () => {
    // The model just guessed wrong — an actionable failure, not "nothing to run".
    await writeFile(
      join(ws, 'package.json'),
      JSON.stringify({ name: 's', version: '1.0.0', scripts: { build: 'echo hi' } })
    )
    const result = await runScript('dev')
    expect(result.skipped).toBeFalsy()
    expect(result.passed).toBe(false)
    expect(result.output).toMatch(/build/)
  }, 120_000)

  it('runScript still fails a malformed package.json rather than skipping it', async () => {
    await writeFile(join(ws, 'package.json'), '{"name":"s",')
    const result = await runScript('dev')
    expect(result.skipped).toBeFalsy()
    expect(result.passed).toBe(false)
  }, 120_000)

  it('still fails an unparseable package.json rather than skipping it', async () => {
    // Must not be swallowed by the skip path: a malformed package.json is a real
    // bug the model has to fix, and npm's EJSONPARSE is what tells it where.
    await writeFile(join(ws, 'package.json'), '{\n  "name": "x",\n  "scripts": {\n    "test": "node test.js"\n}\n')
    await writeFile(join(ws, 'test.js'), 'console.log("hi")\n')

    const result = await runTests()

    expect(result.skipped).toBeFalsy()
    expect(result.passed).toBe(false)
    expect(result.output).toMatch(/EJSONPARSE|JSON\.parse|Invalid package\.json/i)
  }, 120_000)
})
