/**
 * splen/engine.ts — the contract between the Splen runtime and an inference
 * engine, with no Electron and no native code in it.
 *
 * Kept apart from runtime.ts (which needs Electron for the install folder) so
 * the production llama.cpp backend can be loaded under plain Node too. That is
 * how the safety gate measures the exact engine code the app ships
 * (scripts/finetune/splen_inapp_server.ts), instead of a copy of it.
 */

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
  /** Cap on reply tokens. The app leaves it unset (the window is the cap); the gate sets 1024. */
  maxTokens?: number
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

/** The prompt does not fit in the largest window the runtime will open. */
export class SplenPromptTooLongError extends Error {
  // Plain fields, not constructor parameter properties: Node's type stripping
  // (which the gate uses to load this file) does not support the shorthand.
  readonly promptTokens: number
  readonly contextSize: number

  constructor(promptTokens: number, contextSize: number) {
    super(
      `This conversation is too long for Splen to read in one go (${promptTokens} tokens, room for ${contextSize}). Start a new conversation to continue.`
    )
    this.name = 'SplenPromptTooLongError'
    this.promptTokens = promptTokens
    this.contextSize = contextSize
  }
}
