import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { Ollama } from 'ollama'
import { BrowserWindow, ipcMain } from 'electron'
import { toolSchemas, executeTool, describeToolCall, type ToolSchema, type ToolResult, type Tier } from './tools'
import { database } from './database'
import { clampTierToEntitlement } from './stripe/pricing'
import { getCurrentUserId } from './stripe/subscriptionSync'

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

const SYSTEM_PROMPT = `You are OpenUI, an intelligent desktop assistant running as a menu-bar app. You help users get things done on their computer through natural conversation.

You can control the operating system by calling tools. To call a tool, respond with ONLY a valid JSON object and nothing else:
{"tool": "tool_name", "args": {"key": "value"}}

After each tool runs you will receive a message starting with "TOOL RESULT" describing what happened. Use it to decide the next step. Chain as many tool calls as the task needs — one per message. When the task is complete, reply to the user in plain natural language (never wrap your final answer in JSON).

Available tools:
${toolSchemas.map(renderSchema).join('\n')}

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

export function emit(win: BrowserWindow, channel: string, ...args: unknown[]): void {
  if (!win.isDestroyed()) {
    win.webContents.send(channel, ...args)
  }
}

export function parseToolCall(text: string): ToolCall | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'tool' in parsed &&
      typeof (parsed as Record<string, unknown>).tool === 'string' &&
      'args' in parsed
    ) {
      const call = parsed as { tool: string; args: unknown }
      const args =
        typeof call.args === 'object' && call.args !== null
          ? (call.args as Record<string, unknown>)
          : {}
      return { tool: call.tool, args }
    }
  } catch {
    // Not valid JSON — not a tool call
  }
  return null
}

/** Turn a tool execution into a message the model can read on the next turn. */
function formatToolResult(call: ToolCall, result: ToolResult): string {
  if (result.ok) {
    return `TOOL RESULT [${call.tool}] success: ${result.output ?? '(no output)'}`
  }
  return `TOOL RESULT [${call.tool}] error: ${result.error ?? 'unknown error'}`
}

async function callOllama(win: BrowserWindow, messages: Message[], systemPrompt: string): Promise<string> {
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
      emit(win, 'openui:chat:chunk', delta)
    }
  }
  return full
}

async function callAnthropic(win: BrowserWindow, messages: Message[], systemPrompt: string): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const stream = client.messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: systemPrompt,
    messages: messages.map((m) => ({ role: m.role, content: m.content }))
  })
  let full = ''
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      const delta = event.delta.text
      full += delta
      emit(win, 'openui:chat:chunk', delta)
    }
  }
  return full
}

async function callEnterprise(win: BrowserWindow, messages: Message[], systemPrompt: string): Promise<string> {
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
      emit(win, 'openui:chat:chunk', delta)
    }
  }
  return full
}

/**
 * Stream one model turn for the given tier and return the full text. The
 * `systemPrompt` is supplied by the caller so the same router can drive both the
 * interactive desktop assistant (handleChat) and the autonomous coding agent
 * (autonomous.ts), which need different instructions and tool sets.
 */
export function callModel(
  win: BrowserWindow,
  tier: Tier,
  messages: Message[],
  systemPrompt: string = SYSTEM_PROMPT
): Promise<string> {
  if (tier === 'free') return callOllama(win, messages, systemPrompt)
  if (tier === 'pro') return callAnthropic(win, messages, systemPrompt)
  return callEnterprise(win, messages, systemPrompt)
}

/**
 * Drive a full agentic turn: stream a model response, and while it keeps
 * emitting tool calls, execute each tool in the main process, push the result
 * back into the conversation, and let the model continue reasoning. Task-list
 * status is pushed to the renderer as each tool moves working → done/error.
 */
export async function handleChat(win: BrowserWindow, userMessage: string, tier: Tier): Promise<void> {
  const turnStart = history.length // for clean rollback on failure

  if (!currentConversationId) {
    currentConversationId = database.conversations.createConversation(null, 'New Chat')
  }
  const convId = currentConversationId

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
  const effectiveSystemPrompt = isPrReview
    ? PR_REVIEW_SYSTEM_PROMPT
    : isDesigner
      ? DESIGNER_SYSTEM_PROMPT
      : SYSTEM_PROMPT

  // PR review needs more turns: list + diff×N + comment×N.
  // Designer needs more turns: get_file + export×N (with Vision calls) + comment×N.
  const maxTurns = isPrReview ? 32 : isDesigner ? 16 : MAX_TOOL_TURNS

  try {
    let finalText = ''

    for (let turn = 0; turn < maxTurns; turn++) {
      const responseText = await callModel(win, effectiveTier, history, effectiveSystemPrompt)
      history.push({ role: 'assistant', content: responseText })

      const toolCall = parseToolCall(responseText)
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

      // Execute in Node and report the outcome to the task list.
      const result = await executeTool(toolCall.tool, toolCall.args, { tier: effectiveTier })

      // If a tool detected a missing OS permission, notify the renderer so it
      // can show a modal guiding the user to System Settings.
      if (result.permissionDenied) {
        emit(win, 'openui:permission:denied', result.permissionDenied)
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

    emit(win, 'openui:chat:done', { text: finalText, toolCall: null })
  } catch (err) {
    history.length = turnStart // roll back the entire failed turn
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
}
