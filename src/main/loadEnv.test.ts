import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

let isPackaged = false
vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return isPackaged
    }
  }
}))

const config = vi.fn()
vi.mock('dotenv', () => ({ config }))

describe('loadEnv', () => {
  beforeEach(() => {
    vi.resetModules()
    config.mockClear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('loads .env when the app is not packaged', async () => {
    isPackaged = false
    await import('./loadEnv')
    expect(config).toHaveBeenCalledTimes(1)
  })

  it('does not read .env when the app is packaged', async () => {
    isPackaged = true
    await import('./loadEnv')
    expect(config).not.toHaveBeenCalled()
  })
})
