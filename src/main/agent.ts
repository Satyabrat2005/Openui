import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { Ollama } from 'ollama'
import { BrowserWindow, ipcMain } from 'electron'
import { toolSchemas, executeTool, describeToolCall, type ToolSchema, type ToolResult, type PendingApprovalResult, type Tier } from './tools'
import { getMcpToolSchemas, callMcpTool } from './mcp-client'
import { database } from './database'
import { clampTierToEntitlement } from './stripe/pricing'
import { getCurrentUserId } from './stripe/subscriptionSync'
import {
  isOllamaRunning,
  isCloudProxyConfigured,
  callCloudProxy,
  classifyTaskComplexity,
  emitLocalUsage
} from './cloudFreeTier'
import { trackEvent } from './telemetry/posthog'
import { Events } from './telemetry/events'
import { classifyFeedbackSignal, getCustomSystemPrompt } from './improvement'

export interface Message {
  role: 'user' | 'assistant'
  content: string
}

export interface ToolCall {
  tool: string
  args: Record<string, unknown>
}

type TaskStatus = 'pending' | 'working' | 'done' | 'error'

interface TaskUpdate {
  id: string
  label: string
  status: TaskStatus
  detail?: string
}

const history: Message[] = []
let currentConversationId: string | null = null

// Safety bound on the agentic loop so a model that keeps emitting tool calls
// (or loops on a failing tool) can never spin forever.
const MAX_TOOL_TURNS = 8

let taskSeq = 0

// ── HITL (Human-in-the-Loop) ──────────────────────────────────────────────────

/** Resolvers keyed by request id, awaited while the renderer shows HitlModal. */
const pendingHitlRequests = new Map<string, (approved: boolean) => void>()
let hitlSeq = 0

/**
 * Emit a HITL request to the renderer and return a Promise that resolves once
 * the user clicks Allow (true) or Deny (false) in the HitlModal.
 */
function waitForHitlApproval(
  win: BrowserWindow,
  tool: string,
  args: Record<string, unknown>
): Promise<boolean> {
  const id = `hitl${++hitlSeq}`
  return new Promise<boolean>((resolve) => {
    pendingHitlRequests.set(id, resolve)
    emit(win, 'openui:hitl:request', { id, tool, args, label: describeToolCall(tool, args) })
  })
}

/** Render one tool schema as a compact signature line for the system prompt. */
function renderSchema(schema: ToolSchema): string {
  const params = Object.entries(schema.parameters.properties)
    .map(([key, spec]) => {
      const optional = schema.parameters.required.includes(key) ? '' : '?'
      const choices = spec.enum ? ` (${spec.enum.join('|')})` : ''
      return `${key}${optional}: ${spec.type}${choices}`
    })
    .join(', ')
  return `- ${schema.name}(${params}) — ${schema.description}`
}

/**
 * The system prompt for the interactive assistant. Prefers the locally-refined
 * prompt produced by the weekly self-improvement job (promptRefiner.ts) when one
 * exists and the AI-Improvement toggle is on; otherwise uses the built-in
 * default. The refiner is instructed to preserve the tool list verbatim, so the
 * learned prompt still carries an accurate "Available tools" section.
 */
function buildSystemPrompt(): string {
  return getCustomSystemPrompt() ?? buildDefaultSystemPrompt()
}

export function buildDefaultSystemPrompt(): string {
  const allSchemas: ToolSchema[] = [...toolSchemas, ...getMcpToolSchemas()]
  return `You are OpenUI, an intelligent desktop assistant running as a menu-bar app. You help users get things done on their computer through natural conversation.

You can control the operating system by calling tools. To call a tool, respond with ONLY a raw JSON object — no prose before or after it, and NO markdown code fences:
{"tool": "tool_name", "args": {"key": "value"}}

The very first character of a tool-call message MUST be "{". Do not say things like "Sure, I'll do that" before the JSON, and never wrap it in markdown code fences (no triple-backtick blocks).

After each tool runs you (and ONLY you) will receive a message starting with "TOOL RESULT" describing what actually happened. Use it to decide the next step. Chain as many tool calls as the task needs — one per message. When the task is complete, reply to the user in plain natural language (never wrap your final answer in JSON).

CRITICAL RULES — these are the difference between working and broken:
- To DO anything on the computer (open an app/folder, search files, browse the web, edit the calendar) you MUST emit the tool-call JSON. Describing the action in words does NOT perform it.
- NEVER write a line that starts with "TOOL RESULT" yourself — that text only ever comes from the system after a real tool runs. If you write it, the action never happened.
- NEVER invent or describe results you have not received: do not claim a folder "has been opened", do not fabricate file paths or search results, do not say a page "has navigated". Call the tool and wait for the real TOOL RESULT.
- You are NOT "just a menu-bar app that can't open files". You CAN control this computer through the tools below. Use them.
- A tool call is the WHOLE message: the first character is "{" and there is nothing before or after it.

Available tools:
${allSchemas.map(renderSchema).join('\n')}

Examples — map the request to a single tool-call message (emit ONLY the JSON):
- "open the OpenUI folder" / "open Downloads" → {"tool": "open_app", "args": {"appName": "C:\\\\Users\\\\You\\\\Downloads"}}
- "open Spotify" / "launch Chrome" → {"tool": "open_app", "args": {"appName": "Spotify"}}
- "find a file named report" / "search my files for budget" → {"tool": "search_files", "args": {"query": "report"}}
- "check my email" / "open Gmail in the browser" → {"tool": "browser_navigate", "args": {"url": "https://mail.google.com/"}}
- "schedule a meeting tomorrow at 3pm" → {"tool": "control_calendar", "args": {"action": "create", "eventDetails": {"title": "Meeting", "start": "2025-01-01T15:00:00"}}}

Browser automation workflow — use this for ALL web-based tasks (booking flights, scraping websites, filling web forms, reading prices, searching the web). Playwright targets elements directly by CSS selector: faster, more reliable, and more precise than pixel-coordinate clicking:
1. Call browser_navigate(url) — opens the URL in a visible Chromium window the user can watch.
2. Call browser_extract_text() — reads the page body to understand the layout, find form labels, or scrape data.
3. Call browser_click(selector) or browser_fill_input(selector, text) to interact with the page.
4. Repeat steps 2–3 as needed until the task is done.
Examples of tasks that MUST use this workflow: "book a flight", "check flight prices", "search Google", "scrape a website", "fill out a web form", "log into a website".

Screen navigation workflow — use this ONLY for native desktop apps with no web interface (e.g. VS Code panels, macOS system dialogs, Electron apps):
1. Call read_screen() — it returns a description of every visible UI element with approximate X,Y coordinates.
2. Identify the target element's coordinates from the description.
3. Call move_mouse(x, y) to position the pointer over it.
4. Call left_click() to activate it.

For anything that does not require a system action, just reply in plain text.

GitHub PR review workflow — use this when the user asks to "Review my PRs" or "review pull requests":
1. Call list_open_prs(repo) — use the repo the user mentions, or the value of GITHUB_REPO env var if they say "my PRs".
2. For each open PR, call get_pr_diff(repo, pr_number) to fetch the code changes.
3. Analyse the diff in depth: bugs, security vulnerabilities, architectural concerns, code quality.
4. Call post_pr_comment(repo, pr_number, comment) to leave a structured review on each PR.
Repeat steps 2–4 for every open PR. After all PRs are reviewed, give the user a summary of your findings.

Figma design workflow — use this when the user mentions "Figma", asks for a design review, or wants AI feedback on UI frames. The file_key is the alphanumeric string in the Figma URL: figma.com/file/{file_key}/…
1. Call get_figma_file(file_key) to discover the file structure and all top-level frame IDs.
2. Call export_figma_frames(file_key, node_ids?) to export frames as PNGs and analyse them with Claude Vision. Prefer the most important screens (main view, key flows).
3. Call create_figma_comment(file_key, message, node_id?) to post AI-generated feedback directly on the Figma file, anchored to specific frames.
If the user needs to interact with the Figma web UI directly (inspect prototypes, view comments), call browser_navigate("https://www.figma.com/file/{file_key}") to open it in the Playwright browser.`
}

/**
 * A strict, focused system prompt used when the user triggers the PR review
 * workflow ("Review my PRs"). Forces pro-tier (Claude Sonnet) and gives the
 * model a structured review mandate instead of the general assistant prompt.
 */
const PR_REVIEW_SYSTEM_PROMPT = `You are an automated CTO-level code reviewer embedded in OpenUI. Your sole job right now is to review every open pull request in the specified GitHub repository and leave a structured review comment on each one.

You can call tools in the same JSON format: {"tool": "tool_name", "args": {"key": "value"}}

Available tools:
${[...toolSchemas.filter((s) => ['list_open_prs', 'get_pr_diff', 'post_pr_comment'].includes(s.name))].map(renderSchema).join('\n')}

Workflow — follow this EXACTLY:
1. Call list_open_prs(repo) to retrieve all open PRs.
2. For each PR returned, call get_pr_diff(repo, pr_number) to get the code diff.
3. Analyse the diff rigorously against these criteria:
   - BUGS: logic errors, off-by-one errors, null-pointer risks, incorrect conditionals.
   - SECURITY: injection vulnerabilities, insecure defaults, exposed secrets, unsafe deserialization, missing auth checks.
   - ARCHITECTURE: coupling, cohesion, separation of concerns, adherence to existing patterns in the codebase.
   - MERGE DECISION: weigh the above and decide: APPROVE, REQUEST CHANGES, or COMMENT ONLY.
4. Call post_pr_comment(repo, pr_number, comment) with a review formatted EXACTLY as:

## OpenUI Automated Code Review

**Decision: [APPROVE / REQUEST CHANGES / COMMENT ONLY]**

### Bugs
[List each bug found with line references, or "None detected."]

### Security Issues
[List each vulnerability with severity (High/Medium/Low), or "None detected."]

### Architecture
[Assess design impact, coupling, and consistency with existing patterns.]

### Verdict
[One sentence: should this PR be merged, and under what conditions?]

---
*Review generated by OpenUI — review this code for bugs, security issues, and architecture. Decide if it should be merged.*

5. After posting comments on ALL PRs, reply in plain text with a summary table.

Review this code for bugs, security issues, and architecture. Decide if it should be merged.`

/** Pattern that triggers the dedicated PR review mode. */
const PR_REVIEW_RE = /\breview\b.*\bprs?\b|\bprs?\b.*\breview|\bpull\s+request/i

/** Pattern that triggers the dedicated designer / Figma review mode. */
const DESIGNER_RE =
  /\bfigma\b|\bdesign(?:er)?\s+(?:file|review|frame)|\bfigma\s+(?:file|frame|comment)|review.*\bfigma\b|\bfigma.*\breview\b/i

const DESIGNER_TOOL_NAMES = [
  'get_figma_file',
  'export_figma_frames',
  'create_figma_comment',
  'browser_navigate',
  'browser_extract_text',
  'browser_click',
  'browser_fill_input'
]

/**
 * A focused system prompt used when the user triggers the designer workflow.
 * Forces pro tier (Claude Vision) and exposes only Figma + browser tools.
 */
const DESIGNER_SYSTEM_PROMPT = `You are OpenUI, an AI design partner embedded in a menu-bar app. Your role is to help designers review, analyse, and improve their Figma files using computer vision and structured feedback.

You can call tools in the same JSON format: {"tool": "tool_name", "args": {"key": "value"}}

Available tools:
${toolSchemas
  .filter((s) => DESIGNER_TOOL_NAMES.includes(s.name))
  .map(renderSchema)
  .join('\n')}

Design review workflow — follow this order when reviewing a Figma file:
1. Call get_figma_file(file_key) to understand the file structure and list all top-level frames with their node IDs.
2. Call export_figma_frames(file_key, node_ids?) to export the most important frames as PNGs and analyse them with Claude Vision. Prefer key screens (home, checkout, main flow).
3. Synthesise findings across all analysed frames — identify patterns and the highest-impact issues.
4. Call create_figma_comment(file_key, message, node_id?) to leave targeted, actionable feedback anchored to specific frames. One comment per frame with issues.
5. After posting all comments, reply in plain text with a summary table of findings and comment IDs.

If the user asks to open or directly inspect the Figma file, call browser_navigate("https://www.figma.com/file/{file_key}") to open it in the Playwright browser, then use browser_extract_text and browser_click to interact with the Figma web UI.

When writing feedback comments:
- Reference the exact frame name and describe the affected element.
- Give concrete values (e.g. "increase line-height from 1.2 to 1.5", "use #1A73E8 for primary CTA to meet WCAG AA 4.5:1").
- Prioritise: Accessibility (WCAG AA) → Usability → Visual polish.
- Format comments in markdown with headings and bullet lists.`

function modelForTier(tier: Tier): string {
  if (tier === 'free') return process.env.OLLAMA_MODEL ?? 'llama3:8b'
  if (tier === 'pro') return 'claude-sonnet-4-6'
  return process.env.GLM_MODEL ?? 'glm-4'
}

function classifyChatError(err: unknown): string {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  if (msg.includes('api key') || msg.includes('unauthorized') || msg.includes('401')) return 'auth_error'
  if (msg.includes('timeout') || msg.includes('timed out')) return 'timeout_error'
  if (msg.includes('network') || msg.includes('connect') || msg.includes('fetch')) return 'network_error'
  return 'unknown_error'
}

export function emit(win: BrowserWindow, channel: string, ...args: unknown[]): void {
  if (!win.isDestroyed()) {
    win.webContents.send(channel, ...args)
  }
}

/**
 * Extract the first *balanced* JSON object from `text`, starting at the first
 * `{`. String-aware so braces inside string values don't end the object early,
 * and tolerant of trailing prose/newlines after the closing `}` (models often
 * append an explanation). Returns the object's source text, or null.
 */
function extractFirstJsonObject(text: string): string | null {
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

/** All tool names the agent can actually execute (built-in + MCP). */
function knownToolNames(): Set<string> {
  const names = new Set<string>()
  for (const s of toolSchemas) names.add(s.name)
  for (const s of getMcpToolSchemas()) names.add(s.name)
  return names
}

/**
 * Coerce a parsed JSON object into a ToolCall, accepting the field aliases real
 * models emit (tool/name/tool_name, args/arguments/parameters/input). Returns
 * null when it isn't tool-shaped. When `requireKnown` is set, the tool name must
 * match a real registered tool — used for the embedded-scan path so prose that
 * merely contains a JSON object isn't mistaken for a tool call.
 */
function objToToolCall(parsed: unknown, requireKnown: boolean): ToolCall | null {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const obj = parsed as Record<string, unknown>
  const toolRaw = obj.tool ?? obj.tool_name ?? obj.name
  if (typeof toolRaw !== 'string' || !toolRaw.trim()) return null
  const tool = toolRaw.trim()
  if (requireKnown && !knownToolNames().has(tool)) return null

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
 */
export function parseToolCall(text: string): ToolCall | null {
  if (!text) return null

  let candidate = text.trim()
  // Unwrap a full markdown code fence: ```json\n{...}\n```  or  ```\n{...}\n```
  const fence = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fence) candidate = fence[1].trim()

  // ── Pass 1: clean leading JSON (the contract the prompt asks for) ──────────
  if (candidate.startsWith('{')) {
    const jsonText = extractFirstJsonObject(candidate)
    if (jsonText) {
      try {
        const call = objToToolCall(JSON.parse(jsonText), false)
        if (call) return call
      } catch {
        /* fall through to the embedded scan */
      }
    }
  }

  // ── Pass 2: recover a tool call embedded in prose/fences anywhere in text ──
  // Scan every `{` position; the first balanced object that names a known tool
  // wins. Bounded by the number of `{` characters, so it's cheap.
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    const jsonText = extractFirstJsonObject(text.slice(start))
    if (!jsonText) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(jsonText)
    } catch {
      continue // unbalanced or invalid here — try the next `{`
    }
    const call = objToToolCall(parsed, true)
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

/** Turn a tool execution into a message the model can read on the next turn. */
function formatToolResult(call: ToolCall, result: ToolResult): string {
  if (result.ok) {
    return `TOOL RESULT [${call.tool}] success: ${result.output ?? '(no output)'}`
  }
  return `TOOL RESULT [${call.tool}] error: ${result.error ?? 'unknown error'}`
}

async function callOllama(
  _win: BrowserWindow,
  messages: Message[],
  systemPrompt: string,
  onDelta: (delta: string) => void
): Promise<string> {
  const ollama = new Ollama({ host: process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434' })
  const stream = await ollama.chat({
    model: process.env.OLLAMA_MODEL ?? 'llama3:8b',
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages.map((m) => ({ role: m.role, content: m.content }))
    ],
    stream: true
  })
  let full = ''
  for await (const part of stream) {
    const delta = part.message?.content ?? ''
    if (delta) {
      full += delta
      onDelta(delta)
    }
  }
  return full
}

// Direct-API model ids used ONLY by the local-dev fallback (no Supabase / not
// signed in). In production every cloud turn goes through the chat-proxy Edge
// Function, whose own model map is the source of truth for shipped users.
const DIRECT_PRO_MODEL = 'claude-sonnet-4-6'
const DIRECT_FREE_MODEL = 'claude-3-5-haiku-latest'

async function callAnthropic(
  _win: BrowserWindow,
  messages: Message[],
  systemPrompt: string,
  model: string,
  onDelta: (delta: string) => void
): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const stream = client.messages.stream({
    model,
    max_tokens: 2048,
    system: systemPrompt,
    messages: messages.map((m) => ({ role: m.role, content: m.content }))
  })
  let full = ''
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      const delta = event.delta.text
      full += delta
      onDelta(delta)
    }
  }
  return full
}

async function callEnterprise(
  _win: BrowserWindow,
  messages: Message[],
  systemPrompt: string,
  onDelta: (delta: string) => void
): Promise<string> {
  const client = new OpenAI({
    baseURL: process.env.GLM_BASE_URL ?? 'http://127.0.0.1:8080/v1',
    apiKey: process.env.GLM_API_KEY ?? 'no-key'
  })
  const stream = await client.chat.completions.create({
    model: process.env.GLM_MODEL ?? 'glm-4',
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))
    ],
    stream: true
  })
  let full = ''
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content ?? ''
    if (delta) {
      full += delta
      onDelta(delta)
    }
  }
  return full
}

/**
 * Cloud-first model router (Phase A onboarding). The product promise is that the
 * app works the moment you sign in — no Ollama, no local setup — so the DEFAULT
 * for every tier is the cloud proxy (our API keys, server-side in the Edge
 * Function). Ollama is only ever an optional cost-saver / offline fallback.
 *
 * Priority:
 *   • Free      → local Ollama if running (free + unlimited), else cloud proxy.
 *   • Pro       → local Ollama for simple tasks if running, else cloud proxy.
 *   • Enterprise→ cloud proxy.
 *
 * The user NEVER sees an "Ollama is not installed" error: a down/absent Ollama
 * just silently routes to the cloud. `routeCloudOrDirect` adds a local-dev escape
 * hatch (direct API keys) for when Supabase/auth isn't wired up yet.
 *
 * `systemPrompt` is supplied by the caller so the same router drives both the
 * interactive desktop assistant (handleChat) and the autonomous coding agent
 * (autonomous.ts), which need different instructions and tool sets.
 */
export async function callModel(
  win: BrowserWindow,
  tier: Tier,
  messages: Message[],
  systemPrompt: string = buildSystemPrompt(),
  // Every streamed token is delivered here. The default forwards straight to the
  // renderer (legacy behaviour, used by autonomous.ts); the interactive loop
  // passes a StreamGate so tool-call JSON is withheld from the UI.
  onDelta: (delta: string) => void = (delta) => emit(win, 'openui:chat:chunk', delta)
): Promise<string> {
  const ollamaUp = await isOllamaRunning()

  if (tier === 'free') {
    if (ollamaUp) {
      // Local Ollama → free + unlimited, saves our API costs.
      emitLocalUsage(win, tier)
      return callOllama(win, messages, systemPrompt, onDelta)
    }
    return routeCloudOrDirect(win, 'free', messages, systemPrompt, 'free-default', onDelta)
  }

  if (tier === 'pro') {
    // Keep cheap/simple work local when Ollama is available; send the rest to cloud.
    if (ollamaUp && !classifyTaskComplexity(messages)) {
      emitLocalUsage(win, tier)
      return callOllama(win, messages, systemPrompt, onDelta)
    }
    return routeCloudOrDirect(win, 'pro', messages, systemPrompt, 'pro-default', onDelta)
  }

  return routeCloudOrDirect(win, 'enterprise', messages, systemPrompt, 'enterprise-default', onDelta)
}

/**
 * Route a turn through the cloud proxy when configured (signed in + Supabase),
 * otherwise fall back to direct provider APIs using local env keys. The direct
 * path exists only for local development before auth/Supabase are wired up — a
 * shipped, signed-in user always takes the proxy path.
 *
 * The free direct fallback never surfaces an Ollama error: if no Anthropic key
 * is set we try local Ollama as a last resort, and if that also fails we return a
 * neutral, friendly message rather than a raw connection error.
 */
async function routeCloudOrDirect(
  win: BrowserWindow,
  tier: Tier,
  messages: Message[],
  systemPrompt: string,
  modelKey: string,
  onDelta: (delta: string) => void
): Promise<string> {
  if (isCloudProxyConfigured()) {
    return callCloudProxy(win, tier, messages, systemPrompt, modelKey, onDelta)
  }

  // ── Local-dev / unauthenticated fallback (direct API keys) ──────────────────
  emitLocalUsage(win, tier)
  if (tier === 'enterprise') return callEnterprise(win, messages, systemPrompt, onDelta)
  if (tier === 'pro') return callAnthropic(win, messages, systemPrompt, DIRECT_PRO_MODEL, onDelta)

  // Free fallback: prefer a direct Anthropic (Haiku) call if a key exists.
  if (process.env.ANTHROPIC_API_KEY) {
    return callAnthropic(win, messages, systemPrompt, DIRECT_FREE_MODEL, onDelta)
  }
  // No cloud key configured locally — try Ollama, but degrade gracefully so the
  // user never sees an "Ollama not installed" error if it isn't there.
  try {
    return await callOllama(win, messages, systemPrompt, onDelta)
  } catch {
    // No cloud session and no local model: surface a neutral connectivity
    // message. We never instruct the user to install anything — cloud is the
    // product's default path and a guest session normally guarantees it.
    const msg =
      "I couldn't reach the AI service just now. Please check your internet " +
      'connection and try again in a moment.'
    onDelta(msg)
    return msg
  }
}

/**
 * Drive a full agentic turn: stream a model response, and while it keeps
 * emitting tool calls, execute each tool in the main process, push the result
 * back into the conversation, and let the model continue reasoning. Task-list
 * status is pushed to the renderer as each tool moves working → done/error.
 */
export async function handleChat(win: BrowserWindow, userMessage: string, tier: Tier, fromVoice = false): Promise<void> {
  const rollbackLen = history.length // for clean rollback on failure

  if (!currentConversationId) {
    currentConversationId = database.conversations.createConversation(null, 'New Chat')
  }
  const convId = currentConversationId

  // Self-improvement loop: treat this message as an implicit reaction to the
  // PREVIOUS assistant turn. "wrong"/"try again" downgrades it to 1, "perfect"/
  // "thanks" upgrades it to 5. Best-effort and never allowed to break the chat.
  try {
    const signal = classifyFeedbackSignal(userMessage)
    if (signal) database.feedback.applySignalToLast(convId, signal)
  } catch (err) {
    console.error('[improvement] failed to score previous turn:', err)
  }

  history.push({ role: 'user', content: userMessage })
  database.messages.addMessage(convId, 'user', userMessage)
  emit(win, 'openui:task:reset')

  // PR review: force pro tier (Claude Sonnet) and use the strict review prompt.
  // Designer: force pro tier (Claude Vision) and use the Figma design review prompt.
  const isPrReview = PR_REVIEW_RE.test(userMessage)
  const isDesigner = DESIGNER_RE.test(userMessage) && !isPrReview
  // PR review / designer want pro-tier models. SECURITY: clamp the final tier to
  // the signed-in user's verified entitlement so the untrusted renderer (or these
  // forced-pro modes) can't route to models the user hasn't paid for. No-op when
  // no user is signed in (e.g. local dev) — see clampTierToEntitlement.
  const requestedTier: Tier = isPrReview || isDesigner ? 'pro' : tier
  const effectiveTier: Tier = clampTierToEntitlement(requestedTier, getCurrentUserId())

  // If the client requested a higher tier than the server allows, notify the
  // renderer so it can show the upgrade modal.
  if (tier !== effectiveTier && tier !== 'free') {
    emit(win, 'openui:tier-upgrade-needed', {
      requestedTier: tier,
      effectiveTier,
      currentTier: effectiveTier
    })
  }

  const effectiveSystemPrompt = isPrReview
    ? PR_REVIEW_SYSTEM_PROMPT
    : isDesigner
      ? DESIGNER_SYSTEM_PROMPT
      : buildSystemPrompt()

  // PR review needs more turns: list + diff×N + comment×N.
  // Designer needs more turns: get_file + export×N (with Vision calls) + comment×N.
  const maxTurns = isPrReview ? 32 : isDesigner ? 16 : MAX_TOOL_TURNS

  const model = modelForTier(effectiveTier)
  if (requestedTier !== effectiveTier) {
    trackEvent(Events.MODEL_DOWNGRADE, {
      tier,
      requested_model: modelForTier(requestedTier),
      downgraded_to: model
    })
  }
  trackEvent(Events.CHAT_MESSAGE_SENT, {
    tier: effectiveTier,
    model,
    message_length: userMessage.length,
    has_voice: fromVoice
  })

  try {
    let finalText = ''

    for (let turn = 0; turn < maxTurns; turn++) {
      trackEvent(Events.MODEL_ROUTE_SELECTED, {
        tier: effectiveTier,
        requested_model: model,
        actual_model: model,
        reason: isPrReview ? 'pr_review' : isDesigner ? 'designer' : 'tier_routing'
      })
      const callStart = Date.now()
      // Gate every streamed token: tool-call JSON is withheld from the renderer,
      // natural language streams through live. This is what keeps raw JSON off
      // the screen regardless of which provider/transport produced the response.
      const gate = new StreamGate((delta) => emit(win, 'openui:chat:chunk', delta))
      const responseText = await callModel(win, effectiveTier, history, effectiveSystemPrompt, gate.push)
      trackEvent(Events.CHAT_RESPONSE_RECEIVED, {
        tier: effectiveTier,
        model,
        token_count: Math.ceil(responseText.length / 4),
        latency_ms: Date.now() - callStart
      })
      history.push({ role: 'assistant', content: responseText })

      const toolCall = parseToolCall(responseText)
      // Reveal any withheld output that turned out NOT to be a real tool call.
      gate.finalize(toolCall !== null)
      console.log(
        `[agent] turn ${turn}: ${toolCall ? `tool=${toolCall.tool}` : 'natural-language reply'} (${responseText.length} chars)`
      )
      if (!toolCall) {
        finalText = responseText // natural-language answer ⇒ turn complete
        database.messages.addMessage(convId, 'assistant', finalText)
        break
      }

      // Surface the call to the renderer and open a task-list row.
      emit(win, 'openui:chat:tool', toolCall)
      const taskId = `t${++taskSeq}`
      const label = describeToolCall(toolCall.tool, toolCall.args)
      emit(win, 'openui:task:update', {
        id: taskId,
        label,
        status: 'working',
        detail: 'OpenUI is working…'
      } satisfies TaskUpdate)

      // State-changing tools first return PendingApprovalResult — pause and
      // ask the user via HitlModal before actually running the tool.
      const rawResult: ToolResult | PendingApprovalResult = await executeTool(
        toolCall.tool,
        toolCall.args,
        { tier: effectiveTier }
      )

      let result: ToolResult
      if ('status' in rawResult && rawResult.status === 'pending_approval') {
        const approved = await waitForHitlApproval(win, rawResult.tool, rawResult.args)
        if (approved) {
          result = (await executeTool(toolCall.tool, toolCall.args, {
            tier: effectiveTier,
            bypassHitl: true
          })) as ToolResult
        } else {
          result = {
            ok: false,
            error: `User denied the action: ${describeToolCall(toolCall.tool, toolCall.args)}. Do not retry; let the user know you cannot proceed without their approval.`
          }
        }
      } else {
        result = rawResult as ToolResult
      }

      // Fall back to MCP if the tool is unknown to built-ins.
      if (!result.ok && result.error?.startsWith('Unknown tool')) {
        result = await callMcpTool(toolCall.tool, toolCall.args)
      }

      // If a tool detected a missing OS permission, notify the renderer so it
      // can show a modal guiding the user to System Settings.
      if (result.permissionDenied) {
        emit(win, 'openui:permission:denied', result.permissionDenied)
      }

      // Free-tier read_screen succeeds via local OCR but cloud vision is
      // available on Pro — proactively show the upgrade prompt.
      if (toolCall.tool === 'read_screen' && effectiveTier === 'free') {
        emit(win, 'openui:tier-upgrade-needed', {
          requestedTier: 'pro',
          effectiveTier: 'free',
          currentTier: 'free'
        })
      }

      emit(win, 'openui:task:update', {
        id: taskId,
        label,
        status: result.ok ? 'done' : 'error',
        detail: result.ok ? result.output : result.error
      } satisfies TaskUpdate)

      // Feed the result back so the model can take the next step.
      history.push({ role: 'user', content: formatToolResult(toolCall, result) })

      if (turn === maxTurns - 1) {
        finalText = 'Reached the tool-call limit for this request.'
        database.messages.addMessage(convId, 'assistant', finalText)
      }
    }

    // Record this completed turn for the self-improvement loop. Starts neutral
    // (3); the user's next message (or a 👍/👎) re-scores it. Best-effort.
    try {
      database.feedback.recordTurn(convId, userMessage, finalText)
    } catch (err) {
      console.error('[improvement] failed to record turn feedback:', err)
    }

    emit(win, 'openui:chat:done', { text: finalText, toolCall: null })
  } catch (err) {
    history.length = rollbackLen // roll back the entire failed turn
    trackEvent(Events.CHAT_ERROR, { tier: effectiveTier, model, error_type: classifyChatError(err) })
    const message = err instanceof Error ? err.message : String(err)
    emit(win, 'openui:chat:error', message)
  }
}

export function clearHistory(): void {
  history.length = 0
  currentConversationId = null
}

/** Coerce an untrusted IPC tier value to a known Tier, defaulting to 'free'. */
export function coerceTier(value: unknown): Tier {
  return value === 'pro' || value === 'enterprise' ? value : 'free'
}

/** Max characters accepted for a single chat/voice message (defensive bound). */
const MAX_MESSAGE_LEN = 16_000

export function registerAgentIPC(win: BrowserWindow): void {
  // Resolve the waiting agent loop turn when the user responds to a HITL prompt.
  ipcMain.on('openui:hitl:response', (_event, payload: unknown) => {
    if (typeof payload !== 'object' || payload === null) return
    const { id, approved } = payload as Record<string, unknown>
    if (typeof id !== 'string') return
    const resolve = pendingHitlRequests.get(id)
    if (resolve) {
      pendingHitlRequests.delete(id)
      resolve(approved === true)
    }
  })

  ipcMain.handle('openui:chat', async (_event, payload: unknown) => {
    if (typeof payload !== 'object' || payload === null) return
    const { message, tier } = payload as Record<string, unknown>
    if (typeof message !== 'string' || !message.trim()) {
      emit(win, 'openui:chat:error', 'Invalid chat request: "message" must be a non-empty string.')
      return
    }
    if (message.length > MAX_MESSAGE_LEN) {
      emit(win, 'openui:chat:error', 'Message is too long.')
      return
    }
    await handleChat(win, message, coerceTier(tier))
  })
  ipcMain.on('openui:clear-history', () => clearHistory())

  // Explicit 👍/👎 on the last response → set the explicit_rating on the most
  // recent conversation_feedback row (1 = 👎, 5 = 👍). Untrusted IPC: coerce to
  // the two allowed values and ignore anything else.
  ipcMain.handle('openui:rate-last', (_event, rating: unknown) => {
    const value = rating === 1 || rating === 5 ? rating : null
    if (value === null) return false
    try {
      return database.feedback.setExplicitRatingOnLast(value) !== null
    } catch (err) {
      console.error('[improvement] failed to set explicit rating:', err)
      return false
    }
  })

  // Poll for Ollama state changes every 60 s. When Ollama comes online after
  // being absent, notify the renderer so it can switch to local mode and show
  // a brief "Local AI detected" toast. Silently transitions back to cloud when
  // Ollama stops — no error shown to the user.
  let lastOllamaStatus = false
  setInterval(async () => {
    const current = await isOllamaRunning()
    if (current !== lastOllamaStatus) {
      lastOllamaStatus = current
      if (current) {
        emit(win, 'openui:local-ai-available')
        console.log('[Telemetry] ollama_detected { method: "polling" }')
      }
    }
  }, 60_000)
}

export function registerConversationIPC(win: BrowserWindow): void {
  ipcMain.handle('openui:get-conversations', async () => {
    const userId = getCurrentUserId()
    if (!userId) return []
    return database.conversations.getConversationsByUser(userId)
  })

  ipcMain.handle('openui:load-conversation', async (_event, conversationId: unknown) => {
    if (typeof conversationId !== 'string') return []
    return database.messages.getMessagesByConversation(conversationId)
  })

  // Resume a past conversation: loads its messages into the in-memory history
  // so that the next chat turn is contextually aware, then returns the messages
  // for the renderer to display as a thread.
  ipcMain.handle('openui:resume-conversation', async (_event, conversationId: unknown) => {
    if (typeof conversationId !== 'string') return []
    const messages = database.messages.getMessagesByConversation(conversationId)
    history.length = 0
    for (const msg of messages) {
      if (msg.role === 'user' || msg.role === 'assistant') {
        history.push({ role: msg.role, content: msg.content ?? '' })
      }
    }
    currentConversationId = conversationId
    return messages
  })

  win // referenced to satisfy linter — win is used for future push events
}
