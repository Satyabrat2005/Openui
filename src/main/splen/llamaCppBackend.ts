/**
 * splen/llamaCppBackend.ts — the llama.cpp engine behind runtime.ts.
 *
 * Loaded lazily (runtime.ts imports this module on first use) so a machine that
 * never downloads Splen never loads the native binding, and a broken binding
 * surfaces as a failed Splen turn rather than a main process that will not start.
 *
 * `build: 'never'`: users have no compiler toolchain. If no prebuilt binary fits
 * the machine, node-llama-cpp must fail — not try to compile llama.cpp on first
 * use. `gpu: 'auto'` picks Vulkan/CUDA/Metal when present and falls back to CPU.
 *
 * The prompt is tokenized with special tokens ON, the way llama-server's
 * /completion parses Ollama's rendered prompt: `<|im_start|>` must become the
 * control token, not the eleven characters. Qwen adds no BOS, and neither does
 * Ollama's qwen3.5 renderer (LeadingBOS ""), so none is added here.
 */
import { SPLEN_SAMPLING } from './prompt'
import { fitContextSize, SplenPromptTooLongError, type SplenBackend, type SplenGenerateRequest } from './engine'

/**
 * The slice of node-llama-cpp 3.x used here. Declared locally so this file
 * states exactly what it depends on; the dynamic import below is checked
 * against it at the one place it enters.
 */
type Token = number
interface NlcSequence {
  dispose(): void
}
interface NlcContext {
  readonly contextSize: number
  getSequence(): NlcSequence
  dispose(): Promise<void>
}
interface NlcModel {
  tokenize(text: string, specialTokens?: boolean): Token[]
  createContext(options: { contextSize: number; sequences: number }): Promise<NlcContext>
  dispose(): Promise<void>
}
interface NlcLlama {
  loadModel(options: { modelPath: string; gpuLayers?: 'auto' }): Promise<NlcModel>
}
interface NlcCompletion {
  generateCompletion(
    input: Token[],
    options: {
      onTextChunk?: (text: string) => void
      maxTokens?: number
      temperature?: number
      topK?: number
      topP?: number
      minP?: number
      seed?: number
      repeatPenalty?: {
        lastTokens?: number
        penalty?: number
        frequencyPenalty?: number
        presencePenalty?: number
        penalizeNewLine?: boolean
      }
    }
  ): Promise<string>
  dispose(): void
}
interface NodeLlamaCpp {
  getLlama(options: { gpu: 'auto'; build: 'never' }): Promise<NlcLlama>
  LlamaCompletion: new (options: { contextSequence: NlcSequence }) => NlcCompletion
}

// Not a string literal so the bundler leaves it to Node's resolver at runtime:
// node-llama-cpp is ESM-only with native binaries and must stay external.
const MODULE_ID = 'node-llama-cpp'

let llamaPromise: Promise<{ nlc: NodeLlamaCpp; llama: NlcLlama }> | null = null

function getEngine(): Promise<{ nlc: NodeLlamaCpp; llama: NlcLlama }> {
  if (!llamaPromise) {
    llamaPromise = (async () => {
      const nlc = (await import(/* @vite-ignore */ MODULE_ID)) as NodeLlamaCpp
      const llama = await nlc.getLlama({ gpu: 'auto', build: 'never' })
      return { nlc, llama }
    })()
    llamaPromise.catch(() => {
      llamaPromise = null
    })
  }
  return llamaPromise
}

export async function createLlamaCppBackend(modelPath: string): Promise<SplenBackend> {
  const { nlc, llama } = await getEngine()
  const model = await llama.loadModel({ modelPath, gpuLayers: 'auto' })
  let context: NlcContext | null = null

  /** Reuse the open window when it is big enough; otherwise reopen at the new size. */
  async function contextFor(size: number): Promise<NlcContext> {
    if (context && context.contextSize >= size) return context
    if (context) await context.dispose()
    context = null
    context = await model.createContext({ contextSize: size, sequences: 1 })
    return context
  }

  return {
    async generate(req: SplenGenerateRequest): Promise<string> {
      const tokens = model.tokenize(req.prompt, true)
      const size = fitContextSize(tokens.length, req.contextSize)
      if (tokens.length >= size) {
        // llama-server would shift the context and drop the middle of the
        // prompt — where the tool instructions live. Refuse instead.
        throw new SplenPromptTooLongError(tokens.length, size)
      }
      const ctx = await contextFor(size)
      // A fresh sequence per turn: nothing from one conversation can leak
      // into the next through cached state.
      const sequence = ctx.getSequence()
      const completion = new nlc.LlamaCompletion({ contextSequence: sequence })
      try {
        return await completion.generateCompletion(tokens, {
          onTextChunk: req.onText,
          maxTokens: Math.min(size - tokens.length, req.maxTokens ?? Infinity),
          temperature: SPLEN_SAMPLING.temperature,
          topK: SPLEN_SAMPLING.topK,
          topP: SPLEN_SAMPLING.topP,
          minP: SPLEN_SAMPLING.minP,
          ...(req.seed !== undefined ? { seed: req.seed } : {}),
          repeatPenalty: {
            lastTokens: SPLEN_SAMPLING.repeatLastN,
            penalty: SPLEN_SAMPLING.repeatPenalty,
            frequencyPenalty: SPLEN_SAMPLING.frequencyPenalty,
            presencePenalty: SPLEN_SAMPLING.presencePenalty,
            // llama.cpp penalises every recent token, newlines included.
            penalizeNewLine: true
          }
        })
      } finally {
        completion.dispose()
        sequence.dispose()
      }
    },

    async dispose(): Promise<void> {
      if (context) await context.dispose()
      context = null
      await model.dispose()
    }
  }
}
