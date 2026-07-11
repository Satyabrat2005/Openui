import { describe, it, expect, beforeEach, vi } from 'vitest'

// planner.ts's only runtime dependency is './agent' (callModel + extractFirstJsonObject).
// Mock it so decomposeCodingTask is deterministic and no model/electron loads. The
// stub extractFirstJsonObject mirrors the real "first {...} object" behaviour, which
// is all these tests exercise (the scripted model returns clean JSON).
const callModelMock = vi.fn()
vi.mock('./agent', () => ({
  callModel: (...args: unknown[]) => callModelMock(...args),
  extractFirstJsonObject: (s: string): string | null => {
    const a = s.indexOf('{')
    const b = s.lastIndexOf('}')
    return a >= 0 && b > a ? s.slice(a, b + 1) : null
  }
}))

import { isLargeTask, computeTurnBudget, decomposeCodingTask } from './planner'

const win = {} as never
const tier = 'free' as never

describe('isLargeTask', () => {
  it('flags a task that enumerates several deliverables', () => {
    const description = ['- add login form', '- wire the API', '* handle errors', '4) write tests'].join(
      '\n'
    )
    expect(isLargeTask({ title: 'Build auth', description })).toBe(true)
  })

  it('flags a long task that uses breadth language', () => {
    const description = 'We should refactor the data layer across all modules. '.repeat(20)
    expect(isLargeTask({ title: 'Refactor', description })).toBe(true)
  })

  it('leaves a short, focused task alone', () => {
    expect(isLargeTask({ title: 'Fix the typo in the header', description: 'It says Wecome.' })).toBe(
      false
    )
  })

  it('does not treat two bullets as large', () => {
    expect(isLargeTask({ title: 'Small', description: '- one\n- two' })).toBe(false)
  })
})

describe('computeTurnBudget', () => {
  it('gives a plain task exactly the floor budget', () => {
    expect(computeTurnBudget({ title: 'Fix bug', description: 'the button is off-centre' })).toBe(20)
  })

  it('grows with enumerated steps and caps at the ceiling', () => {
    const three = '- a\n- b\n- c'
    expect(computeTurnBudget({ title: 't', description: three })).toBe(20 + 3 * 5)
    const many = Array.from({ length: 20 }, (_, i) => `- step ${i}`).join('\n')
    expect(computeTurnBudget({ title: 't', description: many })).toBe(48)
  })

  it('honours an explicit sub-task count when larger than the bullet estimate', () => {
    expect(computeTurnBudget({ title: 't', description: 'no bullets here' }, 4)).toBe(20 + 4 * 5)
  })
})

describe('decomposeCodingTask', () => {
  beforeEach(() => callModelMock.mockReset())

  it('parses and normalises a valid decomposition', async () => {
    callModelMock.mockResolvedValueOnce(
      JSON.stringify({
        subtasks: [
          { id: 's1', title: 'API', instruction: 'build the API', files: ['src/api.ts'] },
          { title: 'UI', instruction: 'build the UI', files: ['src/ui.tsx'], dependsOn: ['s1'] }
        ]
      })
    )
    const out = await decomposeCodingTask(win, tier, { title: 'Feature', description: 'x' })
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ id: 's1', title: 'API', files: ['src/api.ts'], dependsOn: [] })
    // Missing id is synthesised; dependsOn is preserved when it points at a real id.
    expect(out[1]).toMatchObject({ id: 's2', dependsOn: ['s1'] })
  })

  it('drops dependencies that point at unknown ids', async () => {
    callModelMock.mockResolvedValueOnce(
      JSON.stringify({
        subtasks: [
          { id: 'a', title: 'A', instruction: 'do a', dependsOn: ['ghost'] },
          { id: 'b', title: 'B', instruction: 'do b', dependsOn: ['a'] }
        ]
      })
    )
    const out = await decomposeCodingTask(win, tier, { title: 't' })
    expect(out.find((s) => s.id === 'a')?.dependsOn).toEqual([])
    expect(out.find((s) => s.id === 'b')?.dependsOn).toEqual(['a'])
  })

  it('returns [] when the model produces fewer than two usable sub-tasks', async () => {
    callModelMock.mockResolvedValueOnce(
      JSON.stringify({ subtasks: [{ id: 's1', title: 'only', instruction: 'just one' }] })
    )
    expect(await decomposeCodingTask(win, tier, { title: 't' })).toEqual([])
  })

  it('degrades to [] on non-JSON output rather than throwing', async () => {
    callModelMock.mockResolvedValueOnce('I cannot split this task, sorry.')
    expect(await decomposeCodingTask(win, tier, { title: 't' })).toEqual([])
  })

  it('degrades to [] when the model call throws', async () => {
    callModelMock.mockRejectedValueOnce(new Error('ollama down'))
    expect(await decomposeCodingTask(win, tier, { title: 't' })).toEqual([])
  })

  it('skips entries missing an instruction', async () => {
    callModelMock.mockResolvedValueOnce(
      JSON.stringify({
        subtasks: [
          { id: 's1', title: 'ok', instruction: 'real work' },
          { id: 's2', title: 'bad' },
          { id: 's3', title: 'ok2', instruction: 'more work' }
        ]
      })
    )
    const out = await decomposeCodingTask(win, tier, { title: 't' })
    expect(out.map((s) => s.id)).toEqual(['s1', 's3'])
  })
})
