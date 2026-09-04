// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import type { ModelPullProgress, ModelStatus } from '../env'

// The download control is the ONLY path the app offers to get a model, so what
// matters is that it (a) shows real progress rather than a decorative spinner,
// (b) gives each failure its own message instead of one generic "failed", and
// (c) never sends the user to a terminal.

import ModelManager from './ModelManager'

const GENERAL = 'qwen3.5:latest'

function statusRow(over: Partial<ModelStatus> = {}): ModelStatus {
  return {
    id: GENERAL,
    label: 'General assistant',
    purpose: 'Everyday chat.',
    approxSize: 'about 2 GB',
    installed: false,
    downloading: false,
    ...over
  }
}

let pullCb: ((p: ModelPullProgress) => void) | null = null

function stub(over: Record<string, unknown> = {}): void {
  ;(window as unknown as { openui: Record<string, unknown> }).openui = {
    listLocalModels: vi.fn(() => Promise.resolve([statusRow()])),
    downloadModel: vi.fn(() => Promise.resolve({ ok: true, model: GENERAL })),
    onModelPull: vi.fn((cb: (p: ModelPullProgress) => void) => {
      pullCb = cb
      return vi.fn()
    }),
    ...over
  }
}

function progress(over: Partial<ModelPullProgress> = {}): ModelPullProgress {
  return {
    model: GENERAL,
    status: 'pulling',
    percent: null,
    completed: null,
    total: null,
    layer: null,
    done: false,
    ...over
  }
}

beforeEach(() => {
  pullCb = null
  stub()
})
afterEach(cleanup)

describe('ModelManager — listing', () => {
  it('offers a download for a missing model, with its approximate size', async () => {
    render(<ModelManager />)
    const btn = await screen.findByRole('button', { name: /download/i })
    expect(btn.textContent).toContain('about 2 GB')
  })

  it('shows an installed model as installed, with no download button', async () => {
    stub({ listLocalModels: vi.fn(() => Promise.resolve([statusRow({ installed: true })])) })
    render(<ModelManager />)
    expect(await screen.findByTestId(`model-ready-${GENERAL}`)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /download/i })).toBeNull()
  })

  it('renders nothing broken when the model list cannot be read', async () => {
    stub({ listLocalModels: vi.fn(() => Promise.reject(new Error('ipc down'))) })
    render(<ModelManager />)
    await waitFor(() => expect(screen.queryByRole('button', { name: /download/i })).toBeNull())
  })
})

describe('ModelManager — real progress', () => {
  it('renders byte-derived progress from the pull stream, not a bare spinner', async () => {
    // A pull that never resolves keeps the row in its downloading state.
    stub({ downloadModel: vi.fn(() => new Promise(() => {})) })
    render(<ModelManager />)
    fireEvent.click(await screen.findByRole('button', { name: /download/i }))

    pullCb?.(progress({ percent: 42, completed: 42, total: 100, layer: 'abcdef012345' }))

    const status = await screen.findByRole('status')
    expect(status.textContent).toContain('42%')
    // The real byte counts and the layer id are surfaced, so a stalled layer is
    // attributable rather than looking like a frozen bar.
    expect(status.textContent).toContain('layer abcdef012345')
  })

  it('shows the phase text — not a 0% bar — for a phase with no byte counts', async () => {
    stub({ downloadModel: vi.fn(() => new Promise(() => {})) })
    render(<ModelManager />)
    fireEvent.click(await screen.findByRole('button', { name: /download/i }))

    pullCb?.(progress({ status: 'pulling manifest', percent: null }))

    const status = await screen.findByRole('status')
    expect(status.textContent).toContain('pulling manifest')
    expect(status.textContent).not.toContain('0%')
    // An indeterminate phase gets a moving bar, never a zero-width one.
    expect(document.querySelector('.ou-model-fill.indeterminate')).toBeTruthy()
  })

  it('re-reads the list when a download reports success, so the row flips to installed', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce([statusRow()])
      .mockResolvedValue([statusRow({ installed: true })])
    stub({ listLocalModels: list, downloadModel: vi.fn(() => new Promise(() => {})) })
    render(<ModelManager />)
    await screen.findByRole('button', { name: /download/i })

    pullCb?.(progress({ percent: 100, done: true, status: 'ready' }))

    expect(await screen.findByTestId(`model-ready-${GENERAL}`)).toBeTruthy()
  })
})

describe('ModelManager — each failure gets its own message', () => {
  const failures: { code: string; message: string; installUrl?: string }[] = [
    {
      code: 'engine_unavailable',
      message: 'OpenUI needs the local AI engine (Ollama) installed and running.',
      installUrl: 'https://ollama.com/download'
    },
    { code: 'network', message: 'The download stopped because the connection was lost.' },
    { code: 'disk_space', message: 'There isn’t enough free disk space to finish the download.' },
    { code: 'already_in_progress', message: 'That model is already downloading.' },
    { code: 'model_not_found', message: 'That model isn’t available from the model library.' },
    { code: 'unauthenticated', message: 'Sign in to download a model.' }
  ]

  for (const f of failures) {
    it(`surfaces "${f.code}" with its own message`, async () => {
      stub({ downloadModel: vi.fn(() => Promise.resolve({ ok: false, ...f })) })
      render(<ModelManager />)
      fireEvent.click(await screen.findByRole('button', { name: /download/i }))

      const err = await screen.findByTestId(`model-error-${GENERAL}`)
      expect(err.textContent).toContain(f.message)
      // No failure path may route the user to a terminal.
      expect(err.textContent).not.toMatch(/terminal|command line|ollama pull|ollama run|ollama serve/i)
    })
  }

  it('offers the installer link — and only that — when the engine is missing', async () => {
    const f = failures[0]
    stub({ downloadModel: vi.fn(() => Promise.resolve({ ok: false, ...f })) })
    const open = vi.fn()
    window.open = open as unknown as typeof window.open

    render(<ModelManager />)
    fireEvent.click(await screen.findByRole('button', { name: /download/i }))
    fireEvent.click(await screen.findByRole('button', { name: /get the local ai engine/i }))

    expect(open).toHaveBeenCalledWith('https://ollama.com/download', '_blank', 'noopener,noreferrer')
  })

  it('a rejected IPC call still produces a legible message rather than a silent no-op', async () => {
    stub({ downloadModel: vi.fn(() => Promise.reject(new Error('bridge died'))) })
    render(<ModelManager />)
    fireEvent.click(await screen.findByRole('button', { name: /download/i }))

    const err = await screen.findByTestId(`model-error-${GENERAL}`)
    expect(err.textContent).toMatch(/could not be started/i)
  })

  it('clears a previous failure when the download is retried', async () => {
    const download = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, code: 'network', message: 'The connection was lost.' })
      .mockImplementation(() => new Promise(() => {}))
    stub({ downloadModel: download })
    render(<ModelManager />)

    fireEvent.click(await screen.findByRole('button', { name: /download/i }))
    await screen.findByTestId(`model-error-${GENERAL}`)

    fireEvent.click(screen.getByRole('button', { name: /download/i }))
    await waitFor(() => expect(screen.queryByTestId(`model-error-${GENERAL}`)).toBeNull())
  })
})
