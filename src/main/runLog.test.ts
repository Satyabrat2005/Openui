import { describe, it, expect } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildLogLine, startRun, setRunLogDirForTests } from './runLog'

/**
 * Wait for the run log to flush, by polling for the lines rather than sleeping
 * a fixed interval.
 *
 * runLog appends fire-and-forget (an un-awaited appendFile per entry), so there
 * is no handle to await from the test side. This used to be a flat 50 ms sleep,
 * which raced the flush under parallel test load: readdirSync found no .jsonl
 * yet and the assertions failed intermittently — green alone, red in a full
 * suite run. Polling returns as soon as the writes land (normally single-digit
 * ms) and only spends the full budget when something is genuinely wrong.
 *
 * Only whole lines are parsed: every append ends in "\n", so splitting and
 * dropping the trailing element discards a half-written final line instead of
 * throwing inside JSON.parse.
 */
const FLUSH_TIMEOUT_MS = 5000

async function readFlushedLines(
  dir: string,
  expected: number
): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + FLUSH_TIMEOUT_MS
  let complete: string[] = []
  for (;;) {
    const file = readdirSync(dir).find((f) => f.endsWith('.jsonl'))
    if (file) {
      complete = readFileSync(join(dir, file), 'utf8').split('\n').slice(0, -1)
      if (complete.length >= expected) return complete.map((l) => JSON.parse(l))
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `run log flushed ${complete.length}/${expected} lines within ${FLUSH_TIMEOUT_MS}ms`
      )
    }
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('runLog — structured JSONL task logging', () => {
  it('serialises entries as single JSON lines with clipped fields', () => {
    const line = buildLogLine('run-1', 'chat', 'tool_call', {
      tool: 'read_screen',
      error: 'x'.repeat(5000)
    })
    expect(line.endsWith('\n')).toBe(true)
    const parsed = JSON.parse(line)
    expect(parsed.runId).toBe('run-1')
    expect(parsed.kind).toBe('chat')
    expect(parsed.type).toBe('tool_call')
    expect(parsed.tool).toBe('read_screen')
    expect((parsed.error as string).length).toBeLessThan(2100) // clipped
    expect(typeof parsed.ts).toBe('string')
  })

  it('writes run_start, tool_call and run_end lines for a run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openui-runlog-'))
    setRunLogDirForTests(dir)

    const run = startRun('autonomous-task', { taskId: 't-9' })
    run.toolCall({ tool: 'write_file', ok: true, ms: 12, argsSummary: 'Write app.js' })
    run.event('rollback', { detail: 'restored 2 files' })
    run.end('failure', 'tests failed after 20 turns')

    // run_start, tool_call, event, run_end
    const lines = await readFlushedLines(dir, 4)
    expect(readdirSync(dir).filter((f) => f.endsWith('.jsonl')).length).toBe(1)
    const types = lines.map((l) => l.type)
    expect(types).toEqual(['run_start', 'tool_call', 'event', 'run_end'])
    expect(lines[0].taskId).toBe('t-9')
    expect(lines[1].tool).toBe('write_file')
    expect(lines[1].ok).toBe(true)
    expect(lines[3].status).toBe('failure')
    expect(lines.every((l) => l.runId === run.runId)).toBe(true)

    setRunLogDirForTests(null)
  })

  it('records the §6 checkpoint and §7 resume events with their payloads', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openui-runlog-'))
    setRunLogDirForTests(dir)

    const run = startRun('autonomous-task', { taskId: 't-42' })
    // Shapes emitted by autonomous.ts: an atomic commit checkpoint (§6) and a
    // cross-session resume (§7).
    run.event('resume', { taskId: 't-42', completed: 1, of: 3, lastGoodCommit: 'deadbee' })
    run.event('checkpoint', { sha: 'abc1234', task: 't-42' })
    run.end('success', 'all sub-tasks merged and verified')

    // run_start, resume, checkpoint, run_end
    const lines = await readFlushedLines(dir, 4)

    const resume = lines.find((l) => l.event === 'resume')
    expect(resume).toMatchObject({ type: 'event', completed: 1, of: 3, lastGoodCommit: 'deadbee' })
    const checkpoint = lines.find((l) => l.event === 'checkpoint')
    expect(checkpoint).toMatchObject({ type: 'event', sha: 'abc1234', task: 't-42' })

    setRunLogDirForTests(null)
  })
})
