import { describe, it, expect } from 'vitest'
import {
  queueOf,
  deriveCounts,
  statusToken,
  resolveInspectorOpen,
  inlineApprovalVisible,
  connectedScope
} from './runQueue'
import type { TaskCard } from '../env'

/** Minimal card factory — only the fields the derivations read. */
function card(p: Partial<TaskCard>): TaskCard {
  return {
    id: p.id ?? 'c',
    title: p.title ?? 't',
    status: p.status ?? 'in_progress',
    kind: 'chat',
    steps: [],
    groups: [],
    startedAt: 0,
    ...p
  } as TaskCard
}

describe('queueOf', () => {
  it('prefers the explicit queue field', () => {
    expect(queueOf(card({ queue: 'waiting', status: 'in_progress' }))).toBe('waiting')
    expect(queueOf(card({ queue: 'done', status: 'in_progress' }))).toBe('done')
  })
  it('falls back to status for cards with no queue field', () => {
    expect(queueOf(card({ status: 'in_progress' }))).toBe('active')
    expect(queueOf(card({ status: 'done' }))).toBe('done')
    expect(queueOf(card({ status: 'failed' }))).toBe('done')
  })
})

describe('deriveCounts', () => {
  it('counts running, waiting and finished from the queue model', () => {
    const tasks = [
      card({ id: '1', status: 'in_progress', queue: 'active' }),
      card({ id: '2', status: 'in_progress', queue: 'active' }),
      card({ id: '3', status: 'in_progress', queue: 'waiting' }), // paused on approval
      card({ id: '4', status: 'done', queue: 'done' }),
      card({ id: '5', status: 'failed' })
    ]
    expect(deriveCounts(tasks)).toEqual({ running: 2, waiting: 1, finished: 2 })
  })
  it('a waiting run is never also counted as running', () => {
    const tasks = [card({ status: 'in_progress', queue: 'waiting' })]
    expect(deriveCounts(tasks)).toEqual({ running: 0, waiting: 1, finished: 0 })
  })
  it('is empty-safe', () => {
    expect(deriveCounts([])).toEqual({ running: 0, waiting: 0, finished: 0 })
  })
})

describe('statusToken', () => {
  it('maps queue/status to the run-row pill', () => {
    expect(statusToken(card({ queue: 'waiting', status: 'in_progress' }))).toEqual({ label: 'NEEDS YOU', cls: 'waiting' })
    expect(statusToken(card({ status: 'in_progress', queue: 'active' }))).toEqual({ label: 'RUNNING', cls: 'running' })
    expect(statusToken(card({ status: 'failed', queue: 'done' }))).toEqual({ label: 'FAILED', cls: 'failed' })
    expect(statusToken(card({ status: 'done', queue: 'done' }))).toEqual({ label: 'FINISHED', cls: 'finished' })
  })
})

describe('resolveInspectorOpen — auto-collapse, manual wins', () => {
  it('follows the responsive default when there is no manual override', () => {
    expect(resolveInspectorOpen(null, false)).toBe(true) // wide → open
    expect(resolveInspectorOpen(null, true)).toBe(false) // narrow → collapsed
  })
  it('lets a manual choice override the responsive value in BOTH directions', () => {
    // Manually opened while narrow — a later resize must not clobber it.
    expect(resolveInspectorOpen(true, true)).toBe(true)
    // Manually closed while wide.
    expect(resolveInspectorOpen(false, false)).toBe(false)
  })
})

describe('inlineApprovalVisible — inline vs modal reconciliation', () => {
  it('shows inline only when a request exists AND its run is visible', () => {
    expect(inlineApprovalVisible(true, 'r1', ['r1', 'r2'])).toBe(true)
  })
  it('falls back to the modal when the target run is filtered out of view', () => {
    expect(inlineApprovalVisible(true, 'r1', ['r2', 'r3'])).toBe(false)
  })
  it('shows nothing inline when there is no request', () => {
    expect(inlineApprovalVisible(false, 'r1', ['r1'])).toBe(false)
  })
  it('handles a missing target id', () => {
    expect(inlineApprovalVisible(true, null, ['r1'])).toBe(false)
    expect(inlineApprovalVisible(true, undefined, ['r1'])).toBe(false)
  })
})

describe('connectedScope — scope-pill / CONNECTED population', () => {
  const apps = [
    { id: 'browser', state: 'connected' },
    { id: 'whatsapp', state: 'connected' },
    { id: 'slack', state: 'disconnected' },
    { id: 'telegram', state: 'error' },
    { id: 'custom', state: 'connecting' }
  ]
  it('includes only apps that are actually connected', () => {
    expect(connectedScope(apps).map((a) => a.id)).toEqual(['browser', 'whatsapp'])
  })
  it('never fabricates connections — an all-disconnected store yields no pills', () => {
    expect(connectedScope(apps.map((a) => ({ ...a, state: 'disconnected' })))).toEqual([])
  })
  it('is empty-safe', () => {
    expect(connectedScope([])).toEqual([])
  })
})
