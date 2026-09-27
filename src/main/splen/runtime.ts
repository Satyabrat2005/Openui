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

/** Same idle window as Ollama's default keep_alive. */
export const SPLEN_IDLE_UNLOAD_MS = 5 * 60 * 1000

/**
 * Largest window the runtime opens — agent.ts's MAX_NUM_CTX, for the same
 * reason: past it the KV cache stops fitting beside the weights on 8 GB.
 */
export const SPLEN_MAX_CONTEXT = 32768

/** Room left for the reply when a window is grown to fit a prompt. */
export const SPLEN_REPLY_HEADROOM = 2048

/**
 * The window to actually open. The caller sizes it from a 4-chars-per-token
 * estimate; the backend knows the real count. A prompt the estimate undercounted
 * gets a bigger window (the same power-of-two ladder resolveNumCtx uses) rather
 * than a refusal — up to SPLEN_MAX_CONTEXT, past which it is too long.
 */
export function fitContextSize(promptTokens: number, requested: number): number {
  if (promptTokens + SPLEN_REPLY_HEADROOM <= requested) return requested
  return Math.min(SPLEN_MAX_CONTEXT, 2 ** Math.ceil(Math.log2(promptTokens + SPLEN_REPLY_HEADROOM)))
}

export interface SplenGenerateRequest {
  prompt: string
  /** Context window the caller asked for, in tokens (see fitContextSize). */
  contextSize: number
  seed?: number
  onText: (text: string) => void
}

/**
 * What the runtime needs from an inference engine. Narrow on purpose: the
 * llama.cpp binding is the only production implementation, and tests
 * substitute a fake so the locking, unloading and error paths are checked
 * without a GPU or a 2.8 GB file.
 */
export interface SplenBackend {
  generate(req: SplenGenerateRequest): Promise<string>
  dispose(): Promise<void>
}

export type SplenBackendFactory = (modelPath: string) => Promise<SplenBackend>

/** Splen was asked for but is not on this machine (or failed verification). */
export class SplenNotInstalledError extends Error {
  constructor() {
    super('Splen is not downloaded on this computer yet. Download it from the model screen to use it.')
    this.name = 'SplenNotInstalledError'
  }
}

/** The prompt does not fit in the largest window the runtime will open. */
export class SplenPromptTooLongError extends Error {
  constructor(
    readonly promptTokens: number,
    readonly contextSize: number
  ) {
    super(
      `This conversation is too long for Splen to read in one go (${promptTokens} tokens, room for ${contextSize}). Start a new conversation to continue.`
    )
    this.name = 'SplenPromptTooLongError'
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
