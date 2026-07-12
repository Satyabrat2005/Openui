/**
 * planner.ts — the PLANNING stage of the interactive agent (Milestone 1).
 *
 * The old behaviour was a purely reactive loop: the model emitted one tool,
 * saw the result, then reasoned about the next — so the user only ever saw the
 * task list grow "one out of one". This module adds an explicit planning pass:
 * before executing anything, we ask the model to decompose a task-shaped request
 * into a short ordered checklist. handleChat then shows the WHOLE checklist up
 * front, gets a single approval, and drives the executor to completion — ticking
 * steps off as it goes.
 *
 * The plan is deliberately tool-agnostic prose (not tool JSON): it's a
 * human-readable checklist. The executor (agent.ts) is what maps each step to
 * concrete tool calls and checks it off via the `complete_step` checkpoint.
 */
import type { BrowserWindow } from 'electron'
import { callModel, extractFirstJsonObject, type Message } from './agent'
import type { Tier } from './tools'
import type { AgentTask } from './tasks'

/** A fully-formed plan: a one-line goal plus an ordered list of step titles. */
export interface Plan {
  summary: string
  steps: string[]
}

/** Upper bound on plan size — keeps the checklist scannable and the loop bounded. */
const MAX_STEPS = 8

/**
 * Cheap gate deciding whether a message is worth a planning pass at all. Plain
 * conversation and simple questions ("hi", "what's the weather?") skip planning
 * entirely and take the fast reactive path. False positives are harmless:
 * generatePlan returns null for anything that doesn't decompose into ≥2 steps,
 * so at worst we spend one extra model call.
 */
const TASK_RE =
  /\b(open|launch|start|close|quit|send|message|whatsapp|email|schedule|book|find|search|locate|clean|empty|recycle|delete|remove|move|copy|rename|download|install|navigate|browse|go to|fill|log ?in|sign ?in|create|make|set ?up|play|pause|screenshot|record|reopen|restore|debug|deploy|organi[sz]e|reply|draft|compose)\b/i
const SEQ_RE = /\b(then|after that|and then|first|next|finally|afterwards)\b|;/i

export function looksLikeTask(message: string): boolean {
  const m = message.trim()
  if (!m) return false
  return TASK_RE.test(m) || SEQ_RE.test(m)
}

const PLANNER_SYSTEM_PROMPT = `You are the PLANNING stage of OpenUI, an AI assistant that automates a user's computer (opening apps, browsing the web, searching files, sending messages, editing the calendar, cleaning up files, and so on).

Your ONLY job right now is to break the user's request into a short ordered checklist of concrete steps OpenUI will perform. Do NOT perform anything and do NOT emit tool calls — just the plan.

Respond with ONLY a raw JSON object — no prose before/after, no markdown code fences:
{"summary": "<one short sentence naming the goal>", "steps": ["<step 1>", "<step 2>", ...]}

Rules:
- Each step is a short imperative phrase a person could tick off (≤ 12 words).
- Use 2 to ${MAX_STEPS} steps. Order them by dependency (a step that needs a previous result comes later). Merge trivial actions; never pad.
- ONE step = ONE OpenUI action (one tool call). Writing a file — with ALL its contents — is a SINGLE step; NEVER split it into "create the file", "add line 1", "add line 2", "save". There is no per-line or "save" action: a file is written whole. Likewise "open a folder in an editor" is one step, not "navigate" + "open".
- Example — "make a folder on my Desktop, open it in VS Code, and write hello.js with two lines" → {"summary":"Create openui-demo and add hello.js","steps":["Create the folder Desktop/openui-demo","Open Desktop/openui-demo in VS Code","Write hello.js in it with the requested lines"]} (3 steps, not 7).
- Prefer opening a DESKTOP app over its website when both exist (e.g. WhatsApp Desktop before WhatsApp Web).
- If the request is a single trivial action, or is just conversation / a question that needs no computer actions, return {"summary": "", "steps": []}.`

/**
 * Ask the model to decompose `message` into an ordered plan. Returns a Plan only
 * when the request genuinely needs ≥2 steps; otherwise null (the caller then
 * falls back to the normal single-loop path).
 *
 * The planning tokens are NOT streamed to the chat UI — we pass a discarding
 * onDelta so the user sees the finished checklist (via the task list), not the
 * raw JSON being generated.
 */
export async function generatePlan(
  win: BrowserWindow,
  tier: Tier,
  message: string
): Promise<Plan | null> {
  const messages: Message[] = [{ role: 'user', content: message }]
  // Discard streamed tokens: planning output is structural JSON, never shown.
  const raw = await callModel(win, tier, messages, PLANNER_SYSTEM_PROMPT, () => {})

  const jsonText = extractFirstJsonObject(raw)
  if (!jsonText) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null

  const obj = parsed as Record<string, unknown>
  const summary = typeof obj.summary === 'string' ? obj.summary.trim() : ''
  const steps = Array.isArray(obj.steps)
    ? obj.steps
        .filter((s): s is string => typeof s === 'string')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, MAX_STEPS)
    : []

  if (steps.length < 2) return null
  return { summary: summary || 'Task plan', steps }
}

// --- Coding-task decomposition (§3) ---------------------------------------
//
// A large autonomous coding task is split into independent sub-tasks so the loop
// can run several in parallel (each in its own worktree) instead of grinding one
// linear 20-turn loop. Independence is expressed structurally: sub-tasks with
// disjoint `files` and empty `dependsOn` can run concurrently; the rest run in
// dependency order.

/** Upper bound on sub-tasks — beyond this the coordination cost outweighs the win. */
export const MAX_SUBTASKS = 6

// Per-task tool-call budget (§3). Coding needs more turns than the interactive
// assistant (write → test → fix cycles); the budget grows with task complexity
// from a floor up to a ceiling.
const CODING_TURN_FLOOR = 20
const CODING_TURN_CEILING = 48
const CODING_TURN_PER_STEP = 5

/**
 * Dynamic per-task turn budget (§3), mirroring the interactive planner's
 * `min(CEILING, BASE + steps*perStep)`. `steps` is estimated from the task's own
 * enumerated deliverables (bullet/numbered lines), optionally overridden by a
 * known sub-task count. Pure and deterministic so it is unit-testable. A plain,
 * unstructured task yields exactly CODING_TURN_FLOOR — behaviour is unchanged
 * unless the task is genuinely large.
 */
export function computeTurnBudget(
  task: { title: string; description?: string },
  subtaskCount = 0
): number {
  const text = `${task.title}\n${task.description ?? ''}`
  const bullets = (text.match(/^[\t ]*(?:[-*]|\d+[.)])[\t ]+\S/gm) ?? []).length
  const steps = Math.max(0, Math.floor(subtaskCount), bullets)
  return Math.min(CODING_TURN_CEILING, CODING_TURN_FLOOR + steps * CODING_TURN_PER_STEP)
}

/** One unit of a decomposed coding task. */
export interface SubTask {
  /** Stable id used to express dependencies (`dependsOn`). */
  id: string
  /** Short imperative title for the UI / commit message. */
  title: string
  /** Full instruction handed to a coding worker as its task prompt. */
  instruction: string
  /** Files this sub-task expects to touch; disjoint sets ⇒ safe to parallelise. */
  files: string[]
  /** Ids of sub-tasks that must finish first. */
  dependsOn: string[]
}

const DECOMPOSE_SYSTEM_PROMPT = `You break a software task into the smallest set of INDEPENDENT sub-tasks that can be built and tested separately.

Rules:
- Emit 2 to ${MAX_SUBTASKS} sub-tasks. If the task is small and cohesive, emit an empty list instead of forcing a split.
- Prefer sub-tasks that touch DISJOINT files so they can run in parallel.
- Use "dependsOn" only when one sub-task genuinely needs another's output; keep the dependency graph shallow.
- Each "instruction" must be self-contained: a worker sees only that instruction, not the others.

Respond with ONLY a JSON object, no prose:
{"subtasks":[{"id":"s1","title":"...","instruction":"...","files":["src/a.ts"],"dependsOn":[]}]}`

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean)
    : []
}

/**
 * Heuristic gate: is this task big/broad enough to be worth decomposing? Pure and
 * deterministic so it is unit-testable without a model. A task qualifies when it
 * enumerates several deliverables, or is long AND uses breadth language ("across
 * all…", "refactor", "each module"). Small focused tasks return false and run on
 * the normal single loop.
 */
export function isLargeTask(task: Pick<AgentTask, 'title' | 'description'>): boolean {
  const text = `${task.title}\n${task.description ?? ''}`
  const bulletCount = (text.match(/^[\t ]*(?:[-*]|\d+[.)])[\t ]+\S/gm) ?? []).length
  const multiDeliverable = bulletCount >= 3
  const longEnough = text.length >= 600
  const breadthKeyword =
    /\b(refactor|migrat(?:e|ion)|rewrite|overhaul|end[- ]to[- ]end)\b|across (?:the |all |multiple )|each (?:file|module|component|page|route)|multiple (?:files|modules|components|pages|routes|places)/i.test(
      text
    )
  return multiDeliverable || (longEnough && breadthKeyword)
}

/**
 * Ask the model to decompose a coding task into independent sub-tasks. Returns an
 * empty array when the task should stay whole (small/cohesive, or the model
 * declined to split), so the caller falls back to the normal single loop. Invalid
 * or partial JSON degrades to `[]` rather than throwing — decomposition is an
 * optimisation, never a hard dependency of the loop.
 */
export async function decomposeCodingTask(
  win: BrowserWindow,
  tier: Tier,
  task: Pick<AgentTask, 'title' | 'description'>
): Promise<SubTask[]> {
  const prompt = `Task title: ${task.title}\n\nTask details:\n${task.description ?? '(none)'}`
  const messages: Message[] = [{ role: 'user', content: prompt }]

  let raw: string
  try {
    raw = await callModel(win, tier, messages, DECOMPOSE_SYSTEM_PROMPT, () => {}, { coding: true })
  } catch {
    return []
  }

  const jsonText = extractFirstJsonObject(raw)
  if (!jsonText) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null) return []

  const rawList = (parsed as Record<string, unknown>).subtasks
  if (!Array.isArray(rawList)) return []

  const subtasks: SubTask[] = []
  const seenIds = new Set<string>()
  for (let i = 0; i < rawList.length && subtasks.length < MAX_SUBTASKS; i++) {
    const entry = rawList[i]
    if (typeof entry !== 'object' || entry === null) continue
    const obj = entry as Record<string, unknown>
    const instruction = typeof obj.instruction === 'string' ? obj.instruction.trim() : ''
    if (!instruction) continue
    let id = typeof obj.id === 'string' && obj.id.trim() ? obj.id.trim() : `s${i + 1}`
    // Guarantee unique ids so dependsOn resolution and worktree names stay distinct.
    while (seenIds.has(id)) id = `${id}_${i + 1}`
    seenIds.add(id)
    const title = typeof obj.title === 'string' && obj.title.trim() ? obj.title.trim() : instruction.slice(0, 60)
    subtasks.push({ id, title, instruction, files: asStringArray(obj.files), dependsOn: asStringArray(obj.dependsOn) })
  }

  // Drop dependencies that point at ids we discarded, so the scheduler never
  // deadlocks waiting on a sub-task that does not exist.
  for (const st of subtasks) st.dependsOn = st.dependsOn.filter((d) => seenIds.has(d) && d !== st.id)

  // Fewer than 2 valid sub-tasks ⇒ not worth the parallel machinery.
  return subtasks.length >= 2 ? subtasks : []
}
