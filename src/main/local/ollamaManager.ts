import { execFile } from 'child_process'
import { getSetting, setSetting } from '../database/repositories/settingsRepo'

function trackEvent(event: string, props?: Record<string, unknown>): void {
  console.log('[Telemetry]', event, props ?? '')
}

export async function isOllamaRunning(): Promise<boolean> {
  try {
    const response = await fetch('http://127.0.0.1:11434/', {
      method: 'GET',
      signal: AbortSignal.timeout(2000)
    })
    return response.ok
  } catch {
    return false
  }
}

export async function isOllamaInstalled(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('ollama', ['--version'], (error) => {
      resolve(!error)
    })
  })
}

export async function startOllama(): Promise<boolean> {
  return new Promise((resolve) => {
    let resolved = false
    const resolveOnce = (val: boolean): void => {
      if (resolved) return
      resolved = true
      resolve(val)
    }

    execFile('ollama', ['serve'], (error) => {
      if (error) {
        console.error('[Ollama] Failed to start:', error)
        resolveOnce(false)
      }
    })

    let attempts = 0
    const check = setInterval(async () => {
      attempts++
      if (await isOllamaRunning()) {
        clearInterval(check)
        resolveOnce(true)
      } else if (attempts > 15) {
        clearInterval(check)
        resolveOnce(false)
      }
    }, 1000)
  })
}

export async function pullModel(modelName: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('ollama', ['pull', modelName], (error) => {
      if (error) {
        console.error(`[Ollama] Failed to pull ${modelName}:`, error)
        resolve(false)
      } else {
        resolve(true)
      }
    })
  })
}

export function getOllamaInstallUrl(): string {
  return 'https://ollama.com/download'
}

export async function shouldPromptOllamaSetup(): Promise<boolean> {
  if (await isOllamaInstalled()) return false

  const dismissed = getSetting('ollama_prompt_dismissed')
  if (dismissed === true) return false

  const lastPrompted = getSetting('ollama_prompt_last_shown')
  if (typeof lastPrompted === 'number') {
    const daysSince = (Date.now() - lastPrompted) / (1000 * 60 * 60 * 24)
    if (daysSince < 7) return false
  }

  return true
}

export async function dismissOllamaPrompt(permanently: boolean): Promise<void> {
  if (permanently) setSetting('ollama_prompt_dismissed', true)
  setSetting('ollama_prompt_last_shown', Date.now())
  trackEvent('ollama_prompt_dismissed', { permanent: permanently })
}
