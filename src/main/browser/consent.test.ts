import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  originOf,
  isOriginGranted,
  grantOrigin,
  revokeOrigin,
  listGrantedOrigins,
  setConsentDirForTests
} from './consent'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'openui-consent-'))
  setConsentDirForTests(dir)
})

describe('consent — per-site browser grants', () => {
  it('normalises URLs to origins and rejects non-http(s) schemes', () => {
    expect(originOf('https://Example.com/path?q=1#f')).toBe('https://example.com')
    expect(originOf('http://localhost:3000/x')).toBe('http://localhost:3000')
    expect(originOf('file:///etc/passwd')).toBeNull()
    expect(originOf('javascript:alert(1)')).toBeNull()
    expect(originOf('not a url')).toBeNull()
  })

  it('starts with no grants and persists a grant across cache resets', () => {
    expect(isOriginGranted('https://example.com')).toBe(false)
    grantOrigin('https://example.com', 'hitl')
    expect(isOriginGranted('https://example.com')).toBe(true)

    // Simulate a process restart: the registry reloads from disk.
    setConsentDirForTests(dir)
    expect(isOriginGranted('https://example.com')).toBe(true)
    expect(listGrantedOrigins()).toEqual(['https://example.com'])
  })

  it('appends every grant to the domain audit log', () => {
    grantOrigin('https://a.com', 'hitl')
    grantOrigin('https://b.com', 'settings')
    grantOrigin('https://a.com', 'hitl') // duplicate — no second audit line

    const log = readFileSync(join(dir, 'logs', 'browser-domains.log'), 'utf8')
    const lines = log.trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(/GRANT https:\/\/a\.com via hitl$/)
    expect(lines[1]).toMatch(/GRANT https:\/\/b\.com via settings$/)
  })

  it('a grant for one origin does not leak to others', () => {
    grantOrigin('https://example.com', 'hitl')
    expect(isOriginGranted('https://evil-example.com')).toBe(false)
    expect(isOriginGranted('http://example.com')).toBe(false) // scheme matters
    expect(isOriginGranted('https://sub.example.com')).toBe(false)
  })

  it('revoke removes the grant and audits it', () => {
    grantOrigin('https://example.com', 'hitl')
    revokeOrigin('https://example.com')
    expect(isOriginGranted('https://example.com')).toBe(false)
    const log = readFileSync(join(dir, 'logs', 'browser-domains.log'), 'utf8')
    expect(log).toMatch(/REVOKE https:\/\/example\.com/)
  })

  it('creates no files until the first grant', () => {
    expect(isOriginGranted('https://x.com')).toBe(false)
    expect(existsSync(join(dir, 'browser-consent.json'))).toBe(false)
  })
})
