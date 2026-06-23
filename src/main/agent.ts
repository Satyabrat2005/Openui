import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { Ollama } from 'ollama'
import { BrowserWindow, ipcMain } from 'electron'
import { toolSchemas, executeTool, describeToolCall, type ToolSchema, type ToolResult, type Tier } from './tools'

interface Message {
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

Screen navigation workflow — use this when a task requires clicking UI elements that have no AppleScript API (e.g. web-browser content, VS Code side-bar panels, extension icons, or any Electron app):
1. Call read_screen() — it returns a description of every visible UI element with approximate X,Y coordinates.
2. Identify the target element's coordinates from the description.
3. Call move_mouse(x, y) to position the pointer over it.
4. Call left_click() to activate it.

For anything that does not require a system action, just reply in plain text.`

function emit(win: BrowserWindow, channel: string, ...args: unknown[]): void {
  if (!win.isDestroyed()) {
    win.webContents.send(channel, ...args)
  }
}

function parseToolCall(text: string): ToolCall | null {
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

async function callOllama(win: BrowserWindow, messages: Message[]): Promise<string> {
  const ollama = new Ollama({ host: process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434' })
  const stream = await ollama.chat({
    model: process.env.OLLAMA_MODEL ?? 'llama3:8b',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
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

async function callAnthropic(win: BrowserWindow, messages: Message[]): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const stream = client.messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
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

async function callEnterprise(win: BrowserWindow, messages: Message[]): Promise<string> {
  const client = new OpenAI({
    baseURL: process.env.GLM_BASE_URL ?? 'http://127.0.0.1:8080/v1',
    apiKey: process.env.GLM_API_KEY ?? 'no-key'
  })
  const stream = await client.chat.completions.create({
    model: process.env.GLM_MODEL ?? 'glm-4',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
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

function callModel(win: BrowserWindow, tier: Tier, messages: Message[]): Promise<string> {
  if (tier === 'free') return callOllama(win, messages)
  if (tier === 'pro') return callAnthropic(win, messages)
  return callEnterprise(win, messages)
}

/**
 * Drive a full agentic turn: stream a model response, and while it keeps
 * emitting tool calls, execute each tool in the main process, push the result
 * back into the conversation, and let the model continue reasoning. Task-list
 * status is pushed to the renderer as each tool moves working → done/error.
 */
export async function handleChat(win: BrowserWindow, userMessage: string, tier: Tier): Promise<void> {
  const turnStart = history.length // for clean rollback on failure
  history.push({ role: 'user', content: userMessage })
  emit(win, 'openui:task:reset')

  try {
    let finalText = ''

    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      const responseText = await callModel(win, tier, history)
      history.push({ role: 'assistant', content: responseText })

      const toolCall = parseToolCall(responseText)
      if (!toolCall) {
        finalText = responseText // natural-language answer ⇒ turn complete
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
      const result = await executeTool(toolCall.tool, toolCall.args, { tier })

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

      if (turn === MAX_TOOL_TURNS - 1) {
        finalText = 'Reached the tool-call limit for this request.'
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
