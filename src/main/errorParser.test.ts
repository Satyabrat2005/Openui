import { describe, it, expect } from 'vitest'
import { parseFailures, failureSignature } from './errorParser'

describe('parseFailures — tsc', () => {
  it('parses the paren form with the TS error code', () => {
    const out = 'src/foo.ts(12,5): error TS2322: Type "string" is not assignable to type "number".'
    const [f] = parseFailures(out)
    expect(f).toMatchObject({ file: 'src/foo.ts', line: 12, column: 5, errorType: 'TS2322' })
    expect(f.message).toMatch(/not assignable/)
  })

  it('parses the pretty/dash form', () => {
    const out = 'src/bar.ts:8:3 - error TS7006: Parameter "x" implicitly has an "any" type.'
    const [f] = parseFailures(out)
    expect(f).toMatchObject({ file: 'src/bar.ts', line: 8, column: 3, errorType: 'TS7006' })
  })
})

describe('parseFailures — compilers (g++)', () => {
  it('parses g++ error lines and skips warnings', () => {
    const out = [
      'main.cpp:14:9: error: expected ";" before "return"',
      'main.cpp:20:1: warning: unused variable "k" [-Wunused-variable]'
    ].join('\n')
    const failures = parseFailures(out)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ file: 'main.cpp', line: 14, column: 9, errorType: 'error' })
  })
})

describe('parseFailures — Vitest / Jest stacks', () => {
  it('picks the innermost app frame from a stack', () => {
    const out = [
      'FAIL  src/math.test.ts > adds numbers',
      'AssertionError: expected 3 to be 4',
      '❯ src/math.test.ts:9:20',
      '    at run (node_modules/vitest/dist/index.js:1:1)'
    ].join('\n')
    const failures = parseFailures(out)
    const files = failures.map((f) => `${f.file}:${f.line}`)
    expect(files).toContain('src/math.test.ts:9')
  })

  it('parses a parenthesised Node stack frame', () => {
    const out = 'Error: boom\n    at Object.<anonymous> (src/index.js:42:11)'
    const failures = parseFailures(out)
    expect(failures.some((f) => f.file === 'src/index.js' && f.line === 42)).toBe(true)
  })
})

describe('parseFailures — pytest', () => {
  it('parses the short-test-summary FAILED line with the error type', () => {
    const out = 'FAILED tests/test_model.py::test_accuracy - AssertionError: 0.4 < 0.9'
    const [f] = parseFailures(out)
    expect(f).toMatchObject({ file: 'tests/test_model.py', errorType: 'AssertionError' })
  })

  it('parses a traceback location line', () => {
    const out = 'tests/test_model.py:31: in test_accuracy\n    assert acc > 0.9'
    const failures = parseFailures(out)
    expect(failures[0]).toMatchObject({ file: 'tests/test_model.py', line: 31 })
  })
})

describe('parseFailures — ESLint blocks', () => {
  it('attaches inline rows to the preceding bare file path', () => {
    const out = [
      '/repo/src/app.ts',
      '  3:7   error  "x" is assigned a value but never used  no-unused-vars',
      '  9:1   warning  Unexpected console statement           no-console'
    ].join('\n')
    const failures = parseFailures(out)
    // Only the error row, carrying the file from the header line and the rule id.
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({
      file: '/repo/src/app.ts',
      line: 3,
      column: 7,
      errorType: 'no-unused-vars'
    })
  })
})

describe('parseFailures — hygiene', () => {
  it('returns nothing for clean output', () => {
    expect(parseFailures('TESTS PASSED\n42 passing')).toEqual([])
    expect(parseFailures('')).toEqual([])
  })

  it('does not treat ordinary prose containing a dotted token as a location', () => {
    expect(parseFailures('See the docs at readme.md for details.')).toEqual([])
  })

  it('de-duplicates repeated identical failures', () => {
    const line = 'src/foo.ts(1,1): error TS1005: ";" expected.'
    expect(parseFailures(`${line}\n${line}\n${line}`)).toHaveLength(1)
  })

  it('caps the number of failures returned', () => {
    const many = Array.from({ length: 50 }, (_, i) => `src/f${i}.ts(1,1): error TS1005: msg`).join(
      '\n'
    )
    expect(parseFailures(many).length).toBeLessThanOrEqual(20)
  })
})

describe('failureSignature', () => {
  it('is stable across cosmetic message differences (numbers, quotes, slashes)', () => {
    const a = failureSignature({
      file: 'src/foo.ts',
      line: 12,
      errorType: 'TS2322',
      message: 'Type "string" is not assignable to type "number" at index 3',
      raw: ''
    })
    const b = failureSignature({
      file: 'src\\foo.ts',
      line: 12,
      errorType: 'TS2322',
      message: 'Type "boolean" is not assignable to type "number" at index 7',
      raw: ''
    })
    expect(a).toBe(b)
  })

  it('differs when the location or error type differs', () => {
    const base = { file: 'a.ts', line: 1, errorType: 'TS1', message: 'm', raw: '' }
    expect(failureSignature(base)).not.toBe(failureSignature({ ...base, line: 2 }))
    expect(failureSignature(base)).not.toBe(failureSignature({ ...base, errorType: 'TS2' }))
  })
})
