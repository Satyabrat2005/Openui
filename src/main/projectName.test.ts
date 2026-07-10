/**
 * projectName.test.ts — slug derivation for the project folder.
 *
 * The slug becomes a path segment under ~/OpenUI Projects, so the cases that
 * matter most are the adversarial ones: a request that tries to smuggle a
 * separator or a `..` must not be able to relocate the sandbox root.
 */
import { describe, it, expect } from 'vitest'
import { deriveProjectSlug, isSafeProjectSlug } from './projectName'

describe('deriveProjectSlug', () => {
  it('strips framing verbs and articles from the head of the request', () => {
    expect(deriveProjectSlug('Build me a 3D motion graphics website for food and groceries')).toBe(
      '3d-motion-graphics-website'
    )
  })

  it('keeps the subject when the request has no framing', () => {
    expect(deriveProjectSlug('todo list app')).toBe('todo-list-app')
  })

  it('never ends on a trailing noise word', () => {
    // "for" would otherwise survive as the 5th word.
    expect(deriveProjectSlug('create a snake game for')).toBe('snake-game')
  })

  it('falls back when the request is empty or all noise', () => {
    expect(deriveProjectSlug('')).toBe('project')
    expect(deriveProjectSlug('please can you build me a')).toBe('project')
    expect(deriveProjectSlug('!!!')).toBe('project')
  })

  it('tolerates a non-string message', () => {
    expect(deriveProjectSlug(undefined as unknown as string)).toBe('project')
    expect(deriveProjectSlug(null as unknown as string)).toBe('project')
  })

  it('caps the slug length and leaves no trailing hyphen', () => {
    const slug = deriveProjectSlug('supercalifragilistic expialidocious antidisestablishmentarianism')
    expect(slug.length).toBeLessThanOrEqual(48)
    expect(slug.endsWith('-')).toBe(false)
    expect(isSafeProjectSlug(slug)).toBe(true)
  })

  it('renames Windows reserved device names', () => {
    expect(deriveProjectSlug('con')).toBe('con-project')
    expect(deriveProjectSlug('NUL')).toBe('nul-project')
  })

  // The trust boundary: a slug is interpolated into a path, so no request may
  // produce a separator, a parent-dir hop, or a drive letter.
  it.each([
    ['../../etc/passwd', 'etc-passwd'],
    ['..', 'project'],
    ['.', 'project'],
    ['C:\\Windows\\System32', 'c-windows-system32'],
    ['foo/bar', 'foo-bar'],
    ['x y', 'x-y']
  ])('sanitises %j into a bare segment', (input, expected) => {
    const slug = deriveProjectSlug(input)
    expect(slug).toBe(expected)
    expect(isSafeProjectSlug(slug)).toBe(true)
    expect(slug).not.toMatch(/[/\\]/)
    expect(slug.split('-')).not.toContain('..')
  })

  it('always returns a slug the sandbox will accept', () => {
    const messages = [
      'Build a REST API!',
      '   ',
      'app -- with --- dashes',
      '🎉 emoji project 🎉',
      'a'.repeat(200)
    ]
    for (const m of messages) expect(isSafeProjectSlug(deriveProjectSlug(m))).toBe(true)
  })
})

describe('isSafeProjectSlug', () => {
  it('accepts bare lowercase slugs', () => {
    expect(isSafeProjectSlug('project')).toBe(true)
    expect(isSafeProjectSlug('my-app-2')).toBe(true)
  })

  it('rejects separators, traversal, casing and edge hyphens', () => {
    expect(isSafeProjectSlug('foo/bar')).toBe(false)
    expect(isSafeProjectSlug('foo\\bar')).toBe(false)
    expect(isSafeProjectSlug('..')).toBe(false)
    expect(isSafeProjectSlug('.')).toBe(false)
    expect(isSafeProjectSlug('-lead')).toBe(false)
    expect(isSafeProjectSlug('trail-')).toBe(false)
    expect(isSafeProjectSlug('MyApp')).toBe(false)
    expect(isSafeProjectSlug('')).toBe(false)
    expect(isSafeProjectSlug('a'.repeat(49))).toBe(false)
  })

  it('rejects non-strings', () => {
    expect(isSafeProjectSlug(undefined as unknown as string)).toBe(false)
    expect(isSafeProjectSlug(42 as unknown as string)).toBe(false)
  })
})
