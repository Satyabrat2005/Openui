// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react'

// Settings for the Splen build: a section list on the left, the section on the
// right, only what the texting agent uses. The sections from the older
// all-purpose assistant stay in the code behind SHOW_EXTRA_SETTINGS and must
// not render.

vi.mock('./ModelManager', () => ({ default: () => <div data-testid="model-manager">Local model</div> }))

import SettingsModal from './SettingsModal'

const TELEGRAM_TOKEN = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const api = (): Record<string, ReturnType<typeof vi.fn>> =>
  (window as unknown as { openui: Record<string, ReturnType<typeof vi.fn>> }).openui
const withSettings = (values: Record<string, unknown>): void => {
  api().getSetting = vi.fn((key: string) => Promise.resolve(values[key]))
}
const memory = (id: string, summary: string, subject = 'Ashu'): unknown => ({
  id,
  channel: 'whatsapp',
  subject_key: subject.toLowerCase(),
  subject_label: subject,
  summary,
  created_at: Math.floor(Date.now() / 1000) - 60
})

beforeEach(() => {
  const ok = <T,>(v: T) => vi.fn(() => Promise.resolve(v))
  ;(window as unknown as { openui: Record<string, unknown> }).openui = {
    getConsentStatus: ok('denied'),
    getSetting: ok(undefined),
    setSetting: ok(undefined),
    getWhatsAppAutoReply: ok({ enabled: false, allowlist: [] }),
    gmailStatus: ok({ connected: false, builtInClient: false }),
    telegramConnect: ok({ ok: true, username: 'splen_test_bot', name: 'Splen' }),
    googleCalendarStatus: ok({ connected: false }),
    googleDriveStatus: ok({ connected: false }),
    listMemories: ok([]),
    deleteMemory: ok(true),
    getUsageToday: ok({ allowed: true, used: 4, limit: null, remaining: null, unlimited: true, resetsAt: 0 }),
    getUsageSummary: ok({ activeDays: 12, windowDays: 30, totalMessages: 87, messagesPerActiveDay: 7.3, currentStreak: 3, busiestDay: null }),
    onConsentUpdated: vi.fn(() => vi.fn())
  }
})
afterEach(cleanup)

describe('SettingsModal — sections', () => {
  it('lists the sections the texting agent uses, and opens on General', async () => {
    render(<SettingsModal onClose={vi.fn()} appVersion="7.4.0" />)
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent)
    expect(tabs).toEqual(['General', 'Model', 'Channels', 'Keys', 'Memory', 'Usage', 'Privacy & safety'])
    expect(screen.getByRole('tab', { name: 'General' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('heading', { name: 'General' })).toBeTruthy()
    expect(screen.getByRole('radiogroup', { name: 'Appearance' })).toBeTruthy()
    expect(screen.getAllByText('Splen v7.4.0').length).toBeGreaterThan(0)
  })

  it('shows one section at a time', () => {
    render(<SettingsModal onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Model' }))
    expect(screen.getByTestId('model-manager')).toBeTruthy()
    expect(screen.queryByRole('radiogroup', { name: 'Appearance' })).toBeNull()
  })

  it('moves between sections with the arrow keys', () => {
    render(<SettingsModal onClose={vi.fn()} />)
    const list = screen.getByRole('tablist')
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    expect(screen.getByRole('tab', { name: 'Model' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(list, { key: 'ArrowUp' })
    fireEvent.keyDown(list, { key: 'ArrowUp' })
    expect(screen.getByRole('tab', { name: 'Privacy & safety' }).getAttribute('aria-selected')).toBe('true')
  })

  it('opens where the caller asked, with the channel expanded', async () => {
    render(<SettingsModal onClose={vi.fn()} initialSection="channels" initialChannel="telegram" />)
    expect(screen.getByRole('button', { name: /^Telegram/ }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('button', { name: /^Gmail/ }).getAttribute('aria-expanded')).toBe('false')
    await waitFor(() => expect(screen.getByLabelText('Telegram bot token')).toBeTruthy())
  })

  it('hides the sections that are not part of the product', () => {
    render(<SettingsModal onClose={vi.fn()} />)
    expect(screen.queryByRole('tab', { name: 'Advanced' })).toBeNull()
    for (const tab of screen.getAllByRole('tab')) {
      fireEvent.click(tab)
      for (const label of ['Figma', 'GitHub', 'Google Calendar', 'Google Drive', 'Local calendar automation', 'Screen OCR language', 'AI Improvement', 'Cloud AI']) {
        expect(screen.queryByText(label)).toBeNull()
      }
    }
  })

  it('Escape and the close button both close it', () => {
    const onClose = vi.fn()
    render(<SettingsModal onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Close settings' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})

describe('SettingsModal — easy connect', () => {
  const openChannels = (channel?: 'gmail' | 'telegram' | 'whatsapp' | 'slack'): void => {
    render(<SettingsModal onClose={vi.fn()} initialSection="channels" initialChannel={channel} />)
  }

  it('Gmail carries the Google OAuth client fields when the build has no client', async () => {
    openChannels('gmail')
    await waitFor(() => expect(screen.getByLabelText('Google OAuth client ID')).toBeTruthy())
    expect(screen.getByLabelText('Google OAuth client secret')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Connect Gmail' })).toBeTruthy()
  })

  it('Gmail with the built-in Google client is one button, no Client ID fields', async () => {
    api().gmailStatus = vi.fn(() => Promise.resolve({ connected: false, builtInClient: true }))
    openChannels('gmail')
    await waitFor(() => expect(screen.getByText(/choose your Google account/)).toBeTruthy())
    expect(screen.queryByLabelText('Google OAuth client ID')).toBeNull()
    const button = screen.getByRole('button', { name: 'Connect Gmail' }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    // The own-client path is still one click away.
    fireEvent.click(screen.getByRole('button', { name: /use my own google cloud client/i }))
    expect(screen.getByLabelText('Google OAuth client ID')).toBeTruthy()
  })

  it('Telegram checks the token with Telegram, then says which bot and what to do next', async () => {
    openChannels('telegram')
    const input = await screen.findByLabelText('Telegram bot token')
    fireEvent.change(input, { target: { value: TELEGRAM_TOKEN } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(screen.getByText('Connected as @splen_test_bot')).toBeTruthy())
    expect(api().telegramConnect).toHaveBeenCalledWith(TELEGRAM_TOKEN)
    expect(screen.getByTestId('telegram-next').textContent).toMatch(/press Start/)
  })

  it('Telegram shows why a token was rejected', async () => {
    api().telegramConnect = vi.fn(() => Promise.resolve({ ok: false, error: 'Telegram rejected this token.' }))
    openChannels('telegram')
    const input = await screen.findByLabelText('Telegram bot token')
    fireEvent.change(input, { target: { value: 'nope' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(screen.getByText('Telegram rejected this token.')).toBeTruthy())
    expect(screen.queryByTestId('telegram-next')).toBeNull()
  })

  it('a token that has only been typed is not reported as saved', async () => {
    openChannels('telegram')
    const input = await screen.findByLabelText('Telegram bot token')
    fireEvent.change(input, { target: { value: TELEGRAM_TOKEN } })
    expect(within(screen.getByRole('button', { name: /^Telegram/ })).getByText('Not connected')).toBeTruthy()
  })

  it('says so when the WhatsApp auto-reply settings cannot be read', async () => {
    api().getWhatsAppAutoReply = vi.fn(() => Promise.reject(new Error('nope')))
    openChannels('whatsapp')
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Couldn’t load the auto-reply settings'))
  })

  it('switches WhatsApp drafting on through the same setting', async () => {
    api().setWhatsAppAutoReply = vi.fn((cfg: unknown) => Promise.resolve(cfg))
    openChannels('whatsapp')
    fireEvent.click(await screen.findByRole('switch', { name: 'Draft WhatsApp replies automatically' }))
    expect(api().setWhatsAppAutoReply).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }))
  })
})

describe('SettingsModal — keys', () => {
  const clipboard = (writeText: ReturnType<typeof vi.fn>): void => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  }

  it('explains itself when nothing is saved', async () => {
    render(<SettingsModal onClose={vi.fn()} initialSection="keys" />)
    expect(await screen.findByText('No keys saved')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Go to Channels' }))
    expect(screen.getByRole('tab', { name: 'Channels' }).getAttribute('aria-selected')).toBe('true')
  })

  it('never shows a saved token in full', async () => {
    withSettings({ telegram_bot_token: TELEGRAM_TOKEN })
    const { container } = render(<SettingsModal onClose={vi.fn()} initialSection="keys" />)
    await screen.findByText('Telegram bot token')
    expect(container.textContent).not.toContain(TELEGRAM_TOKEN)
    expect(container.querySelector('.ou-key-value')?.textContent).toBe('12345…••••')
  })

  it('Copy puts the real token on the clipboard and confirms it', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    clipboard(writeText)
    withSettings({ telegram_bot_token: TELEGRAM_TOKEN })
    render(<SettingsModal onClose={vi.fn()} initialSection="keys" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Copy Telegram bot token' }))
    expect(writeText).toHaveBeenCalledWith(TELEGRAM_TOKEN)
    expect((await screen.findByRole('status')).textContent).toBe('Copied')
  })

  it('says when the copy failed rather than claiming it worked', async () => {
    clipboard(vi.fn(() => Promise.reject(new Error('denied'))))
    withSettings({ telegram_bot_token: TELEGRAM_TOKEN })
    render(<SettingsModal onClose={vi.fn()} initialSection="keys" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Copy Telegram bot token' }))
    expect((await screen.findByRole('status')).textContent).toBe('Couldn’t copy')
  })

  it('Remove takes two clicks, clears the setting, and the channel reports it', async () => {
    withSettings({ telegram_bot_token: TELEGRAM_TOKEN })
    render(<SettingsModal onClose={vi.fn()} initialSection="keys" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Telegram bot token' }))
    expect(api().setSetting).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm removing Telegram bot token' }))
    await waitFor(() => expect(screen.getByText('No keys saved')).toBeTruthy())
    expect(api().setSetting).toHaveBeenCalledWith('telegram_bot_token', '')
    fireEvent.click(screen.getByRole('tab', { name: 'Channels' }))
    expect(within(screen.getByRole('button', { name: /^Telegram/ })).getByText('Not connected')).toBeTruthy()
  })
})

describe('SettingsModal — memory', () => {
  it('shows a skeleton until the list has been read', () => {
    api().listMemories = vi.fn(() => new Promise(() => {}))
    render(<SettingsModal onClose={vi.fn()} initialSection="memory" />)
    expect(screen.getByTestId('settings-loading')).toBeTruthy()
    expect(screen.queryByText('Nothing remembered yet')).toBeNull()
  })

  it('has an empty state and a failed state', async () => {
    const { unmount } = render(<SettingsModal onClose={vi.fn()} initialSection="memory" />)
    expect(await screen.findByText('Nothing remembered yet')).toBeTruthy()
    unmount()
    api().listMemories = vi.fn(() => Promise.reject(new Error('nope')))
    render(<SettingsModal onClose={vi.fn()} initialSection="memory" />)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Couldn’t read what Splen remembers'))
  })

  it('Forget removes that one line', async () => {
    api().listMemories = vi.fn(() => Promise.resolve([memory('a', 'Friday works'), memory('b', 'Call mom', 'Mom')]))
    render(<SettingsModal onClose={vi.fn()} initialSection="memory" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Forget: Friday works' }))
    expect(api().deleteMemory).toHaveBeenCalledWith('a')
    expect(screen.queryByText('Friday works')).toBeNull()
    expect(screen.getByText('Call mom')).toBeTruthy()
  })
})

describe('SettingsModal — usage', () => {
  it('shows real days active, with no invented limit while the app is free', async () => {
    render(<SettingsModal onClose={vi.fn()} initialSection="usage" />)
    const bar = await screen.findByRole('progressbar', { name: 'Days active' })
    expect(bar.getAttribute('aria-valuenow')).toBe('12')
    expect(bar.getAttribute('aria-valuemax')).toBe('30')
    expect(screen.getByText('87')).toBeTruthy()
    expect(screen.getByText('Unlimited messages')).toBeTruthy()
  })

  it('measures today against the limit when plans are on', async () => {
    api().getUsageToday = vi.fn(() => Promise.resolve({ allowed: true, used: 6, limit: 10, remaining: 3, unlimited: false, resetsAt: 0 }))
    render(<SettingsModal onClose={vi.fn()} initialSection="usage" />)
    const bar = await screen.findByRole('progressbar', { name: 'Messages used today' })
    expect(bar.getAttribute('aria-valuenow')).toBe('6')
    expect(bar.getAttribute('aria-valuemax')).toBe('10')
    expect(screen.queryByText('Unlimited messages')).toBeNull()
  })

  it('says so when usage cannot be read', async () => {
    api().getUsageSummary = vi.fn(() => Promise.reject(new Error('nope')))
    render(<SettingsModal onClose={vi.fn()} initialSection="usage" />)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Couldn’t read usage'))
  })
})

describe('SettingsModal — privacy and safety', () => {
  it('saves the approval level to the same setting as before', async () => {
    render(<SettingsModal onClose={vi.fn()} initialSection="privacy" />)
    fireEvent.click(screen.getByRole('radio', { name: /Ask each/ }))
    expect(api().setSetting).toHaveBeenCalledWith('autonomy_level', 'ask-each')
    expect(screen.getByRole('radio', { name: /Ask each/ }).getAttribute('aria-checked')).toBe('true')
  })

  it('the analytics switch grants consent', async () => {
    api().grantConsent = vi.fn(() => Promise.resolve('granted'))
    render(<SettingsModal onClose={vi.fn()} initialSection="privacy" />)
    fireEvent.click(screen.getByRole('switch', { name: 'Anonymous usage analytics' }))
    await waitFor(() => expect(api().grantConsent).toHaveBeenCalled())
  })
})
