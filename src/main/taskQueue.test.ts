import { describe, it, expect, vi, beforeEach } from 'vitest'

// taskQueue journals through runLog, which lazily requires `electron` only when
// the default log dir is resolved; point it at a temp dir instead so the module
// graph loads (and writes) fine in the plain-node vitest environment.
vi.mock('electron', () => ({
  app: { getPath: () => process.cwd() }
}))

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setRunLogDirForTests } from './runLog'
import { enqueue, cancelLane, getQueueStats, resetQueueForTests } from './taskQueue'

setRunLogDirForTests(mkdtempSync(join(tmpdir(), 'openui-runlog-')))

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  resetQueueForTests()
})

describe('taskQueue — lane concurrency', () => {
  it('runs at most one coding job at a time, in order', async () => {
    const order: string[] = []
    let releaseFirst: () => void = () => {}
    const firstGate = new Promise<void>((r) => (releaseFirst = r))

    const a = enqueue('coding', 'a', async () => {
      order.push('a-start')
      await firstGate
      order.push('a-end')
    })
    const b = enqueue('coding', 'b', async () => {
      order.push('b-start')
    })

    await tick()
    expect(order).toEqual(['a-start']) // b must wait for the lane
    expect(getQueueStats().coding).toEqual({ active: 1, waiting: 1 })

    releaseFirst()
    await Promise.all([a, b])
    expect(order).toEqual(['a-start', 'a-end', 'b-start'])
  })

  it('lets the chat lane run two jobs concurrently', async () => {
    let running = 0
    let peak = 0
    const gates: (() => void)[] = []
    const job = (): Promise<void> =>
      new Promise<void>((release) => {
        running++
        peak = Math.max(peak, running)
        gates.push(() => {
          running--
          release()
        })
      })

    const jobs = [
      enqueue('chat', '1', job),
      enqueue('chat', '2', job),
      enqueue('chat', '3', job)
    ]
    await tick()
    expect(peak).toBe(2) // third job queued behind the cap
    gates.forEach((g) => g())
    await tick()
    gates.forEach((g) => g())
    await Promise.all(jobs)
    expect(peak).toBe(2)
  })

  it('runs higher-priority jobs first within a lane', async () => {
    const order: string[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))

    // Occupy the lane, then queue low before high — high must still run first.
    const blocker = enqueue('coding', 'blocker', () => gate)
    const low = enqueue('coding', 'low', async () => {
      order.push('low')
    })
    const high = enqueue('coding', 'high', async () => {
      order.push('high')
    }, { priority: 5 })

    release()
    await Promise.all([blocker, low, high])
    expect(order).toEqual(['high', 'low'])
  })

  it('propagates job failures to the caller without breaking the lane', async () => {
    await expect(
      enqueue('coding', 'boom', async () => {
        throw new Error('kaput')
      })
    ).rejects.toThrow('kaput')
    // Lane still works afterwards.
    await expect(enqueue('coding', 'next', async () => 42)).resolves.toBe(42)
  })

  it('runs coding-worker jobs concurrently, unlike the single coding lane', async () => {
    // §3: parallel sub-agents each run in an isolated worktree, so this lane's cap
    // is >1. Two jobs held open must overlap (peak ≥ 2) where the `coding` lane
    // would serialise them.
    let running = 0
    let peak = 0
    const gates: (() => void)[] = []
    const job = (): Promise<void> =>
      new Promise<void>((release) => {
        running++
        peak = Math.max(peak, running)
        gates.push(() => {
          running--
          release()
        })
      })

    const jobs = [enqueue('coding-worker', 'w1', job), enqueue('coding-worker', 'w2', job)]
    await tick()
    expect(peak).toBeGreaterThanOrEqual(2)
    expect(getQueueStats()['coding-worker'].active).toBeGreaterThanOrEqual(2)
    gates.forEach((g) => g())
    await Promise.all(jobs)
  })

  it('cancelLane rejects waiting jobs and aborts running ones', async () => {
    let sawAbort = false
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))

    const running = enqueue('browser', 'running', async (signal) => {
      signal.addEventListener('abort', () => (sawAbort = true))
      await gate
      return 'finished'
    })
    const waiting = enqueue('browser', 'waiting', async () => 'never')

    await tick()
    cancelLane('browser')
    await expect(waiting).rejects.toThrow(/cancelled before it started/)
    expect(sawAbort).toBe(true)

    // Cooperative model: the running job finishes at its own pace.
    release()
    await expect(running).resolves.toBe('finished')
  })
})
