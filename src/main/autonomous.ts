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
import { callModel, parseToolCall, emit, StreamGate, type Message } from './agent'
import { codingToolSchemas, executeCodingTool, describeCodingToolCall } from './codingTools'
import { VerifyGate } from './verifyGate'
import { parseFailures, failureSignature } from './errorParser'
import { FixTracker } from './fixTracker'
import { getNextTask, recordTaskOutcome, type TaskSource, type AgentTask } from './tasks'
import { resetActiveProject, readSandboxRegion } from './sandbox'
import { disarmEditorAutoOpen } from './editor'
import { detectProjectType, getProjectProfile, type ProjectProfile } from './projectProfiles'
import { startRun, type RunLog } from './runLog'
import {
  beginTaskSnapshot,
  discardActiveSnapshot,
  pruneSnapshots,
  restoreActiveSnapshot
} from './snapshots'
import type { Tier, ToolResult, ToolSchema } from './tools'

/** Status the renderer reflects in the left rail's "Background Agent" banner. */
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
1. Orient before changing anything. Call list_files to see the tree, search_code to locate a symbol or string (it returns "file:line: text"), and read_file to read what you are about to touch. Never edit a file you have not read this session.
2. Create NEW files with write_file. To scaffold a new project, write the WHOLE file tree — package.json (with the right dependencies and "scripts"), source files, config, and tests.
3. Change EXISTING files with edit_file, never write_file. write_file replaces the entire file, so using it for a small change silently deletes every line you did not retype. edit_file swaps one exact snippet and leaves the rest untouched. If edit_file reports that old_string is ambiguous, add surrounding lines to make it unique — do not fall back to write_file.
4. If the project has dependencies, call install_dependencies once after writing package.json.
5. Verify your work with the verifier that fits the project (the PROJECT TYPE section below tells you which):
   - Call run_tests to run an npm test suite, and/or
   - Call run_script to run a build/train/lint script you defined (e.g. {"tool":"run_script","args":{"script":"build"}}). A dev server ("dev"/"start") is run as a boot smoke test — it confirms the app starts without crashing.
   - For Python work, call run_pytest and/or run_python; for single-file C++, call run_cpp with the sample input.
6. Read the output carefully. If it starts with "TESTS FAILED" / "SCRIPT FAILED" / "INSTALL FAILED", a "DEBUG CONTEXT" block is appended below the output showing the exact failing file:line and the surrounding source — use it directly (only call read_file if you need more of the file), then fix the CAUSE with edit_file and re-run the failing step. If the same failure returns after your fix, it is not at that line: look at the caller and the values flowing in rather than re-patching the same spot. Iterate.
7. Commit each coherent, VERIFIED change so the work is reviewable and revertable. On a fresh workspace run {"tool":"git","args":{"subcommand":"init"}} first, then add and commit:
   {"tool":"git","args":{"subcommand":"add","args":["."]}}
   {"tool":"git","args":{"subcommand":"commit","args":["-m","Short summary of the change"]}}
   Commit only after the relevant verifier passed — never commit a red build. git here cannot push, pull, fetch or reach any network; publishing is a separate step a human approves.
8. When verification passes, reply in plain natural language summarising what you built/changed. Do NOT wrap the final summary in JSON. If you edit ANY file after the last passing run, you must re-run the verifier before summarising — a green run only describes the tree as it was when it ran.

If after several honest attempts you cannot make it pass, reply in plain text beginning with "GIVE UP:" followed by a short explanation. Never fake a pass or delete tests to make them pass.`

/** Build the first user message describing the task to work on. */
function taskPrompt(task: AgentTask, profile: ProjectProfile): string {
  const lines = [
    `TASK (${task.source}): ${task.title}`,
    task.description ? `\nDetails:\n${task.description}` : '',
    `\n${profile.taskHint}`
  ]
  return lines.filter(Boolean).join('\n')
}

function formatToolResult(tool: string, result: ToolResult): string {
  if (result.ok) return `TOOL RESULT [${tool}] success: ${result.output ?? '(no output)'}`
  return `TOOL RESULT [${tool}] error: ${result.error ?? 'unknown error'}`
}

// How many distinct failing locations to auto-fetch source for per red run. A
// bound keeps the injected context from blowing the model's window when a build
// prints dozens of errors — the model fixes the first few and re-runs.
const MAX_DEBUG_LOCATIONS = 3

/**
 * Structured error handling for a red verifier (Task §4). Parses the failure
 * output into file:line locations, auto-fetches the surrounding source from the
 * sandbox (so the model does not spend a turn reading it back), journals each
 * failure signature, and — when the FixTracker shows the same failure recurring
 * after an edit — appends escalation guidance (widen the view / find the caller-
 * side root cause). Returns text to append to the tool result, or '' when the
 * output held no recognisable failure location.
 */
async function buildDebugContext(
  output: string,
  tracker: FixTracker,
  runLog: RunLog
): Promise<string> {
  const failures = parseFailures(output)
  if (failures.length === 0) return ''

  tracker.observeFailures(failures.map(failureSignature))

  const sections: string[] = []
  const escalations = new Set<string>()
  const seenLocations = new Set<string>()

  for (const f of failures) {
    const sig = failureSignature(f)
    runLog.event('failure', {
      sig,
      file: f.file,
      line: f.line,
      type: f.errorType,
      attempts: tracker.attempts(sig)
    })

    const guidance = tracker.guidanceFor(sig)
    if (guidance) escalations.add(guidance)

    // One snippet per distinct location, capped — the log may repeat a line.
    const locKey = `${f.file.replace(/\\/g, '/')}:${f.line}`
    if (seenLocations.has(locKey) || sections.length >= MAX_DEBUG_LOCATIONS) continue
    seenLocations.add(locKey)

    const head = `${f.file}:${f.line}${f.errorType ? ` — ${f.errorType}` : ''}${
      f.message ? `: ${f.message}` : ''
    }`
    const region = await readSandboxRegion(f.file, f.line, tracker.readRadiusFor(sig))
    sections.push(
      region.ok && region.snippet
        ? `${head}\n${region.snippet}`
        : `${head}\n(could not show source: ${region.reason})`
    )
  }

  if (sections.length === 0 && escalations.size === 0) return ''
  const parts = ['\n\n--- DEBUG CONTEXT (auto-fetched at the failing lines) ---']
  if (sections.length) parts.push(sections.join('\n\n'))
  if (escalations.size) parts.push([...escalations].join('\n'))
  parts.push('Fix the cause shown above with write_file, then re-run the verifier.')
  return parts.join('\n')
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
async function workOnTask(
  win: BrowserWindow,
  tier: Tier,
  task: AgentTask,
  runLog: RunLog,
  profile: ProjectProfile
): Promise<TaskOutcome> {
  const messages: Message[] = [{ role: 'user', content: taskPrompt(task, profile) }]
  const systemPrompt = `${CODING_SYSTEM_PROMPT}\n\n${profile.promptAddendum}`
  // §5: refuses to let the agent finish on unverified work — a passing verifier
  // marks the tree verified, any later edit expires that pass.
  const verifyGate = new VerifyGate(profile)
  // §4: tracks recurring failures across the run to drive escalation.
  const fixTracker = new FixTracker()

  for (let turn = 0; turn < MAX_CODING_TURNS; turn++) {
    if (stopRequested) {
      return { success: false, summary: 'Paused: the user returned before the task finished.' }
    }

    // Withhold tool-call JSON from the UI, same as the interactive loop.
    const gate = new StreamGate((delta) => emit(win, 'openui:chat:chunk', delta))
    // Code-heavy loop: run on the code-tuned Ollama model (OLLAMA_CODE_MODEL)
    // rather than the general one.
    const responseText = await callModel(win, tier, messages, systemPrompt, gate.push, { coding: true })
    messages.push({ role: 'assistant', content: responseText })

    const toolCall = parseToolCall(responseText)
    gate.finalize(toolCall !== null)
    if (!toolCall) {
      // Plain-language reply ⇒ the agent considers the task finished (or gave up).
      const decision = verifyGate.onFinalReply(responseText)
      if (decision === 'nudge') {
        // It wrote code and never proved it works. Say so and keep the loop alive.
        emit(win, 'openui:task:update', {
          id: `a${++taskSeq}`,
          label: verifyGate.nudgeLabel,
          status: 'working',
          detail: `Summarised without running ${profile.verifiers.join(' / ')} — asking it to verify.`
        })
        messages.push({ role: 'user', content: verifyGate.nudgeMessage() })
        continue
      }
      return { success: verifyGate.isVerified && decision !== 'give_up', summary: responseText.trim() }
    }

    const taskId = `a${++taskSeq}`
    const label = describeCodingToolCall(toolCall.tool, toolCall.args)
    emit(win, 'openui:task:update', { id: taskId, label, status: 'working', detail: 'Coding…' })

    const toolT0 = Date.now()
    const result = await executeCodingTool(toolCall.tool, toolCall.args)
    runLog.toolCall({
      tool: toolCall.tool,
      ok: result.ok,
      ms: Date.now() - toolT0,
      argsSummary: label,
      error: result.ok ? undefined : result.error?.slice(0, 300)
    })
    // §5 success signal: only THIS profile's verifier counts, a later red run
    // clears an earlier pass, and any successful edit expires a pass that
    // described the tree as it used to be.
    verifyGate.observe(toolCall.tool, toolCall.args, result.ok, result.output ?? '')

    // §4: when a verifier came back red, attach the parsed failure locations +
    // their surrounding source (and escalation guidance for recurring failures)
    // so the model can fix the cause without spending a turn reading it back.
    let debugContext = ''
    if (result.ok && profile.verdict(toolCall.tool, result.output ?? '') === 'fail') {
      debugContext = await buildDebugContext(result.output ?? '', fixTracker, runLog)
    }

    emit(win, 'openui:task:update', {
      id: taskId,
      label,
      status: result.ok ? 'done' : 'error',
      detail: result.ok ? result.output?.slice(0, 200) : result.error
    })

    messages.push({ role: 'user', content: formatToolResult(toolCall.tool, result) + debugContext })
  }

  return { success: false, summary: 'Reached the coding-turn limit before verification passed.' }
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

  // Unattended work goes to the shared default workspace, never into the folder
  // a previous interactive build named, and never pops an editor window over
  // whatever the user is currently doing.
  resetActiveProject()
  disarmEditorAutoOpen()

  try {
    let worked = 0
    void pruneSnapshots()

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

      // Task 3: classify the task so prompts and the verification signal match
      // the kind of project (website / node / ML / DL / competitive programming).
      const profile = getProjectProfile(detectProjectType(task.title, task.description))
      emitAutonomousStatus(win, {
        active: true,
        state: 'working',
        currentTask: task.title,
        detail: `Project type: ${profile.label}`
      })

      // Transactional task run (Task 5): snapshot pre-images of every file the
      // task writes, and journal the whole run as structured JSONL.
      const runLog = startRun('autonomous-task', {
        taskId: task.id,
        title: task.title,
        source: task.source,
        projectType: profile.type,
        tier
      })
      try {
        await beginTaskSnapshot(task.id)
      } catch (err) {
        console.warn('[autonomous] snapshot unavailable for this task:', err)
      }

      let outcome: TaskOutcome
      try {
        outcome = await workOnTask(win, tier, task, runLog, profile)
      } catch (err) {
        outcome = { success: false, summary: err instanceof Error ? err.message : String(err) }
      }

      // If we stopped because the user returned, leave the task pending so it is
      // retried next idle window rather than being marked failed. Partial
      // progress is kept (the retry opens a fresh snapshot from that state).
      if (stopRequested && !outcome.success) {
        discardActiveSnapshot()
        runLog.end('cancelled', 'paused — user became active')
        emitAutonomousStatus(win, { active: true, state: 'paused', currentTask: task.title })
        break
      }

      if (outcome.success) {
        discardActiveSnapshot()
        runLog.end('success', outcome.summary.slice(0, 300))
      } else {
        // Definitive failure (GIVE UP / turn limit / crash): roll the workspace
        // back so the next task never starts on top of half-broken edits.
        const rollback = await restoreActiveSnapshot()
        runLog.event('rollback', { detail: rollback })
        runLog.end('failure', outcome.summary.slice(0, 300))
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
