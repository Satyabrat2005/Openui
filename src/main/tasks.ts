/**
 * tasks.ts — task sources for the autonomous coding agent (Phase 8).
 *
 * Two backends:
 *   1. Local `todo.json` in the workspace — the default, zero-config source.
 *      Shape: { tasks: [{ id, title, description?, status }] }.
 *      The agent reads pending tasks and writes back "done"/"failed" status so
 *      progress survives restarts and the user can see what was attempted.
 *   2. GitHub Issues — READ-ONLY. With GITHUB_TOKEN + GITHUB_REPO set, open
 *      issues are pulled as tasks. We deliberately never close, comment on, or
 *      otherwise mutate GitHub from an unattended loop: that is an outward-facing,
 *      hard-to-reverse action that must stay under explicit user control. The
 *      result of working an issue is recorded only in the local todo.json mirror.
 */
import { writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ensureWorkspace } from './sandbox'

export type TaskStatus = 'pending' | 'done' | 'failed'

export interface AgentTask {
  id: string
  title: string
  description?: string
  status: TaskStatus
  /** Where the task came from, for display + to avoid mutating GitHub. */
  source: 'todo' | 'github'
}

export type TaskSource = 'todo' | 'github'

function todoPath(workspace: string): string {
  return join(workspace, 'todo.json')
}

interface TodoFile {
  tasks: AgentTask[]
}

/** Load the local todo.json, tolerating absence/corruption with an empty list. */
async function loadTodoFile(): Promise<TodoFile> {
  const workspace = await ensureWorkspace()
  try {
    const raw = await readFile(todoPath(workspace), 'utf8')
    const parsed = JSON.parse(raw) as Partial<TodoFile>
    if (!parsed || !Array.isArray(parsed.tasks)) return { tasks: [] }
    // Normalise each entry defensively — the file is user-editable.
    const tasks = parsed.tasks
      .filter((t): t is AgentTask => !!t && typeof t.id === 'string' && typeof t.title === 'string')
      .map((t) => ({
        id: t.id,
        title: t.title,
        description: typeof t.description === 'string' ? t.description : undefined,
        status: (t.status === 'done' || t.status === 'failed' ? t.status : 'pending') as TaskStatus,
        source: 'todo' as const
      }))
    return { tasks }
  } catch {
    return { tasks: [] }
  }
}

async function saveTodoFile(file: TodoFile): Promise<void> {
  const workspace = await ensureWorkspace()
  await writeFile(todoPath(workspace), JSON.stringify(file, null, 2), 'utf8')
}

/**
 * Fetch open issues from GitHub as tasks (read-only). Requires:
 *   GITHUB_REPO  — "owner/name"
 *   GITHUB_TOKEN — a token with repo read scope (optional for public repos but
 *                  recommended to avoid the low unauthenticated rate limit).
 * Returns [] (not an error) when unconfigured, so the caller can silently fall
 * back to the local todo.json.
 */
async function fetchGitHubIssues(): Promise<AgentTask[]> {
  const repo = process.env.GITHUB_REPO?.trim()
  const token = process.env.GITHUB_TOKEN?.trim()
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return []

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'OpenUI-Autonomous-Agent'
  }
  if (token) headers.Authorization = `Bearer ${token}`

  // Electron's main process has the global fetch (Node ≥ 18 / Chromium).
  const res = await fetch(`https://api.github.com/repos/${repo}/issues?state=open&per_page=20`, {
    headers
  })
  if (!res.ok) {
    throw new Error(`GitHub API returned ${res.status} ${res.statusText}`)
  }
  const issues = (await res.json()) as Array<{
    number: number
    title: string
    body: string | null
    pull_request?: unknown
  }>
  return issues
    // The issues endpoint also returns PRs; drop those.
    .filter((i) => !i.pull_request)
    .map((i) => ({
      id: `gh-${i.number}`,
      title: i.title,
      description: i.body ?? undefined,
      status: 'pending' as TaskStatus,
      source: 'github' as const
    }))
}

/**
 * Return the next pending task from the configured source, or null when there
 * is nothing to do. GitHub status is mirrored into todo.json so issues already
 * attempted are not picked up again on the next idle cycle.
 */
export async function getNextTask(source: TaskSource): Promise<AgentTask | null> {
  if (source === 'github') {
    const [issues, todo] = await Promise.all([fetchGitHubIssues(), loadTodoFile()])
    const attempted = new Set(todo.tasks.filter((t) => t.status !== 'pending').map((t) => t.id))
    const next = issues.find((i) => !attempted.has(i.id))
    return next ?? null
  }
  const todo = await loadTodoFile()
  return todo.tasks.find((t) => t.status === 'pending') ?? null
}

/**
 * Record the outcome of a task in the local todo.json. For GitHub-sourced tasks
 * this upserts a mirror row (we never write back to GitHub). For todo-sourced
 * tasks it updates the matching row in place.
 */
export async function recordTaskOutcome(task: AgentTask, status: 'done' | 'failed'): Promise<void> {
  const file = await loadTodoFile()
  const i = file.tasks.findIndex((t) => t.id === task.id)
  if (i === -1) {
    file.tasks.push({ ...task, status })
  } else {
    file.tasks[i] = { ...file.tasks[i], status }
  }
  await saveTodoFile(file)
}
