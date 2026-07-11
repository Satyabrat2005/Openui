import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// sandbox.ts imports electron's `app`/`shell` at module scope but only calls
// them inside functions we don't exercise here; a minimal stub keeps the import
// resolvable. OPENUI_WORKSPACE pins the root at a temp dir.
vi.mock('electron', () => ({
  app: { getPath: () => process.cwd() },
  shell: { openPath: vi.fn() }
}))

import {
  slugifyProject,
  deriveProjectSlug,
  setActiveProject,
  getWorkspaceDir,
  getWorkspaceRoot,
  stripRedundantProjectPrefix
} from './sandbox'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'openui-root-'))
  process.env.OPENUI_WORKSPACE = root
})

afterEach(() => {
  setActiveProject('') // reset module state so tests don't leak into each other
  delete process.env.OPENUI_WORKSPACE
})

describe('slugifyProject', () => {
  it('produces filesystem-safe slugs', () => {
    expect(slugifyProject('My Todo App!')).toBe('my-todo-app')
    expect(slugifyProject('  Snake  Game  ')).toBe('snake-game')
    expect(slugifyProject('react/counter')).toBe('react-counter')
    expect(slugifyProject('')).toBe('')
  })
})

describe('deriveProjectSlug', () => {
  it('honours an explicitly named folder', () => {
    expect(deriveProjectSlug('build a react app and make a folder called todo-app')).toBe('todo-app')
    expect(deriveProjectSlug('make a snake game, name it snake-classic')).toBe('snake-classic')
    expect(deriveProjectSlug('create a project named "Cool Dashboard"')).toBe('cool-dashboard')
  })

  it('slugifies the description when no name is given', () => {
    expect(deriveProjectSlug('build a react counter app')).toBe('react-counter-app')
    expect(deriveProjectSlug('make a snake game in html')).toBe('snake-game-html')
  })

  it('falls back to a timestamped name when nothing usable remains', () => {
    // "make this folder and do this coding" is all filler words → fallback.
    expect(deriveProjectSlug('make this folder and do this coding')).toMatch(/^project-[a-z0-9]+$/)
  })
})

describe('stripRedundantProjectPrefix', () => {
  it('strips a leading "<project>/" so the model cannot double-nest', () => {
    setActiveProject('demo-counter')
    expect(stripRedundantProjectPrefix('demo-counter/package.json')).toBe('package.json')
    expect(stripRedundantProjectPrefix('demo-counter/src/App.jsx')).toBe('src/App.jsx')
    expect(stripRedundantProjectPrefix('demo-counter\\src\\App.jsx')).toBe('src/App.jsx')
    // A top-level path (no prefix) is untouched; so is a same-named nested dir file.
    expect(stripRedundantProjectPrefix('package.json')).toBe('package.json')
    expect(stripRedundantProjectPrefix('src/demo-counter/x.js')).toBe('src/demo-counter/x.js')
  })

  it('is a no-op when no project is active', () => {
    setActiveProject('')
    expect(stripRedundantProjectPrefix('demo-counter/package.json')).toBe('demo-counter/package.json')
  })
})

describe('setActiveProject / getWorkspaceDir', () => {
  it('points the workspace at a named subfolder of the root, and resets with ""', () => {
    expect(getWorkspaceDir()).toBe(getWorkspaceRoot()) // no active project → root
    const dir = setActiveProject('todo-app')
    expect(dir).toBe(join(root, 'todo-app'))
    expect(getWorkspaceDir()).toBe(join(root, 'todo-app'))
    setActiveProject('')
    expect(getWorkspaceDir()).toBe(root)
  })
})
