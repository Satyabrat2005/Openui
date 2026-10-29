/**
 * buddyPose — which pose the Splen character on the home screen is in.
 *
 * Pure so the mapping is testable without rendering SVG. The character reflects
 * the REAL run state (TaskActivityContext), never a timer pretending work is
 * happening: asleep when nothing runs, a task-shaped pose while a run is in
 * progress, a short "done" beat after the latest run finishes.
 */
import type { TaskCard } from '../env'

export type BuddyPose = 'sleep' | 'write' | 'code' | 'work' | 'done'

/** How long the "done" pose lingers after a run finishes before Splen dozes off again. */
export const DONE_LINGER_MS = 6000

const CODE_RE = /\b(code|coding|build|building|builds|execute|executing|run script|script|deploy|debug|fix (the )?bug|compile|program)\b/i
const WRITE_RE = /\b(summari[sz]e|summary|summaries|write|draft|compose|reply|read|catch ?up|what did i miss|notes?|email|mail|message|translate)\b/i

/** Pose for a task's text. `mode` is the composer's Answer/Act toggle at submit time. */
export function poseForText(text: string, mode: 'ask' | 'do'): Exclude<BuddyPose, 'sleep' | 'done'> {
  if (CODE_RE.test(text)) return 'code'
  if (WRITE_RE.test(text)) return 'write'
  return mode === 'ask' ? 'write' : 'work'
}

/**
 * Pose for the whole console. `modes` remembers which toggle each run was
 * started with (runs started elsewhere, e.g. a workflow, default to Act).
 */
export function poseForRuns(
  runs: readonly TaskCard[],
  modes: Readonly<Record<string, 'ask' | 'do'>>,
  now: number
): BuddyPose {
  const active = runs.find((r) => r.status === 'in_progress')
  if (active) return poseForText(active.title, modes[active.title] ?? 'do')
  const latestEnd = runs.reduce((max, r) => Math.max(max, r.endedAt ?? 0), 0)
  if (latestEnd > 0 && now - latestEnd < DONE_LINGER_MS) return 'done'
  return 'sleep'
}

/** One-line caption under the character. */
export const POSE_CAPTION: Record<BuddyPose, string> = {
  sleep: 'Your wish is my command!',
  write: 'Reading and writing…',
  code: 'Building it…',
  work: 'On it…',
  done: 'Done! What’s next?'
}
