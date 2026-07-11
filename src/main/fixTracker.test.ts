import { describe, it, expect } from 'vitest'
import { FixTracker } from './fixTracker'

const SIG = 'src/foo.ts:12|TS2322|type § is not assignable'
const OTHER = 'src/bar.ts:3|TS7006|parameter § implicitly any'

describe('FixTracker — counting attempts', () => {
  it('starts at zero and has no guidance', () => {
    const t = new FixTracker()
    expect(t.attempts(SIG)).toBe(0)
    expect(t.escalationFor(SIG)).toBe('none')
    expect(t.guidanceFor(SIG)).toBeNull()
  })

  it('counts one per red run, de-duping within a run', () => {
    const t = new FixTracker()
    t.observeFailures([SIG, SIG, OTHER]) // same run reporting SIG twice
    expect(t.attempts(SIG)).toBe(1)
    expect(t.attempts(OTHER)).toBe(1)
  })
})

describe('FixTracker — escalation as a failure recurs', () => {
  it('escalates none → widen → root_cause across successive red runs', () => {
    const t = new FixTracker()
    t.observeFailures([SIG])
    expect(t.escalationFor(SIG)).toBe('none')
    t.observeFailures([SIG])
    expect(t.escalationFor(SIG)).toBe('widen')
    t.observeFailures([SIG])
    expect(t.escalationFor(SIG)).toBe('root_cause')
  })

  it('widens the read radius as the failure persists', () => {
    const t = new FixTracker()
    t.observeFailures([SIG])
    const r1 = t.readRadiusFor(SIG)
    t.observeFailures([SIG])
    const r2 = t.readRadiusFor(SIG)
    t.observeFailures([SIG])
    const r3 = t.readRadiusFor(SIG)
    expect(r2).toBeGreaterThan(r1)
    expect(r3).toBeGreaterThan(r2)
  })

  it('gives caller-side guidance naming the location once recurring', () => {
    const t = new FixTracker()
    t.observeFailures([SIG])
    expect(t.guidanceFor(SIG)).toBeNull()
    t.observeFailures([SIG])
    const widen = t.guidanceFor(SIG)
    expect(widen).toContain('src/foo.ts:12')
    expect(widen).toMatch(/came back after your last edit/i)
    t.observeFailures([SIG])
    const root = t.guidanceFor(SIG)
    expect(root).toMatch(/root cause|caller/i)
  })

  it('tracks each signature independently', () => {
    const t = new FixTracker()
    t.observeFailures([SIG])
    t.observeFailures([SIG])
    t.observeFailures([OTHER])
    expect(t.escalationFor(SIG)).toBe('widen')
    expect(t.escalationFor(OTHER)).toBe('none')
  })
})
