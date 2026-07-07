import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  check_repo_exists,
  create_repo,
  update_readme,
  open_pull_request
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
