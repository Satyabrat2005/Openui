/**
 * activeProject.test.ts — where the sandbox root points.
 *
 * setActiveProject is the seam where a name derived from a user message becomes
 * a directory. resolveInSandbox stops a path from escaping the root; these tests
 * cover the other half — that a hostile name cannot MOVE the root.
 *
 * OPENUI_WORKSPACE must stay unset here: it short-circuits getWorkspaceDir and
 * would hide exactly what we're testing.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { join } from 'node:path'

// CI runs Linux, developers run Windows. getWorkspaceDir() resolve()s the
// OPENUI_WORKSPACE override, so the fixture paths must be ABSOLUTE on whichever
// platform the suite runs on — "C:\..." is merely a relative path on Linux, and
// resolve() would silently prefix it with the runner's cwd.
const FS_ROOT = process.platform === 'win32' ? 'C:\\' : '/'
const HOME = join(FS_ROOT, 'Users', 'Jane Doe')

vi.mock('electron', () => ({
  app: { getPath: (n: string) => (n === 'home' ? HOME : join(HOME, 'AppData', 'Roaming', 'openui')) }
}))

import { getWorkspaceDir, getProjectsRoot, setActiveProject, getActiveProject, resetActiveProject } from './sandbox'

const ROOT = join(HOME, 'OpenUI Projects')

beforeEach(() => {
  delete process.env.OPENUI_WORKSPACE
  resetActiveProject()
})

describe('projects root', () => {
  it('lives in the user home, not in userData', () => {
    expect(getProjectsRoot()).toBe(ROOT)
    expect(getProjectsRoot()).not.toContain('AppData')
  })
})

describe('setActiveProject', () => {
  it('points the workspace at a per-project folder', () => {
    setActiveProject('snake-game')
    expect(getActiveProject()).toBe('snake-game')
    expect(getWorkspaceDir()).toBe(join(ROOT, 'snake-game'))
  })

  it('defaults to the shared workspace before any project is named', () => {
    expect(getActiveProject()).toBeNull()
    expect(getWorkspaceDir()).toBe(join(ROOT, 'workspace'))
  })

  it('resetActiveProject returns unattended runs to the shared workspace', () => {
    setActiveProject('snake-game')
    resetActiveProject()
    expect(getActiveProject()).toBeNull()
    expect(getWorkspaceDir()).toBe(join(ROOT, 'workspace'))
  })

  // A slug that is not a bare path segment must not be able to relocate the
  // sandbox root — it is rejected and the default workspace is used instead.
  it.each(['../../..', 'foo/bar', 'foo\\bar', 'C:\\Windows', '..', '.', '', '-lead', 'UPPER'])(
    'rejects the unsafe slug %j and falls back to the default workspace',
    (bad) => {
      setActiveProject(bad)
      expect(getActiveProject()).toBe('workspace')
      expect(getWorkspaceDir()).toBe(join(ROOT, 'workspace'))
    }
  )

  it('never escapes the projects root, whatever the slug', () => {
    for (const bad of ['../evil', '..\\evil', '/etc/passwd', 'a/../../b']) {
      setActiveProject(bad)
      expect(getWorkspaceDir().startsWith(ROOT)).toBe(true)
    }
  })
})

describe('OPENUI_WORKSPACE override', () => {
  it('still wins over the active project (tests and power users depend on it)', () => {
    const override = join(FS_ROOT, 'tmp', 'ws')
    process.env.OPENUI_WORKSPACE = override
    setActiveProject('snake-game')
    expect(getWorkspaceDir()).toBe(override)
    expect(getWorkspaceDir()).not.toContain('OpenUI Projects')
  })
})
