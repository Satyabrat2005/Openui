// GitHub write tools for the web service — ports of the desktop github.ts
// contract (Openui/src/main/github.ts) to per-request raw REST. The desktop
// module resolves ONE process-wide token from env/settings; the web service is
// multi-user and receives a DIFFERENT token per request (ctx.connections.github),
// so importing the desktop functions (which read a global token) would be racy.
// We therefore mirror the SAME validation, the SAME blobs→tree→commit→ref push
// flow, and the SAME "you need a token" error shape here, with the token passed
// explicitly. Every state-changing tool below is gated in gates.ts — this file
// makes the gate honest by giving each one a real implementation.

// Contract constants — identical to desktop github.ts.
const REPO_RE = /^[\w.-]+\/[\w.-]+$/
const MAX_README_CHARS = 512 * 1024
const MAX_TITLE_CHARS = 256
const MAX_PR_BODY_CHARS = 65_536
const INIT_BRANCH = 'openui/init'
const MAX_PUSH_FILES = 25
const MAX_PUSH_TOTAL_CHARS = 2 * 1024 * 1024
const PUSH_PATH_RE = /^[\w][\w.\- /]{0,199}$/

export interface GhResult {
  ok: boolean
  output?: string
  error?: string
}

/** Uniform "you need a token" error — the web analogue of desktop tokenRequiredError. */
function tokenRequiredError(tool: string): GhResult {
  return {
    ok: false,
    error:
      `${tool} requires a connected GitHub token with "repo" scope. ` +
      `Add one in OpenUI Web → Connect → GitHub (a personal access token from ` +
      `github.com → Settings → Developer settings → Personal access tokens) and try again.`
  }
}

function parseRepo(repo: string): { owner: string; repo: string } | null {
  if (!REPO_RE.test(repo)) return null
  const slash = repo.indexOf('/')
  return { owner: repo.slice(0, slash), repo: repo.slice(slash + 1) }
}

interface GhResponse<T = unknown> {
  status: number
  ok: boolean
  body: T
}
async function gh<T = unknown>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
  accept = 'application/vnd.github+json'
): Promise<GhResponse<T>> {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: accept,
      'User-Agent': 'openui-web',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  })
  const text = await res.text()
  let parsed: unknown = {}
  try {
    parsed = text ? JSON.parse(text) : {}
  } catch {
    parsed = { message: text }
  }
  return { status: res.status, ok: res.ok, body: parsed as T }
}

function ghErr(tool: string, r: GhResponse<{ message?: string }>): GhResult {
  return { ok: false, error: `${tool} failed: github_${r.status}: ${r.body?.message ?? 'error'}` }
}

// ── create_repo ───────────────────────────────────────────────────────────────
export async function create_repo(args: Record<string, unknown>, token: string): Promise<GhResult> {
  const name = typeof args.name === 'string' ? args.name.trim() : ''
  if (!name) return { ok: false, error: 'create_repo requires a string "name".' }
  if (!token) return tokenRequiredError('create_repo')
  const isPrivate = args.private === false || args.private === 'false' ? false : true
  const r = await gh<{ full_name?: string; html_url?: string; message?: string }>(token, 'POST', '/user/repos', {
    name,
    description: typeof args.description === 'string' ? args.description : '',
    private: isPrivate
  })
  if (!r.ok) return ghErr('create_repo', r)
  return { ok: true, output: `Created repo ${r.body.full_name} — ${r.body.html_url}` }
}

// ── update_readme (create-or-update README.md on a branch) ─────────────────────
export async function update_readme(args: Record<string, unknown>, token: string): Promise<GhResult> {
  const repoStr = typeof args.repo === 'string' ? args.repo.trim() : ''
  const content = typeof args.content === 'string' ? args.content : ''
  const branch = typeof args.branch === 'string' && args.branch.trim() ? args.branch.trim() : INIT_BRANCH
  const message = typeof args.message === 'string' && args.message.trim() ? args.message.trim() : ''
  if (!repoStr) return { ok: false, error: 'update_readme requires a string "repo" (e.g. "owner/repo").' }
  if (!content) return { ok: false, error: 'update_readme requires non-empty string "content".' }
  if (content.length > MAX_README_CHARS) {
    return { ok: false, error: `update_readme "content" exceeds the ${MAX_README_CHARS}-character limit.` }
  }
  const parsed = parseRepo(repoStr)
  if (!parsed) return { ok: false, error: `update_readme: invalid repo format "${repoStr}". Expected "owner/repo".` }
  if (!token) return tokenRequiredError('update_readme')
  const { owner, repo } = parsed

  const repoInfo = await gh<{ default_branch?: string; message?: string }>(token, 'GET', `/repos/${owner}/${repo}`)
  if (!repoInfo.ok) return ghErr('update_readme', repoInfo)
  const base = repoInfo.body.default_branch as string

  const branchErr = await ensureBranch(token, owner, repo, branch, base)
  if (branchErr) return branchErr

  // Existing README sha (required for an update; 404 ⇒ new file).
  let existingSha: string | undefined
  const cur = await gh<{ sha?: string }>(token, 'GET', `/repos/${owner}/${repo}/contents/README.md?ref=${encodeURIComponent(branch)}`)
  if (cur.ok && typeof cur.body?.sha === 'string') existingSha = cur.body.sha
  else if (cur.status !== 404) return ghErr('update_readme', cur as GhResponse<{ message?: string }>)

  const put = await gh<{ commit?: { html_url?: string }; message?: string }>(
    token,
    'PUT',
    `/repos/${owner}/${repo}/contents/README.md`,
    {
      message: message || (existingSha ? 'docs: update README (via OpenUI)' : 'docs: add README (via OpenUI)'),
      content: Buffer.from(content, 'utf8').toString('base64'),
      branch,
      ...(existingSha ? { sha: existingSha } : {})
    }
  )
  if (!put.ok) return ghErr('update_readme', put)
  return {
    ok: true,
    output: `${existingSha ? 'Updated' : 'Created'} README.md on branch "${branch}" of ${repoStr}. Commit: ${put.body.commit?.html_url}`
  }
}

/** Ensure `branch` exists, creating it off `base` if missing. Returns an error result or null. */
async function ensureBranch(token: string, owner: string, repo: string, branch: string, base: string): Promise<GhResult | null> {
  if (branch === base) return null
  const ref = await gh<{ message?: string }>(token, 'GET', `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`)
  if (ref.ok) return null
  if (ref.status !== 404) return ghErr('push_files', ref)
  const baseRef = await gh<{ object?: { sha?: string }; message?: string }>(
    token,
    'GET',
    `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(base)}`
  )
  if (!baseRef.ok) return ghErr('push_files', baseRef)
  const create = await gh<{ message?: string }>(token, 'POST', `/repos/${owner}/${repo}/git/refs`, {
    ref: `refs/heads/${branch}`,
    sha: baseRef.body.object?.sha
  })
  if (!create.ok) return ghErr('push_files', create)
  return null
}

// ── push_files (one commit via the Git Data API) ──────────────────────────────
export async function push_files(args: Record<string, unknown>, token: string): Promise<GhResult> {
  const repoStr = typeof args.repo === 'string' ? args.repo.trim() : ''
  const branch = typeof args.branch === 'string' && args.branch.trim() ? args.branch.trim() : INIT_BRANCH
  const message = typeof args.message === 'string' && args.message.trim() ? args.message.trim() : 'feat: add project files (via OpenUI)'
  const files = args.files
  if (!repoStr) return { ok: false, error: 'push_files requires a string "repo" (e.g. "owner/repo").' }
  if (typeof files !== 'object' || files === null || Array.isArray(files)) {
    return { ok: false, error: 'push_files requires "files": an object mapping repo-relative paths to file contents.' }
  }
  const entries = Object.entries(files as Record<string, unknown>)
  if (entries.length === 0) return { ok: false, error: 'push_files "files" is empty.' }
  if (entries.length > MAX_PUSH_FILES) return { ok: false, error: `push_files accepts at most ${MAX_PUSH_FILES} files per call.` }
  let total = 0
  for (const [path, content] of entries) {
    if (typeof content !== 'string') return { ok: false, error: `push_files: content of "${path}" must be a string.` }
    if (!PUSH_PATH_RE.test(path) || path.includes('..') || path.endsWith('/')) {
      return { ok: false, error: `push_files: invalid file path "${path}". Use repo-relative paths like "src/index.js".` }
    }
    total += content.length
  }
  if (total > MAX_PUSH_TOTAL_CHARS) {
    return { ok: false, error: `push_files: total content exceeds the ${MAX_PUSH_TOTAL_CHARS}-character limit.` }
  }
  const parsed = parseRepo(repoStr)
  if (!parsed) return { ok: false, error: `push_files: invalid repo format "${repoStr}". Expected "owner/repo".` }
  if (!token) return tokenRequiredError('push_files')
  const { owner, repo } = parsed

  const repoInfo = await gh<{ default_branch?: string; message?: string }>(token, 'GET', `/repos/${owner}/${repo}`)
  if (!repoInfo.ok) return ghErr('push_files', repoInfo)
  const base = repoInfo.body.default_branch as string

  const branchErr = await ensureBranch(token, owner, repo, branch, base)
  if (branchErr) return branchErr

  const headRef = await gh<{ object?: { sha?: string }; message?: string }>(
    token,
    'GET',
    `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`
  )
  if (!headRef.ok) return ghErr('push_files', headRef)
  const headSha = headRef.body.object?.sha as string

  const headCommit = await gh<{ tree?: { sha?: string }; message?: string }>(token, 'GET', `/repos/${owner}/${repo}/git/commits/${headSha}`)
  if (!headCommit.ok) return ghErr('push_files', headCommit)

  const tree = await gh<{ sha?: string; message?: string }>(token, 'POST', `/repos/${owner}/${repo}/git/trees`, {
    base_tree: headCommit.body.tree?.sha,
    tree: entries.map(([path, content]) => ({ path, mode: '100644', type: 'blob', content: content as string }))
  })
  if (!tree.ok) return ghErr('push_files', tree)

  const commit = await gh<{ sha?: string; message?: string }>(token, 'POST', `/repos/${owner}/${repo}/git/commits`, {
    message,
    tree: tree.body.sha,
    parents: [headSha]
  })
  if (!commit.ok) return ghErr('push_files', commit)

  const upd = await gh<{ message?: string }>(token, 'PATCH', `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
    sha: commit.body.sha
  })
  if (!upd.ok) return ghErr('push_files', upd)

  return {
    ok: true,
    output:
      `Pushed ${entries.length} file(s) to "${branch}" of ${repoStr} as one commit ` +
      `(${String(commit.body.sha).slice(0, 7)}): ${entries.map(([p]) => p).join(', ')}`
  }
}

// ── open_pull_request ─────────────────────────────────────────────────────────
export async function open_pull_request(args: Record<string, unknown>, token: string): Promise<GhResult> {
  const repoStr = typeof args.repo === 'string' ? args.repo.trim() : ''
  const title = typeof args.title === 'string' ? args.title.trim() : ''
  const body = typeof args.body === 'string' ? args.body : ''
  const head = typeof args.head === 'string' && args.head.trim() ? args.head.trim() : INIT_BRANCH
  const baseArg = typeof args.base === 'string' && args.base.trim() ? args.base.trim() : ''
  if (!repoStr) return { ok: false, error: 'open_pull_request requires a string "repo" (e.g. "owner/repo").' }
  if (!title) return { ok: false, error: 'open_pull_request requires a non-empty string "title".' }
  if (title.length > MAX_TITLE_CHARS) return { ok: false, error: `open_pull_request "title" exceeds ${MAX_TITLE_CHARS} characters.` }
  if (body.length > MAX_PR_BODY_CHARS) return { ok: false, error: `open_pull_request "body" exceeds ${MAX_PR_BODY_CHARS} characters.` }
  const parsed = parseRepo(repoStr)
  if (!parsed) return { ok: false, error: `open_pull_request: invalid repo format "${repoStr}". Expected "owner/repo".` }
  if (!token) return tokenRequiredError('open_pull_request')
  const { owner, repo } = parsed

  let base = baseArg
  if (!base) {
    const repoInfo = await gh<{ default_branch?: string; message?: string }>(token, 'GET', `/repos/${owner}/${repo}`)
    if (!repoInfo.ok) return ghErr('open_pull_request', repoInfo)
    base = repoInfo.body.default_branch as string
  }
  if (head === base) {
    return {
      ok: false,
      error: `open_pull_request: head and base are both "${base}". Commit your changes to a different branch (e.g. "${INIT_BRANCH}") first.`
    }
  }
  const r = await gh<{ number?: number; html_url?: string; message?: string }>(token, 'POST', `/repos/${owner}/${repo}/pulls`, {
    title,
    body,
    head,
    base
  })
  if (!r.ok) return ghErr('open_pull_request', r)
  return {
    ok: true,
    output: `Opened PR #${r.body.number} "${title}" (${head} → ${base}) in ${repoStr}. Review and merge it here: ${r.body.html_url}`
  }
}

// ── merge_pr (the one destructive GitHub write) ───────────────────────────────
export async function merge_pr(args: Record<string, unknown>, token: string): Promise<GhResult> {
  const repoStr = typeof args.repo === 'string' ? args.repo.trim() : ''
  const prNumber = typeof args.pr_number === 'number' ? args.pr_number : Number(args.pr_number)
  const methodArg = typeof args.method === 'string' ? args.method.trim() : 'merge'
  if (!repoStr) return { ok: false, error: 'merge_pr requires a string "repo" (e.g. "owner/repo").' }
  if (!Number.isInteger(prNumber) || prNumber <= 0) return { ok: false, error: 'merge_pr requires a positive integer "pr_number".' }
  if (!['merge', 'squash', 'rebase'].includes(methodArg)) {
    return { ok: false, error: 'merge_pr "method" must be one of: merge, squash, rebase.' }
  }
  const parsed = parseRepo(repoStr)
  if (!parsed) return { ok: false, error: `merge_pr: invalid repo format "${repoStr}". Expected "owner/repo".` }
  if (!token) return tokenRequiredError('merge_pr')
  const { owner, repo } = parsed

  // Surface an honest, specific state instead of a raw 405 when not mergeable.
  const pr = await gh<{ state?: string; draft?: boolean; mergeable?: boolean | null; message?: string }>(
    token,
    'GET',
    `/repos/${owner}/${repo}/pulls/${prNumber}`
  )
  if (!pr.ok) return ghErr('merge_pr', pr)
  if (pr.body.state !== 'open') return { ok: false, error: `merge_pr: PR #${prNumber} in ${repoStr} is ${pr.body.state}, not open.` }
  if (pr.body.draft) return { ok: false, error: `merge_pr: PR #${prNumber} is a draft — mark it ready for review first.` }
  if (pr.body.mergeable === false) {
    return { ok: false, error: `merge_pr: PR #${prNumber} has conflicts with its base branch and cannot be merged. Resolve the conflicts first.` }
  }

  const r = await gh<{ sha?: string; message?: string }>(token, 'PUT', `/repos/${owner}/${repo}/pulls/${prNumber}/merge`, {
    merge_method: methodArg
  })
  if (!r.ok) return ghErr('merge_pr', r)
  return { ok: true, output: `Merged PR #${prNumber} in ${repoStr} via ${methodArg} (${String(r.body.sha).slice(0, 7)}): ${r.body.message}` }
}

export const githubTools: Record<string, (args: Record<string, unknown>, token: string) => Promise<GhResult>> = {
  create_repo,
  update_readme,
  push_files,
  open_pull_request,
  merge_pr
}
