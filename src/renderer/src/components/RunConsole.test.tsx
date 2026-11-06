// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react'
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
// Recent chats: one saved chat, so a test can reopen it from the sidebar.
vi.mock('./ConversationList', () => ({
  default: ({ onSelect }: { onSelect: (id: string) => void }) => (
    <button type="button" onClick={() => onSelect('conv-1')}>Saved chat</button>
  )
}))
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
    expect(screen.getByRole('button', { name: /New chat/ })).toBeTruthy()
    expect(screen.getByText('Recent')).toBeTruthy()
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

})

describe('RunConsole — a chat thread, like any chat app', () => {
  const api = (): Record<string, ReturnType<typeof vi.fn>> =>
    (window as unknown as { openui: Record<string, ReturnType<typeof vi.fn>> }).openui

  it('keeps every message you sent and every answer, in order', () => {
    activity.tasks = [
      card({ id: 'a', title: 'summarise my unseen whatsapp texts', status: 'done', answer: 'You have 3 unread chats.', endedAt: 1 }),
      card({ id: 'b', title: 'and the one from Ashu?', status: 'done', answer: 'Ashu asked about Friday.', endedAt: 2 })
    ]
    render(<RunConsole />)
    const text = screen.getByTestId('thread').textContent ?? ''
    const order = ['summarise my unseen whatsapp texts', 'You have 3 unread chats.', 'and the one from Ashu?', 'Ashu asked about Friday.']
    let at = -1
    for (const piece of order) {
      const i = text.indexOf(piece)
      expect(i).toBeGreaterThan(at)
      at = i
    }
    expect(screen.getByTestId('latest-answer').textContent).toBe('Ashu asked about Friday.')
    // The composer stays, docked under the thread.
    expect(screen.getByLabelText('Describe a task or ask a question')).toBeTruthy()
  })

  it('your message shows at once, with a thinking line until the answer streams in', () => {
    activity.tasks = [card({ id: 'a', title: 'read my chat with Ashu', status: 'in_progress', steps: [] })]
    const { rerender } = render(<RunConsole />)
    expect(screen.getByText('read my chat with Ashu')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('Thinking…')

    activity.tasks = [card({ id: 'a', title: 'read my chat with Ashu', status: 'in_progress', steps: [{ id: 's', label: 'Reading WhatsApp', status: 'working' }] })]
    rerender(<RunConsole />)
    expect(screen.getByRole('status').textContent).toContain('Reading WhatsApp…')

    activity.tasks = [card({ id: 'a', title: 'read my chat with Ashu', status: 'in_progress', answer: 'Ashu says' })]
    rerender(<RunConsole />)
    expect(screen.getByTestId('latest-answer').textContent).toBe('Ashu says')
    expect(screen.getByTestId('latest-answer').className).toContain('streaming')
  })

  it('New chat starts an empty thread and clears the context', () => {
    activity.tasks = [card({ id: 'a', title: 'old question', status: 'done', answer: 'old answer' })]
    render(<RunConsole />)
    expect(screen.getByText('old answer')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /New chat/ }))
    expect(api().clearHistory).toHaveBeenCalled()
    expect(screen.queryByText('old answer')).toBeNull()
    expect(screen.getByText('Your wish is my command!')).toBeTruthy()
  })

  it('reopening a recent chat shows its saved messages and loads it as context', async () => {
    api().resumeConversation = vi.fn(() =>
      Promise.resolve([
        { role: 'user', content: 'what did mom say?', created_at: 1 },
        { role: 'tool', content: 'raw tool output', created_at: 2 },
        { role: 'assistant', content: 'Mom asked you to call her.', created_at: 3 }
      ])
    )
    render(<RunConsole />)
    fireEvent.click(screen.getByRole('button', { name: 'Saved chat' }))
    await waitFor(() => expect(screen.getByText('Mom asked you to call her.')).toBeTruthy())
    expect(api().resumeConversation).toHaveBeenCalledWith('conv-1')
    expect(screen.getByText('what did mom say?')).toBeTruthy()
    expect(screen.queryByText('raw tool output')).toBeNull()
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

describe('RunConsole — getting Splen onto the computer', () => {
  const api = (): Record<string, ReturnType<typeof vi.fn>> =>
    (window as unknown as { openui: Record<string, ReturnType<typeof vi.fn>> }).openui
  const SPLEN = 'openui/splen:4b'
  const row = (installed: boolean): unknown => ({
    id: SPLEN, label: 'Splen 4B', purpose: '', approxSize: 'about 2.8 GB', installed, downloading: false
  })
  // The subscription callback is invoked from outside React, so it must be
  // wrapped in act() or the resulting setState never flushes to the DOM.
  function fire<T>(name: string, payload: T): void {
    const cb = api()[name].mock.calls[0][0] as (p: T) => void
    act(() => cb(payload))
  }

  it('shows no strip once Splen is installed', async () => {
    api().listLocalModels = vi.fn(() => Promise.resolve([row(true)]))
    render(<RunConsole />)
    await waitFor(() => expect(api().listLocalModels).toHaveBeenCalled())
    expect(screen.queryByTestId('model-strip')).toBeNull()
  })

  it('shows no strip when the server does not offer Splen yet', async () => {
    api().listLocalModels = vi.fn(() => Promise.resolve([]))
    render(<RunConsole />)
    await waitFor(() => expect(api().listLocalModels).toHaveBeenCalled())
    expect(screen.queryByTestId('model-strip')).toBeNull()
  })

  it('offers the one download a new user needs, and starts it', async () => {
    api().listLocalModels = vi.fn(() => Promise.resolve([row(false)]))
    api().downloadModel = vi.fn(() => new Promise(() => {}))
    render(<RunConsole />)
    const strip = await screen.findByTestId('model-strip')
    expect(strip.textContent).toContain('Download Splen to get started')
    expect(strip.textContent).toContain('about 2.8 GB')
    fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    expect(api().downloadModel).toHaveBeenCalledWith(SPLEN)
  })

  it('renders real percentage and byte progress', async () => {
    api().listLocalModels = vi.fn(() => Promise.resolve([row(false)]))
    render(<RunConsole />)
    await screen.findByTestId('model-strip')
    fire('onModelPull', { model: SPLEN, status: 'downloading', percent: 42, completed: 2_000_000_000, total: 4_700_000_000, layer: null, done: false })
    const strip = screen.getByTestId('model-strip')
    expect(strip.textContent).toContain('Downloading Splen')
    expect(strip.textContent).toContain('42%')
    expect(strip.textContent).toContain('1.9 GB')
    expect(strip.textContent).toContain('4.4 GB')
    expect((strip.querySelector('.ou-sp-model-fill') as HTMLElement).style.width).toBe('42%')
  })

  // A 0%-width bar is what made this look frozen. Phases with no byte counts
  // must show their status text and an indeterminate fill instead.
  it('shows the phase text, not a 0% bar, when there are no byte counts', async () => {
    api().listLocalModels = vi.fn(() => Promise.resolve([row(false)]))
    render(<RunConsole />)
    await screen.findByTestId('model-strip')
    fire('onModelPull', { model: SPLEN, status: 'checking the file', percent: null, completed: null, total: null, layer: null, done: false })
    const strip = screen.getByTestId('model-strip')
    expect(strip.textContent).toContain('checking the file')
    expect(strip.textContent).not.toContain('0%')
    expect(strip.querySelector('.ou-sp-model-fill.idle')).toBeTruthy()
  })

  it('says why a download stopped and offers Try again', async () => {
    api().listLocalModels = vi.fn(() => Promise.resolve([row(false)]))
    api().downloadModel = vi.fn(() => Promise.resolve({ ok: false, code: 'network', message: 'The connection was lost.' }))
    render(<RunConsole />)
    await screen.findByTestId('model-strip')
    fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    await waitFor(() => expect(screen.getByTestId('model-strip').textContent).toContain('The connection was lost.'))
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })
})

describe('RunConsole — empty, loading and failed states', () => {
  const api = (): Record<string, ReturnType<typeof vi.fn>> =>
    (window as unknown as { openui: Record<string, ReturnType<typeof vi.fn>> }).openui

  it('an empty chat offers things to try; picking one fills the box and sends nothing', () => {
    render(<RunConsole />)
    fireEvent.click(screen.getByRole('button', { name: /Summarise my unread WhatsApp chats/ }))
    expect((screen.getByLabelText('Describe a task or ask a question') as HTMLTextAreaElement).value).toBe('Summarise my unread WhatsApp chats')
    expect(api().chat).not.toHaveBeenCalled()
  })

  it('a failed run says so and Try again resends it', () => {
    activity.tasks = [card({ id: 'f', title: 'read my chat with Ashu', status: 'failed', answer: 'WhatsApp is not open.' })]
    render(<RunConsole />)
    expect(screen.getByRole('alert').textContent).toContain('WhatsApp is not open.')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(activity.beginTask).toHaveBeenCalledWith('read my chat with Ashu', 'chat')
    expect(api().chat).toHaveBeenCalledWith('read my chat with Ashu', 'free')
  })

  it('a reopened chat shows a skeleton while it loads', async () => {
    api().resumeConversation = vi.fn(() => new Promise(() => {}))
    render(<RunConsole />)
    fireEvent.click(screen.getByRole('button', { name: 'Saved chat' }))
    expect(await screen.findByTestId('thread-loading')).toBeTruthy()
  })

  it('a chat that cannot be reopened says so, with a way out', async () => {
    api().resumeConversation = vi.fn(() => Promise.reject(new Error('gone')))
    render(<RunConsole />)
    fireEvent.click(screen.getByRole('button', { name: 'Saved chat' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('couldn’t be opened'))
  })
})
