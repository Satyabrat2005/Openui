import { describe, it, expect } from 'vitest'
import { labelForModel } from './modelLabel'

describe('labelForModel', () => {
  it('splits a size tag and capitalises the family', () => {
    expect(labelForModel('llama3:8b')).toBe('Llama 3 8B')
    expect(labelForModel('qwen3.5:9b')).toBe('Qwen 3.5 9B')
  })

  it('drops a "latest" tag (it carries no size)', () => {
    expect(labelForModel('qwen2.5:latest')).toBe('Qwen 2.5')
  })

  it('drops the registry namespace, which names the publisher not the model', () => {
    expect(labelForModel('openui/splen:4b')).toBe('Splen 4B')
  })

  it('handles an id with no tag', () => {
    expect(labelForModel('mistral')).toBe('Mistral')
  })

  it('normalises hyphens and underscores to spaced words', () => {
    expect(labelForModel('deepseek-coder:6.7b')).toBe('Deepseek Coder 6.7B')
    expect(labelForModel('code_llama:13b')).toBe('Code Llama 13B')
  })
})
