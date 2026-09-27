/**
 * splen/prompt.ts — the exact text Splen is asked, and how its next token is drawn.
 *
 * WHY THIS IS A PORT, NOT A TEMPLATE. Every number Splen has ever earned — the
 * safety gate, the held-out memory and sending sets — was measured through
 * Ollama 0.31.2. For a model with a Go RENDERER (Splen's Modelfile copies
 * `RENDERER qwen3.5` from the app's previous model), Ollama does not use the
 * chat template inside the GGUF: it renders the prompt in Go and sends raw text
 * to llama-server's /completion. The in-app runtime has to send the same text,
 * byte for byte, or those numbers stop describing the model users get. So this
 * is a line-for-line port of `Qwen35Renderer.Render` at ollama v0.31.2
 * (model/renderers/qwen35.go) for the only shape the app sends: a system prompt,
 * then user/assistant turns, no native tools, no images, thinking off.
 *
 * Parity is proven, not assumed: the renderer is checked against Ollama's own
 * output before any gate number is reported for the in-app runtime.
 */

export interface SplenTurn {
  role: 'user' | 'assistant'
  content: string
}

const IM_START = '<|im_start|>'
const IM_END = '<|im_end|>'
const THINK_OPEN = '<think>'
const THINK_CLOSE = '</think>'

/**
 * Go's strings.TrimSpace trims Unicode White_Space; JS String.prototype.trim
 * trims WhiteSpace + LineTerminator. The two sets differ only in U+FEFF (JS
 * trims it, Go does not) and U+0085 (Go trims it, JS does not), so trim with
 * Go's set explicitly — a pasted message can carry either.
 */
const GO_SPACE = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000])

function isGoSpace(code: number): boolean {
  return GO_SPACE.has(code) || (code >= 0x2000 && code <= 0x200a)
}

function goTrimSpace(s: string): string {
  let start = 0
  let end = s.length
  while (start < end && isGoSpace(s.charCodeAt(start))) start++
  while (end > start && isGoSpace(s.charCodeAt(end - 1))) end--
  return s.slice(start, end)
}

/**
 * An earlier assistant turn keeps only its answer: any reasoning before a
 * `</think>` is dropped, as Ollama does with thinking off
 * (splitQwen35ReasoningContent with isThinking=false).
 */
function stripReasoning(content: string): string {
  const idx = content.indexOf(THINK_CLOSE)
  if (idx === -1) return content
  return content.slice(idx + THINK_CLOSE.length).replace(/^\n+/, '')
}

/**
 * Render a conversation the way Ollama 0.31.2 renders it for Splen with
 * `think: false`. The result ends with an open assistant turn and an empty
 * think block, so the model answers directly.
 */
export function renderSplenPrompt(systemPrompt: string, turns: SplenTurn[]): string {
  let out = `${IM_START}system\n${goTrimSpace(systemPrompt)}${IM_END}\n`
  turns.forEach((turn, i) => {
    const content = goTrimSpace(turn.content)
    const last = i === turns.length - 1
    if (turn.role === 'user') {
      out += `${IM_START}user\n${content}${IM_END}\n`
    } else {
      out += `${IM_START}assistant\n${stripReasoning(content)}`
      // A trailing assistant turn is a prefill: the model continues it.
      if (!last) out += `${IM_END}\n`
    }
  })
  const prefill = turns.length > 0 && turns[turns.length - 1].role === 'assistant'
  if (!prefill) out += `${IM_START}assistant\n${THINK_OPEN}\n\n${THINK_CLOSE}\n\n`
  return out
}

/**
 * Sampling, as Ollama sends it to llama-server for Splen: the Modelfile's four
 * PARAMETER lines (copied from qwen3.5:latest by package_splen4b.py) on top of
 * Ollama 0.31.2's DefaultOptions for everything else. min_p is not in
 * DefaultOptions, so Ollama sends Go's zero value — 0, not llama.cpp's own 0.05.
 */
export const SPLEN_SAMPLING = {
  temperature: 1,
  topK: 20,
  topP: 0.95,
  minP: 0,
  repeatPenalty: 1.1,
  repeatLastN: 64,
  presencePenalty: 1.5,
  frequencyPenalty: 0
} as const
