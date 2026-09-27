/**
 * splen/runtime.ts — run Splen inside OpenUI's own process. No Ollama, no port.
 *
 * Under Ollama any program on the machine could reach the model (the daemon
 * listens on 127.0.0.1:11434) and `ollama run` opened it in a terminal. Here the
 * weights are loaded by llama.cpp through node-llama-cpp, inside the Electron
 * main process: nothing listens, and nothing outside this process can send the
 * model a prompt. The engine is the same llama.cpp that Ollama 0.31.2 hands
 * Splen to (llm/llama_server.go), which is what makes the measured numbers
 * transferable — together with the byte-identical prompt (prompt.ts) and the
 * same sampling (SPLEN_SAMPLING). "Transferable" is still a claim to check: the
 * safety gate is re-run on this runtime before it ships.
 *
 * One generation at a time, through the same lock as every Ollama call: an
 * 8 GB card holds one working set (see ollamaLock.ts). The model is unloaded
 * after a few idle minutes so a quiet app does not sit on ~3 GB of VRAM —
 * Ollama's own keep_alive default, kept for the same reason.
 */
import { withOllamaLock } from '../ollamaLock'
import { renderSplenPrompt, type SplenTurn } from './prompt'
import { readSplenInstall, splenWeightsPath } from './install'
import type { SplenBackend, SplenBackendFactory } from './engine'

// The engine contract lives in engine.ts (no Electron) so the gate can load the
// production backend under plain Node; re-exported for existing callers.
export {
  fitContextSize,
  SPLEN_MAX_CONTEXT,
  SPLEN_REPLY_HEADROOM,
  SplenPromptTooLongError,
  type SplenBackend,
  type SplenBackendFactory,
  type SplenGenerateRequest
} from './engine'

/** Same idle window as Ollama's default keep_alive. */
export const SPLEN_IDLE_UNLOAD_MS = 5 * 60 * 1000

/** Splen was asked for but is not on this machine (or failed verification). */
export class SplenNotInstalledError extends Error {
  constructor() {
    super('Splen is not downloaded on this computer yet. Download it from the model screen to use it.')
    this.name = 'SplenNotInstalledError'
  }
}

let factory: SplenBackendFactory = async (modelPath) => {
  const { createLlamaCppBackend } = await import('./llamaCppBackend')
  return createLlamaCppBackend(modelPath)
}
let backend: Promise<SplenBackend> | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null

/** Tests swap the engine; the app never calls this. */
export function setSplenBackendFactoryForTests(next: SplenBackendFactory): void {
  factory = next
}

function clearIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
}

/** Unload the model now. Safe to call when nothing is loaded. */
export async function unloadSplen(): Promise<void> {
  clearIdleTimer()
  const current = backend
  backend = null
  if (!current) return
  try {
    await (await current).dispose()
  } catch {
    // A load that failed has nothing to free.
  }
}

function scheduleUnload(): void {
  clearIdleTimer()
  idleTimer = setTimeout(() => {
    // Take the lock so an unload never lands in the middle of a generation.
    void withOllamaLock(unloadSplen)
  }, SPLEN_IDLE_UNLOAD_MS)
  // An idle timer must not keep the process alive on quit.
  idleTimer.unref?.()
}

function loadBackend(): Promise<SplenBackend> {
  if (!backend) {
    const loading = factory(splenWeightsPath())
    // A failed load must not be cached, or every later turn replays the failure.
    loading.catch(() => {
      if (backend === loading) backend = null
    })
    backend = loading
  }
  return backend
}

export interface SplenChatRequest {
  systemPrompt: string
  turns: SplenTurn[]
  /** Context window, sized by the caller exactly as it is for Ollama (resolveNumCtx). */
  numCtx: number
  onDelta: (delta: string) => void
  seed?: number
}

/**
 * One streamed Splen reply. Resolves with the full text; each piece is also
 * handed to `onDelta` as it is produced.
 */
export function generateSplen(req: SplenChatRequest): Promise<string> {
  if (!readSplenInstall()) return Promise.reject(new SplenNotInstalledError())
  const prompt = renderSplenPrompt(req.systemPrompt, req.turns)
  return withOllamaLock(async () => {
    clearIdleTimer()
    try {
      const engine = await loadBackend()
      return await engine.generate({
        prompt,
        contextSize: req.numCtx,
        seed: req.seed,
        onText: req.onDelta
      })
    } finally {
      scheduleUnload()
    }
  })
}
