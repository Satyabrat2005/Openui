import { describe, it, expect, vi } from 'vitest'
import {
  closeUnbalancedJsonObject,
  extractFirstJsonObject,
  looksLikeAttemptedToolCall,
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

describe('looksLikeAttemptedToolCall', () => {
  it('flags a JSON object describing a project instead of calling a tool', () => {
    const blob = '{"projectName":"my-site","files":["index.html","style.css"],"stack":"static"}'
    expect(looksLikeAttemptedToolCall(blob)).toBe(true)
  })

  it('flags a fenced JSON manifest with no tool field', () => {
    // "projectName", not "name" — objToToolCall treats "name" as a tool-name
    // alias by design (see its docblock), so a key that collides with that
    // alias is a real (if hallucinated) tool call, not malformed JSON.
    const blob = '```json\n{"projectName":"app","dependencies":{"react":"^18"}}\n```'
    expect(looksLikeAttemptedToolCall(blob)).toBe(true)
  })

  it('does not flag a real tool call, even with an unknown/hallucinated tool name', () => {
    // A wrong tool name is a genuine (if bad) call attempt — it should route to
    // the normal "Unknown tool" execute path, not be treated as malformed JSON.
    expect(looksLikeAttemptedToolCall('{"tool":"write_file","args":{"path":"a.js"}}')).toBe(false)
    expect(looksLikeAttemptedToolCall('{"tool":"scaffold_project","args":{}}')).toBe(false)
  })

  it('does not flag plain prose', () => {
    expect(looksLikeAttemptedToolCall('Here is a summary of what I built.')).toBe(false)
    expect(looksLikeAttemptedToolCall('')).toBe(false)
  })

  it('does not flag prose that merely mentions a brace', () => {
    expect(looksLikeAttemptedToolCall('The count is {5} today.')).toBe(false)
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

// The classifier is a three-state machine (null → 'tool' | 'text'), and the
// interesting bugs live in the transitions rather than the steady states: a
// stream that ends while still undecided, a text stream holding a tail that
// never resolves, and repeated braces after the hold point.
describe('StreamGate — classification edge cases', () => {
  it('emits nothing for an empty response (never classified)', () => {
    const forward = vi.fn()
    const gate = new StreamGate(forward)
    gate.finalize(false) // stream ended before a single delta arrived
    expect(forward).not.toHaveBeenCalled()
  })

  it('does not leak a whitespace-only response as a visible message', () => {
    // Whitespace alone never classifies, so nothing is forwarded — the user
    // sees no empty bubble.
    const forward = vi.fn()
    const gate = new StreamGate(forward)
    gate.push('  \n\t ')
    gate.finalize(false)
    expect(forward).not.toHaveBeenCalled()
  })

  // A stream ending on 1–2 leading backticks stays undecided forever, so the
  // buffer is dropped. Documented deliberately: withholding a truncated fence
  // is the safe direction (it can only ever be a fence or inline code, and
  // showing a dangling ``` is worse than showing nothing).
  it('withholds a truncated 1–2 backtick response rather than guessing', () => {
    const forward = vi.fn()
    const gate = new StreamGate(forward)
    gate.push('``')
    gate.finalize(false)
    expect(forward).not.toHaveBeenCalled()
  })

  it('classifies as text on the first non-whitespace, non-brace, non-backtick char', () => {
    const chunks: string[] = []
    const gate = new StreamGate((d) => chunks.push(d))
    gate.push('\n\n') // still undecided
    expect(chunks).toHaveLength(0)
    gate.push('Here you go.')
    expect(chunks.join('')).toBe('\n\nHere you go.')
  })

  // Once text mode holds at the first `{`, everything after it stays held —
  // including later prose and further braces. finalize must then reveal that
  // whole tail exactly once, with no duplication and nothing dropped.
  it('reveals a multi-brace tail exactly once, losing no characters', () => {
    const chunks: string[] = []
    const gate = new StreamGate((d) => chunks.push(d))
    gate.push('Totals: ')
    gate.push('{a} then {b} ')
    gate.push('and done.')
    expect(chunks.join('')).toBe('Totals: ') // held from the first brace on

    gate.finalize(false)
    expect(chunks.join('')).toBe('Totals: {a} then {b} and done.')
  })

  it('drops the whole held tail when it was a real tool call, keeping the prose', () => {
    const chunks: string[] = []
    const gate = new StreamGate((d) => chunks.push(d))
    gate.push('On it. ')
    gate.push('{"tool":"open_app",')
    gate.push('"args":{"name":"Slack"}}')
    gate.finalize(true)
    expect(chunks.join('')).toBe('On it. ')
    expect(chunks.join('')).not.toContain('{')
  })

  // A brace arriving in the very same delta that classifies the response must
  // not slip through: classification and the hold point are computed from the
  // buffer, not from the individual delta.
  it('holds a brace that arrives in the same delta as the classifying text', () => {
    const chunks: string[] = []
    const gate = new StreamGate((d) => chunks.push(d))
    gate.push('Sure: {"tool":"open_app","args":{}}')
    expect(chunks.join('')).toBe('Sure: ')
    gate.finalize(true)
    expect(chunks.join('')).toBe('Sure: ')
  })

  it('a tool-classified stream forwards nothing mid-stream, however many deltas arrive', () => {
    const forward = vi.fn()
    const gate = new StreamGate(forward)
    for (const d of ['{', '"tool"', ':', '"delete_file"', ',"args":{"path":"~/a"}}']) gate.push(d)
    expect(forward).not.toHaveBeenCalled()
  })
})

// ── Unclosed-object recovery (pass 3) ───────────────────────────────────────
// Regression cover for a build that wrote ZERO files on merged main: asked for
// a 10-file site, qwen2.5-coder:7b emitted a write_file call whose OUTER brace
// it never closed. Both balanced passes returned null, the turn parsed as
// prose, no tool ran, and the builder "finished" with an empty project folder.
describe('closeUnbalancedJsonObject', () => {
  it('returns null for an already-balanced object (strict path owns that case)', () => {
    expect(closeUnbalancedJsonObject('{"a":1}')).toBeNull()
    expect(closeUnbalancedJsonObject('{"a":{"b":2}}')).toBeNull()
  })

  it('returns null when there is no object at all', () => {
    expect(closeUnbalancedJsonObject('just prose')).toBeNull()
    expect(closeUnbalancedJsonObject('')).toBeNull()
  })

  it('closes a single missing brace', () => {
    expect(closeUnbalancedJsonObject('{"a":{"b":2}')).toBe('{"a":{"b":2}}')
  })

  it('closes several missing braces', () => {
    expect(closeUnbalancedJsonObject('{"a":{"b":{"c":1}')).toBe('{"a":{"b":{"c":1}}}')
  })

  // The important refusal: a response cut off mid-string is genuinely truncated.
  // Closing it would hand write_file a half-written `content` and silently
  // truncate a real file — worse than dropping the call.
  it('REFUSES to recover a response that ends inside an unterminated string', () => {
    expect(closeUnbalancedJsonObject('{"tool":"write_file","args":{"content":"half a fi')).toBeNull()
  })

  it('does not mistake braces inside a string for structure', () => {
    // The `{` inside the string value must not add depth.
    expect(closeUnbalancedJsonObject('{"a":"a { brace"')).toBe('{"a":"a { brace"}')
  })

  it('drops a dangling code fence before closing', () => {
    expect(closeUnbalancedJsonObject('{"a":1\n```')).toBe('{"a":1}')
  })
})

describe('parseToolCall — unclosed object recovery', () => {
  // The EXACT shape streamed by the live app (fenced, outer brace missing).
  const LIVE_BYTES =
    '```json\n{\n  "tool": "search_files",\n  "args": {\n    "path": "package.json",\n    "content": "{\n  \\"name\\": \\"bookshop\\"\n}"\n}\n```'

  it('recovers the live unclosed tool call, with its content intact', () => {
    const call = parseToolCall(LIVE_BYTES, KNOWN)
    expect(call).not.toBeNull()
    expect(call?.tool).toBe('search_files')
    // The escaped JSON the model was writing into the file survives untouched.
    expect(call?.args.content).toBe('{\n  "name": "bookshop"\n}')
    expect(call?.args.path).toBe('package.json')
  })

  it('still refuses an unclosed call naming an UNKNOWN tool', () => {
    // Pass 3 is guessing at structure, so it must not invent calls from prose.
    const text = '{"tool":"not_a_real_tool","args":{"a":1}'
    expect(parseToolCall(text, KNOWN)).toBeNull()
  })

  it('does not recover a truncated call (ends mid-string) even for a known tool', () => {
    const text = '{"tool":"open_app","args":{"name":"Sla'
    expect(parseToolCall(text, KNOWN)).toBeNull()
  })

  it('leaves balanced parsing untouched', () => {
    const call = parseToolCall('{"tool":"open_app","args":{"name":"Slack"}}', KNOWN)
    expect(call).toEqual({ tool: 'open_app', args: { name: 'Slack' } })
  })

  it('does not turn ordinary prose containing a stray brace into a tool call', () => {
    expect(parseToolCall('I would use { to open a block here.', KNOWN)).toBeNull()
  })
})
