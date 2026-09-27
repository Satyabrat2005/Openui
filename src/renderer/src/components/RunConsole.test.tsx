// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import type { TaskCard, HitlRequestPayload } from '../env'

// RunConsole is the Splen home screen: sidebar, greeting, character, composer.
// These tests exercise the component with real renders and real key presses,
// with the data sources and child modals mocked at the boundary.

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
    resumeConversation: vi.fn(),
    // Event subscriptions return their own unsubscribe function, so the mock has
    // to as well or React's cleanup throws. onChatModel feeds the model chip
    // (which no longer hardcodes a model name); onModelPull feeds the first-run
    // download progress bar.
    onChatModel: vi.fn(() => vi.fn()),
    onModelPull: vi.fn(() => vi.fn())
  }
  // Force the wide layout so the inspector is open by default (TOUCHED test).
  Object.defineProperty(window, 'innerWidth', { value: 1400, configurable: true })
})
afterEach(cleanup)

describe("RunConsole — Splen home screen (the owner's design, nothing extra)", () => {
  it('shows the sidebar, greeting, sleeping character and composer — and nothing else', () => {
    render(<RunConsole />)
    expect(screen.getByText('Splen')).toBeTruthy()
    expect(screen.getByRole('button', { name: /New run/ })).toBeTruthy()
    for (const ch of ['Channels', 'WhatsApp', 'Telegram', 'Slack', 'Gmail', 'Settings']) expect(screen.getByText(ch)).toBeTruthy()
    expect(screen.getByText('Your wish is my command!')).toBeTruthy()
    expect(document.querySelector('.ou-sp-buddy')?.getAttribute('data-pose')).toBe('sleep')
    expect(screen.getByRole('radio', { name: 'Answer' })).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'Act' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy()
  })

  it('adds no ledger, inspector or run list even when runs exist', () => {
    activity.tasks = [card({ id: 'x', title: 'Summarize my inbox', status: 'in_progress', queue: 'active' })]
    render(<RunConsole />)
    expect(document.querySelector('.ou-rc-ledger')).toBeNull()
    expect(document.querySelector('.ou-rc-inspector')).toBeNull()
    expect(screen.queryByText('Run ledger')).toBeNull()
  })

  it('Enter sends through the same chat pipeline; Shift+Enter does not', () => {
    render(<RunConsole />)
    const box = screen.getByLabelText('Describe a task or ask a question')
    fireEvent.change(box, { target: { value: 'Summarize my inbox' } })
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true })
    expect(activity.beginTask).not.toHaveBeenCalled()
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(activity.beginTask).toHaveBeenCalledWith('Summarize my inbox', 'chat')
    const api = (window as unknown as { openui: Record<string, ReturnType<typeof vi.fn>> }).openui
    expect(api.chat).toHaveBeenCalledWith('Summarize my inbox', 'free')
  })

  it('the character switches pose while a run is in progress', () => {
    activity.tasks = [card({ id: 'x', title: 'build me a website', status: 'in_progress', queue: 'active' })]
    render(<RunConsole />)
    expect(document.querySelector('.ou-sp-buddy')?.getAttribute('data-pose')).toBe('code')
  })

  it("shows the latest run's answer under the composer", () => {
    activity.tasks = [
      card({ id: 'old', title: 'first', status: 'done', answer: 'old answer', endedAt: 1 }),
      card({ id: 'new', title: 'second', status: 'done', answer: 'Three things happened today.', endedAt: 2 })
    ]
    render(<RunConsole />)
    expect(screen.getByTestId('latest-answer').textContent).toBe('Three things happened today.')
    expect(screen.queryByText('old answer')).toBeNull()
  })
})

// Safety: with no inline approval surface, EVERY confirmation must go to App's
// blocking modal. RunConsole therefore always reports "not shown inline".
describe('RunConsole — approvals always use the modal', () => {
  it('reports onApprovalInline(false) even while a run waits on an approval', () => {
    activity.tasks = [card({ id: 'w', title: 'Send it', status: 'in_progress', queue: 'waiting' })]
    const onApprovalInline = vi.fn()
    const hitlRequest: HitlRequestPayload = { id: 'h', tool: 'send_whatsapp_message', args: {}, label: 'Send WhatsApp message to Mom' }
    render(<RunConsole hitlRequest={hitlRequest} onApprovalInline={onApprovalInline} onRespondHitl={vi.fn()} />)
    expect(onApprovalInline).toHaveBeenCalledWith(false)
    expect(onApprovalInline).not.toHaveBeenCalledWith(true)
    expect(screen.queryByText('Approve this action')).toBeNull()
  })
})

describe('RunConsole — first-run model download', () => {
  // The subscription callback is invoked from outside React, so it must be
  // wrapped in act() or the resulting setState never flushes to the DOM.
  function fire<T>(name: string, payload: T): void {
    const api = (window as unknown as { openui: Record<string, ReturnType<typeof vi.fn>> }).openui
    const cb = api[name].mock.calls[0][0] as (p: T) => void
    act(() => cb(payload))
  }

  it('shows no download bar when nothing is downloading', () => {
    render(<RunConsole />)
    expect(document.querySelector('[data-testid="model-pull"]')).toBeNull()
  })

  it('renders real percentage and byte progress', () => {
    render(<RunConsole />)
    fire('onModelPull', {
      model: 'qwen2.5-coder:7b',
      status: 'pulling abc123',
      percent: 42,
      completed: 2_000_000_000,
      total: 4_700_000_000,
      layer: 'abc123456789',
      done: false
    })
    const bar = document.querySelector('[data-testid="model-pull"]') as HTMLElement
    expect(bar).toBeTruthy()
    expect(bar.textContent).toContain('Downloading Qwen 2.5 Coder 7B')
    expect(bar.textContent).toContain('42%')
    expect(bar.textContent).toContain('1.9 GB')
    expect(bar.textContent).toContain('4.4 GB')
    const fill = bar.querySelector('.ou-sp-pull-fill') as HTMLElement
    expect(fill.style.width).toBe('42%')
  })

  // A 0%-width bar is what made this look frozen. Phases with no byte counts
  // must show their status text and an indeterminate fill instead.
  it('shows the phase text, not a 0% bar, when there are no byte counts', () => {
    render(<RunConsole />)
    fire('onModelPull', {
      model: 'qwen3.5:latest',
      status: 'pulling manifest',
      percent: null,
      completed: null,
      total: null,
      layer: null,
      done: false
    })
    const bar = document.querySelector('[data-testid="model-pull"]') as HTMLElement
    expect(bar.textContent).toContain('pulling manifest')
    expect(bar.textContent).not.toContain('0%')
    expect(bar.querySelector('.ou-sp-pull-fill.idle')).toBeTruthy()
  })

  it('surfaces a download failure instead of silently clearing', () => {
    render(<RunConsole />)
    fire('onModelPull', {
      model: 'bad:7b',
      status: 'error',
      percent: null,
      completed: null,
      total: null,
      layer: null,
      done: false,
      error: 'file does not exist'
    })
    const bar = document.querySelector('[data-testid="model-pull"]') as HTMLElement
    expect(bar.textContent).toContain('file does not exist')
  })
})
