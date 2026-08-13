import { describe, it, expect } from 'vitest'
import {
  parseOverleafProjectRef,
  projectUrl,
  classifyOverleafPage,
  validateLatexPayload,
  compareWrittenContent,
  overleafToolSchemas,
  overleafRegistry,
  NOT_LOGGED_IN_MESSAGE,
  overleaf_open_project
} from './overleaf'

const ID = '65a1b2c3d4e5f60718293a4b'

describe('parseOverleafProjectRef', () => {
  it('accepts a bare 24-hex project id', () => {
    expect(parseOverleafProjectRef(ID)).toBe(ID)
    expect(parseOverleafProjectRef(`  ${ID.toUpperCase()}  `)).toBe(ID)
  })

  it('extracts the id from a real project URL', () => {
    expect(parseOverleafProjectRef(`https://www.overleaf.com/project/${ID}`)).toBe(ID)
    expect(parseOverleafProjectRef(`https://overleaf.com/project/${ID}/edit`)).toBe(ID)
  })

  // The id is used to build a URL we then navigate a real browser to, so a
  // foreign host must never be able to smuggle one through.
  it('refuses a project id hosted on a non-Overleaf domain', () => {
    expect(parseOverleafProjectRef(`https://evil.example.com/project/${ID}`)).toBeNull()
    expect(parseOverleafProjectRef(`https://overleaf.com.evil.example/project/${ID}`)).toBeNull()
  })

  it('returns null for junk rather than guessing', () => {
    expect(parseOverleafProjectRef('')).toBeNull()
    expect(parseOverleafProjectRef('my thesis')).toBeNull()
    expect(parseOverleafProjectRef('https://www.overleaf.com/')).toBeNull()
    expect(parseOverleafProjectRef('abc123')).toBeNull()
  })

  it('builds the canonical editor URL', () => {
    expect(projectUrl(ID)).toBe(`https://www.overleaf.com/project/${ID}`)
  })
})

describe('classifyOverleafPage', () => {
  // THE TRAP, measured on the real site: www.overleaf.com/login serves
  // meta[name="ol-user_id"] with NO content and meta[name="ol-usersEmail"]
  // with content="". Checking that the tag EXISTS reports "logged in" on the
  // login page, and the flow would march on into an editor that isn't there.
  it('treats the real logged-out login page as logged out', () => {
    expect(
      classifyOverleafPage({
        url: 'https://www.overleaf.com/login?',
        userId: null,
        usersEmail: ''
      })
    ).toEqual({ state: 'logged-out' })
  })

  it('is logged out on /register too', () => {
    expect(
      classifyOverleafPage({ url: 'https://www.overleaf.com/register', userId: null, usersEmail: null })
    ).toEqual({ state: 'logged-out' })
  })

  // Belt and braces: even if a future Overleaf build DID populate the user meta
  // on the login page, the URL alone still forces the logged-out verdict.
  it('stays logged out on an auth URL even with a populated user meta', () => {
    expect(
      classifyOverleafPage({
        url: 'https://www.overleaf.com/login',
        userId: 'abc123',
        usersEmail: 'someone@example.com'
      })
    ).toEqual({ state: 'logged-out' })
  })

  it('recognises a signed-in project editor', () => {
    expect(
      classifyOverleafPage({
        url: `https://www.overleaf.com/project/${ID}`,
        userId: 'u-1',
        usersEmail: 'me@example.com'
      })
    ).toEqual({ state: 'editor', projectId: ID })
  })

  it('accepts either user signal on its own', () => {
    const onlyEmail = classifyOverleafPage({
      url: `https://www.overleaf.com/project/${ID}`,
      userId: null,
      usersEmail: 'me@example.com'
    })
    expect(onlyEmail).toEqual({ state: 'editor', projectId: ID })
  })

  it('reports signed-in-but-not-in-a-project as elsewhere', () => {
    expect(
      classifyOverleafPage({ url: 'https://www.overleaf.com/project', userId: 'u-1', usersEmail: '' })
    ).toEqual({ state: 'elsewhere', where: '/project' })
  })

  // An unparseable URL means we do not know where the browser is. The property
  // that matters is that it is never classified as an editor we may type into.
  // It is deliberately NOT reported as logged-out either: that would tell a
  // signed-in user to go log in, which is a confidently wrong instruction.
  it('never classifies an unparseable URL as a typeable editor', () => {
    const state = classifyOverleafPage({ url: 'not a url', userId: 'u-1', usersEmail: 'a@b.c' })
    expect(state.state).not.toBe('editor')
    expect(state).toEqual({ state: 'elsewhere', where: '/' })
  })
})

describe('validateLatexPayload', () => {
  it('requires non-empty content', () => {
    expect(validateLatexPayload('')).toMatch(/non-empty/)
    expect(validateLatexPayload('   ')).toMatch(/non-empty/)
    expect(validateLatexPayload(undefined)).toMatch(/non-empty/)
    expect(validateLatexPayload(42)).toMatch(/non-empty/)
  })
  it('rejects an oversized payload', () => {
    expect(validateLatexPayload('x'.repeat(100_001))).toMatch(/over the/)
  })
  it('accepts ordinary LaTeX', () => {
    expect(validateLatexPayload('\\section{Intro}\nHello.')).toBeNull()
  })
})

describe('compareWrittenContent', () => {
  it('verifies an exact match', () => {
    expect(compareWrittenContent('\\section{A}', '\\section{A}').verified).toBe(true)
  })

  // CodeMirror virtualises: off-screen lines are absent from the DOM entirely.
  // A prefix must count as verified or every document taller than the window
  // would be reported as a mismatch.
  it('accepts a truncated readback as the virtualisation it is', () => {
    const written = 'line one\nline two\nline three\nline four'
    const result = compareWrittenContent(written, 'line one\nline two')
    expect(result.verified).toBe(true)
    expect(result.note).toMatch(/virtualised/)
  })

  it('reports genuinely different content as unverified, not as success', () => {
    const result = compareWrittenContent('\\section{Intro}', '\\section{Something Else}')
    expect(result.verified).toBe(false)
    expect(result.note).toMatch(/Could NOT verify/)
  })

  it('does not treat an empty readback as a verified prefix', () => {
    expect(compareWrittenContent('\\section{A}', '').verified).toBe(false)
  })
})

describe('overleaf tool surface', () => {
  it('exposes exactly the four tools', () => {
    const names = overleafToolSchemas.map((s) => s.name).sort()
    expect(names).toEqual([
      'overleaf_open_project',
      'overleaf_read_latex',
      'overleaf_recompile',
      'overleaf_write_latex'
    ])
    expect(Object.keys(overleafRegistry).sort()).toEqual(names)
  })

  // The safety boundary, asserted as a test so it cannot be quietly widened:
  // there is no tool that shares, publishes, or submits a project, and none
  // that logs in. If someone adds one, this fails.
  it('has NO share / publish / submit / login tool', () => {
    const names = overleafToolSchemas.map((s) => s.name)
    for (const forbidden of ['share', 'publish', 'submit', 'login', 'signin', 'password']) {
      expect(names.some((n) => n.includes(forbidden))).toBe(false)
    }
    const blob = JSON.stringify(overleafToolSchemas).toLowerCase()
    expect(blob).not.toMatch(/"password"/)
  })

  it('tells the model not to log in on the user’s behalf', () => {
    expect(NOT_LOGGED_IN_MESSAGE).toMatch(/will not sign in for you/i)
    expect(NOT_LOGGED_IN_MESSAGE).toMatch(/DO NOT attempt to enter credentials/)
  })

  it('disambiguates itself from the local write_latex tool', () => {
    const write = overleafToolSchemas.find((s) => s.name === 'overleaf_write_latex')
    expect(write?.description).toMatch(/write_latex/)
    expect(write?.description).toMatch(/EXISTING Overleaf project/)
  })

  it('rejects a bad project ref before opening any browser', async () => {
    const r = await overleaf_open_project({ project: 'my thesis' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/24-character id/)
    expect(r.error).toMatch(/do not guess/i)
  })

  it('reports no browser session rather than launching one', async () => {
    const r = await overleaf_open_project({ project: ID })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/connect_browser/)
  })
})
