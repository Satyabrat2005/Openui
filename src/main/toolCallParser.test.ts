import { describe, it, expect, vi } from 'vitest'
import {
  extractFirstJsonObject,
  objToToolCall,
  parseToolCall,
  repairLooseJson,
  StreamGate
} from './toolCallParser'

// A stand-in tool registry for the embedded-recovery (pass 2) path. The real
// agent injects built-in + MCP tool names; the parser logic under test is
// identical regardless of which names are in the set.
const KNOWN = new Set(['open_app', 'search_files', 'read_screen', 'complete_step'])

describe('extractFirstJsonObject', () => {
  it('returns null when there is no object', () => {
    expect(extractFirstJsonObject('')).toBeNull()
    expect(extractFirstJsonObject('just prose, no braces')).toBeNull()
  })

  it('extracts a simple balanced object', () => {
    expect(extractFirstJsonObject('{"a":1}')).toBe('{"a":1}')
  })

  it('extracts a nested object without stopping at inner braces', () => {
    const src = '{"a":{"b":{"c":1}}}'
    expect(extractFirstJsonObject(src)).toBe(src)
  })

  it('ignores braces that live inside string values', () => {
    const src = '{"msg":"a } not the end { still string"}'
    expect(extractFirstJsonObject(src)).toBe(src)
  })

  it('respects escaped quotes inside strings', () => {
    const src = '{"msg":"she said \\"hi\\" }"}'
    expect(extractFirstJsonObject(src)).toBe(src)
  })

  it('stops at the first balanced close and tolerates trailing prose', () => {
    expect(extractFirstJsonObject('{"a":1}  and then some explanation')).toBe('{"a":1}')
  })

  it('skips leading prose to the first opening brace', () => {
    expect(extractFirstJsonObject('Sure! here it is: {"a":1} done')).toBe('{"a":1}')
  })

  it('returns null for an unbalanced (still-streaming) fragment', () => {
    expect(extractFirstJsonObject('{"a":{"b":1}')).toBeNull()
  })
})

describe('objToToolCall — shape and field aliases', () => {
  it('accepts the canonical {tool, args} shape', () => {
    expect(objToToolCall({ tool: 'open_app', args: { name: 'x' } }, false, KNOWN)).toEqual({
      tool: 'open_app',
      args: { name: 'x' }
    })
  })

  it('accepts tool-name aliases: tool_name and name', () => {
    expect(objToToolCall({ tool_name: 'open_app', args: {} }, false, KNOWN)?.tool).toBe('open_app')
    expect(objToToolCall({ name: 'open_app', args: {} }, false, KNOWN)?.tool).toBe('open_app')
  })

  it('accepts args aliases: arguments, parameters, input', () => {
    expect(objToToolCall({ tool: 'x', arguments: { a: 1 } }, false, KNOWN)?.args).toEqual({ a: 1 })
    expect(objToToolCall({ tool: 'x', parameters: { a: 2 } }, false, KNOWN)?.args).toEqual({ a: 2 })
    expect(objToToolCall({ tool: 'x', input: { a: 3 } }, false, KNOWN)?.args).toEqual({ a: 3 })
  })

  it('defaults args to {} when missing or not an object', () => {
    expect(objToToolCall({ tool: 'x' }, false, KNOWN)?.args).toEqual({})
    expect(objToToolCall({ tool: 'x', args: 'nope' }, false, KNOWN)?.args).toEqual({})
    expect(objToToolCall({ tool: 'x', args: [1, 2] }, false, KNOWN)?.args).toEqual({})
  })

  it('trims whitespace around the tool name', () => {
    expect(objToToolCall({ tool: '  open_app  ', args: {} }, false, KNOWN)?.tool).toBe('open_app')
  })

  it('rejects non-objects, arrays, and null', () => {
    expect(objToToolCall(null, false, KNOWN)).toBeNull()
    expect(objToToolCall('str', false, KNOWN)).toBeNull()
    expect(objToToolCall(42, false, KNOWN)).toBeNull()
    expect(objToToolCall([{ tool: 'x' }], false, KNOWN)).toBeNull()
  })

  it('rejects a missing or empty tool name', () => {
    expect(objToToolCall({ args: {} }, false, KNOWN)).toBeNull()
    expect(objToToolCall({ tool: '   ' }, false, KNOWN)).toBeNull()
    expect(objToToolCall({ tool: 123 }, false, KNOWN)).toBeNull()
  })

  it('honours requireKnown: unknown tools rejected only when required', () => {
    expect(objToToolCall({ tool: 'made_up', args: {} }, true, KNOWN)).toBeNull()
    // requireKnown=false lets an unknown/typo tool through (routes to MCP fallback).
    expect(objToToolCall({ tool: 'made_up', args: {} }, false, KNOWN)?.tool).toBe('made_up')
  })
})

describe('parseToolCall — pass 1 (clean/fenced leading JSON)', () => {
  it('parses a clean leading JSON object', () => {
    expect(parseToolCall('{"tool":"open_app","args":{"name":"Slack"}}', KNOWN)).toEqual({
      tool: 'open_app',
      args: { name: 'Slack' }
    })
  })

  it('accepts an UNKNOWN tool name in pass 1 (routes to MCP fallback)', () => {
    // Leading-JSON path does not require a known tool, preserving prior behaviour.
    expect(parseToolCall('{"tool":"some_mcp_tool","args":{}}', KNOWN)).toEqual({
      tool: 'some_mcp_tool',
      args: {}
    })
  })

  it('unwraps a ```json fenced object', () => {
    const msg = '```json\n{"tool":"search_files","args":{"q":"todo"}}\n```'
    expect(parseToolCall(msg, KNOWN)).toEqual({ tool: 'search_files', args: { q: 'todo' } })
  })

  it('unwraps a plain ``` fenced object', () => {
    const msg = '```\n{"tool":"open_app","args":{}}\n```'
    expect(parseToolCall(msg, KNOWN)).toEqual({ tool: 'open_app', args: {} })
  })
})

describe('parseToolCall — pass 2 (embedded recovery, known-tool gated)', () => {
  it('recovers a known tool call after chatty prose', () => {
    const msg = 'Sure, I will do that now: {"tool":"open_app","args":{"name":"Notes"}}'
    expect(parseToolCall(msg, KNOWN)).toEqual({ tool: 'open_app', args: { name: 'Notes' } })
  })

  it('recovers a real call after a hallucinated TOOL RESULT preamble', () => {
    const msg = 'TOOL RESULT: done.\nNow calling: {"tool":"read_screen","args":{}}'
    expect(parseToolCall(msg, KNOWN)).toEqual({ tool: 'read_screen', args: {} })
  })

  it('does NOT execute an embedded object naming an unknown tool', () => {
    // Safety: prose containing an unrelated JSON object must never be executed.
    expect(parseToolCall('Here is some config: {"tool":"rm_rf","args":{}}', KNOWN)).toBeNull()
  })

  it('skips a leading non-tool object and finds the real call after it', () => {
    const msg = 'Context {"note":"ignore me"} then {"tool":"open_app","args":{}}'
    expect(parseToolCall(msg, KNOWN)).toEqual({ tool: 'open_app', args: {} })
  })

  it('returns null for pure natural language', () => {
    expect(parseToolCall('I opened Slack for you — anything else?', KNOWN)).toBeNull()
  })

  it('returns null for prose that merely mentions JSON but has no tool object', () => {
    expect(parseToolCall('The response was {"status":"ok","count":3}.', KNOWN)).toBeNull()
  })

  it('returns null for empty/whitespace input', () => {
    expect(parseToolCall('', KNOWN)).toBeNull()
    expect(parseToolCall('   ', KNOWN)).toBeNull()
  })

  it('with no known tools, disables embedded recovery', () => {
    // Default empty set — pass 2 cannot confirm any tool, so prose stays inert.
    expect(parseToolCall('do it: {"tool":"open_app","args":{}}')).toBeNull()
    // ...but a clean leading object still parses (pass 1 does not require known).
    expect(parseToolCall('{"tool":"open_app","args":{}}')).toEqual({ tool: 'open_app', args: {} })
  })
})

// Regression: local models writing a multi-line file with write_file routinely
// put LITERAL newlines inside the JSON string instead of "\n". That is invalid
// JSON, so a strict JSON.parse threw and the whole tool call was silently
// dropped — the builder wrote a couple of files then stalled. The parser now
// repairs raw control chars inside strings before giving up.
describe('parseToolCall — tolerates raw control chars in string values', () => {
  const KNOWN_BUILD = new Set(['write_file', 'run_script'])

  it('recovers a write_file whose content has raw (unescaped) newlines', () => {
    const raw = '{"tool":"write_file","args":{"path":"build.js","content":"const x=1;\nconsole.log(x);\n"}}'
    // Precondition: this really is invalid JSON as-is.
    expect(() => JSON.parse(raw)).toThrow()

    const call = parseToolCall(raw, KNOWN_BUILD)
    expect(call?.tool).toBe('write_file')
    expect(call?.args.path).toBe('build.js')
    expect(call?.args.content).toBe('const x=1;\nconsole.log(x);\n')
  })

  it('recovers raw newlines/tabs when the call is embedded in prose (pass 2)', () => {
    const raw = 'Sure!\n{"tool":"write_file","args":{"path":"a.py","content":"def f():\n\treturn 1"}}'
    const call = parseToolCall(raw, KNOWN_BUILD)
    expect(call?.tool).toBe('write_file')
    expect(call?.args.content).toBe('def f():\n\treturn 1')
  })

  it('leaves already-valid JSON untouched', () => {
    const valid = JSON.stringify({ tool: 'run_script', args: { script: 'build' } })
    expect(repairLooseJson(valid)).toBe(valid)
    expect(parseToolCall(valid, KNOWN_BUILD)).toEqual({ tool: 'run_script', args: { script: 'build' } })
  })

  it('repairLooseJson only escapes control chars INSIDE strings, not structural whitespace', () => {
    // The newline between key/value is structural and must stay a real newline;
    // the newline inside the value must become \n.
    const src = '{\n  "k": "a\nb"\n}'
    const repaired = repairLooseJson(src)
    expect(JSON.parse(repaired)).toEqual({ k: 'a\nb' })
  })
})

describe('StreamGate — tool responses are withheld from the UI', () => {
  it('withholds a JSON tool response entirely and keeps it hidden on a real call', () => {
    const forward = vi.fn()
    const gate = new StreamGate(forward)
    for (const t of ['{"tool"', ':"open', '_app","args":{}}']) gate.push(t)
    expect(forward).not.toHaveBeenCalled()
    gate.finalize(true) // it was a real tool call
    expect(forward).not.toHaveBeenCalled()
  })

  it('reveals the whole buffer when a JSON-looking response was NOT a tool call', () => {
    const forward = vi.fn()
    const gate = new StreamGate(forward)
    gate.push('{"status":"ok"}')
    expect(forward).not.toHaveBeenCalled()
    gate.finalize(false) // false positive — reveal it
    expect(forward).toHaveBeenCalledWith('{"status":"ok"}')
  })

  it('withholds a fenced (```) response until finalize', () => {
    const forward = vi.fn()
    const gate = new StreamGate(forward)
    gate.push('```')
    gate.push('json\n{"tool":"open_app","args":{}}\n```')
    expect(forward).not.toHaveBeenCalled()
    gate.finalize(true)
    expect(forward).not.toHaveBeenCalled()
  })

  it('waits on a lone backtick until it can tell fence from prose', () => {
    const forward = vi.fn()
    const gate = new StreamGate(forward)
    gate.push('`') // could be inline code or a fence — undecided
    expect(forward).not.toHaveBeenCalled()
    gate.push('`x') // now 3+ leading chars starting with ` → treated as fenced/tool
    expect(forward).not.toHaveBeenCalled()
  })
})

describe('StreamGate — text responses stream live', () => {
  it('forwards natural-language deltas as they arrive', () => {
    const chunks: string[] = []
    const gate = new StreamGate((d) => chunks.push(d))
    gate.push('Hello ')
    gate.push('there!')
    gate.finalize(false)
    expect(chunks.join('')).toBe('Hello there!')
  })

  it('waits through leading whitespace before classifying', () => {
    const forward = vi.fn()
    const gate = new StreamGate(forward)
    gate.push('   ')
    expect(forward).not.toHaveBeenCalled() // nothing emitted while only whitespace seen
    gate.push('hi')
    // Once classified as text the whole buffer flushes; whitespace is stripped
    // only for classification, not from the output.
    expect(forward).toHaveBeenCalledWith('   hi')
  })

  it('streams prose but holds a trailing JSON tail, dropping it when it was a tool call', () => {
    const chunks: string[] = []
    const gate = new StreamGate((d) => chunks.push(d))
    gate.push('Okay! ')
    gate.push('{"tool":"open_app","args":{}}')
    expect(chunks.join('')).toBe('Okay! ') // prose forwarded, brace tail held back
    gate.finalize(true) // the tail was a real tool call → stays hidden
    expect(chunks.join('')).toBe('Okay! ')
  })

  it('reveals a held tail when it turns out to be a stray brace, not a tool call', () => {
    const chunks: string[] = []
    const gate = new StreamGate((d) => chunks.push(d))
    gate.push('Your total is ')
    gate.push('{5 items}') // a literal brace in prose, not JSON
    expect(chunks.join('')).toBe('Your total is ')
    gate.finalize(false) // not a tool call → reveal the tail
    expect(chunks.join('')).toBe('Your total is {5 items}')
  })

  it('ignores empty deltas', () => {
    const forward = vi.fn()
    const gate = new StreamGate(forward)
    gate.push('')
    expect(forward).not.toHaveBeenCalled()
  })
})
