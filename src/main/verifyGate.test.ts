/**
 * verifyGate.test.ts — the pure false-completion state machine.
 *
 * The gate's job: never let a prose "done" be trusted unless real work happened.
 * These tests pin the three situations it must tell apart —
 *   1. read-only task, nothing claimed        → accept
 *   2. wrote the tree but never verified it    → nudge, then reject
 *   3. claimed completion but touched nothing  → nudge, then reject
 * plus the classification helpers agent.ts relies on.
 */
import { describe, it, expect } from 'vitest'
import {
  VerifyGate,
  mutatesWorkspace,
  isVerifier,
  verifierPassed,
  claimsCompletion,
  isGiveUp
} from './verifyGate'

describe('classification helpers', () => {
  it('flags workspace-mutating tools and leaves read-only ones alone', () => {
    expect(mutatesWorkspace('write_file')).toBe(true)
    expect(mutatesWorkspace('create_folder')).toBe(true)
    expect(mutatesWorkspace('send_whatsapp_message')).toBe(true)
    expect(mutatesWorkspace('read_file')).toBe(false)
    expect(mutatesWorkspace('list_files')).toBe(false)
    expect(mutatesWorkspace('search_files')).toBe(false)
  })

  it('recognises the verifier tools', () => {
    expect(isVerifier('run_script')).toBe(true)
    expect(isVerifier('run_tests')).toBe(true)
    expect(isVerifier('write_file')).toBe(false)
  })

  it('reads pass/fail from the verifier output marker, not from ok', () => {
    expect(verifierPassed('SCRIPT OK [build]\n…')).toBe(true)
    expect(verifierPassed('TESTS PASSED\n12 passing')).toBe(true)
    expect(verifierPassed('SCRIPT FAILED [build]\nboom')).toBe(false)
    expect(verifierPassed('TESTS FAILED\n1 failing')).toBe(false)
    expect(verifierPassed(undefined)).toBe(false)
    expect(verifierPassed('no marker here')).toBe(false)
  })

  it('detects completion-claiming prose but not a GIVE UP', () => {
    expect(claimsCompletion('I built your site, all done!')).toBe(true)
    expect(claimsCompletion('Built it!')).toBe(true)
    expect(claimsCompletion("Here's your website.")).toBe(true)
    expect(claimsCompletion('GIVE UP: I could not install the deps.')).toBe(false)
    expect(claimsCompletion('What folder should I use?')).toBe(false)
    expect(isGiveUp('GIVE UP: npm is broken')).toBe(true)
    expect(isGiveUp('I finished it')).toBe(false)
  })
})

describe('VerifyGate — read-only task', () => {
  it('accepts a completion reply when no side effect was expected', () => {
    const gate = new VerifyGate()
    // Nothing mutated, but the task never implied one.
    expect(gate.hasUnverifiedWork('All done — here are the results.', { sideEffectExpected: false })).toBe(false)
    expect(gate.onFinalReply('All done — here are the results.', { sideEffectExpected: false })).toEqual({
      action: 'accept'
    })
  })
})

describe('VerifyGate — claimed but nothing done', () => {
  it('nudges (naming the tool) then rejects once the budget is spent', () => {
    const gate = new VerifyGate({ maxNudges: 2 })
    const claim = 'I built the whole thing, it works now!'

    const first = gate.onFinalReply(claim, { nextAction: 'write_file' })
    expect(first.action).toBe('nudge')
    expect(first.message).toContain('write_file')

    expect(gate.onFinalReply(claim).action).toBe('nudge')

    const third = gate.onFinalReply(claim)
    expect(third.action).toBe('reject')
    expect(third.message).toMatch(/did NOT complete/i)
  })
})

describe('VerifyGate — wrote files but never verified', () => {
  it('treats a mutation without a passing verifier as unverified', () => {
    const gate = new VerifyGate()
    gate.recordToolCall('write_file', { ok: true, output: 'Wrote 10 bytes.' })
    expect(gate.touchedWorkspace).toBe(true)
    expect(gate.isVerified).toBe(false)

    const decision = gate.onFinalReply('Done, your site is ready.')
    expect(decision.action).toBe('nudge')
    expect(decision.message).toMatch(/run_script|run_tests/i)
  })
})

describe('VerifyGate — happy path', () => {
  it('accepts once files are written and a verifier passes', () => {
    const gate = new VerifyGate()
    gate.recordToolCall('write_file', { ok: true, output: 'Wrote 10 bytes.' })
    gate.recordToolCall('run_script', { ok: true, output: 'SCRIPT OK [build]\nbuilt fine' })

    expect(gate.isVerified).toBe(true)
    expect(gate.hasUnverifiedWork('I built your site and the build passes.')).toBe(false)
    expect(gate.onFinalReply('I built your site and the build passes.')).toEqual({ action: 'accept' })
  })

  it('re-arms verification when the tree is mutated again after a green build', () => {
    const gate = new VerifyGate()
    gate.recordToolCall('write_file', { ok: true, output: 'wrote' })
    gate.recordToolCall('run_script', { ok: true, output: 'SCRIPT OK [build]' })
    expect(gate.isVerified).toBe(true)

    // A later edit invalidates the earlier pass — must re-verify.
    gate.recordToolCall('write_file', { ok: true, output: 'wrote again' })
    expect(gate.isVerified).toBe(false)
    expect(gate.onFinalReply('All fixed and done!').action).toBe('nudge')
  })
})
