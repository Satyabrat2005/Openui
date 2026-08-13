/**
 * codingSubagents.ts — parallel coding workers for large tasks (Task §3).
 *
 * A large autonomous task is decomposed (planner.decomposeCodingTask) into
 * independent sub-tasks. This module runs those sub-tasks CONCURRENTLY, each in
 * its own git worktree so their edits never collide in the single shared
 * workspace directory. A worker:
 *   1. gets a fresh linked worktree + branch off the current HEAD,
 *   2. runs a bounded coding loop pinned to that worktree via runInWorkspace
 *      (AsyncLocalStorage — so every sandbox path/tool/git call resolves there),
 *   3. commits its verified work on its own branch.
 * Then the coordinator merges each worker's branch back into the main workspace,
 * aborting + reporting any conflict so the caller can re-integrate sequentially.
 *
 * The whole path degrades safely: if the workspace is not a git repo (no base
 * commit to branch from), runParallelCodingSubagents reports `anyRan: false` and
 * the caller falls back to the normal single loop — a task is never dropped.
 *
 * NOTE: a live parallel run needs a real git binary + the coding model (Ollama).
 * The scheduling (scheduleLayers) and merge/worktree mechanics are unit-tested;
 * the model layer is mocked in tests.
 */
import type { BrowserWindow } from 'electron'
import { callModel, parseToolCall, StreamGate, type Message } from './agent'
import { looksLikeAttemptedToolCall } from './toolCallParser'
import { executeCodingTool } from './codingTools'
import { VerifyGate } from './verifyGate'
import {
  addWorktree,
  removeWorktree,
  mergeWorktreeBranch,
  abortMerge,
  runInWorkspace,
  commitCheckpoint,
  currentCommit,
  type WorktreeHandle
} from './sandbox'
import type { SubTask } from './planner'
import type { ProjectProfile } from './projectProfiles'
import type { RunLog } from './runLog'
import type { Tier, ToolResult } from './tools'

const WORKER_SYSTEM_PROMPT = `You are one of several OpenUI coding sub-agents, each working UNATTENDED on a DIFFERENT slice of a larger task, in your own isolated copy of the workspace. Never ask for clarification — make a reasonable decision and proceed.

You own ONLY your sub-task. Do not attempt the other slices; another agent has them. Stay within the files your sub-task names (plus anything you must create for it). Do not delete or rewrite unrelated code.

To call a tool, respond with ONLY a valid JSON object and nothing else:
{"tool": "tool_name", "args": {"key": "value"}}

After each tool runs you receive a message starting with "TOOL RESULT". Call exactly one tool per message.

Workflow: read before you edit (read_file); create new files with write_file and change existing files with edit_file (never rewrite a whole file for a small change); run the verifier that fits the project (run_tests / run_script / run_pytest / run_cpp) and fix the CAUSE of any failure, then re-run. When your slice is done AND its verifier is green, reply in plain natural language summarising what you changed — do NOT wrap the summary in JSON. If you cannot make it pass after honest attempts, reply in plain text beginning with "GIVE UP:". Never fake a pass or delete tests to make them pass.`

/** Outcome of one sub-task worker after its (attempted) merge into main. */
export interface SubtaskOutcome {
  subtask: SubTask
  /** The worker's own verifier went green. */
  success: boolean
  /** The worker's branch merged cleanly into the main workspace. */
  merged: boolean
  summary: string
}

export interface DecompositionResult {
  outcomes: SubtaskOutcome[]
  /** At least one worker actually ran (false ⇒ caller must fall back to the single loop). */
  anyRan: boolean
  /** Every sub-task ran, verified, and merged with no conflict. */
  allMerged: boolean
}

/** Per-worker turn budget: smaller than a whole task, grows with declared files. */
function workerTurnBudget(subtask: SubTask): number {
  return Math.min(24, 8 + subtask.files.length * 3)
}

function formatToolResult(tool: string, result: ToolResult): string {
  if (result.ok) return `TOOL RESULT [${tool}] success: ${result.output ?? '(no output)'}`
  return `TOOL RESULT [${tool}] error: ${result.error ?? 'unknown error'}`
}

function workerPrompt(subtask: SubTask, profile: ProjectProfile): string {
  const lines = [
    `SUB-TASK: ${subtask.title}`,
    `\n${subtask.instruction}`,
    subtask.files.length ? `\nExpected files: ${subtask.files.join(', ')}` : '',
    `\n${profile.taskHint}`
  ]
  return lines.filter(Boolean).join('\n')
}

/**
 * Split sub-tasks into dependency-ordered layers. Sub-tasks within a layer have
 * no unmet dependency on each other and so may run in parallel — file overlap is
 * safe because each runs in its own worktree; overlap only matters at merge time.
 * Pure and deterministic (unit-tested). A dependency cycle (or a reference to a
 * dropped id) never deadlocks: the tangled remainder is emitted as one final
 * layer so every sub-task still runs.
 */
export function scheduleLayers(subtasks: SubTask[]): SubTask[][] {
  const ids = new Set(subtasks.map((s) => s.id))
  const done = new Set<string>()
  const layers: SubTask[][] = []
  let remaining = subtasks.slice()

  while (remaining.length > 0) {
    const ready = remaining.filter((s) =>
      s.dependsOn.every((d) => !ids.has(d) || done.has(d))
    )
    if (ready.length === 0) {
      // Unresolvable dependencies among the remainder — run them together rather
      // than deadlock. Correctness (every sub-task runs) over optimal ordering.
      layers.push(remaining)
      break
    }
    layers.push(ready)
    for (const s of ready) done.add(s.id)
    remaining = remaining.filter((s) => !done.has(s.id))
  }
  return layers
}

/** Run one sub-task to completion inside its own worktree; commit on its branch. */
async function runWorker(
  win: BrowserWindow,
  tier: Tier,
  subtask: SubTask,
  profile: ProjectProfile
): Promise<{ subtask: SubTask; handle: WorktreeHandle | null; success: boolean; summary: string }> {
  const handle = await addWorktree(subtask.id)
  if (!handle) {
    return { subtask, handle: null, success: false, summary: 'Could not create an isolated worktree.' }
  }

  return runInWorkspace(handle.path, async () => {
    const budget = workerTurnBudget(subtask)
    const systemPrompt = `${WORKER_SYSTEM_PROMPT}\n\n${profile.promptAddendum}`
    const messages: Message[] = [{ role: 'user', content: workerPrompt(subtask, profile) }]
    const verifyGate = new VerifyGate(profile)

    let success = false
    let summary = `Sub-task "${subtask.title}" reached its turn limit before verifying.`

    for (let turn = 0; turn < budget; turn++) {
      // Workers do not stream into the single chat UI — discard their deltas.
      const gate = new StreamGate(() => {})
      const responseText = await callModel(win, tier, messages, systemPrompt, gate.push, {
        coding: true
      })
      messages.push({ role: 'assistant', content: responseText })

      const toolCall = parseToolCall(responseText)
      const malformed = !toolCall && looksLikeAttemptedToolCall(responseText)
      gate.finalize(toolCall !== null || malformed)

      if (!toolCall) {
        // Ask BEFORE onFinalReply consumes the nudge, since it reads the same state.
        const giveUp = verifyGate.giveUpChallenge(responseText)
        const decision = verifyGate.onFinalReply(responseText)
        if (decision === 'nudge') {
          messages.push({
            role: 'user',
            content: giveUp ? verifyGate.giveUpMessage(giveUp) : verifyGate.nudgeMessage()
          })
          continue
        }
        success = verifyGate.isVerified && decision !== 'give_up'
        summary = responseText.trim()
        break
      }

      const result = await executeCodingTool(toolCall.tool, toolCall.args)
      verifyGate.observe(toolCall.tool, toolCall.args, result.ok, result.output ?? '')
      messages.push({ role: 'user', content: formatToolResult(toolCall.tool, result) })
    }

    // Commit whatever the worker produced onto its branch so it can be merged.
    // (A clean tree just returns the standing HEAD — harmless.)
    await commitCheckpoint(`subtask: ${subtask.title}`.slice(0, 200))

    return { subtask, handle, success, summary }
  })
}

/**
 * Run a decomposed task's sub-tasks in parallel worktrees, then merge each
 * verified branch back into the main workspace. Requires a base commit to branch
 * from; if the workspace is not a git repo one is created, and if that is
 * impossible the result reports `anyRan: false` so the caller falls back to the
 * normal single loop. Merges are serialised (they mutate the main tree); a
 * conflicting merge is aborted and reported, leaving the main tree clean.
 */
export async function runParallelCodingSubagents(
  win: BrowserWindow,
  tier: Tier,
  subtasks: SubTask[],
  profile: ProjectProfile,
  runLog: RunLog
): Promise<DecompositionResult> {
  // Workers branch off a base commit — make sure one exists.
  if ((await currentCommit()) === null) {
    const base = await commitCheckpoint('base: before decomposition')
    if (!base) {
      return { outcomes: [], anyRan: false, allMerged: false }
    }
  }

  const layers = scheduleLayers(subtasks)
  const outcomes: SubtaskOutcome[] = []

  for (const layer of layers) {
    // Everything in a layer runs concurrently, each in its own worktree.
    const results = await Promise.all(layer.map((st) => runWorker(win, tier, st, profile)))

    // Merge serially — merge mutates the single main working tree.
    for (const wr of results) {
      let merged = false
      if (wr.success && wr.handle) {
        const mergeRes = await mergeWorktreeBranch(wr.handle.branch)
        if (mergeRes.passed) {
          merged = true
          runLog.event('subtask_merged', { subtask: wr.subtask.id, branch: wr.handle.branch })
        } else {
          // Leave the main tree clean; the caller's integration loop re-does the gap.
          await abortMerge()
          runLog.event('merge_conflict', { subtask: wr.subtask.id, branch: wr.handle.branch })
        }
      } else if (wr.handle) {
        runLog.event('subtask_failed', { subtask: wr.subtask.id })
      }

      if (wr.handle) await removeWorktree(wr.handle)
      outcomes.push({ subtask: wr.subtask, success: wr.success, merged, summary: wr.summary })
    }
  }

  const anyRan = outcomes.some((o) => o.subtask !== undefined) && layers.some((l) => l.length > 0)
  const allMerged = outcomes.length > 0 && outcomes.every((o) => o.merged)
  return { outcomes, anyRan, allMerged }
}
