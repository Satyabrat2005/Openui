import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, relative, sep } from 'node:path'

/**
 * THE TERMINAL BOUNDARY, as a test.
 *
 * The product claim this phase makes is narrow and worth stating exactly: OpenUI
 * never shows, documents, or requires a terminal command to get or use a model.
 * That is a UX boundary, NOT access control — anyone administering their own
 * machine can install a model outside the app, and nothing here changes that.
 *
 * What a test CAN protect is the narrow claim: no `ollama pull` / `ollama run` /
 * `ollama serve` string reaches a user through an in-app string, an error
 * message, a log line, or the user-facing docs. That is easy to reintroduce by
 * accident in a hurry — one helpful-looking error message is all it takes — so
 * it is pinned here instead of relying on review.
 *
 * Code COMMENTS are exempt: they explain the boundary to the next developer and
 * never reach a user. So are developer-only surfaces (build/launch scripts, the
 * benchmark harness, internal runbooks), which are read by people already in a
 * terminal.
 */

const ROOT = resolve(__dirname, '..', '..')

/**
 * The trailing word boundary matters: without it this also matches prose like
 * "Is Ollama running?", which describes a state rather than handing anyone a
 * command to type. (A first draft of this pattern lost its boundaries to a bad
 * escape and matched NOTHING at all — every scan below passed vacuously. Hence
 * the self-check test, which proves the pattern still fires on known-bad text.)
 */
const COMMAND_RE = /\bollama\s+(pull|run|serve)\b/i

/** Developer-only surfaces: read by people who are already in a terminal. */
const EXEMPT_FILES = new Set(
  [
    'run.sh',
    'run.bat',
    'run.command',
    'CHANGELOG.md',
    join('docs', 'DEMO_RUNBOOK.md'),
    join('scripts', 'benchmark', 'README.md')
  ].map((p) => p.replace(/[\\/]/g, sep))
)

/** Strip line and block comments so only real strings are inspected. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

describe('the app never hands a user a terminal command', () => {
  it('the detector itself actually detects — these scans are not vacuous', () => {
    // A pattern that matches nothing passes every file trivially, which is how a
    // scan like this silently stops protecting anything.
    expect(COMMAND_RE.test('run `ollama pull qwen3.5` in a terminal')).toBe(true)
    expect(COMMAND_RE.test('Start it with "ollama serve"')).toBe(true)
    expect(COMMAND_RE.test('ollama run qwen2.5-coder:7b')).toBe(true)
    // …and does not fire on prose that merely names the engine.
    expect(COMMAND_RE.test('Is Ollama running with the model pulled?')).toBe(false)
    expect(COMMAND_RE.test('Requires Ollama running locally')).toBe(false)
  })

  it('no shipped source string, error, or log names an ollama command', () => {
    const offenders: string[] = []

    for (const file of walk(join(ROOT, 'src'))) {
      if (!/\.(ts|tsx)$/.test(file)) continue
      // Tests assert ON these strings; they are not shipped surfaces.
      if (/\.(test|spec)\.tsx?$/.test(file)) continue

      const body = stripComments(readFileSync(file, 'utf8'))
      body.split('\n').forEach((line, i) => {
        if (COMMAND_RE.test(line)) offenders.push(`${relative(ROOT, file)}:${i + 1}: ${line.trim()}`)
      })
    }

    expect(offenders, `terminal command reachable by a user:\n${offenders.join('\n')}`).toEqual([])
  })

  it('the user-facing docs point at the app, not at a terminal', () => {
    const offenders: string[] = []
    const docs = [join(ROOT, 'README.md'), ...walk(join(ROOT, 'docs')).filter((f) => f.endsWith('.md'))]

    for (const file of docs) {
      const rel = relative(ROOT, file)
      if (EXEMPT_FILES.has(rel)) continue
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (COMMAND_RE.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`)
        })
    }

    expect(offenders, `terminal command in user-facing docs:\n${offenders.join('\n')}`).toEqual([])
  })

  it('the one process OpenUI does spawn is spawned with no console window', () => {
    // The download itself never shells out (it is an HTTP call to the Ollama
    // daemon). The single spawn on this path starts the engine for the user when
    // it is installed but not running — a visible console window there is the
    // same class of bug the browser/CDP work fixed last cycle.
    const agent = readFileSync(join(ROOT, 'src', 'main', 'agent.ts'), 'utf8')
    const spawnLine = agent.split('\n').find((l) => l.includes("spawn(bin, ['serve']"))
    expect(spawnLine, 'the engine spawn was not found — did it move?').toBeTruthy()
    expect(spawnLine).toMatch(/windowsHide:\s*true/)

    // And nothing in the main process shells out a model download at all.
    const shelled = walk(join(ROOT, 'src', 'main'))
      .filter((f) => /\.tsx?$/.test(f) && !/\.(test|spec)\.tsx?$/.test(f))
      .filter((f) => {
        const body = readFileSync(f, 'utf8')
        return /\b(spawn|exec|execFile)\s*\(/.test(body) && /['"`]pull['"`]/.test(body)
      })
    expect(shelled).toEqual([])
  })
})
