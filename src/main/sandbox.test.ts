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
  writeSandboxFile
} from './sandbox'

let ws: string

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'openui-sandbox-'))
  process.env.OPENUI_WORKSPACE = ws
})

afterEach(async () => {
  delete process.env.OPENUI_WORKSPACE
  await rm(ws, { recursive: true, force: true })
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
