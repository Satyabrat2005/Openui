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

  // CONTRACT CHANGE (was: honoured immediately). A GIVE UP after files were
  // written but nothing was ever verified is a guess about untested work — 6 of
  // the 8 give_ups in an 18-run live sample had already written files. It is now
  // challenged ONCE and then honoured, so a real dead end still terminates.
  it('challenges a GIVE UP over untested work, then honours the repeat', () => {
    const gate = new VerifyGate(nodeSpec)
    gate.observe('write_file', { path: 'a.js' }, true, 'ok')
    const reply = 'GIVE UP: the dependency will not install.'
    expect(gate.giveUpChallenge(reply)).toBe('untested')
    expect(gate.onFinalReply(reply)).toBe('nudge')
    expect(gate.giveUpMessage('untested')).toMatch(/never ran a single verification/i)
    expect(gate.onFinalReply(reply)).toBe('nudge') // second nudge in the budget
    expect(gate.onFinalReply(reply)).toBe('give_up') // budget spent — honoured
  })

  it('honours GIVE UP immediately when the run never touched the tree', () => {
    const gate = new VerifyGate(nodeSpec)
    expect(gate.onFinalReply('GIVE UP: I do not understand the request.')).toBe('give_up')
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

// The exact sequence that produced a false GIVE UP on a finished static site:
// write the files, run the only verifier the model has, get back "there is no
// suite here". Before the fix that read as a red run, so the gate nudged, the
// model could not make a non-existent suite pass, and a complete build ended as
// a failure. Driven through the REAL website profile, not a stub spec.
describe('VerifyGate — a finished static site is not a failure', () => {
  const SKIPPED = 'TESTS SKIPPED\nNo package.json in the workspace, so there is no test suite to run.'

  it('accepts a static-site build whose run_tests found nothing to run', () => {
    const gate = new VerifyGate(getProjectProfile('website'))
    gate.observe('write_file', { path: 'index.html' }, true, 'ok')
    gate.observe('write_file', { path: 'styles.css' }, true, 'ok')
    gate.observe('run_tests', {}, true, SKIPPED)

    expect(gate.isVerified).toBe(true)
    expect(gate.hasUnverifiedWork).toBe(false)
    expect(gate.onFinalReply('Built the static site — no build step, so nothing was smoke-run.')).toBe(
      'accept'
    )
  })

  it('still nudges a Node project that never wrote a test script', () => {
    const gate = new VerifyGate(getProjectProfile('node'))
    gate.observe('write_file', { path: 'index.js' }, true, 'ok')
    gate.observe('run_tests', {}, true, 'TESTS SKIPPED\nno test script')

    expect(gate.isVerified).toBe(false)
    expect(gate.onFinalReply('done')).toBe('nudge')
  })

  // The shape a finished static site ACTUALLY fails in on merged main, seen in
  // live trials: write index.html → open_in_browser → list_files (which IS the
  // website profile's verifier, and passes) → "GIVE UP: there are no tests or
  // scripts to run". The gate honoured that unconditionally and reported a
  // completed build as a failure.
  it('pushes back on a GIVE UP that a passing verifier contradicts', () => {
    const gate = new VerifyGate(getProjectProfile('website'))
    gate.observe('write_file', { path: 'index.html' }, true, 'ok')
    gate.observe('list_files', {}, true, 'Workspace files:\nindex.html')
    expect(gate.isVerified).toBe(true)

    const reply = 'GIVE UP: the project is static HTML, so there are no tests to run.'
    expect(gate.giveUpChallenge(reply)).toBe('contradicted')
    expect(gate.onFinalReply(reply)).toBe('nudge')
    expect(gate.giveUpMessage('contradicted')).toMatch(/already passed/i)
  })

  it('honours a repeated GIVE UP so a real dead end still terminates', () => {
    const gate = new VerifyGate(getProjectProfile('website'), 1)
    gate.observe('write_file', { path: 'index.html' }, true, 'ok')
    gate.observe('list_files', {}, true, 'Workspace files:\nindex.html')
    const reply = 'GIVE UP: nothing to run.'
    expect(gate.onFinalReply(reply)).toBe('nudge')
    // Budget spent — the model's answer stands rather than looping forever.
    expect(gate.onFinalReply(reply)).toBe('give_up')
  })

  it('still honours GIVE UP immediately when nothing has been verified', () => {
    // Unverified work plus GIVE UP is a genuine dead end, not a contradiction.
    // Nothing was built at all — "I can't do this" is a real answer.
    const gate = new VerifyGate(getProjectProfile('node'))
    const reply = 'GIVE UP: I do not understand the request.'
    expect(gate.giveUpChallenge(reply)).toBeNull()
    expect(gate.onFinalReply(reply)).toBe('give_up')
  })

  it('a site whose only script run was skipped still counts as verified', () => {
    // run_script on a project with no package.json reports SCRIPT SKIPPED —
    // "nothing to run" — which the website profile treats as satisfied.
    const gate = new VerifyGate(getProjectProfile('website'))
    gate.observe('write_file', { path: 'index.html' }, true, 'ok')
    gate.observe('run_script', { script: 'dev' }, true, 'SCRIPT SKIPPED [dev]\nNo package.json')
    expect(gate.isVerified).toBe(true)
    expect(gate.onFinalReply('Built the static site.')).toBe('accept')
  })

  it('a site WITH a build script is still held to running it', () => {
    // run_tests returns a plain failure (not skipped) when another script exists,
    // so the gate keeps pushing until run_script actually goes green.
    const gate = new VerifyGate(getProjectProfile('website'))
    gate.observe('write_file', { path: 'src/main.js' }, true, 'ok')
    gate.observe('run_tests', {}, true, 'TESTS FAILED\nno usable "test" script. It does define: build.')
    expect(gate.onFinalReply('done')).toBe('nudge')

    gate.observe('run_script', { name: 'build' }, true, 'SCRIPT OK [build]\nbuilt')
    expect(gate.onFinalReply('Built.')).toBe('accept')
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
