import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// sandbox.ts (imported by snapshots for getWorkspaceDir) reads electron's app
// at module scope; OPENUI_WORKSPACE overrides the actual dir used.
vi.mock('electron', () => ({
  app: { getPath: () => process.cwd() }
}))

import {
  beginTaskSnapshot,
  resumeTaskSnapshot,
  snapshotBeforeWrite,
  restoreActiveSnapshot,
  discardActiveSnapshot,
  hasActiveSnapshot,
  setSnapshotRootForTests
} from './snapshots'

let workspace: string

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'openui-ws-'))
  process.env.OPENUI_WORKSPACE = workspace
  setSnapshotRootForTests(mkdtempSync(join(tmpdir(), 'openui-snap-')))
  discardActiveSnapshot()
})

describe('snapshots — transactional workspace rollback', () => {
  it('restores an overwritten file to its pre-task content', async () => {
    writeFileSync(join(workspace, 'app.js'), 'original')

    await beginTaskSnapshot('task-1')
    await snapshotBeforeWrite('app.js')
    writeFileSync(join(workspace, 'app.js'), 'broken edit')

    const summary = await restoreActiveSnapshot()
    expect(readFileSync(join(workspace, 'app.js'), 'utf8')).toBe('original')
    expect(summary).toMatch(/restored 1 file/)
    expect(hasActiveSnapshot()).toBe(false)
  })

  it('deletes files the task created', async () => {
    await beginTaskSnapshot('task-2')
    await snapshotBeforeWrite('new-module.js')
    writeFileSync(join(workspace, 'new-module.js'), 'brand new')

    await restoreActiveSnapshot()
    expect(existsSync(join(workspace, 'new-module.js'))).toBe(false)
  })

  it('only snapshots the FIRST write per file (pre-image, not intermediate)', async () => {
    writeFileSync(join(workspace, 'x.txt'), 'v0')
    await beginTaskSnapshot('task-3')

    await snapshotBeforeWrite('x.txt')
    writeFileSync(join(workspace, 'x.txt'), 'v1')
    await snapshotBeforeWrite('x.txt') // second write — must keep v0, not v1
    writeFileSync(join(workspace, 'x.txt'), 'v2')

    await restoreActiveSnapshot()
    expect(readFileSync(join(workspace, 'x.txt'), 'utf8')).toBe('v0')
  })

  it('handles nested paths', async () => {
    mkdirSync(join(workspace, 'src', 'lib'), { recursive: true })
    writeFileSync(join(workspace, 'src', 'lib', 'util.js'), 'keep me')

    await beginTaskSnapshot('task-4')
    await snapshotBeforeWrite('src/lib/util.js')
    writeFileSync(join(workspace, 'src', 'lib', 'util.js'), 'clobbered')
    await snapshotBeforeWrite('src/lib/created.js')
    writeFileSync(join(workspace, 'src', 'lib', 'created.js'), 'temp')

    await restoreActiveSnapshot()
    expect(readFileSync(join(workspace, 'src', 'lib', 'util.js'), 'utf8')).toBe('keep me')
    expect(existsSync(join(workspace, 'src', 'lib', 'created.js'))).toBe(false)
  })

  it('is a no-op outside a snapshot transaction', async () => {
    writeFileSync(join(workspace, 'free.txt'), 'interactive')
    await snapshotBeforeWrite('free.txt') // no beginTaskSnapshot — must not throw
    expect(await restoreActiveSnapshot()).toBe('No snapshot to restore.')
  })

  it('discard keeps the workspace as the task left it', async () => {
    writeFileSync(join(workspace, 'done.txt'), 'before')
    await beginTaskSnapshot('task-5')
    await snapshotBeforeWrite('done.txt')
    writeFileSync(join(workspace, 'done.txt'), 'after — task succeeded')

    discardActiveSnapshot()
    expect(readFileSync(join(workspace, 'done.txt'), 'utf8')).toBe('after — task succeeded')
    expect(await restoreActiveSnapshot()).toBe('No snapshot to restore.')
  })
})

describe('resumeTaskSnapshot — cross-session resume (§7)', () => {
  it('re-opens the original snapshot so rollback targets the true baseline', async () => {
    writeFileSync(join(workspace, 'app.js'), 'original')

    await beginTaskSnapshot('resume-me')
    await snapshotBeforeWrite('app.js')
    writeFileSync(join(workspace, 'app.js'), 'partial session-1 progress')

    // Simulate the app closing mid-task: in-memory state is gone, but the
    // persisted manifest survives on disk.
    discardActiveSnapshot()
    expect(hasActiveSnapshot()).toBe(false)

    // A new session re-opens the snapshot WITHOUT wiping the original pre-images.
    expect(await resumeTaskSnapshot('resume-me')).toBe(true)
    expect(hasActiveSnapshot()).toBe(true)

    // Rolling back therefore targets the original baseline, not the half-done edit.
    await restoreActiveSnapshot()
    expect(readFileSync(join(workspace, 'app.js'), 'utf8')).toBe('original')
  })

  it('returns false when there is no snapshot to resume', async () => {
    expect(await resumeTaskSnapshot('never-existed')).toBe(false)
    expect(hasActiveSnapshot()).toBe(false)
  })
})
