/**
 * github.ts — GitHub PR review tools for the OpenUI agent (Phase 10).
 *
 * Three tools the agent can call to drive automated PR reviews:
 *   list_open_prs(repo)                          — list open PRs
 *   get_pr_diff(repo, pr_number)                 — fetch the unified diff
 *   post_pr_comment(repo, pr_number, comment)    — leave a review comment
 *
 * Uses @octokit/rest (lazy-loaded — absent package surfaces as a tool error,
 * not a crash). Authentication is via GITHUB_TOKEN env var; unauthenticated
 * requests work for public repos but hit a very low rate limit.
 *
 * SECURITY:
 *   - repo names are validated against REPO_RE before reaching the API.
 *   - diff output is capped to MAX_DIFF_CHARS to prevent context flooding.
 *   - comment bodies are length-validated against GitHub's API limit.
 *   - no env var or secret is interpolated into any URL or API field;
 *     all untrusted data is passed as typed API method parameters.
 */

import type { ToolResult, ToolSchema } from './tools'

// "owner/repo" — alphanumeric, dots, hyphens, underscores only.
const REPO_RE = /^[\w.-]+\/[\w.-]+$/

// A bare repository name (no owner) for create_repo — GitHub's own charset.
const REPO_NAME_RE = /^[\w.-]{1,100}$/

// Large diffs (monorepo sweeps, generated files) would flood the context window.
const MAX_DIFF_CHARS = 24_000

// GitHub's hard limit on issue / PR comment bodies.
const MAX_COMMENT_CHARS = 65_536

// Defensive caps on repo-write payloads (README content, PR title/body).
const MAX_README_CHARS = 512 * 1024
const MAX_TITLE_CHARS = 256
const MAX_PR_BODY_CHARS = 65_536

// Default branch name used when committing a README so it can be opened as a PR
// against the repo's default branch rather than committing straight to it.
const INIT_BRANCH = 'openui/init'

/** True only when a GITHUB_TOKEN is configured — required for any write op. */
function hasToken(): boolean {
  return !!process.env.GITHUB_TOKEN?.trim()
}

/** Uniform "you need a token" error for the write tools. */
function tokenRequiredError(tool: string): ToolResult {
  return {
    ok: false,
    error:
      `${tool} requires a GitHub token with "repo" scope. ` +
      `Set GITHUB_TOKEN in your environment (create one at github.com → Settings → ` +
      `Developer settings → Personal access tokens) and try again.`
  }
}

/** Narrow an Octokit error to its HTTP status, if present. */
function errStatus(err: unknown): number | undefined {
  return typeof err === 'object' && err !== null && 'status' in err
    ? Number((err as { status?: unknown }).status)
    : undefined
}

/** Lazy-load @octokit/rest and return the Octokit constructor. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getOctokitClass(): any {
  try {
    // @octokit/rest v20 exports `{ Octokit }` as a named export.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('@octokit/rest') as Record<string, unknown>
    const Cls = mod.Octokit ?? (mod.default as Record<string, unknown>)?.Octokit ?? mod.default ?? mod
    if (typeof Cls !== 'function') {
      throw new Error('Could not locate Octokit constructor in @octokit/rest exports.')
    }
    return Cls
  } catch (err) {
    throw new Error(
      `@octokit/rest is not installed. Run: npm install @octokit/rest\n` +
        `${err instanceof Error ? err.message : String(err)}`
    )
  }
}

/** Build an authenticated (or anonymous) Octokit instance from env. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildClient(): any {
  const Octokit = getOctokitClass()
  const token = process.env.GITHUB_TOKEN?.trim()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Octokit({ auth: token ?? undefined }) as any
}

/** Validate and split an "owner/repo" string into Octokit parameters. */
function parseRepo(repo: string): { owner: string; repo: string } | null {
  if (!REPO_RE.test(repo)) return null
  const slash = repo.indexOf('/')
  return { owner: repo.slice(0, slash), repo: repo.slice(slash + 1) }
}

// ── tool implementations ──────────────────────────────────────────────────────

/** List open pull requests for a GitHub repository (up to 30, newest first). */
export async function list_open_prs(args: Record<string, unknown>): Promise<ToolResult> {
  const repoStr = typeof args.repo === 'string' ? args.repo.trim() : ''
  if (!repoStr) {
    return { ok: false, error: 'list_open_prs requires a string "repo" (e.g. "owner/repo").' }
  }
  const parsed = parseRepo(repoStr)
  if (!parsed) {
    return {
      ok: false,
      error: `list_open_prs: invalid repo format "${repoStr}". Expected "owner/repo".`
    }
  }

  try {
    const octokit = buildClient()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await octokit.pulls.list({
      ...parsed,
      state: 'open',
      per_page: 30,
      sort: 'updated',
      direction: 'desc'
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prs = data as Array<any>
    if (!prs.length) {
      return { ok: true, output: `No open pull requests found in ${repoStr}.` }
    }
    const lines = prs.map(
      (pr) =>
        `#${pr.number as number} — ${pr.title as string} ` +
        `(by ${(pr.user?.login as string | undefined) ?? 'unknown'}, ` +
        `opened ${(pr.created_at as string).slice(0, 10)})`
    )
    return { ok: true, output: `Open PRs in ${repoStr}:\n${lines.join('\n')}` }
  } catch (err) {
    return {
      ok: false,
      error: `list_open_prs failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}

/** Fetch the unified diff for a specific pull request. */
export async function get_pr_diff(args: Record<string, unknown>): Promise<ToolResult> {
  const repoStr = typeof args.repo === 'string' ? args.repo.trim() : ''
  const rawNum = args.pr_number
  const prNumber =
    typeof rawNum === 'number' ? rawNum : Number.isFinite(Number(rawNum)) ? Number(rawNum) : NaN

  if (!repoStr) {
    return { ok: false, error: 'get_pr_diff requires a string "repo" (e.g. "owner/repo").' }
  }
  if (!Number.isFinite(prNumber) || prNumber <= 0) {
    return { ok: false, error: 'get_pr_diff requires a positive integer "pr_number".' }
  }
  const parsed = parseRepo(repoStr)
  if (!parsed) {
    return {
      ok: false,
      error: `get_pr_diff: invalid repo format "${repoStr}". Expected "owner/repo".`
    }
  }

  try {
    const octokit = buildClient()
    // Requesting the diff media type returns the raw unified diff as a string.
    const response = await octokit.pulls.get({
      ...parsed,
      pull_number: prNumber,
      mediaType: { format: 'diff' }
    })
    const diff = typeof response.data === 'string' ? response.data : JSON.stringify(response.data)
    const trimmed = diff.slice(0, MAX_DIFF_CHARS)
    const truncNote =
      diff.length > MAX_DIFF_CHARS
        ? `\n\n[Diff truncated at ${MAX_DIFF_CHARS.toLocaleString()} characters — ` +
          `${(diff.length - MAX_DIFF_CHARS).toLocaleString()} more characters omitted]`
        : ''
    return {
      ok: true,
      output: `Diff for PR #${prNumber} in ${repoStr}:\n\`\`\`diff\n${trimmed}${truncNote}\n\`\`\``
    }
  } catch (err) {
    return {
      ok: false,
      error: `get_pr_diff failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}

/** Post a review comment on a GitHub pull request. */
export async function post_pr_comment(args: Record<string, unknown>): Promise<ToolResult> {
  const repoStr = typeof args.repo === 'string' ? args.repo.trim() : ''
  const rawNum = args.pr_number
  const prNumber =
    typeof rawNum === 'number' ? rawNum : Number.isFinite(Number(rawNum)) ? Number(rawNum) : NaN
  const comment = typeof args.comment === 'string' ? args.comment.trim() : ''

  if (!repoStr) {
    return { ok: false, error: 'post_pr_comment requires a string "repo" (e.g. "owner/repo").' }
  }
  if (!Number.isFinite(prNumber) || prNumber <= 0) {
    return { ok: false, error: 'post_pr_comment requires a positive integer "pr_number".' }
  }
  if (!comment) {
    return { ok: false, error: 'post_pr_comment requires a non-empty string "comment".' }
  }
  if (comment.length > MAX_COMMENT_CHARS) {
    return {
      ok: false,
      error: `post_pr_comment "comment" exceeds the ${MAX_COMMENT_CHARS.toLocaleString()}-character GitHub limit.`
    }
  }
  const parsed = parseRepo(repoStr)
  if (!parsed) {
    return {
      ok: false,
      error: `post_pr_comment: invalid repo format "${repoStr}". Expected "owner/repo".`
    }
  }

  try {
    const octokit = buildClient()
    // PRs share the issues API in GitHub — issue_number and pull_number are the same.
    const { data } = await octokit.issues.createComment({
      ...parsed,
      issue_number: prNumber,
      body: comment
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const commentData = data as any
    return {
      ok: true,
      output:
        `Posted review comment on PR #${prNumber} in ${repoStr}. ` +
        `Comment URL: ${commentData.html_url as string}`
    }
  } catch (err) {
    return {
      ok: false,
      error: `post_pr_comment failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}

// ── repo automation: check → create → README → PR (Task 2, Item 5) ───────────
//
// SECURITY / SAFETY: these are outward-facing, hard-to-reverse writes to GitHub.
// They are registered as STATE_CHANGING_TOOLS in tools.ts, so the agent loop
// gates each behind the HITL approval modal; open_pull_request is additionally
// in DESTRUCTIVE_TOOLS so it ALWAYS asks — even under approve-plan / full-auto.
// There is deliberately NO merge tool: merging is left to a human click on
// GitHub. The autonomous loop never calls these (tasks.ts keeps GitHub writes
// under explicit user control).

/** Check whether a repository exists (read-only). */
export async function check_repo_exists(args: Record<string, unknown>): Promise<ToolResult> {
  const repoStr = typeof args.repo === 'string' ? args.repo.trim() : ''
  if (!repoStr) {
    return { ok: false, error: 'check_repo_exists requires a string "repo" (e.g. "owner/repo").' }
  }
  const parsed = parseRepo(repoStr)
  if (!parsed) {
    return { ok: false, error: `check_repo_exists: invalid repo format "${repoStr}". Expected "owner/repo".` }
  }
  try {
    const octokit = buildClient()
    const { data } = await octokit.repos.get(parsed)
    return {
      ok: true,
      output:
        `Repository ${repoStr} EXISTS (default branch: ${data.default_branch as string}, ` +
        `${data.private ? 'private' : 'public'}). URL: ${data.html_url as string}`
    }
  } catch (err) {
    if (errStatus(err) === 404) {
      return { ok: true, output: `Repository ${repoStr} does NOT exist.` }
    }
    return {
      ok: false,
      error: `check_repo_exists failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}

/** Create a new repository for the authenticated user (initialised with a commit). */
export async function create_repo(args: Record<string, unknown>): Promise<ToolResult> {
  const name = typeof args.name === 'string' ? args.name.trim() : ''
  const description = typeof args.description === 'string' ? args.description.trim() : undefined
  const isPrivate = args.private === true || args.private === 'true'
  if (!name) return { ok: false, error: 'create_repo requires a string "name".' }
  if (!REPO_NAME_RE.test(name)) {
    return {
      ok: false,
      error: `create_repo: invalid repository name "${name}". Use letters, digits, ".", "-" or "_" (max 100 chars).`
    }
  }
  if (!hasToken()) return tokenRequiredError('create_repo')

  try {
    const octokit = buildClient()
    // auto_init creates the default branch with an initial commit, so a README
    // can later be committed to a branch and opened as a PR against it.
    const { data } = await octokit.repos.createForAuthenticatedUser({
      name,
      description,
      private: isPrivate,
      auto_init: true
    })
    return {
      ok: true,
      output:
        `Created repository ${data.full_name as string} ` +
        `(${data.private ? 'private' : 'public'}, default branch: ${data.default_branch as string}). ` +
        `URL: ${data.html_url as string}`
    }
  } catch (err) {
    if (errStatus(err) === 422) {
      return { ok: false, error: `create_repo: a repository named "${name}" already exists on your account.` }
    }
    return {
      ok: false,
      error: `create_repo failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}

/**
 * Create or update README.md on a branch (default: openui/init, branched off the
 * repo's default branch) so it can be opened as a pull request. Handles both the
 * create and update cases by looking up the existing file SHA on the branch.
 */
export async function update_readme(args: Record<string, unknown>): Promise<ToolResult> {
  const repoStr = typeof args.repo === 'string' ? args.repo.trim() : ''
  const content = typeof args.content === 'string' ? args.content : ''
  const branch = typeof args.branch === 'string' && args.branch.trim() ? args.branch.trim() : INIT_BRANCH
  if (!repoStr) return { ok: false, error: 'update_readme requires a string "repo" (e.g. "owner/repo").' }
  if (!content) return { ok: false, error: 'update_readme requires non-empty string "content".' }
  if (content.length > MAX_README_CHARS) {
    return { ok: false, error: `update_readme "content" exceeds the ${MAX_README_CHARS}-character limit.` }
  }
  const parsed = parseRepo(repoStr)
  if (!parsed) {
    return { ok: false, error: `update_readme: invalid repo format "${repoStr}". Expected "owner/repo".` }
  }
  if (!hasToken()) return tokenRequiredError('update_readme')

  try {
    const octokit = buildClient()

    // Discover the default branch to base the working branch on.
    const { data: repoData } = await octokit.repos.get(parsed)
    const base = repoData.default_branch as string

    // Ensure the target branch exists; create it off the default branch if not.
    if (branch !== base) {
      try {
        await octokit.git.getRef({ ...parsed, ref: `heads/${branch}` })
      } catch (err) {
        if (errStatus(err) !== 404) throw err
        const { data: baseRef } = await octokit.git.getRef({ ...parsed, ref: `heads/${base}` })
        await octokit.git.createRef({
          ...parsed,
          ref: `refs/heads/${branch}`,
          sha: baseRef.object.sha as string
        })
      }
    }

    // Look up the existing README SHA on the branch (required for updates).
    let existingSha: string | undefined
    try {
      const { data: file } = await octokit.repos.getContent({ ...parsed, path: 'README.md', ref: branch })
      if (!Array.isArray(file) && 'sha' in file) existingSha = file.sha as string
    } catch (err) {
      if (errStatus(err) !== 404) throw err // 404 ⇒ new file, leave sha undefined
    }

    const { data } = await octokit.repos.createOrUpdateFileContents({
      ...parsed,
      path: 'README.md',
      message: existingSha ? 'docs: update README (via OpenUI)' : 'docs: add README (via OpenUI)',
      content: Buffer.from(content, 'utf8').toString('base64'),
      branch,
      ...(existingSha ? { sha: existingSha } : {})
    })
    return {
      ok: true,
      output:
        `${existingSha ? 'Updated' : 'Created'} README.md on branch "${branch}" of ${repoStr}. ` +
        `Commit: ${data.commit?.html_url as string}`
    }
  } catch (err) {
    return {
      ok: false,
      error: `update_readme failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}

/**
 * Open a pull request. base defaults to the repo's default branch; head defaults
 * to the openui/init branch that update_readme commits to. This never merges —
 * that stays a human click on GitHub.
 */
export async function open_pull_request(args: Record<string, unknown>): Promise<ToolResult> {
  const repoStr = typeof args.repo === 'string' ? args.repo.trim() : ''
  const title = typeof args.title === 'string' ? args.title.trim() : ''
  const body = typeof args.body === 'string' ? args.body : ''
  const head = typeof args.head === 'string' && args.head.trim() ? args.head.trim() : INIT_BRANCH
  const baseArg = typeof args.base === 'string' && args.base.trim() ? args.base.trim() : ''
  if (!repoStr) return { ok: false, error: 'open_pull_request requires a string "repo" (e.g. "owner/repo").' }
  if (!title) return { ok: false, error: 'open_pull_request requires a non-empty string "title".' }
  if (title.length > MAX_TITLE_CHARS) {
    return { ok: false, error: `open_pull_request "title" exceeds ${MAX_TITLE_CHARS} characters.` }
  }
  if (body.length > MAX_PR_BODY_CHARS) {
    return { ok: false, error: `open_pull_request "body" exceeds ${MAX_PR_BODY_CHARS} characters.` }
  }
  const parsed = parseRepo(repoStr)
  if (!parsed) {
    return { ok: false, error: `open_pull_request: invalid repo format "${repoStr}". Expected "owner/repo".` }
  }
  if (!hasToken()) return tokenRequiredError('open_pull_request')

  try {
    const octokit = buildClient()
    let base = baseArg
    if (!base) {
      const { data: repoData } = await octokit.repos.get(parsed)
      base = repoData.default_branch as string
    }
    if (head === base) {
      return {
        ok: false,
        error: `open_pull_request: head and base are both "${base}". Commit your changes to a different branch (e.g. "${INIT_BRANCH}") first.`
      }
    }
    const { data } = await octokit.pulls.create({ ...parsed, title, body, head, base })
    return {
      ok: true,
      output:
        `Opened PR #${data.number as number} "${title}" (${head} → ${base}) in ${repoStr}. ` +
        `Review and merge it here: ${data.html_url as string}`
    }
  } catch (err) {
    return {
      ok: false,
      error: `open_pull_request failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}

// ── schemas (LLM-facing surface) ─────────────────────────────────────────────

/** JSON schemas for the three GitHub PR review tools. */
export const githubToolSchemas: ToolSchema[] = [
  {
    name: 'list_open_prs',
    description:
      'List all open pull requests in a GitHub repository, sorted by most recently updated. ' +
      'Returns PR number, title, author, and creation date. ' +
      'Requires GITHUB_TOKEN env var (repo read scope) for private repos; ' +
      'works without a token for public repos at a lower rate limit.',
    parameters: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'GitHub repository in "owner/repo" format, e.g. "torvalds/linux".'
        }
      },
      required: ['repo']
    }
  },
  {
    name: 'get_pr_diff',
    description:
      'Fetch the unified diff (code changes) for a GitHub pull request. ' +
      'Returns the raw diff suitable for code review analysis. ' +
      'Diffs larger than 24,000 characters are truncated with a note.',
    parameters: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'GitHub repository in "owner/repo" format.'
        },
        pr_number: {
          type: 'number',
          description: 'The pull request number (integer).'
        }
      },
      required: ['repo', 'pr_number']
    }
  },
  {
    name: 'post_pr_comment',
    description:
      'Post a markdown comment on a GitHub pull request — used to leave an automated code review ' +
      'after analysing the PR diff with get_pr_diff. ' +
      'Requires GITHUB_TOKEN env var with repo write scope.',
    parameters: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'GitHub repository in "owner/repo" format.'
        },
        pr_number: {
          type: 'number',
          description: 'The pull request number (integer).'
        },
        comment: {
          type: 'string',
          description: 'The markdown comment body to post on the pull request.'
        }
      },
      required: ['repo', 'pr_number', 'comment']
    }
  },
  {
    name: 'check_repo_exists',
    description:
      'Check whether a GitHub repository exists (read-only). Returns whether it exists and, if so, its default branch and visibility. ' +
      'Call this FIRST when automating repo setup, to decide whether to create the repo.',
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'GitHub repository in "owner/repo" format.' }
      },
      required: ['repo']
    }
  },
  {
    name: 'create_repo',
    description:
      'Create a new GitHub repository for the authenticated user, initialised with a first commit. ' +
      'Requires GITHUB_TOKEN with "repo" scope. Use after check_repo_exists reports the repo is missing. ' +
      'This is a state-changing action — the user will be asked to approve it.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name (no owner), e.g. "my-app".' },
        description: { type: 'string', description: 'Optional short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private (default false).' }
      },
      required: ['name']
    }
  },
  {
    name: 'update_readme',
    description:
      'Create or update README.md in a GitHub repository on a working branch (default "openui/init", branched off the default branch) so it can be opened as a pull request. ' +
      'Requires GITHUB_TOKEN with "repo" scope. State-changing — the user will be asked to approve it.',
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'GitHub repository in "owner/repo" format.' },
        content: { type: 'string', description: 'The full markdown content for README.md.' },
        branch: { type: 'string', description: 'Branch to commit to (default "openui/init").' }
      },
      required: ['repo', 'content']
    }
  },
  {
    name: 'open_pull_request',
    description:
      'Open a pull request in a GitHub repository from a head branch (default "openui/init") into the base branch (default: the repo default branch). ' +
      'Requires GITHUB_TOKEN with "repo" scope. This does NOT merge — merging is left to a human on GitHub. ' +
      'ALWAYS requires explicit user approval before it runs.',
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'GitHub repository in "owner/repo" format.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request description (markdown).' },
        head: { type: 'string', description: 'The branch with your changes (default "openui/init").' },
        base: { type: 'string', description: 'The branch to merge into (default: repo default branch).' }
      },
      required: ['repo', 'title']
    }
  }
]

/** Executor registry mapping tool name → implementation. */
export const githubRegistry: Record<
  string,
  (args: Record<string, unknown>) => Promise<ToolResult>
> = {
  list_open_prs,
  get_pr_diff,
  post_pr_comment,
  check_repo_exists,
  create_repo,
  update_readme,
  open_pull_request
}
