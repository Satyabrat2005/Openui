import { describe, it, expect, beforeEach, vi } from 'vitest'

// codingSubagents.ts orchestrates the model + git + coding tools. Mock all of
// those boundaries so the SCHEDULING and MERGE-COORDINATION logic is tested
// deterministically, with no real model, git, or filesystem. scheduleLayers is
// pure and needs none of it.
const h = vi.hoisted(() => ({
  callModel: vi.fn(async () => 'All done — verifier is green.'),
  parseToolCall: vi.fn(() => null as unknown),
  executeCodingTool: vi.fn(async () => ({ ok: true, output: 'ok' })),
  verify: { isVerified: true, decision: 'accept' as string },
  sandbox: {
    currentCommit: vi.fn(async () => 'basecommit' as string | null),
    commitCheckpoint: vi.fn(async () => 'sha' as string | null),
    addWorktree: vi.fn(async (name: string) => ({
      name,
      branch: `openui/${name}`,
      path: `/wt/${name}`
    })),
    removeWorktree: vi.fn(async () => {}),
    mergeWorktreeBranch: vi.fn(async () => ({ passed: true, output: 'merged' })),
    abortMerge: vi.fn(async () => true),
    runInWorkspace: vi.fn(async (_dir: string, fn: () => Promise<unknown>) => fn())
  }
}))

vi.mock('./agent', () => ({
  callModel: h.callModel,
  parseToolCall: h.parseToolCall,
  StreamGate: class {
    constructor(_cb: unknown) {}
    push = (): void => {}
    finalize(): void {}
  }
}))
vi.mock('./codingTools', () => ({ executeCodingTool: h.executeCodingTool }))
vi.mock('./verifyGate', () => ({
  VerifyGate: class {
    get isVerified(): boolean {
      return h.verify.isVerified
    }
    onFinalReply(): string {
      return h.verify.decision
    }
    observe(): void {}
    nudgeMessage(): string {
      return 'please verify'
    }
    // A challenged GIVE UP gets a different pushback — these tests drive the
    // decision directly via h.verify.decision, so the double just needs to
    // answer "no challenge" rather than model the real rule.
    giveUpChallenge(): string | null {
      return null
    }
    giveUpMessage(): string {
      return 'it already passed'
    }
    nudgeLabel = 'verify'
  }
}))
vi.mock('./sandbox', () => h.sandbox)

import { scheduleLayers, runParallelCodingSubagents } from './codingSubagents'
import type { SubTask } from './planner'

const st = (id: string, dependsOn: string[] = [], files: string[] = []): SubTask => ({
  id,
  title: id.toUpperCase(),
  instruction: `do ${id}`,
  files,
  dependsOn
})

const win = {} as never
const tier = 'free' as never
const profile = {
  promptAddendum: '',
  taskHint: 'hint',
  verifiers: ['run_tests'],
  verdict: () => 'pass'
} as never

let runLog: { event: ReturnType<typeof vi.fn> }

beforeEach(() => {
  vi.clearAllMocks()
  h.callModel.mockImplementation(async () => 'All done — verifier is green.')
  h.parseToolCall.mockImplementation(() => null)
  h.executeCodingTool.mockImplementation(async () => ({ ok: true, output: 'ok' }))
  h.sandbox.currentCommit.mockImplementation(async () => 'basecommit')
  h.sandbox.commitCheckpoint.mockImplementation(async () => 'sha')
  h.sandbox.addWorktree.mockImplementation(async (name: string) => ({
    name,
    branch: `openui/${name}`,
    path: `/wt/${name}`
  }))
  h.sandbox.removeWorktree.mockImplementation(async () => {})
  h.sandbox.mergeWorktreeBranch.mockImplementation(async () => ({ passed: true, output: 'merged' }))
  h.sandbox.abortMerge.mockImplementation(async () => true)
  h.sandbox.runInWorkspace.mockImplementation(async (_dir: string, fn: () => Promise<unknown>) => fn())
  h.verify.isVerified = true
  h.verify.decision = 'accept'
  runLog = { event: vi.fn() }
})

describe('scheduleLayers', () => {
  it('puts fully independent sub-tasks in a single parallel layer', () => {
    const layers = scheduleLayers([st('a'), st('b'), st('c')])
    expect(layers).toHaveLength(1)
    expect(layers[0].map((s) => s.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('orders a linear dependency chain into successive layers', () => {
    const layers = scheduleLayers([st('c', ['b']), st('b', ['a']), st('a')])
    expect(layers.map((l) => l.map((s) => s.id))).toEqual([['a'], ['b'], ['c']])
  })

  it('parallelises the middle of a diamond', () => {
    // a → {b, c} → d
    const layers = scheduleLayers([st('a'), st('b', ['a']), st('c', ['a']), st('d', ['b', 'c'])])
    expect(layers[0].map((s) => s.id)).toEqual(['a'])
    expect(layers[1].map((s) => s.id).sort()).toEqual(['b', 'c'])
    expect(layers[2].map((s) => s.id)).toEqual(['d'])
  })

  it('does not deadlock on a dependency cycle — the tangle runs as a final layer', () => {
    const layers = scheduleLayers([st('a', ['b']), st('b', ['a'])])
    expect(layers).toHaveLength(1)
    expect(layers[0].map((s) => s.id).sort()).toEqual(['a', 'b'])
  })
})

describe('runParallelCodingSubagents', () => {
  it('runs independent sub-tasks in isolated worktrees and merges each back', async () => {
    const res = await runParallelCodingSubagents(win, tier, [st('s1'), st('s2')], profile, runLog as never)

    expect(res.anyRan).toBe(true)
    expect(res.allMerged).toBe(true)
    expect(res.outcomes).toHaveLength(2)
    expect(res.outcomes.every((o) => o.merged && o.success)).toBe(true)

    expect(h.sandbox.addWorktree).toHaveBeenCalledTimes(2)
    expect(h.sandbox.runInWorkspace).toHaveBeenCalledTimes(2)
    expect(h.sandbox.mergeWorktreeBranch).toHaveBeenCalledTimes(2)
    // Every worktree is cleaned up, whatever happened.
    expect(h.sandbox.removeWorktree).toHaveBeenCalledTimes(2)
    expect(runLog.event).toHaveBeenCalledWith('subtask_merged', expect.objectContaining({ subtask: 's1' }))
  })

  it('aborts and reports a conflicting merge instead of leaving the tree dirty', async () => {
    h.sandbox.mergeWorktreeBranch.mockImplementation(async () => ({
      passed: false,
      output: 'CONFLICT (content): Merge conflict in src/a.ts'
    }))

    const res = await runParallelCodingSubagents(win, tier, [st('s1')], profile, runLog as never)

    // A single sub-task never satisfies the ">=2 valid" contract upstream, but the
    // coordinator still handles it; the merge conflict is aborted and surfaced.
    expect(h.sandbox.abortMerge).toHaveBeenCalledTimes(1)
    expect(res.outcomes[0].merged).toBe(false)
    expect(res.allMerged).toBe(false)
    expect(runLog.event).toHaveBeenCalledWith('merge_conflict', expect.objectContaining({ subtask: 's1' }))
  })

  it('does not merge a worker whose verifier never went green', async () => {
    h.verify.isVerified = false

    const res = await runParallelCodingSubagents(win, tier, [st('s1'), st('s2')], profile, runLog as never)

    expect(res.outcomes.every((o) => !o.success)).toBe(true)
    expect(h.sandbox.mergeWorktreeBranch).not.toHaveBeenCalled()
    expect(res.allMerged).toBe(false)
    // Worktrees are still torn down even when the work failed.
    expect(h.sandbox.removeWorktree).toHaveBeenCalledTimes(2)
    expect(runLog.event).toHaveBeenCalledWith('subtask_failed', expect.objectContaining({ subtask: 's1' }))
  })

  it('reports anyRan:false when the workspace cannot become a git repo', async () => {
    h.sandbox.currentCommit.mockImplementation(async () => null)
    h.sandbox.commitCheckpoint.mockImplementation(async () => null)

    const res = await runParallelCodingSubagents(win, tier, [st('s1'), st('s2')], profile, runLog as never)

    expect(res.anyRan).toBe(false)
    expect(res.outcomes).toEqual([])
    expect(h.sandbox.addWorktree).not.toHaveBeenCalled()
  })

  it('respects dependencies: a dependent sub-task runs after its prerequisite', async () => {
    const order: string[] = []
    h.sandbox.addWorktree.mockImplementation(async (name: string) => {
      order.push(name)
      return { name, branch: `openui/${name}`, path: `/wt/${name}` }
    })

    await runParallelCodingSubagents(win, tier, [st('b', ['a']), st('a')], profile, runLog as never)

    // 'a' must be dispatched before 'b'.
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'))
  })
})
