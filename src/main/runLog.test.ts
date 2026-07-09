import { describe, it, expect } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildLogLine, startRun, setRunLogDirForTests } from './runLog'

const waitForFlush = (): Promise<void> => new Promise((r) => setTimeout(r, 50))

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
    await waitForFlush()

    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
    expect(files.length).toBe(1)
    const lines = readFileSync(join(dir, files[0]), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    const types = lines.map((l) => l.type)
    expect(types).toEqual(['run_start', 'tool_call', 'event', 'run_end'])
    expect(lines[0].taskId).toBe('t-9')
    expect(lines[1].tool).toBe('write_file')
    expect(lines[1].ok).toBe(true)
    expect(lines[3].status).toBe('failure')
    expect(lines.every((l) => l.runId === run.runId)).toBe(true)

    setRunLogDirForTests(null)
  })
})
