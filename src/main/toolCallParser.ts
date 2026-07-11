/**
 * Tool-call parsing and stream gating — the code that decides whether a model
 * response becomes an *executed OS action* or a natural-language answer, and what
 * the user is allowed to see while that decision is being made.
 *
 * This logic is deliberately isolated here (with no Electron/native imports) so
 * it can be unit-tested in a plain Node environment. `agent.ts` re-exports these
 * symbols and supplies the live tool registry to `parseToolCall`.
 */

export interface ToolCall {
  tool: string
  args: Record<string, unknown>
}

/**
 * Extract the first *balanced* JSON object from `text`, starting at the first
 * `{`. String-aware so braces inside string values don't end the object early,
 * and tolerant of trailing prose/newlines after the closing `}` (models often
 * append an explanation). Returns the object's source text, or null.
 */
export function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null // unbalanced — likely a still-streaming fragment
}

/**
 * Repair the one thing local models break most often: raw (unescaped) control
 * characters — newlines, tabs, carriage returns — inside a JSON string value.
 *
 * A model writing a multi-line file with write_file routinely emits the LITERAL
 * newline instead of "\n", e.g.  {"tool":"write_file","args":{"content":"line1
 * line2"}}  — which is invalid JSON, so JSON.parse throws and the tool call is
 * silently dropped, stalling the whole automation. We re-scan and escape only
 * control chars that sit INSIDE a string (structural whitespace between tokens
 * is left untouched), so the caller can re-parse. Valid JSON is returned
 * unchanged, so this is a safe second attempt, never a first-choice parser.
 */
export function repairLooseJson(src: string): string {
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (inString) {
      if (escaped) {
        out += ch
        escaped = false
        continue
      }
      if (ch === '\\') {
        out += ch
        escaped = true
        continue
      }
      if (ch === '"') {
        out += ch
        inString = false
        continue
      }
      // Escape control characters that are illegal unescaped inside a JSON string.
      if (ch === '\n') out += '\\n'
      else if (ch === '\r') out += '\\r'
      else if (ch === '\t') out += '\\t'
      else out += ch
      continue
    }
    if (ch === '"') inString = true
    out += ch
  }
  return out
}

/**
 * Parse a candidate JSON object, tolerating the raw-control-char breakage above.
 * Strict parse first (the common case); on failure, retry once on the repaired
 * text. Returns undefined when neither parse succeeds.
 */
function tryParseJson(jsonText: string): unknown {
  try {
    return JSON.parse(jsonText)
  } catch {
    /* fall through to the lenient repair */
  }
  try {
    return JSON.parse(repairLooseJson(jsonText))
  } catch {
    return undefined
  }
}

/**
 * Coerce a parsed JSON object into a ToolCall, accepting the field aliases real
 * models emit (tool/name/tool_name, args/arguments/parameters/input). Returns
 * null when it isn't tool-shaped. When `requireKnown` is set, the tool name must
 * match a real registered tool — used for the embedded-scan path so prose that
 * merely contains a JSON object isn't mistaken for a tool call.
 */
export function objToToolCall(
  parsed: unknown,
  requireKnown: boolean,
  knownTools: Set<string>
): ToolCall | null {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const obj = parsed as Record<string, unknown>
  const toolRaw = obj.tool ?? obj.tool_name ?? obj.name
  if (typeof toolRaw !== 'string' || !toolRaw.trim()) return null
  const tool = toolRaw.trim()
  if (requireKnown && !knownTools.has(tool)) return null

  const argsRaw = obj.args ?? obj.arguments ?? obj.parameters ?? obj.input
  const args =
    typeof argsRaw === 'object' && argsRaw !== null && !Array.isArray(argsRaw)
      ? (argsRaw as Record<string, unknown>)
      : {}
  return { tool, args }
}

/**
 * Parse a model response into a tool call, or null for a natural-language answer.
 *
 * Robust by design — real models (especially local Ollama models) rarely follow
 * the "respond with ONLY raw JSON" contract. They wrap calls in markdown fences,
 * prepend chatty prose ("Sure, I'll do that: {...}"), or even hallucinate a fake
 * "TOOL RESULT: …" sentence with the real call buried after it. We recover the
 * call in two passes:
 *
 *   1. Fast path — the message is tool-shaped (optionally fenced, then begins
 *      with `{`). Any tool name is accepted here so an unknown/typo'd name still
 *      routes through executeTool → the MCP fallback, preserving prior behaviour.
 *   2. Embedded path — otherwise, scan the whole message for the FIRST balanced
 *      JSON object whose tool field names a REAL registered tool. The
 *      known-tool requirement is what makes this safe: a natural-language answer
 *      that merely mentions JSON, or contains an unrelated `{...}`, is never
 *      executed. This is what rescues "prose then {tool json}" responses.
 *
 * `knownTools` is injected by the caller (agent.ts supplies built-in + MCP tool
 * names). It only gates pass 2; an empty set disables embedded recovery.
 */
export function parseToolCall(text: string, knownTools: Set<string> = new Set()): ToolCall | null {
  if (!text) return null

  let candidate = text.trim()
  // Unwrap a full markdown code fence: ```json\n{...}\n```  or  ```\n{...}\n```
  const fence = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fence) candidate = fence[1].trim()

  // ── Pass 1: clean leading JSON (the contract the prompt asks for) ──────────
  if (candidate.startsWith('{')) {
    const jsonText = extractFirstJsonObject(candidate)
    if (jsonText) {
      const parsed = tryParseJson(jsonText)
      if (parsed !== undefined) {
        const call = objToToolCall(parsed, false, knownTools)
        if (call) return call
      }
    }
  }

  // ── Pass 2: recover a tool call embedded in prose/fences anywhere in text ──
  // Scan every `{` position; the first balanced object that names a known tool
  // wins. Bounded by the number of `{` characters, so it's cheap.
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    const jsonText = extractFirstJsonObject(text.slice(start))
    if (!jsonText) continue
    const parsed = tryParseJson(jsonText)
    if (parsed === undefined) continue // unbalanced or invalid here — try the next `{`
    const call = objToToolCall(parsed, true, knownTools)
    if (call) return call
  }

  return null
}

/**
 * Buffers a streaming model response and decides, from the first non-whitespace
 * characters, whether it is a tool call (JSON object, optionally fenced) or a
 * natural-language answer:
 *
 *   • tool-shaped  → WITHHELD from the UI (the user must never see raw tool JSON);
 *   • text-shaped  → flushed and then streamed live, token by token.
 *
 * This is the architectural fix for "the assistant prints JSON": the gate sits
 * between every model transport and the renderer, so JSON can never reach the UI
 * regardless of which provider produced it. `finalize()` performs false-positive
 * recovery — if something looked like JSON but wasn't a real tool call, it is
 * flushed so the user still sees the answer.
 */
export class StreamGate {
  private buffer = ''
  private decided: 'tool' | 'text' | null = null
  /** Chars of `buffer` already forwarded to the UI (text mode only). */
  private forwardedLen = 0

  constructor(private readonly forward: (delta: string) => void) {}

  /** Feed one streamed delta. Forwards to the UI only once classified as text. */
  push = (delta: string): void => {
    if (!delta) return
    this.buffer += delta

    if (this.decided === 'tool') return // pure tool JSON — keep withholding entirely

    if (this.decided === null) {
      // Inspect the leading non-whitespace character(s) to classify the response.
      const lead = this.buffer.replace(/^\s+/, '')
      if (lead === '') return // only whitespace so far — wait for more
      if (lead[0] === '`') {
        // Possibly the start of a ``` code fence — wait until we can be sure.
        if (lead.length < 3) return
        this.decided = 'tool'
        return
      }
      if (lead[0] === '{') {
        this.decided = 'tool'
        return
      }
      this.decided = 'text' // natural language — fall through to incremental flush
    }

    // Text mode: stream live, but never reveal a JSON tail. Models often append
    // a tool call AFTER chatty prose ("Okay! {\"tool\":…}"); we forward only up
    // to the first `{` and hold the rest until finalize decides whether it was a
    // real tool call (dropped) or just a stray brace in prose (flushed).
    this.flushTextUpToJson()
  }

  /** Forward buffered text up to (but not including) the first `{`. */
  private flushTextUpToJson(): void {
    const brace = this.buffer.indexOf('{', this.forwardedLen)
    const safeEnd = brace === -1 ? this.buffer.length : brace
    if (safeEnd > this.forwardedLen) {
      this.forward(this.buffer.slice(this.forwardedLen, safeEnd))
      this.forwardedLen = safeEnd
    }
  }

  /**
   * Call once the full response is known and classified by the agent.
   *   • tool-shaped but NOT a real call → reveal everything (false positive);
   *   • text with a held JSON tail that WASN'T a tool call → reveal the tail;
   *   • text with a held tail that WAS a tool call → leave it hidden (dropped).
   */
  finalize(isToolCall: boolean): void {
    if (this.decided === 'tool') {
      if (!isToolCall) this.forward(this.buffer)
      return
    }
    if (this.decided === 'text' && !isToolCall && this.forwardedLen < this.buffer.length) {
      this.forward(this.buffer.slice(this.forwardedLen))
      this.forwardedLen = this.buffer.length
    }
  }
}
