import { describe, it, expect, vi } from 'vitest'

// verifyGate imports codingTools for mutatesWorkspace, which pulls in sandbox →
// electron. Nothing here touches the filesystem; the gate is pure.
vi.mock('electron', () => ({
  app: { getPath: () => process.cwd() }
}))

import { VerifyGate, type VerificationSpec } from './verifyGate'
import { getProjectProfile } from './projectProfiles'

/** A node-style spec: run_tests is the only verifier. */
const nodeSpec: VerificationSpec = getProjectProfile('node')

const PASS = 'TESTS PASSED\n1 passing'
const FAIL = 'TESTS FAILED\n1 failing'

describe('VerifyGate — what counts as verified', () => {
  it('starts unverified', () => {
    expect(new VerifyGate(nodeSpec).isVerified).toBe(false)
  })

  it('a passing verifier verifies the tree', () => {
    const gate = new VerifyGate(nodeSpec)
    gate.observe('run_tests', {}, true, PASS)
    expect(gate.isVerified).toBe(true)
  })

  it('a later red run un-verifies an earlier green one', () => {
    const gate = new VerifyGate(nodeSpec)
    gate.observe('run_tests', {}, true, PASS)
    gate.observe('run_tests', {}, true, FAIL)
    expect(gate.isVerified).toBe(false)
  })

  it('ignores tools that are not this project type\'s verifier', () => {
    const gate = new VerifyGate(nodeSpec)
    gate.observe('run_tests', {}, true, PASS)
    gate.observe('list_files', {}, true, 'a.js')
    gate.observe('read_file', { path: 'a.js' }, true, 'contents')
    expect(gate.isVerified).toBe(true)
  })

  it('ignores a verifier that could not run at all', () => {
    const gate = new VerifyGate(nodeSpec)
    gate.observe('run_tests', {}, false, '')
    expect(gate.isVerified).toBe(false)
    expect(gate.hasUnverifiedWork).toBe(false)
  })

  it('uses the project type\'s own verifier, not npm test', () => {
    const cp = new VerifyGate(getProjectProfile('cp'))
    cp.observe('run_tests', {}, true, PASS) // meaningless for a C++ task
    expect(cp.isVerified).toBe(false)
    cp.observe('run_cpp', { path: 'main.cpp' }, true, 'CPP RUN OK [main.cpp]\n42')
    expect(cp.isVerified).toBe(true)
  })
})

// The bug this class exists for: a green verifier describes the tree as it was
// when it ran. Editing after that makes the green run a statement about code
// that no longer exists.
describe('VerifyGate — a passing run expires when the tree changes', () => {
  it.each(['write_file', 'edit_file'])('%s after a green run un-verifies it', (tool) => {
    const gate = new VerifyGate(nodeSpec)
    gate.observe('run_tests', {}, true, PASS)
    expect(gate.isVerified).toBe(true)

    gate.observe(tool, { path: 'a.js' }, true, 'ok')
    expect(gate.isVerified).toBe(false)
    expect(gate.hasUnverifiedWork).toBe(true)
  })

  it('a failed write changed nothing, so it does not expire the run', () => {
    const gate = new VerifyGate(nodeSpec)
    gate.observe('run_tests', {}, true, PASS)
    gate.observe('edit_file', { path: 'a.js' }, false, '')
    expect(gate.isVerified).toBe(true)
  })

  it('git add and commit move content, not the tree, so the run survives', () => {
    const gate = new VerifyGate(nodeSpec)
    gate.observe('run_tests', {}, true, PASS)
    gate.observe('git', { subcommand: 'add', args: ['.'] }, true, 'GIT OK [add]')
    gate.observe('git', { subcommand: 'commit', args: ['-m', 'x'] }, true, 'GIT OK [commit]')
    expect(gate.isVerified).toBe(true)
  })

  it.each(['checkout', 'restore', 'stash', 'rm', 'mv', 'switch'])(
    'git %s rewrites the tree and expires the run',
    (sub) => {
      const gate = new VerifyGate(nodeSpec)
      gate.observe('run_tests', {}, true, PASS)
      gate.observe('git', { subcommand: sub }, true, `GIT OK [${sub}]`)
      expect(gate.isVerified).toBe(false)
    }
  )

  it('re-running the verifier after an edit re-verifies', () => {
    const gate = new VerifyGate(nodeSpec)
    gate.observe('write_file', { path: 'a.js' }, true, 'ok')
    gate.observe('run_tests', {}, true, PASS)
    expect(gate.isVerified).toBe(true)
    expect(gate.hasUnverifiedWork).toBe(false)
  })
})

describe('VerifyGate — deciding on a prose reply', () => {
  it('accepts a read-only run that never touched the tree', () => {
    // Nothing was written, so there is nothing to verify — do not trap it in a loop.
    const gate = new VerifyGate(nodeSpec)
    gate.observe('list_files', {}, true, 'a.js')
    expect(gate.onFinalReply('Here is what the project contains.')).toBe('accept')
  })

  it('nudges a summary that follows unverified edits', () => {
    const gate = new VerifyGate(nodeSpec)
    gate.observe('write_file', { path: 'a.js' }, true, 'ok')
    expect(gate.onFinalReply('I built your project!')).toBe('nudge')
  })

  it('nudges after the verify-then-edit-then-declare-victory sequence', () => {
    const gate = new VerifyGate(nodeSpec)
    gate.observe('write_file', { path: 'a.js' }, true, 'ok')
    gate.observe('run_tests', {}, true, PASS)
    gate.observe('edit_file', { path: 'a.js' }, true, 'ok') // "just a typo fix"
    expect(gate.onFinalReply('All tests pass, done!')).toBe('nudge')
  })

  it('accepts a summary once the work is verified', () => {
    const gate = new VerifyGate(nodeSpec)
    gate.observe('write_file', { path: 'a.js' }, true, 'ok')
    gate.observe('run_tests', {}, true, PASS)
    expect(gate.onFinalReply('Built and tested.')).toBe('accept')
  })

  it('honours GIVE UP even with unverified work outstanding', () => {
    const gate = new VerifyGate(nodeSpec)
    gate.observe('write_file', { path: 'a.js' }, true, 'ok')
    expect(gate.onFinalReply('GIVE UP: the dependency will not install.')).toBe('give_up')
  })

  it('stops nudging once the budget is spent, ending the run red rather than looping', () => {
    const gate = new VerifyGate(nodeSpec, 2)
    gate.observe('write_file', { path: 'a.js' }, true, 'ok')
    expect(gate.onFinalReply('done')).toBe('nudge')
    expect(gate.onFinalReply('really done')).toBe('nudge')
    expect(gate.onFinalReply('I said done')).toBe('accept')
    // Accepted, but never verified — the caller reports this as a failure.
    expect(gate.isVerified).toBe(false)
  })

  it('does not consume a nudge when it accepts', () => {
    const gate = new VerifyGate(nodeSpec, 1)
    gate.observe('run_tests', {}, true, PASS)
    expect(gate.onFinalReply('done')).toBe('accept')
    // The one nudge is still available if work later goes unverified.
    gate.observe('edit_file', { path: 'a.js' }, true, 'ok')
    expect(gate.onFinalReply('done again')).toBe('nudge')
  })
})

describe('VerifyGate — nudge message', () => {
  it('names the single verifier for this project type', () => {
    const msg = new VerifyGate(getProjectProfile('node')).nudgeMessage()
    expect(msg).toContain('run_tests')
    expect(msg).toMatch(/GIVE UP/)
  })

  it('lists multiple verifiers readably', () => {
    const msg = new VerifyGate(getProjectProfile('ml')).nudgeMessage()
    expect(msg).toContain('run_pytest or run_python')
  })

  it('degrades gracefully when a spec names no verifier', () => {
    const empty: VerificationSpec = { verifiers: [], verdict: () => null }
    expect(new VerifyGate(empty).nudgeMessage()).toContain('the verification tool')
  })
})
