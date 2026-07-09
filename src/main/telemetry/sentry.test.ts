/**
 * Tests for the Sentry PII scrubbers — the part that must be exactly right
 * before any event leaves the machine. Pure functions; no Electron, no SDK.
 */
import { describe, expect, it } from 'vitest'
import { scrubText, scrubEvent } from './sentry'

describe('scrubText', () => {
  it('redacts GitHub tokens', () => {
    expect(scrubText('push failed for ghp_abcDEF1234567890abcDEF12')).not.toContain('ghp_')
    expect(scrubText('using github_pat_11AAAAAAA0abcdefghijklmnop')).not.toContain('github_pat_')
    expect(scrubText('oauth gho_abcDEF1234567890abcDEF12 expired')).not.toContain('gho_')
  })

  it('redacts API keys, JWTs and bearer headers', () => {
    expect(scrubText('key sk-proj-abc123def456ghi789jkl rejected')).not.toContain('sk-proj')
    expect(
      scrubText('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk')
    ).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    expect(scrubText('Authorization: Bearer abc123def456ghi789')).not.toContain('abc123def456')
    expect(scrubText('figma figd_AbC123-def456_GHI789jkl failed')).not.toContain('figd_')
  })

  it('redacts email addresses', () => {
    const out = scrubText('user someone@example.com hit an error')
    expect(out).not.toContain('someone@example.com')
    expect(out).toContain('[email]')
  })

  it('strips usernames from Windows and Unix paths but keeps the rest', () => {
    const win = scrubText('Error at C:\\Users\\ashu\\Downloads\\Openui-main\\src\\main\\agent.ts:42')
    expect(win).not.toContain('ashu')
    expect(win).toContain('agent.ts:42')

    const mac = scrubText('at /Users/ashu/dev/openui/index.js')
    expect(mac).not.toContain('ashu')
    expect(mac).toContain('/Users/[user]/dev/openui/index.js')

    const linux = scrubText('at /home/ashu/openui/index.js')
    expect(linux).toContain('/home/[user]/openui/index.js')
  })

  it('leaves ordinary error text alone', () => {
    const msg = 'Cannot read properties of undefined (reading "foo")'
    expect(scrubText(msg)).toBe(msg)
  })
})

describe('scrubEvent', () => {
  it('drops identity fields outright', () => {
    const event = scrubEvent({
      message: 'boom',
      user: { id: '123', email: 'x@y.com' },
      request: { headers: { cookie: 'session=abc' } },
      server_name: 'ASHU-PC',
      extra: { prompt: 'private user text' }
    })
    expect(event.user).toBeUndefined()
    expect(event.request).toBeUndefined()
    expect(event.server_name).toBeUndefined()
    expect(event.extra).toBeUndefined()
    expect(event.message).toBe('boom')
  })

  it('scrubs exception values and stack frame paths', () => {
    const event = scrubEvent({
      exception: {
        values: [
          {
            value: 'ENOENT: no such file C:\\Users\\ashu\\secret.txt (token ghp_abcDEF1234567890abcDEF12)',
            stacktrace: {
              frames: [
                { filename: 'C:\\Users\\ashu\\Downloads\\Openui-main\\src\\main\\agent.ts', abs_path: '/Users/ashu/x.js' }
              ]
            }
          }
        ]
      }
    })
    const ex = event.exception!.values![0]
    expect(ex.value).not.toContain('ashu')
    expect(ex.value).not.toContain('ghp_')
    expect(ex.stacktrace!.frames![0].filename).not.toContain('ashu')
    expect(ex.stacktrace!.frames![0].abs_path).toBe('/Users/[user]/x.js')
  })

  it('scrubs breadcrumb messages and drops breadcrumb data', () => {
    const event = scrubEvent({
      breadcrumbs: [
        { message: 'fetch https://api.github.com as someone@example.com', data: { url: 'https://x?token=abc' } }
      ]
    })
    expect(event.breadcrumbs![0].message).toContain('[email]')
    expect(event.breadcrumbs![0].data).toBeUndefined()
  })
})
