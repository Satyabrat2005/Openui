// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'

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
    gmailStatus: ok({ connected: false }),
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
    expect(screen.getAllByRole('button', { name: 'Connect' })).toHaveLength(1)
  })
})
