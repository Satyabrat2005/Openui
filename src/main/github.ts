/**
 * github.ts — GitHub PR review tools for the OpenUI agent (Phase 10).
 *
 * Three tools the agent can call to drive automated PR reviews:
 *   list_open_prs(repo)                          — list open PRs
 *   get_pr_diff(repo, pr_number)                 — fetch the unified diff
 *   post_pr_comment(repo, pr_number, comment)    — leave a review comment
 *
 * Uses @octokit/rest (lazy-loaded — absent package surfaces as a tool error,
 * not a crash). Authentication uses a per-user GitHub personal access token the
 * user supplies in Settings → GitHub (see getGithubToken; the GITHUB_TOKEN env
 * var remains a local-dev fallback). A GitHub PAT is an inherently user-owned
 * credential — unlike OUR shared LLM keys — so the right fix is a Settings
 * field, not a server-side proxy. Unauthenticated requests work for public
 * repos but hit a very low rate limit.
 *
 * SECURITY:
 *   - repo names are validated against REPO_RE before reaching the API.
 *   - diff output is capped to MAX_DIFF_CHARS to prevent context flooding.
 *   - comment bodies are length-validated against GitHub's API limit.
 *   - no env var or secret is interpolated into any URL or API field;
 *     all untrusted data is passed as typed API method parameters.
 *   - the token stays in the main process — never crosses the contextBridge.
 */

import type { ToolResult, ToolSchema } from './tools'
import { database } from './database'

// Settings key under which the user's GitHub personal access token is stored
// (via Settings → GitHub). Keep in sync with the renderer's SettingsModal.
export const GITHUB_TOKEN_SETTING_KEY = 'github_token'

/**
 * Resolve the GitHub personal access token. A GitHub PAT is a per-user
 * credential (unlike OUR shared, server-side LLM keys), so the user supplies
 * their OWN in Settings → GitHub; the GITHUB_TOKEN env var remains a local-dev
 * fallback. Returns '' when neither is set (anonymous, public-repo-only access).
 */
export function getGithubToken(): string {
  const stored = database.settings.getSetting(GITHUB_TOKEN_SETTING_KEY)
  if (typeof stored === 'string' && stored.trim()) return stored.trim()
  return process.env.GITHUB_TOKEN?.trim() ?? ''
}

// "owner/repo" — alphanumeric, dots, hyphens, underscores only.
const REPO_RE = /^[\w.-]+\/[\w.-]+$/

// Large diffs (monorepo sweeps, generated files) would flood the context window.
const MAX_DIFF_CHARS = 24_000

// GitHub's hard limit on issue / PR comment bodies.
const MAX_COMMENT_CHARS = 65_536

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

/** Build an authenticated (or anonymous) Octokit instance from the user token. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildClient(): any {
  const Octokit = getOctokitClass()
  const token = getGithubToken()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Octokit({ auth: token || undefined }) as any
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

// ── schemas (LLM-facing surface) ─────────────────────────────────────────────

/** JSON schemas for the three GitHub PR review tools. */
export const githubToolSchemas: ToolSchema[] = [
  {
    name: 'list_open_prs',
    description:
      'List all open pull requests in a GitHub repository, sorted by most recently updated. ' +
      'Returns PR number, title, author, and creation date. ' +
      'Requires a GitHub token (repo read scope), set in Settings → GitHub, for private repos; ' +
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
      'Requires a GitHub token with repo write scope, set in Settings → GitHub.',
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
  }
]

/** Executor registry mapping tool name → implementation. */
export const githubRegistry: Record<
  string,
  (args: Record<string, unknown>) => Promise<ToolResult>
> = {
  list_open_prs,
  get_pr_diff,
  post_pr_comment
}
