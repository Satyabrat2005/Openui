import { describe, it, expect } from 'vitest'
import { withOllamaLock } from './ollamaLock'

/** Resolves a promise together with its resolver so tests can gate completion. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('withOllamaLock', () => {
  it('runs at most one call at a time', async () => {
    let active = 0
    let maxActive = 0

    const task = () =>
      withOllamaLock(async () => {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise((r) => setTimeout(r, 5))
        active--
        return active
      })

    // Fire five concurrently; the lock must serialize them.
    await Promise.all([task(), task(), task(), task(), task()])
    expect(maxActive).toBe(1)
  })

  it('preserves submission order (FIFO)', async () => {
    const order: number[] = []
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()]

    const runs = gates.map((g, i) =>
      withOllamaLock(async () => {
        await g.promise
        order.push(i)
      })
    )

    // Release out of order; the queue should still complete in submission order.
    gates[0].resolve()
    gates[1].resolve()
    gates[2].resolve()
    await Promise.all(runs)
    expect(order).toEqual([0, 1, 2])
  })

  it('a rejected call does not poison the queue', async () => {
    const failing = withOllamaLock(async () => {
      throw new Error('boom')
    })
    await expect(failing).rejects.toThrow('boom')

    // The next call must still run and resolve normally.
    const recovered = await withOllamaLock(async () => 'ok')
    expect(recovered).toBe('ok')
  })

  it('runs a call queued after the failing one has already settled', async () => {
    await withOllamaLock(async () => {
      throw new Error('first fails')
    }).catch(() => {})

    const result = await withOllamaLock(async () => 42)
    expect(result).toBe(42)
  })
})
