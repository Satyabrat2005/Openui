// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import type { TaskCard, TouchedResource, HitlRequestPayload, PlanRequestPayload } from '../env'

// RunConsole owns the highest-stakes glue of the redesign: queue bucketing in the
// ledger, the approval callout (HITL vs plan copy + which handler fires), and the
// TOUCHED audit list. Its pure derivations live in lib/runQueue (already tested);
// these tests exercise the COMPONENT behaviour on top of that — real render +
// real clicks — with the data sources and child modals mocked at the boundary.

// ── Controllable task-activity state (the ledger's data source) ────────────────
const activity: {
  tasks: TaskCard[]
  focusedId: string | null
  runningCount: number
  waitingCount: number
  beginTask: ReturnType<typeof vi.fn>
  focusTask: ReturnType<typeof vi.fn>
} = {
  tasks: [],
  focusedId: null,
  runningCount: 0,
  waitingCount: 0,
  beginTask: vi.fn(),
  focusTask: vi.fn()
}
vi.mock('../context/TaskActivityContext', () => ({
  useTaskActivity: () => activity
}))
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ tier: 'free', user: { name: 'Rin', email: 'rin@example.com' } })
}))
vi.mock('../hooks/useUpdater', () => ({
  useUpdater: () => ({ updateState: { status: 'idle' }, appVersion: '1.0.0', checkForUpdates: vi.fn() })
}))
// Child overlays never render in these tests (their show* state stays false), but
// ConnectAppsModal ALSO exports the connection store the sidebar reads on mount.
vi.mock('./ConnectAppsModal', () => ({
  default: () => null,
  getConnections: () => [],
  subscribeConnections: () => () => {}
}))
vi.mock('./SettingsModal', () => ({ default: () => null }))
vi.mock('./ConversationList', () => ({ default: () => null }))
vi.mock('./WorkflowsUI', () => ({ default: () => null }))

import RunConsole from './RunConsole'

function card(p: Partial<TaskCard>): TaskCard {
  return {
    id: p.id ?? 'c',
    title: p.title ?? 'Task',
    status: p.status ?? 'in_progress',
    kind: 'chat',
    steps: [],
    groups: [],
    startedAt: Date.now() - 5000,
    ...p
  } as TaskCard
}

// window.openui surface RunConsole touches on mount / interaction.
beforeEach(() => {
  activity.tasks = []
  activity.focusedId = null
  activity.runningCount = 0
  activity.waitingCount = 0
  activity.beginTask = vi.fn()
  activity.focusTask = vi.fn()
  ;(window as unknown as { openui: Record<string, unknown> }).openui = {
    listWorkflows: vi.fn(() => Promise.resolve([])),
    getSetting: vi.fn(() => Promise.resolve(undefined)),
    captureScreenThumbnail: vi.fn(() => Promise.resolve({ ok: false })),
    chat: vi.fn(() => Promise.resolve()),
    clearHistory: vi.fn(),
    resumeConversation: vi.fn()
  }
  // Force the wide layout so the inspector is open by default (TOUCHED test).
  Object.defineProperty(window, 'innerWidth', { value: 1400, configurable: true })
})
afterEach(cleanup)

describe('RunConsole — queue bucketing in the ledger', () => {
  it('the "Needs you" filter shows only runs awaiting an approval', () => {
    activity.tasks = [
      card({ id: 'r1', title: 'Running one', status: 'in_progress', queue: 'active' }),
      card({ id: 'r2', title: 'Waiting one', status: 'in_progress', queue: 'waiting' }),
      card({ id: 'r3', title: 'Finished one', status: 'done', queue: 'done' })
    ]
    render(<RunConsole />)

    // 'All' shows everything.
    const ledger = document.querySelector('.ou-rc-ledger') as HTMLElement
    expect(within(ledger).getByText('Running one')).toBeTruthy()
    expect(within(ledger).getByText('Waiting one')).toBeTruthy()
    expect(within(ledger).getByText('Finished one')).toBeTruthy()

    // Click the ledger's "Needs you" filter.
    fireEvent.click(within(ledger).getByRole('button', { name: 'Needs you' }))
    expect(within(ledger).getByText('Waiting one')).toBeTruthy()
    expect(within(ledger).queryByText('Running one')).toBeNull()
    expect(within(ledger).queryByText('Finished one')).toBeNull()
  })

  it('the "Running" filter excludes a run that is paused on an approval', () => {
    activity.tasks = [
      card({ id: 'r1', title: 'Truly running', status: 'in_progress', queue: 'active' }),
      card({ id: 'r2', title: 'Paused on approval', status: 'in_progress', queue: 'waiting' })
    ]
    render(<RunConsole />)
    const ledger = document.querySelector('.ou-rc-ledger') as HTMLElement
    fireEvent.click(within(ledger).getByRole('button', { name: 'Running' }))
    expect(within(ledger).getByText('Truly running')).toBeTruthy()
    // A waiting run is in_progress but must NOT show under Running.
    expect(within(ledger).queryByText('Paused on approval')).toBeNull()
  })

  it('the "Finished" filter shows completed and failed runs, not in-progress ones', () => {
    activity.tasks = [
      card({ id: 'r1', title: 'Still going', status: 'in_progress', queue: 'active' }),
      card({ id: 'r2', title: 'All done', status: 'done', queue: 'done' }),
      card({ id: 'r3', title: 'Broke', status: 'failed', queue: 'done' })
    ]
    render(<RunConsole />)
    const ledger = document.querySelector('.ou-rc-ledger') as HTMLElement
    fireEvent.click(within(ledger).getByRole('button', { name: 'Finished' }))
    expect(within(ledger).getByText('All done')).toBeTruthy()
    expect(within(ledger).getByText('Broke')).toBeTruthy()
    expect(within(ledger).queryByText('Still going')).toBeNull()
  })
})

describe('RunConsole — approval callout (HITL vs plan)', () => {
  const waitingRun = card({ id: 'w', title: 'Needs approval', status: 'in_progress', queue: 'waiting' })

  it('renders PLAN copy with the step count and calls onRespondPlan(true) on Approve', () => {
    activity.tasks = [waitingRun]
    const onRespondPlan = vi.fn()
    const onRespondHitl = vi.fn()
    const planRequest: PlanRequestPayload = {
      id: 'p1',
      summary: 'Book a table for two',
      steps: [{ id: 's1', title: 'a' }, { id: 's2', title: 'b' }, { id: 's3', title: 'c' }]
    }
    render(
      <RunConsole planRequest={planRequest} onRespondPlan={onRespondPlan} onRespondHitl={onRespondHitl} />
    )
    const callout = document.querySelector('.ou-rc-callout') as HTMLElement
    expect(callout).toBeTruthy()
    expect(within(callout).getByText('Approve the plan')).toBeTruthy()
    expect(within(callout).getByText(/Book a table for two \(3 steps\)/)).toBeTruthy()

    fireEvent.click(within(callout).getByRole('button', { name: 'Approve' }))
    expect(onRespondPlan).toHaveBeenCalledWith(true)
    expect(onRespondHitl).not.toHaveBeenCalled()
  })

  it('singularises a one-step plan', () => {
    activity.tasks = [waitingRun]
    const planRequest: PlanRequestPayload = { id: 'p', summary: 'One thing', steps: [{ id: 's', title: 'x' }] }
    render(<RunConsole planRequest={planRequest} onRespondPlan={vi.fn()} />)
    expect(screen.getByText(/One thing \(1 step\)/)).toBeTruthy()
  })

  it('renders HITL copy from the request label and calls onRespondHitl(false) on Deny', () => {
    activity.tasks = [waitingRun]
    const onRespondHitl = vi.fn()
    const onRespondPlan = vi.fn()
    const hitlRequest: HitlRequestPayload = {
      id: 'h1',
      tool: 'send_whatsapp_message',
      args: {},
      label: 'Send WhatsApp message to Mom'
    }
    render(
      <RunConsole hitlRequest={hitlRequest} onRespondHitl={onRespondHitl} onRespondPlan={onRespondPlan} />
    )
    const callout = document.querySelector('.ou-rc-callout') as HTMLElement
    expect(within(callout).getByText('Approve this action')).toBeTruthy()
    expect(within(callout).getByText('Send WhatsApp message to Mom')).toBeTruthy()

    fireEvent.click(within(callout).getByRole('button', { name: 'Deny' }))
    expect(onRespondHitl).toHaveBeenCalledWith(false)
    expect(onRespondPlan).not.toHaveBeenCalled()
  })

  it('plan takes precedence when both a plan and a hitl request are present', () => {
    activity.tasks = [waitingRun]
    const planRequest: PlanRequestPayload = { id: 'p', summary: 'Plan wins', steps: [{ id: 's', title: 'x' }] }
    const hitlRequest: HitlRequestPayload = { id: 'h', tool: 't', args: {}, label: 'hitl label' }
    render(<RunConsole planRequest={planRequest} hitlRequest={hitlRequest} onRespondPlan={vi.fn()} onRespondHitl={vi.fn()} />)
    expect(screen.getByText('Approve the plan')).toBeTruthy()
    expect(screen.queryByText('Approve this action')).toBeNull()
  })

  it('renders NO callout when there is a request but no run is waiting', () => {
    activity.tasks = [card({ id: 'a', title: 'Active', status: 'in_progress', queue: 'active' })]
    const planRequest: PlanRequestPayload = { id: 'p', summary: 's', steps: [{ id: 's', title: 'x' }] }
    render(<RunConsole planRequest={planRequest} onRespondPlan={vi.fn()} />)
    expect(document.querySelector('.ou-rc-callout')).toBeNull()
  })
})

describe('RunConsole — TOUCHED audit list in the inspector', () => {
  it('renders each touched resource with its operation label', () => {
    const touched: TouchedResource[] = [
      { app: 'whatsapp', resource: 'Mom', operation: 'POST' },
      { app: 'files', resource: '~/report.pdf', operation: 'READ' },
      { app: 'github', resource: 'openui#12', operation: 'HELD' }
    ]
    const run = card({ id: 'sel', title: 'Audited run', status: 'done', queue: 'done', touched })
    activity.tasks = [run]
    activity.focusedId = 'sel'
    render(<RunConsole />)

    const inspector = document.querySelector('.ou-rc-inspector') as HTMLElement
    expect(inspector).toBeTruthy()
    const rows = inspector.querySelectorAll('.ou-rc-touched')
    expect(rows.length).toBe(3)
    expect(within(inspector).getByText('Mom')).toBeTruthy()
    expect(within(inspector).getByText('~/report.pdf')).toBeTruthy()
    // Operation labels render verbatim from the enum.
    expect(within(inspector).getByText('POST')).toBeTruthy()
    expect(within(inspector).getByText('READ')).toBeTruthy()
    expect(within(inspector).getByText('HELD')).toBeTruthy()
  })

  it('shows the empty state when a run has touched nothing', () => {
    const run = card({ id: 'sel', title: 'Clean run', status: 'done', queue: 'done', touched: [] })
    activity.tasks = [run]
    activity.focusedId = 'sel'
    render(<RunConsole />)
    const inspector = document.querySelector('.ou-rc-inspector') as HTMLElement
    expect(within(inspector).getByText('Nothing touched yet.')).toBeTruthy()
    expect(inspector.querySelectorAll('.ou-rc-touched').length).toBe(0)
  })
})
