import { describe, it, expect } from 'vitest'
import { parseUnifiedDiff, applyPatch } from './patch'

// A small helper so fixtures read as real files, not escaped one-liners.
const lines = (...l: string[]): string => l.join('\n')

describe('parseUnifiedDiff', () => {
  it('parses a single hunk with explicit ranges', () => {
    const diff = lines('@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c')
    const hunks = parseUnifiedDiff(diff)
    expect(hunks).toHaveLength(1)
    expect(hunks[0]).toMatchObject({ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3 })
    expect(hunks[0].lines).toEqual([
      { type: ' ', text: 'a' },
      { type: '-', text: 'b' },
      { type: '+', text: 'B' },
      { type: ' ', text: 'c' }
    ])
  })

  it('defaults a missing length to 1', () => {
    const hunks = parseUnifiedDiff(lines('@@ -5 +5 @@', '-old', '+new'))
    expect(hunks[0]).toMatchObject({ oldStart: 5, oldLines: 1, newStart: 5, newLines: 1 })
  })

  it('parses multiple hunks', () => {
    const diff = lines('@@ -1,1 +1,1 @@', '-a', '+A', '@@ -5,1 +5,1 @@', '-e', '+E')
    expect(parseUnifiedDiff(diff)).toHaveLength(2)
  })

  it('ignores --- / +++ / diff --git preamble before the first hunk', () => {
    const diff = lines(
      'diff --git a/x.ts b/x.ts',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -1,1 +1,1 @@',
      '-a',
      '+A'
    )
    const hunks = parseUnifiedDiff(diff)
    expect(hunks).toHaveLength(1)
    expect(hunks[0].lines).toEqual([
      { type: '-', text: 'a' },
      { type: '+', text: 'A' }
    ])
  })

  it('ignores "\\ No newline at end of file" markers', () => {
    const diff = lines('@@ -1,1 +1,1 @@', '-a', '\\ No newline at end of file', '+A')
    expect(parseUnifiedDiff(diff)[0].lines).toEqual([
      { type: '-', text: 'a' },
      { type: '+', text: 'A' }
    ])
  })

  it('throws on empty input and on input with no hunks', () => {
    expect(() => parseUnifiedDiff('')).toThrow(/empty/)
    expect(() => parseUnifiedDiff('just some prose, no hunks')).toThrow(/no @@ hunks/)
  })
})

describe('applyPatch', () => {
  it('replaces a line, preserving the trailing newline', () => {
    const original = lines('a', 'b', 'c') + '\n'
    const hunks = parseUnifiedDiff(lines('@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c'))
    expect(applyPatch(original, hunks)).toBe(lines('a', 'B', 'c') + '\n')
  })

  it('preserves the absence of a trailing newline', () => {
    const original = lines('a', 'b', 'c') // no trailing \n
    const hunks = parseUnifiedDiff(lines('@@ -2,1 +2,1 @@', '-b', '+B'))
    expect(applyPatch(original, hunks)).toBe(lines('a', 'B', 'c'))
  })

  it('applies a pure insertion (no removed lines)', () => {
    const original = lines('a', 'c') + '\n'
    const hunks = parseUnifiedDiff(lines('@@ -1,2 +1,3 @@', ' a', '+b', ' c'))
    expect(applyPatch(original, hunks)).toBe(lines('a', 'b', 'c') + '\n')
  })

  it('applies a pure deletion (no added lines)', () => {
    const original = lines('a', 'b', 'c') + '\n'
    const hunks = parseUnifiedDiff(lines('@@ -1,3 +1,2 @@', ' a', '-b', ' c'))
    expect(applyPatch(original, hunks)).toBe(lines('a', 'c') + '\n')
  })

  it('applies two hunks in one pass', () => {
    const original = lines('a', 'b', 'c', 'd', 'e') + '\n'
    const diff = lines('@@ -1,1 +1,1 @@', '-a', '+A', '@@ -5,1 +5,1 @@', '-e', '+E')
    expect(applyPatch(original, parseUnifiedDiff(diff))).toBe(lines('A', 'b', 'c', 'd', 'E') + '\n')
  })

  it('tolerates drifted line numbers when context still matches', () => {
    // The diff claims the change is at line 2, but the file has an extra header
    // line so it is really at line 4. Context ("needle") still pins it.
    const original = lines('hdr1', 'hdr2', 'pre', 'needle', 'post') + '\n'
    const hunks = parseUnifiedDiff(lines('@@ -2,3 +2,3 @@', ' pre', '-needle', '+FOUND', ' post'))
    expect(applyPatch(original, hunks)).toBe(lines('hdr1', 'hdr2', 'pre', 'FOUND', 'post') + '\n')
  })

  it('rejects a patch whose context no longer matches the file', () => {
    const original = lines('a', 'totally', 'different') + '\n'
    const hunks = parseUnifiedDiff(lines('@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c'))
    expect(() => applyPatch(original, hunks)).toThrow(/does not apply/)
  })
})
