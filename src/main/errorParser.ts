/**
 * errorParser.ts — turn raw verifier output into structured failures (Task §4).
 *
 * The autonomous coding loop feeds `run_tests` / `run_pytest` / `run_script`
 * output back to the model as a wall of text and hopes it re-reads the offending
 * file itself — which costs a whole turn on every failure and, on a big repo,
 * often lands on the wrong line. This module extracts the `file:line` + error
 * type from the formats the sandbox's runners actually produce (tsc, Vitest /
 * Jest, pytest, g++, ESLint) so the loop can auto-fetch the surrounding code and
 * detect when the SAME failure keeps recurring after a "fix".
 *
 * Deliberately pure: string in, structs out. No fs, no Electron — every format
 * below has a fixture in errorParser.test.ts.
 */

export interface ParsedFailure {
  /** Path exactly as it appeared in the output (may be absolute or relative). */
  file: string
  /** 1-based line number. */
  line: number
  /** 1-based column, when the format reports one. */
  column?: number
  /** Machine-ish error tag: 'TS2322', 'AssertionError', 'error', an ESLint rule… */
  errorType?: string
  /** Human message, trimmed and capped. */
  message?: string
  /** The raw output line this was parsed from. */
  raw: string
}

const MAX_FAILURES = 20
const MAX_MESSAGE = 300

// Source extensions we recognise as file references. Kept deliberately tight so
// arbitrary "word.word" tokens in prose are not mistaken for file paths.
const EXT = 'ts|tsx|js|jsx|mjs|cjs|py|cpp|cc|cxx|c|h|hpp'

// A path token, optionally prefixed by a Windows drive letter so the drive's
// own colon is not mistaken for the line:col separator. No spaces (rare in
// sandbox paths and ambiguous to parse).
const PATH = `(?:[A-Za-z]:)?[\\w./\\\\-]+?\\.(?:${EXT})`

// tsc, paren form:  src/foo.ts(12,5): error TS2322: Type 'x' is not assignable…
const TSC_PAREN = new RegExp(`^\\s*(${PATH})\\((\\d+),(\\d+)\\):\\s*error\\s+(TS\\d+):\\s*(.+?)\\s*$`)

// tsc, pretty/dash form:  src/foo.ts:12:5 - error TS2322: message
const TSC_DASH = new RegExp(`^\\s*(${PATH}):(\\d+):(\\d+)\\s*-\\s*error\\s+(TS\\d+):\\s*(.+?)\\s*$`)

// Compilers (g++/clang) & other `file:line:col: error: msg` producers.
const COMPILER = new RegExp(
  `^\\s*(${PATH}):(\\d+):(\\d+):\\s*((?:fatal )?error|warning):\\s*(.+?)\\s*$`,
  'i'
)

// pytest short-test-summary:  FAILED tests/test_foo.py::test_x - AssertionError: …
const PYTEST_SUMMARY = new RegExp(
  `^\\s*(?:FAILED|ERROR)\\s+(${PATH})::\\S+?(?:\\s+-\\s+(.+?))?\\s*$`
)

// pytest traceback location:  path/to/test_foo.py:12: in test_x   /   :12: SomeError
const PY_PATH = `(?:[A-Za-z]:)?[\\w./\\\\-]+?\\.py`
const PYTEST_LOC = new RegExp(`^\\s*(${PY_PATH}):(\\d+):\\s*(.+?)\\s*$`)

// ESLint inline row (needs the file from the preceding bare-path line):
//   12:5  error  'x' is defined but never used  no-unused-vars
const ESLINT_ROW = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s{2,}([\w\-@/]+))?\s*$/

// A bare file path on its own line — how ESLint (and some reporters) head a block.
const BARE_PATH = new RegExp(`^\\s*(${PATH})\\s*$`)

// Stack frame / generic location:  at fn (src/foo.ts:12:5)  /  ❯ src/foo.ts:12:5
// Captures the LAST file:line(:col) token on the line (the innermost frame).
const STACK_LOC = new RegExp(`(${PATH}):(\\d+)(?::(\\d+))?`, 'g')

function clip(msg: string | undefined): string | undefined {
  if (!msg) return undefined
  const t = msg.trim()
  if (!t) return undefined
  return t.length > MAX_MESSAGE ? t.slice(0, MAX_MESSAGE) + '…' : t
}

/**
 * Extract structured failures from a verifier's combined stdout+stderr.
 * Results are in first-appearance order and de-duplicated by signature, capped
 * so a runaway log cannot flood the model context.
 */
export function parseFailures(output: string): ParsedFailure[] {
  if (typeof output !== 'string' || !output) return []
  const out: ParsedFailure[] = []
  const seen = new Set<string>()
  // ESLint groups rows under a bare path printed on an earlier line.
  let eslintFile: string | null = null

  const push = (f: ParsedFailure): void => {
    if (out.length >= MAX_FAILURES) return
    const sig = failureSignature(f)
    if (seen.has(sig)) return
    seen.add(sig)
    out.push(f)
  }

  for (const raw of output.split(/\r?\n/)) {
    let m: RegExpMatchArray | null

    if ((m = raw.match(TSC_PAREN))) {
      push({ file: m[1], line: +m[2], column: +m[3], errorType: m[4], message: clip(m[5]), raw })
      continue
    }
    if ((m = raw.match(TSC_DASH))) {
      push({ file: m[1], line: +m[2], column: +m[3], errorType: m[4], message: clip(m[5]), raw })
      continue
    }
    if ((m = raw.match(COMPILER))) {
      // Only errors drive the debug loop; skip stand-alone warnings.
      if (/warning/i.test(m[4])) continue
      push({ file: m[1], line: +m[2], column: +m[3], errorType: 'error', message: clip(m[5]), raw })
      continue
    }
    if ((m = raw.match(PYTEST_SUMMARY))) {
      const msg = clip(m[2])
      const type = msg?.match(/^([A-Z]\w*(?:Error|Exception|Warning))\b/)?.[1]
      push({ file: m[1], line: 1, errorType: type ?? 'FAILED', message: msg, raw })
      continue
    }
    if ((m = raw.match(PYTEST_LOC))) {
      push({ file: m[1], line: +m[2], message: clip(m[3]), raw })
      continue
    }
    if ((m = raw.match(BARE_PATH))) {
      eslintFile = m[1]
      continue
    }
    if (eslintFile && (m = raw.match(ESLINT_ROW))) {
      if (m[3] === 'warning') continue
      push({
        file: eslintFile,
        line: +m[1],
        column: +m[2],
        errorType: m[5] ?? 'error',
        message: clip(m[4]),
        raw
      })
      continue
    }
    // Stack frames: only when the line looks like one, so ordinary prose that
    // happens to contain "a.js:1" is not swept up.
    if (/^\s*(?:at\b|❯|❯|In file included from)/.test(raw) || /\)\s*$/.test(raw)) {
      let last: RegExpMatchArray | null = null
      for (const hit of raw.matchAll(STACK_LOC)) last = hit
      if (last) push({ file: last[1], line: +last[2], column: last[3] ? +last[3] : undefined, raw })
    }
  }

  return out
}

/**
 * Normalise a message so cosmetic differences (line-wrapping, quoted literals,
 * embedded numbers) don't hide that it is the SAME failure recurring. Used only
 * for the recurrence key, never shown to anyone.
 */
function normalizeMessage(msg: string | undefined): string {
  if (!msg) return ''
  return msg
    .toLowerCase()
    .replace(/['"`].*?['"`]/g, '§') // collapse quoted literals
    .replace(/\d+/g, '#') // collapse numbers
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
}

/**
 * A stable key for "this exact failure": where it is (file:line) plus what it is
 * (error type + a normalised message). Two runs that produce the same signature
 * are the same bug — which is how the loop notices a "fix" that did not take.
 */
export function failureSignature(f: ParsedFailure): string {
  const file = f.file.replace(/\\/g, '/')
  return `${file}:${f.line}|${f.errorType ?? ''}|${normalizeMessage(f.message)}`
}
