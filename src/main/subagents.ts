/**
 * Real parallel subagent orchestration.
 *
 * When the main agent identifies independent subtasks (e.g. "check Netflix
 * usage", "check LinkedIn usage", "check Amazon usage"), it emits ONE
 * `spawn_subagents` tool call. This module then runs those subtasks *genuinely
 * concurrently* (`Promise.all`), each on its own model drawn from the real pool
 * (models.ts), and streams per-subagent lifecycle events to the renderer so the
 * "Running N in parallel" timeline group reflects actual execution — not a mock.
 *
 * Safety rules for subagents (enforced here, not left to the model):
 *   - No destructive tools (concurrent HITL prompts would be chaos; a subagent
 *     that needs one is told to report back instead).
 *   - No recursion: a subagent cannot itself spawn more subagents.
 *   - Bounded turns per subagent.
 * The module is intentionally decoupled from agent.ts (one-way import) to avoid
 * an import cycle: it re-implements the few tiny helpers it needs locally.
 */
import type { BrowserWindow } from 'electron'
import { parseToolCall } from './toolCallParser'
import {
  toolSchemas,
  executeTool,
  DESTRUCTIVE_TOOLS,
  type ToolResult,
  type PendingApprovalResult,
  type Tier
} from './tools'
import { getMcpToolSchemas, callMcpTool } from './mcp-client'
import { getAvailableModels, assignModels, callModelById, type ModelMessage } from './models'

/** The virtual tool name the main agent emits to fan out. Never hits executeTool. */
export const SPAWN_SUBAGENTS_TOOL = 'spawn_subagents'

/** Hard cap on concurrent subagents (keeps model/CPU load and UI sane). */
export const MAX_SUBAGENTS = 4
/** Per-subagent tool-call budget — subtasks are meant to be small and focused. */
const SUBAGENT_MAX_TURNS = 6

export interface SubTaskSpec {
  title: string
  instruction: string
  /** Optional app hint (e.g. "netflix") so the UI can pick an icon immediately. */
  app?: string
}

interface SubOutcome {
  subId: string
  title: string
  ok: boolean
  summary: string
}

/** Local emit — inlined so this module never imports agent.ts (no cycle). */
function emit(win: BrowserWindow, channel: string, ...args: unknown[]): void {
  if (!win.isDestroyed()) win.webContents.send(channel, ...args)
}

/** Tools a subagent may NOT use, on top of everything in DESTRUCTIVE_TOOLS. */
const SUBAGENT_FORBIDDEN = new Set<string>([SPAWN_SUBAGENTS_TOOL, 'complete_step'])

/** Every tool a subagent is allowed to call (built-in + MCP, minus the above). */
function subagentToolNames(): Set<string> {
  const names = new Set<string>()
  for (const s of toolSchemas) names.add(s.name)
  for (const s of getMcpToolSchemas()) names.add(s.name)
  for (const d of DESTRUCTIVE_TOOLS) names.delete(d)
  for (const f of SUBAGENT_FORBIDDEN) names.delete(f)
  return names
}

/** Compact schema listing for the subagent prompt (no dependency on agent.ts). */
function renderSubagentTools(allowed: Set<string>): string {
  return [...toolSchemas, ...getMcpToolSchemas()]
    .filter((s) => allowed.has(s.name))
    .map((s) => `- ${s.name}: ${s.description}`)
    .join('\n')
}

function subagentSystemPrompt(instruction: string, allowed: Set<string>): string {
  return `You are a focused OpenUI sub-agent working IN PARALLEL with other sub-agents. You have exactly ONE job:

${instruction}

To act, respond with ONLY a raw JSON tool call — no prose, no code fences — first character "{":
{"tool": "tool_name", "args": {"key": "value"}}

After each tool runs you receive a "TOOL RESULT" message. Chain tool calls as needed (one per message). When your single task is done, reply in PLAIN TEXT with a concise result (one or two sentences). Do not wrap the final answer in JSON.

Constraints:
- You CANNOT spawn further sub-agents and CANNOT use destructive tools. If your task truly needs one, stop and report that in plain text instead.
- Stay strictly on your one task. Do not do work assigned to other sub-agents.

Available tools:
${renderSubagentTools(allowed)}`
}

/** Turn a tool execution into the next-turn message the model reads. */
function formatResult(tool: string, result: ToolResult): string {
  return result.ok
    ? `TOOL RESULT [${tool}] success: ${result.output ?? '(no output)'}`
    : `TOOL RESULT [${tool}] error: ${result.error ?? 'unknown error'}`
}

/** Run one subagent to completion on its assigned model. Never throws. */
async function runOneSubagent(
  win: BrowserWindow,
  groupId: string,
  subId: string,
  spec: SubTaskSpec,
  tier: Tier
): Promise<SubOutcome> {
  const allowed = subagentToolNames()
  const systemPrompt = subagentSystemPrompt(spec.instruction, allowed)
  const history: ModelMessage[] = [{ role: 'user', content: spec.instruction }]
  emit(win, 'openui:subagent:status', { groupId, subId, status: 'working' })

  // Resolve this subagent's model once (assigned by the caller via the events).
  const modelRef = subModels.get(`${groupId}:${subId}`)
  if (!modelRef) {
    return { subId, title: spec.title, ok: false, summary: 'No model available.' }
  }

  try {
    for (let turn = 0; turn < SUBAGENT_MAX_TURNS; turn++) {
      const text = await callModelById(modelRef, history, systemPrompt)
      history.push({ role: 'assistant', content: text })

      const call = parseToolCall(text, allowed)
      if (!call) {
        const summary = text.trim() || 'Done.'
        emit(win, 'openui:subagent:done', { groupId, subId, status: 'done', summary })
        return { subId, title: spec.title, ok: true, summary }
      }

      // Belt-and-braces: never let a subagent run a forbidden/destructive tool
      // even if it slipped past the prompt.
      if (DESTRUCTIVE_TOOLS.has(call.tool) || SUBAGENT_FORBIDDEN.has(call.tool)) {
        history.push({
          role: 'user',
          content: `TOOL RESULT [${call.tool}] error: sub-agents may not call this tool. Report back in plain text instead.`
        })
        continue
      }

      emit(win, 'openui:subagent:tool', { groupId, subId, tool: call.tool, args: call.args })

      let result: ToolResult
      const raw: ToolResult | PendingApprovalResult = await executeTool(call.tool, call.args, {
        tier,
        bypassHitl: true
      })
      // Non-destructive tools never return pending_approval, but guard anyway.
      if ('status' in raw && raw.status === 'pending_approval') {
        result = { ok: false, error: 'Requires approval; not permitted for a sub-agent.' }
      } else {
        result = raw as ToolResult
      }
      if (!result.ok && result.error?.startsWith('Unknown tool')) {
        result = await callMcpTool(call.tool, call.args)
      }
      history.push({ role: 'user', content: formatResult(call.tool, result) })
    }

    const summary = 'Reached this sub-agent’s step limit before finishing.'
    emit(win, 'openui:subagent:done', { groupId, subId, status: 'error', summary })
    return { subId, title: spec.title, ok: false, summary }
  } catch (err) {
    const summary = err instanceof Error ? err.message : String(err)
    emit(win, 'openui:subagent:done', { groupId, subId, status: 'error', summary })
    return { subId, title: spec.title, ok: false, summary }
  }
}

/** Per-run map of subId → assigned model, so runOneSubagent can look it up. */
const subModels = new Map<string, import('./models').AvailableModel>()

let groupSeq = 0

/**
 * Fan out `specs` into real concurrent subagents and return a merged summary the
 * parent agent can read as the `spawn_subagents` tool result. Emits the full
 * subagent:* event lifecycle so the renderer can render a live parallel group.
 */
export async function runParallelSubagents(
  win: BrowserWindow,
  specs: SubTaskSpec[],
  tier: Tier
): Promise<string> {
  const clamped = specs.slice(0, MAX_SUBAGENTS)
  if (clamped.length === 0) return 'No sub-tasks were provided to run in parallel.'

  const groupId = `g${++groupSeq}`
  const pool = await getAvailableModels()
  const models = assignModels(pool, clamped.length)

  const subs = clamped.map((spec, i) => {
    const subId = `${groupId}s${i + 1}`
    subModels.set(`${groupId}:${subId}`, models[i])
    return {
      subId,
      title: spec.title,
      app: spec.app,
      model: models[i].id,
      modelLabel: models[i].label
    }
  })

  // Announce the whole group up front so the UI can render every row at once.
  emit(win, 'openui:subagent:group', { groupId, count: subs.length, subs })

  try {
    const outcomes = await Promise.all(
      clamped.map((spec, i) => runOneSubagent(win, groupId, subs[i].subId, spec, tier))
    )
    const allOk = outcomes.every((o) => o.ok)
    emit(win, 'openui:subagent:group-done', { groupId, status: allOk ? 'done' : 'error' })

    const lines = outcomes.map((o) => `- ${o.title}: ${o.ok ? '' : '(incomplete) '}${o.summary}`)
    return `Ran ${outcomes.length} sub-agents in parallel. Results:\n${lines.join('\n')}`
  } finally {
    // Drop this run's model assignments.
    for (const s of subs) subModels.delete(`${groupId}:${s.subId}`)
  }
}

/**
 * Parse the `spawn_subagents` args into validated specs. Accepts
 * `{ tasks: [{ title, instruction, app? }, ...] }` and tolerates a couple of
 * common shape variations the model might emit. Returns [] if nothing usable.
 */
export function parseSubTaskSpecs(args: Record<string, unknown>): SubTaskSpec[] {
  const raw = (args.tasks ?? args.subtasks ?? args.agents) as unknown
  if (!Array.isArray(raw)) return []
  const specs: SubTaskSpec[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const rec = item as Record<string, unknown>
    const instruction = String(rec.instruction ?? rec.task ?? rec.prompt ?? '').trim()
    if (!instruction) continue
    const title = String(rec.title ?? rec.name ?? instruction.slice(0, 48)).trim()
    const app = rec.app != null ? String(rec.app).trim() : undefined
    specs.push({ title, instruction, app })
  }
  return specs
}
