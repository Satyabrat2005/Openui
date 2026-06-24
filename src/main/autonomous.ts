/**
 * autonomous.ts — the Autonomous Coding Mode agent loop (Phase 8).
 *
 * When the scheduler decides the user is away (idle or "I'm busy"), it calls
 * runAutonomousCoding(). This module pulls pending tasks from the configured
 * source (local todo.json or GitHub Issues, see tasks.ts), and for each task
 * drives a coding agent loop in the sandbox: write code → run tests → iterate on
 * failures, all without user intervention. Progress is streamed to the renderer
 * over the existing task-list channels plus a new openui:autonomous:status
 * channel that powers the "Background Agent Working…" UI.
 *
 * It reuses the model router (callModel), tool-call parser (parseToolCall) and
 * emit helper from agent.ts, but with its OWN coding tool set and system prompt
 * so the unattended loop can only touch the sandbox, never the live desktop.
 */
import type { BrowserWindow } from 'electron'
import { callModel, parseToolCall, emit, type Message } from './agent'
import { codingToolSchemas, executeCodingTool, describeCodingToolCall } from './codingTools'
import { getNextTask, recordTaskOutcome, type TaskSource, type AgentTask } from './tasks'
import type { Tier, ToolResult, ToolSchema } from './tools'

/** Status the renderer reflects in the TaskListPopup "Background Agent" banner. */
export interface AutonomousStatus {
  active: boolean
  state: 'disabled' | 'monitoring' | 'working' | 'paused'
  currentTask?: string
  detail?: string
}

// Per-task tool-call budget. Coding needs more turns than the interactive
// assistant (write → test → fix cycles), so this is larger than MAX_TOOL_TURNS.
const MAX_CODING_TURNS = 20

// Cap how many tasks one idle window will burn through before yielding, so a
// long todo list cannot monopolise the machine in a single sweep.
const MAX_TASKS_PER_RUN = 5

let running = false
let stopRequested = false
let taskSeq = 0

export function isAutonomousRunning(): boolean {
  return running
}

/** Cooperative cancel — the loop stops pulling new work at the next checkpoint. */
export function requestAutonomousStop(): void {
  if (running) stopRequested = true
}

export function emitAutonomousStatus(win: BrowserWindow, status: AutonomousStatus): void {
  emit(win, 'openui:autonomous:status', status)
}

/** Render a coding tool schema as a compact signature line for the prompt. */
function renderSchema(schema: ToolSchema): string {
  const params = Object.entries(schema.parameters.properties)
    .map(([key, spec]) => {
      const optional = schema.parameters.required.includes(key) ? '' : '?'
      return `${key}${optional}: ${spec.type}`
    })
    .join(', ')
  return `- ${schema.name}(${params}) — ${schema.description}`
}

const CODING_SYSTEM_PROMPT = `You are OpenUI's autonomous coding agent. You are working UNATTENDED in a sandboxed workspace — there is no human available to answer questions, so never ask for clarification; make a reasonable decision and proceed.

To call a tool, respond with ONLY a valid JSON object and nothing else:
{"tool": "tool_name", "args": {"key": "value"}}

After each tool runs you receive a message starting with "TOOL RESULT". Use it to decide the next step. Call exactly one tool per message.

Available tools:
${codingToolSchemas.map(renderSchema).join('\n')}

Workflow:
1. If unsure of the current state, call list_files / read_file to inspect the workspace.
2. Implement the task with write_file (write complete file contents each time).
3. Call run_tests to verify. Read the output carefully.
4. If the output starts with "TESTS FAILED", fix the code and run_tests again. Iterate.
5. When the output starts with "TESTS PASSED", reply in plain natural language summarising what you changed. Do NOT wrap the final summary in JSON.

If after several honest attempts you cannot make the tests pass, reply in plain text beginning with "GIVE UP:" followed by a short explanation. Never fake a pass or delete tests to make them pass.`

/** Build the first user message describing the task to work on. */
function taskPrompt(task: AgentTask): string {
  const lines = [
    `TASK (${task.source}): ${task.title}`,
    task.description ? `\nDetails:\n${task.description}` : '',
    '\nComplete this task in the workspace, then run the tests until they pass.'
  ]
  return lines.filter(Boolean).join('\n')
}

function formatToolResult(tool: string, result: ToolResult): string {
  if (result.ok) return `TOOL RESULT [${tool}] success: ${result.output ?? '(no output)'}`
  return `TOOL RESULT [${tool}] error: ${result.error ?? 'unknown error'}`
}

interface TaskOutcome {
  success: boolean
  summary: string
}

/**
 * Drive the coding loop for a single task. Returns whether the agent finished
 * with passing tests. Each tool call is surfaced as a task-list row so the user
 * can watch what the background agent did.
 */
async function workOnTask(win: BrowserWindow, tier: Tier, task: AgentTask): Promise<TaskOutcome> {
  const messages: Message[] = [{ role: 'user', content: taskPrompt(task) }]
  let lastTestsPassed = false

  for (let turn = 0; turn < MAX_CODING_TURNS; turn++) {
    if (stopRequested) {
      return { success: false, summary: 'Paused: the user returned before the task finished.' }
    }

    const responseText = await callModel(win, tier, messages, CODING_SYSTEM_PROMPT)
    messages.push({ role: 'assistant', content: responseText })

    const toolCall = parseToolCall(responseText)
    if (!toolCall) {
      // Plain-language reply ⇒ the agent considers the task finished (or gave up).
      const gaveUp = /^\s*GIVE UP:/i.test(responseText)
      return { success: lastTestsPassed && !gaveUp, summary: responseText.trim() }
    }

    const taskId = `a${++taskSeq}`
    const label = describeCodingToolCall(toolCall.tool, toolCall.args)
    emit(win, 'openui:task:update', { id: taskId, label, status: 'working', detail: 'Coding…' })

    const result = await executeCodingTool(toolCall.tool, toolCall.args)
    if (toolCall.tool === 'run_tests' && result.ok) {
      lastTestsPassed = (result.output ?? '').startsWith('TESTS PASSED')
    }

    emit(win, 'openui:task:update', {
      id: taskId,
      label,
      status: result.ok ? 'done' : 'error',
      detail: result.ok ? result.output?.slice(0, 200) : result.error
    })

    messages.push({ role: 'user', content: formatToolResult(toolCall.tool, result) })
  }

  return { success: false, summary: 'Reached the coding-turn limit before the tests passed.' }
}

/**
 * Run the autonomous coding session: pull pending tasks one at a time and work
 * each in the sandbox until the source is exhausted, the per-run cap is hit, or
 * a stop is requested (user returned). Re-entrant calls are ignored.
 */
export async function runAutonomousCoding(
  win: BrowserWindow,
  tier: Tier,
  source: TaskSource
): Promise<void> {
  if (running) return
  running = true
  stopRequested = false

  try {
    let worked = 0
    while (!stopRequested && worked < MAX_TASKS_PER_RUN) {
      let task: AgentTask | null
      try {
        task = await getNextTask(source)
      } catch (err) {
        emitAutonomousStatus(win, {
          active: true,
          state: 'monitoring',
          detail: `Could not load tasks: ${err instanceof Error ? err.message : String(err)}`
        })
        break
      }

      if (!task) {
        emitAutonomousStatus(win, {
          active: true,
          state: 'monitoring',
          detail: worked === 0 ? 'No pending tasks.' : `Finished ${worked} task(s); queue empty.`
        })
        break
      }

      emit(win, 'openui:task:reset')
      emitAutonomousStatus(win, { active: true, state: 'working', currentTask: task.title })

      let outcome: TaskOutcome
      try {
        outcome = await workOnTask(win, tier, task)
      } catch (err) {
        outcome = { success: false, summary: err instanceof Error ? err.message : String(err) }
      }

      // If we stopped because the user returned, leave the task pending so it is
      // retried next idle window rather than being marked failed.
      if (stopRequested && !outcome.success) {
        emitAutonomousStatus(win, { active: true, state: 'paused', currentTask: task.title })
        break
      }

      await recordTaskOutcome(task, outcome.success ? 'done' : 'failed')
      emitAutonomousStatus(win, {
        active: true,
        state: 'working',
        currentTask: task.title,
        detail: `${outcome.success ? '✓' : '✗'} ${outcome.summary.slice(0, 160)}`
      })
      worked++
    }
  } finally {
    running = false
  }
}
