import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  registerTaskHandler,
  submitTask,
  resumeInterrupted,
  cancelTask,
  retryTask,
  listTasks,
  getTask,
  setTaskStoreDirForTests,
  resetTaskStoreForTests,
  resetTaskHandlersForTests,
  DEFAULT_MAX_ATTEMPTS,
  type TaskRecord
} from './durableTasks'
import { resetQueueForTests } from './taskQueue'
import { setRunLogDirForTests } from './runLog'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'durabletasks-'))
  setTaskStoreDirForTests(dir)
  setRunLogDirForTests(join(dir, 'logs'))
  resetTaskHandlersForTests()
  resetTaskStoreForTests()
  resetQueueForTests()
})

afterEach(async () => {
  resetQueueForTests()
  setTaskStoreDirForTests(null)
  setRunLogDirForTests(null)
  await rm(dir, { recursive: true, force: true })
})

const storePath = (): string => join(dir, 'background-tasks.json')

/** Overwrite the store to simulate whatever state a previous session left. */
async function seedStore(records: Partial<TaskRecord>[]): Promise<void> {
  const full = records.map((r, i) => ({
    id: r.id ?? `task-${i}`,
    kind: r.kind ?? 'demo',
    payload: r.payload ?? {},
    lane: r.lane ?? 'coding',
    label: r.label ?? 'demo task',
    status: r.status ?? 'queued',
    attempts: r.attempts ?? 0,
    maxAttempts: r.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    createdAt: r.createdAt ?? Date.now(),
    updatedAt: r.updatedAt ?? Date.now(),
    ...r
  }))
  await writeFile(storePath(), JSON.stringify(full), 'utf8')
  setTaskStoreDirForTests(dir) // clears the in-memory cache
}

describe('submitTask', () => {
  it('runs the handler and records the task as done', async () => {
    registerTaskHandler('demo', async (payload) => `handled ${(payload as { n: number }).n}`)

    const result = await submitTask('demo', { n: 7 }, { label: 'demo #7' })

    expect(result).toBe('handled 7')
    const [record] = listTasks()
    expect(record.status).toBe('done')
    expect(record.attempts).toBe(1)
    expect(record.label).toBe('demo #7')
  })

  it('records a failure with its message and rejects to the caller', async () => {
    registerTaskHandler('demo', async () => {
      throw new Error('handler blew up')
    })

    await expect(submitTask('demo', {})).rejects.toThrow('handler blew up')

    const [record] = listTasks()
    expect(record.status).toBe('failed')
    expect(record.error).toBe('handler blew up')
  })

  it('fails a task whose kind has no handler', async () => {
    await expect(submitTask('unknown-kind', {})).rejects.toThrow(/No handler registered/)
    expect(listTasks()[0].status).toBe('failed')
  })

  it('persists the record to disk so it survives a restart', async () => {
    registerTaskHandler('demo', async () => 'ok')
    await submitTask('demo', { n: 1 })

    const onDisk = JSON.parse(await readFile(storePath(), 'utf8'))
    expect(onDisk).toHaveLength(1)
    expect(onDisk[0].kind).toBe('demo')
    expect(onDisk[0].status).toBe('done')
  })
})

describe('resumeInterrupted', () => {
  it('re-runs a task the previous session left RUNNING', async () => {
    // This is the crash case: the process died mid-task, so the record was
    // never moved out of 'running'.
    await seedStore([{ id: 'a', kind: 'demo', status: 'running', attempts: 1 }])
    const ran: string[] = []
    registerTaskHandler('demo', async () => {
      ran.push('a')
      return 'ok'
    })

    const resumed = resumeInterrupted()
    await new Promise((r) => setTimeout(r, 20))

    expect(resumed.map((r) => r.id)).toEqual(['a'])
    expect(ran).toEqual(['a'])
    expect(getTask('a')?.status).toBe('done')
    expect(getTask('a')?.resumed).toBe(true)
  })

  it('re-runs a task that never started', async () => {
    await seedStore([{ id: 'a', kind: 'demo', status: 'queued', attempts: 0 }])
    registerTaskHandler('demo', async () => 'ok')

    expect(resumeInterrupted().map((r) => r.id)).toEqual(['a'])
    await new Promise((r) => setTimeout(r, 20))
    expect(getTask('a')?.status).toBe('done')
  })

  it('does not resume tasks that already finished', async () => {
    await seedStore([
      { id: 'done', status: 'done' },
      { id: 'failed', status: 'failed' },
      { id: 'cancelled', status: 'cancelled' }
    ])
    registerTaskHandler('demo', async () => 'ok')

    expect(resumeInterrupted()).toEqual([])
  })

  it('gives up on a task that has exhausted its attempt budget', async () => {
    // Otherwise a deterministically broken task is retried on every launch,
    // forever, unattended.
    await seedStore([
      { id: 'a', status: 'running', attempts: DEFAULT_MAX_ATTEMPTS, maxAttempts: DEFAULT_MAX_ATTEMPTS }
    ])
    let called = false
    registerTaskHandler('demo', async () => {
      called = true
      return 'ok'
    })

    expect(resumeInterrupted()).toEqual([])
    expect(called).toBe(false)
    expect(getTask('a')?.status).toBe('failed')
    expect(getTask('a')?.error).toMatch(/Gave up after/)
  })

  it('leaves a task pending when its kind has no handler yet', async () => {
    await seedStore([{ id: 'a', kind: 'future-kind', status: 'queued' }])

    expect(resumeInterrupted()).toEqual([])
    // Not failed, not dropped — a later build that registers this kind can
    // still pick it up. Dropping it would silently lose the work.
    expect(getTask('a')?.status).toBe('queued')
  })

  it('resumes several interrupted tasks in one pass', async () => {
    await seedStore([
      { id: 'a', status: 'running' },
      { id: 'b', status: 'queued' },
      { id: 'c', status: 'done' }
    ])
    registerTaskHandler('demo', async () => 'ok')

    expect(resumeInterrupted().map((r) => r.id).sort()).toEqual(['a', 'b'])
  })
})

describe('cancelTask', () => {
  it('marks a queued task cancelled so it is not resumed later', async () => {
    await seedStore([{ id: 'a', status: 'queued' }])
    registerTaskHandler('demo', async () => 'ok')

    expect(cancelTask('a')).toBe(true)
    expect(getTask('a')?.status).toBe('cancelled')
    expect(resumeInterrupted()).toEqual([])
  })

  it('refuses to cancel an already-finished task', async () => {
    await seedStore([{ id: 'a', status: 'done' }])
    expect(cancelTask('a')).toBe(false)
    expect(getTask('a')?.status).toBe('done')
  })

  it('returns false for an unknown id', () => {
    expect(cancelTask('nope')).toBe(false)
  })

  it('records a handler cancelled via its abort signal as cancelled, not done', async () => {
    // A handler that returns promptly after abort must not look successful, or
    // resume would skip work that was actually cut short.
    registerTaskHandler('demo', async (_payload, signal) => {
      await new Promise((r) => setTimeout(r, 5))
      if (signal.aborted) return 'stopped early'
      return 'ok'
    })

    const promise = submitTask('demo', {}, { lane: 'browser' })
    const { cancelLane } = await import('./taskQueue')
    cancelLane('browser')
    await promise.catch(() => undefined)

    expect(listTasks()[0].status).toBe('cancelled')
  })
})

describe('retryTask', () => {
  it('re-runs a failed task and clears its previous error', async () => {
    let attempt = 0
    registerTaskHandler('demo', async () => {
      attempt++
      if (attempt === 1) throw new Error('transient')
      return 'ok on retry'
    })

    await submitTask('demo', {}).catch(() => undefined)
    const id = listTasks()[0].id
    expect(getTask(id)?.status).toBe('failed')

    await expect(retryTask(id)).resolves.toBe('ok on retry')
    expect(getTask(id)?.status).toBe('done')
    expect(getTask(id)?.error).toBeUndefined()
  })

  it('refuses to retry a task that is already queued or running', async () => {
    await seedStore([{ id: 'a', status: 'queued' }])
    await expect(retryTask('a')).rejects.toThrow(/already queued/)
  })

  it('rejects an unknown id', async () => {
    await expect(retryTask('nope')).rejects.toThrow(/No task with id/)
  })
})

describe('store robustness', () => {
  it('starts clean when the store file is corrupt', async () => {
    await writeFile(storePath(), 'not json at all', 'utf8')
    setTaskStoreDirForTests(dir)
    expect(listTasks()).toEqual([])
  })

  it('drops malformed records rather than feeding them to the scheduler', async () => {
    // The store is a plain file anything on the machine can edit.
    await writeFile(
      storePath(),
      JSON.stringify([
        { id: 'good', kind: 'demo', lane: 'coding', label: 'l', status: 'queued', attempts: 0, maxAttempts: 3, createdAt: 1, updatedAt: 1 },
        { id: 'bad-no-kind', status: 'queued' },
        { status: 'not-a-real-status', id: 'x', kind: 'demo', lane: 'coding', label: 'l', attempts: 0, maxAttempts: 3 },
        'not even an object'
      ]),
      'utf8'
    )
    setTaskStoreDirForTests(dir)

    expect(listTasks().map((r) => r.id)).toEqual(['good'])
  })

  it('lists tasks newest first and filters by status', async () => {
    await seedStore([
      { id: 'old', status: 'done', createdAt: 1_000 },
      { id: 'new', status: 'queued', createdAt: 2_000 }
    ])

    expect(listTasks().map((r) => r.id)).toEqual(['new', 'old'])
    expect(listTasks('done').map((r) => r.id)).toEqual(['old'])
  })
})
