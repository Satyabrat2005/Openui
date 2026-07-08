/**
 * Unit tests for the fine-tuning building blocks that must be exactly right:
 * the checkpoint manifest (never lose the last-known-good model) and the
 * evaluator's split/scoring/promotion math. Pure Node — no Electron, no
 * Ollama, no Python.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  setFinetuneDirForTests,
  loadManifest,
  nextVersion,
  recordCheckpoint,
  promote,
  reject,
  getActiveTag,
  versionDir,
  type CheckpointEntry
} from './manifest'
import { splitDataset, tokenF1, isPromotable } from './evaluator'
import type { ChatFinetuneRecord } from '../trainingStore'

function entry(version: number, status: CheckpointEntry['status']): CheckpointEntry {
  return {
    version,
    tag: `openui-qwen-coder:v${version}`,
    baseModel: 'qwen2.5-coder:7b',
    createdAt: '2026-07-08T00:00:00.000Z',
    trainSize: 50,
    holdoutSize: 8,
    evalScore: null,
    baselineScore: null,
    status
  }
}

describe('finetune manifest', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openui-finetune-'))
    setFinetuneDirForTests(dir)
  })

  afterEach(() => {
    setFinetuneDirForTests(null)
    rmSync(dir, { recursive: true, force: true })
  })

  it('starts empty with no active version', () => {
    expect(loadManifest()).toEqual({ entries: [], activeVersion: null })
    expect(getActiveTag()).toBeNull()
    expect(nextVersion()).toBe(1)
  })

  it('records checkpoints append-only and numbers versions monotonically', () => {
    recordCheckpoint(entry(1, 'rejected'))
    recordCheckpoint(entry(2, 'failed'))
    expect(nextVersion()).toBe(3)
    const m = loadManifest()
    expect(m.entries.map((e) => e.version)).toEqual([1, 2])
    expect(m.activeVersion).toBeNull() // failures never become active
  })

  it('promote flips the pointer and supersedes (not deletes) the old active', () => {
    recordCheckpoint(entry(1, 'rejected'))
    promote(1, 0.5, null)
    expect(getActiveTag()).toBe('openui-qwen-coder:v1')

    recordCheckpoint(entry(2, 'rejected'))
    promote(2, 0.6, 0.5)
    const m = loadManifest()
    expect(m.activeVersion).toBe(2)
    expect(getActiveTag()).toBe('openui-qwen-coder:v2')
    // v1 survives as an instant rollback target.
    const v1 = m.entries.find((e) => e.version === 1)
    expect(v1?.status).toBe('superseded')
    expect(m.entries).toHaveLength(2)
  })

  it('reject leaves the active pointer untouched (auto-rollback semantics)', () => {
    recordCheckpoint(entry(1, 'rejected'))
    promote(1, 0.5, null)
    recordCheckpoint(entry(2, 'rejected'))
    reject(2, 'rejected', 'held-out regression: 0.3 < 0.5', 0.3, 0.5)

    const m = loadManifest()
    expect(m.activeVersion).toBe(1)
    expect(getActiveTag()).toBe('openui-qwen-coder:v1')
    const v2 = m.entries.find((e) => e.version === 2)
    expect(v2?.status).toBe('rejected')
    expect(v2?.note).toContain('regression')
    expect(v2?.evalScore).toBe(0.3)
  })

  it('survives a corrupt manifest file by starting a fresh history', () => {
    recordCheckpoint(entry(1, 'rejected'))
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    writeFileSync(join(dir, 'manifest.json'), '{not json', 'utf8')
    expect(loadManifest()).toEqual({ entries: [], activeVersion: null })
    expect(nextVersion()).toBe(1)
  })

  it('versionDir stays inside the finetune root', () => {
    expect(versionDir(3)).toBe(join(dir, 'v3'))
  })
})

function rec(finalReply: string, roles: string[] = ['user']): ChatFinetuneRecord {
  return {
    messages: [
      ...roles.map((r) => ({ role: r, content: `${r} turn` })),
      { role: 'assistant', content: finalReply }
    ],
    quality: 4,
    outcome: 'success',
    model: 'test',
    tier: 'free'
  }
}

describe('evaluator splitDataset', () => {
  it('holds out every Nth scorable record deterministically, rest to train', () => {
    const records = Array.from({ length: 30 }, (_, i) => rec(`reply ${i}`))
    const a = splitDataset(records, 10)
    const b = splitDataset(records, 10)
    expect(a.holdout.map((r) => r.messages.at(-1)?.content)).toEqual(
      b.holdout.map((r) => r.messages.at(-1)?.content)
    )
    expect(a.holdout).toHaveLength(3) // indices 9, 19, 29
    expect(a.train).toHaveLength(27)
    expect(a.holdout[0].messages.at(-1)?.content).toBe('reply 9')
  })

  it('train and holdout never overlap and cover everything', () => {
    const records = Array.from({ length: 25 }, (_, i) => rec(`unique reply ${i}`))
    const { train, holdout } = splitDataset(records, 5)
    expect(train.length + holdout.length).toBe(25)
    const holdoutSet = new Set(holdout.map((r) => r.messages.at(-1)?.content))
    for (const t of train) {
      expect(holdoutSet.has(t.messages.at(-1)?.content)).toBe(false)
    }
  })

  it('unscorable records (no final assistant turn) always go to train', () => {
    const records = Array.from({ length: 10 }, (_, i) => rec(`reply ${i}`))
    records[9] = {
      messages: [{ role: 'user', content: 'question with no recorded answer' }],
      quality: 4,
      outcome: 'success',
      model: 'test',
      tier: 'free'
    }
    const { train, holdout } = splitDataset(records, 10)
    expect(holdout).toHaveLength(0)
    expect(train).toHaveLength(10)
  })

  it('caps the holdout size', () => {
    const records = Array.from({ length: 200 }, (_, i) => rec(`reply ${i}`))
    const { holdout } = splitDataset(records, 2)
    expect(holdout.length).toBeLessThanOrEqual(12)
  })
})

describe('evaluator tokenF1', () => {
  it('is 1 for an exact match and 0 for disjoint replies', () => {
    expect(tokenF1('run the tests now', 'run the tests now')).toBe(1)
    expect(tokenF1('alpha beta', 'gamma delta')).toBe(0)
  })

  it('is case- and whitespace-insensitive', () => {
    expect(tokenF1('Fix  the   Bug', 'fix the bug')).toBe(1)
  })

  it('scores partial overlap between 0 and 1', () => {
    const score = tokenF1('create a react component', 'create a vue component')
    expect(score).toBeGreaterThan(0)
    expect(score).toBeLessThan(1)
    expect(score).toBeCloseTo(0.75, 5) // 3 of 4 tokens overlap on both sides
  })

  it('respects token multiplicity', () => {
    // 'a a b' vs 'a b b': overlap = a + b = 2; P = R = 2/3
    expect(tokenF1('a a b', 'a b b')).toBeCloseTo(2 / 3, 5)
  })

  it('handles empty strings without NaN', () => {
    expect(tokenF1('', '')).toBe(1)
    expect(tokenF1('something', '')).toBe(0)
    expect(tokenF1('', 'something')).toBe(0)
  })
})

describe('evaluator isPromotable', () => {
  it('promotes on improvement and on ties', () => {
    expect(isPromotable(0.6, 0.5)).toBe(true)
    expect(isPromotable(0.5, 0.5)).toBe(true)
  })

  it('tolerates noise within epsilon but rejects a real regression', () => {
    expect(isPromotable(0.49, 0.5)).toBe(true) // within default 0.02
    expect(isPromotable(0.4, 0.5)).toBe(false) // real regression → auto-reject
  })

  it('honours a custom epsilon', () => {
    expect(isPromotable(0.45, 0.5, 0)).toBe(false)
    expect(isPromotable(0.45, 0.5, 0.1)).toBe(true)
  })
})
