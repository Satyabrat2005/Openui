import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  check_repo_exists,
  create_repo,
  update_readme,
  open_pull_request,
  list_open_prs,
  get_pr_diff,
  post_pr_comment
} from './github'

// These tests exercise the pure validation + token gate that runs BEFORE any
// network call to Octokit, so no HTTP mock is needed. GITHUB_TOKEN is cleared so
// the "token required" branch is deterministic regardless of the dev's env.
const savedToken = process.env.GITHUB_TOKEN

beforeEach(() => {
  delete process.env.GITHUB_TOKEN
})
afterEach(() => {
  if (savedToken === undefined) delete process.env.GITHUB_TOKEN
  else process.env.GITHUB_TOKEN = savedToken
})

describe('check_repo_exists', () => {
  it('rejects a missing repo argument', async () => {
    const r = await check_repo_exists({})
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/requires a string "repo"/)
  })

  it('rejects an invalid owner/repo format', async () => {
    const r = await check_repo_exists({ repo: 'not-a-repo' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/invalid repo format/)
  })
})

describe('create_repo', () => {
  it('requires a name', async () => {
    const r = await create_repo({})
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/requires a string "name"/)
  })

  it('rejects an invalid repository name', async () => {
    const r = await create_repo({ name: 'bad name/with slash' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/invalid repository name/)
  })

  it('requires a token for the write op', async () => {
    const r = await create_repo({ name: 'valid-name' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/requires a GitHub token/)
  })
})

describe('update_readme', () => {
  it('requires repo and content', async () => {
    expect((await update_readme({ content: 'x' })).error).toMatch(/requires a string "repo"/)
    expect((await update_readme({ repo: 'o/r' })).error).toMatch(/requires non-empty string "content"/)
  })

  it('rejects an invalid repo format before touching the network', async () => {
    const r = await update_readme({ repo: 'nope', content: '# hi' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/invalid repo format/)
  })

  it('requires a token', async () => {
    const r = await update_readme({ repo: 'owner/repo', content: '# hi' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/requires a GitHub token/)
  })
})

describe('open_pull_request', () => {
  it('requires repo and title', async () => {
    expect((await open_pull_request({ title: 't' })).error).toMatch(/requires a string "repo"/)
    expect((await open_pull_request({ repo: 'o/r' })).error).toMatch(/requires a non-empty string "title"/)
  })

  it('rejects an invalid repo format', async () => {
    const r = await open_pull_request({ repo: 'nope', title: 'My PR' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/invalid repo format/)
  })

  it('requires a token (never auto-merges)', async () => {
    const r = await open_pull_request({ repo: 'owner/repo', title: 'My PR' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/requires a GitHub token/)
  })
})

// The three read/review tools validate their arguments BEFORE any Octokit call,
// so these cases never hit the network regardless of GITHUB_TOKEN.
describe('list_open_prs', () => {
  it('requires a repo argument', async () => {
    const r = await list_open_prs({})
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/requires a string "repo"/)
  })

  it('rejects an invalid owner/repo format', async () => {
    const r = await list_open_prs({ repo: 'not-a-repo' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/invalid repo format/)
  })
})

describe('get_pr_diff', () => {
  it('requires a repo argument', async () => {
    const r = await get_pr_diff({ pr_number: 1 })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/requires a string "repo"/)
  })

  it('requires a positive integer pr_number', async () => {
    expect((await get_pr_diff({ repo: 'owner/repo' })).error).toMatch(/positive integer "pr_number"/)
    expect((await get_pr_diff({ repo: 'owner/repo', pr_number: -3 })).error).toMatch(
      /positive integer "pr_number"/
    )
  })

  it('rejects an invalid repo format', async () => {
    const r = await get_pr_diff({ repo: 'nope', pr_number: 1 })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/invalid repo format/)
  })
})

describe('post_pr_comment', () => {
  it('requires a repo argument', async () => {
    const r = await post_pr_comment({ pr_number: 1, comment: 'hi' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/requires a string "repo"/)
  })

  it('requires a positive integer pr_number', async () => {
    const r = await post_pr_comment({ repo: 'owner/repo', comment: 'hi' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/positive integer "pr_number"/)
  })

  it('requires a non-empty comment', async () => {
    const r = await post_pr_comment({ repo: 'owner/repo', pr_number: 1, comment: '   ' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/non-empty string "comment"/)
  })
})
