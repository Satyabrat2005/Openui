// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'

// Settings for the Splen build: only what the texting agent uses, grouped so a
// person can find it. The sections from the older all-purpose assistant stay
// in the code behind SHOW_EXTRA_SETTINGS and must not render.

vi.mock('./ModelManager', () => ({ default: () => <div data-testid="model-manager">Local model</div> }))

import SettingsModal from './SettingsModal'

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
    onConsentUpdated: vi.fn(() => vi.fn())
  }
})
afterEach(cleanup)

describe('SettingsModal — Splen build', () => {
  it('groups the sections the texting agent uses', async () => {
    render(<SettingsModal onClose={vi.fn()} appVersion="7.4.0" />)
    await waitFor(() => expect(screen.getByText('WhatsApp auto-reply')).toBeTruthy())
    const groups = [...document.querySelectorAll('.ou-settings-group')].map((g) => g.textContent)
    expect(groups).toEqual(['Splen', 'Channels', 'Safety', 'Privacy & app'])
    for (const label of ['Appearance', 'Telegram', 'Slack', 'Gmail', 'Unified inbox', 'Approvals', 'Memory', 'Anonymous Usage Analytics', 'App Version']) {
      expect(screen.getByText(label)).toBeTruthy()
    }
    expect(screen.getByTestId('model-manager')).toBeTruthy()
  })

  it('hides the sections that are not part of the product', async () => {
    render(<SettingsModal onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Gmail')).toBeTruthy())
    for (const label of ['Figma', 'GitHub', 'Google Calendar', 'Google Drive', 'Local calendar automation', 'Screen OCR language', 'AI Improvement', 'Cloud AI']) {
      expect(screen.queryByText(label)).toBeNull()
    }
  })

  it('Gmail carries the Google OAuth client fields now that Calendar is hidden', async () => {
    render(<SettingsModal onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByLabelText('Google OAuth client ID')).toBeTruthy())
    expect(screen.getByLabelText('Google OAuth client secret')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Connect Gmail' })).toBeTruthy()
  })
})

describe('SettingsModal — easy connect', () => {
  const api = (): Record<string, ReturnType<typeof vi.fn>> =>
    (window as unknown as { openui: Record<string, ReturnType<typeof vi.fn>> }).openui

  it('Gmail with the built-in Google client is one button, no Client ID fields', async () => {
    api().gmailStatus = vi.fn(() => Promise.resolve({ connected: false, builtInClient: true }))
    render(<SettingsModal onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText(/choose your Google account/)).toBeTruthy())
    expect(screen.queryByLabelText('Google OAuth client ID')).toBeNull()
    const button = screen.getByRole('button', { name: 'Connect Gmail' }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    // The own-client path is still one click away.
    fireEvent.click(screen.getByRole('button', { name: /use my own google cloud client/i }))
    expect(screen.getByLabelText('Google OAuth client ID')).toBeTruthy()
  })

  it('Telegram checks the token with Telegram, then says which bot and what to do next', async () => {
    render(<SettingsModal onClose={vi.fn()} />)
    const input = await screen.findByLabelText('Telegram bot token')
    fireEvent.change(input, { target: { value: '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(screen.getByText('Connected as @splen_test_bot')).toBeTruthy())
    expect(api().telegramConnect).toHaveBeenCalledWith('123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
    expect(screen.getByTestId('telegram-next').textContent).toMatch(/press Start/)
  })

  it('Telegram shows why a token was rejected', async () => {
    api().telegramConnect = vi.fn(() => Promise.resolve({ ok: false, error: 'Telegram rejected this token.' }))
    render(<SettingsModal onClose={vi.fn()} />)
    const input = await screen.findByLabelText('Telegram bot token')
    fireEvent.change(input, { target: { value: 'nope' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(screen.getByText('Telegram rejected this token.')).toBeTruthy())
    expect(screen.queryByTestId('telegram-next')).toBeNull()
  })
})
