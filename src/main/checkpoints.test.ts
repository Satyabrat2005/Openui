import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  saveCheckpoint,
  loadCheckpoint,
  clearCheckpoint,
  findResumableCheckpoint,
  setCheckpointDirForTests,
  type CheckpointInput
} from './checkpoints'

let dir: string

const base: CheckpointInput = {
  taskId: 'task-1',
  source: 'todo',
  title: 'Build the thing',
  subtaskIds: ['s1', 's2', 's3'],
  completedSubtaskIds: ['s1'],
  lastGoodCommit: 'abc1234',
  turnsUsed: 7
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'openui-resume-'))
  setCheckpointDirForTests(dir)
})

afterEach(async () => {
  setCheckpointDirForTests(null)
  await rm(dir, { recursive: true, force: true })
})

describe('save / load round-trip', () => {
  it('persists a checkpoint and reads it back with a stamped updatedAt', async () => {
    await saveCheckpoint(base)
    const loaded = await loadCheckpoint('task-1')
    expect(loaded).toMatchObject(base)
    expect(typeof loaded?.updatedAt).toBe('string')
    expect(Number.isNaN(Date.parse(loaded!.updatedAt))) .toBe(false)
  })

  it('overwrites an existing checkpoint for the same task id', async () => {
    await saveCheckpoint(base)
    await saveCheckpoint({ ...base, completedSubtaskIds: ['s1', 's2'], turnsUsed: 12 })
    const loaded = await loadCheckpoint('task-1')
    expect(loaded?.completedSubtaskIds).toEqual(['s1', 's2'])
    expect(loaded?.turnsUsed).toBe(12)
  })

  it('returns null for an unknown task', async () => {
    expect(await loadCheckpoint('nope')).toBeNull()
  })

  it('returns null (not a throw) for a corrupt checkpoint file', async () => {
    await writeFile(join(dir, 'task-1.json'), '{ not valid json', 'utf8')
    expect(await loadCheckpoint('task-1')).toBeNull()
  })

  it('survives an unusual task id via filename sanitisation', async () => {
    const weird = { ...base, taskId: 'github#42/some:branch' }
    await saveCheckpoint(weird)
    expect((await loadCheckpoint('github#42/some:branch'))?.taskId).toBe('github#42/some:branch')
  })
})

describe('clearCheckpoint', () => {
  it('deletes the record so it no longer loads', async () => {
    await saveCheckpoint(base)
    await clearCheckpoint('task-1')
    expect(await loadCheckpoint('task-1')).toBeNull()
  })

  it('is a no-op (no throw) when nothing exists', async () => {
    await expect(clearCheckpoint('ghost')).resolves.toBeUndefined()
  })
})

describe('findResumableCheckpoint', () => {
  // Helper: write a checkpoint file directly with a controlled updatedAt so
  // staleness/ordering are deterministic (saveCheckpoint stamps "now").
  async function writeAt(taskId: string, patch: Partial<CheckpointInput & { updatedAt: string }>) {
    const rec = { ...base, taskId, updatedAt: new Date().toISOString(), ...patch }
    await writeFile(join(dir, `${taskId}.json`), JSON.stringify(rec), 'utf8')
  }

  it('returns null when there is no resume directory or no files', async () => {
    expect(await findResumableCheckpoint('todo')).toBeNull()
  })

  it('finds a non-stale, partially-complete checkpoint for the source', async () => {
    await saveCheckpoint(base)
    const found = await findResumableCheckpoint('todo')
    expect(found?.taskId).toBe('task-1')
  })

  it('filters by source', async () => {
    await saveCheckpoint({ ...base, taskId: 't-gh', source: 'github' })
    expect(await findResumableCheckpoint('todo')).toBeNull()
    expect((await findResumableCheckpoint('github'))?.taskId).toBe('t-gh')
  })

  it('skips checkpoints older than the staleness window', async () => {
    const old = new Date('2020-01-01T00:00:00.000Z').toISOString()
    await writeAt('stale', { updatedAt: old })
    // "now" is well beyond 24h after the checkpoint.
    const now = new Date('2020-01-03T00:00:00.000Z')
    expect(await findResumableCheckpoint('todo', now)).toBeNull()
  })

  it('skips a decomposed task whose sub-tasks are all complete', async () => {
    await writeAt('done', { subtaskIds: ['s1', 's2'], completedSubtaskIds: ['s1', 's2'] })
    expect(await findResumableCheckpoint('todo')).toBeNull()
  })

  it('still resumes a whole (non-decomposed) task with no sub-tasks', async () => {
    await writeAt('whole', { subtaskIds: [], completedSubtaskIds: [] })
    expect((await findResumableCheckpoint('todo'))?.taskId).toBe('whole')
  })

  it('prefers the most recently updated candidate', async () => {
    await writeAt('older', { updatedAt: '2026-01-01T00:00:00.000Z' })
    await writeAt('newer', { updatedAt: '2026-06-01T00:00:00.000Z' })
    const now = new Date('2026-06-01T00:05:00.000Z')
    expect((await findResumableCheckpoint('todo', now))?.taskId).toBe('newer')
  })
})
