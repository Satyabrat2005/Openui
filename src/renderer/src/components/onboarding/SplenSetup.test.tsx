// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'

// First run for Splen: download the model, see the channels, start. The model
// list and the download are the real IPC surface, mocked at the boundary.

vi.mock('../../lib/telemetry', () => ({ track: vi.fn() }))

import SplenSetup from './SplenSetup'

const SPLEN = 'openui/splen:4b'
const row = (installed: boolean): unknown => ({ id: SPLEN, label: 'Splen 4B', purpose: '', approxSize: 'about 2.8 GB', installed, downloading: false })
const api = (): Record<string, ReturnType<typeof vi.fn>> =>
  (window as unknown as { openui: Record<string, ReturnType<typeof vi.fn>> }).openui

beforeEach(() => {
  ;(window as unknown as { openui: Record<string, unknown> }).openui = {
    listLocalModels: vi.fn(() => Promise.resolve([row(false)])),
    downloadModel: vi.fn(() => new Promise(() => {})),
    onModelPull: vi.fn(() => vi.fn()),
    setSetting: vi.fn(() => Promise.resolve())
  }
})
afterEach(cleanup)

describe('SplenSetup', () => {
  it('step 1 is the Splen download, and starts it', async () => {
    render(<SplenSetup onComplete={vi.fn()} />)
    expect(screen.getByRole('heading', { name: 'First, download Splen.' })).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: 'Download' }))
    expect(api().downloadModel).toHaveBeenCalledWith(SPLEN)
    expect((await screen.findByTestId('setup-model')).textContent).toContain('Downloading Splen')
  })

  it('says so plainly when Splen is not offered to the account yet, and lets you go on', async () => {
    api().listLocalModels = vi.fn(() => Promise.resolve([]))
    render(<SplenSetup onComplete={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('setup-model').textContent).toContain('isn’t available for your account yet'))
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy()
  })

  it('shows why a download stopped, with Try again', async () => {
    api().downloadModel = vi.fn(() => Promise.resolve({ ok: false, code: 'disk_space', message: 'Free up some space.' }))
    render(<SplenSetup onComplete={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Download' }))
    await waitFor(() => expect(screen.getByTestId('setup-model').textContent).toContain('Free up some space.'))
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })

  it('an installed Splen needs nothing more', async () => {
    api().listLocalModels = vi.fn(() => Promise.resolve([row(true)]))
    render(<SplenSetup onComplete={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('setup-model').textContent).toContain('Splen is on this computer'))
  })

  it('finishing saves the safe defaults and replays the starter you picked', async () => {
    const onComplete = vi.fn()
    render(<SplenSetup onComplete={onComplete} initialStep={3} />)
    fireEvent.click(screen.getByRole('button', { name: /Summarise my unread WhatsApp chats/ }))
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith('Summarise my unread WhatsApp chats'))
    expect(api().setSetting).toHaveBeenCalledWith('cloud_routing_enabled', false)
    expect(api().setSetting).toHaveBeenCalledWith('guard_confirm_send', true)
    expect(api().setSetting).toHaveBeenCalledWith('autonomy_level', 'approve-plan')
  })

  it('walks 1 → 2 → 3 and back', async () => {
    render(<SplenSetup onComplete={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Skip for now' }))
    expect(screen.getByRole('heading', { name: 'Where your messages are.' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(screen.getByRole('heading', { name: 'You’re set.' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByRole('heading', { name: 'Where your messages are.' })).toBeTruthy()
  })
})
