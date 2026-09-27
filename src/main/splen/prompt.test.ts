import { describe, it, expect } from 'vitest'
import { renderSplenPrompt, SPLEN_SAMPLING } from './prompt'

/**
 * The expected strings are hand-derived from ollama v0.31.2
 * model/renderers/qwen35.go (Qwen35Renderer, isThinking=true by default,
 * emitEmptyThinkOnNoThink=true, called with think=false and no tools). If one
 * of these changes, every Splen number measured under Ollama stops applying.
 */
describe('renderSplenPrompt', () => {
  it('renders one user turn with an empty think block to answer after', () => {
    expect(renderSplenPrompt('You are Splen.', [{ role: 'user', content: 'hi' }])).toBe(
      '<|im_start|>system\nYou are Splen.<|im_end|>\n' +
        '<|im_start|>user\nhi<|im_end|>\n' +
        '<|im_start|>assistant\n<think>\n\n</think>\n\n'
    )
  })

  it('renders earlier assistant turns without a think block', () => {
    expect(
      renderSplenPrompt('S', [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c' }
      ])
    ).toBe(
      '<|im_start|>system\nS<|im_end|>\n' +
        '<|im_start|>user\na<|im_end|>\n' +
        '<|im_start|>assistant\nb<|im_end|>\n' +
        '<|im_start|>user\nc<|im_end|>\n' +
        '<|im_start|>assistant\n<think>\n\n</think>\n\n'
    )
  })

  it('drops reasoning an earlier reply carried, as Ollama does with thinking off', () => {
    const out = renderSplenPrompt('S', [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: '<think>\nplan\n</think>\n\nanswer' },
      { role: 'user', content: 'c' }
    ])
    expect(out).toContain('<|im_start|>assistant\nanswer<|im_end|>\n')
    expect(out).not.toContain('plan')
  })

  it('trims each turn the way Go trims it', () => {
    // U+0085 is whitespace to Go but not to String.prototype.trim; U+FEFF the reverse.
    const NEL = String.fromCharCode(0x85)
    const BOM = String.fromCharCode(0xfeff)
    const out = renderSplenPrompt('  S\n', [{ role: 'user', content: `${NEL} hi \n` }])
    expect(out).toContain('<|im_start|>system\nS<|im_end|>')
    expect(out).toContain('<|im_start|>user\nhi<|im_end|>')
    expect(renderSplenPrompt('S', [{ role: 'user', content: `${BOM}hi` }])).toContain(`user\n${BOM}hi<|im_end|>`)
  })

  it('continues a trailing assistant turn instead of opening a new one', () => {
    const out = renderSplenPrompt('S', [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'partial' }
    ])
    expect(out.endsWith('<|im_start|>assistant\npartial')).toBe(true)
  })

  it('still writes the system block when the system prompt is empty', () => {
    expect(renderSplenPrompt('', [{ role: 'user', content: 'a' }]).startsWith('<|im_start|>system\n<|im_end|>\n')).toBe(
      true
    )
  })

  it('leaves message text alone apart from the trim — tool-call JSON included', () => {
    const call = '{"tool":"send_email","args":{"to":"a@b.co","body":"line1\\nline2"}}'
    expect(renderSplenPrompt('S', [{ role: 'user', content: call }])).toContain(`user\n${call}<|im_end|>`)
  })
})

describe('SPLEN_SAMPLING', () => {
  it('is the Modelfile PARAMETERs on top of Ollama 0.31.2 defaults', () => {
    // Modelfile: presence_penalty 1.5, temperature 1, top_k 20, top_p 0.95.
    // Ollama DefaultOptions: repeat_penalty 1.1, repeat_last_n 64, frequency 0;
    // min_p is absent there, so Ollama sends 0 rather than llama.cpp's 0.05.
    expect(SPLEN_SAMPLING).toEqual({
      temperature: 1,
      topK: 20,
      topP: 0.95,
      minP: 0,
      repeatPenalty: 1.1,
      repeatLastN: 64,
      presencePenalty: 1.5,
      frequencyPenalty: 0
    })
  })
})
