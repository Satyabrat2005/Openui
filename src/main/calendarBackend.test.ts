/**
 * calendarBackend.test.ts — which calendar backend `control_calendar` picks.
 *
 * The bug this pins down, reproduced on this machine: on Windows WITHOUT classic
 * desktop Outlook, "schedule a meeting tomorrow at 3pm" went to Outlook COM and
 * failed with `REGDB_E_CLASSNOTREG` **even with Google Calendar connected**,
 * because "auto" only considered Google when the request needed attendees or a
 * Meet link. Most Windows 11 machines have no automatable Outlook (the bundled
 * "Outlook for Windows" app exposes no COM interface), so the default calendar
 * experience was a raw HRESULT.
 *
 * The Windows-only paths are asserted by faking the platform through the
 * Outlook-probe seam (resetOutlookProbeForTests) rather than by patching
 * process.platform, so these run identically on every OS in CI.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { homedir } from 'node:os'

const gcal = {
  connected: false,
  created: [] as unknown[],
  listed: 0,
  /** Candidate events googleFindEvents will return for the next search. */
  found: [] as Array<{ id: string; summary: string; start: string; htmlLink: string }>,
  /** Every id actually passed to googleDeleteEvent — must stay empty until approval. */
  deleted: [] as string[],
  updated: [] as Array<{ id: string; patch: unknown }>
}

vi.mock('electron', () => ({
  app: { getPath: () => homedir(), getName: () => 'OpenUI' },
  desktopCapturer: {},
  clipboard: {},
  shell: { openPath: vi.fn(async () => ''), trashItem: vi.fn(async () => undefined) },
  systemPreferences: {
    getMediaAccessStatus: () => 'granted',
    isTrustedAccessibilityClient: () => true
  },
  dialog: {},
  BrowserWindow: class {}
}))
vi.mock('./telemetry/posthog', () => ({ trackEvent: () => {} }))
vi.mock('./googleCalendar', () => ({
  isGoogleCalendarConnected: () => gcal.connected,
  googleCreateEvent: async (input: unknown) => {
    gcal.created.push(input)
    return { ok: true, output: 'GOOGLE_CREATED' }
  },
  googleListToday: async () => {
    gcal.listed++
    return { ok: true, output: 'GOOGLE_LISTED' }
  },
  googleFindEvents: async () => ({ ok: true, events: gcal.found }),
  googleDeleteEvent: async (id: string) => {
    gcal.deleted.push(id)
    return { ok: true, output: 'GOOGLE_DELETED' }
  },
  googleUpdateEvent: async (id: string, patch: unknown) => {
    gcal.updated.push({ id, patch })
    return { ok: true, output: 'GOOGLE_UPDATED' }
  },
  SEARCH_WINDOW_DAYS: 60,
  normalizeAttendees: (raw: unknown) => (Array.isArray(raw) ? raw.filter((x) => typeof x === 'string') : [])
}))
// If a test ever reaches the real Windows path, this stands in for the COM call
// and fails the way an absent Outlook does — so a regression is a clear failure
// rather than a hang or a machine-dependent result.
vi.mock('./powershell', () => ({
  runPowerShell: vi.fn(async () => ''),
  runPowerShellScript: vi.fn(async () => {
    throw Object.assign(new Error('COM failed'), {
      stderr: 'Calendar not available (Microsoft Outlook required): REGDB_E_CLASSNOTREG'
    })
  })
}))

import { executeTool, resetOutlookProbeForTests } from './tools'

const IS_WIN = process.platform === 'win32'
const IS_MAC = process.platform === 'darwin'

/**
 * control_calendar is state-changing, so executeTool returns
 * `{status:'pending_approval'}` unless the HITL gate is bypassed, and it has its
 * own sensitive-action gate for attendee invites. Both are approved here because
 * the subject under test is BACKEND SELECTION, not the approval gates (those are
 * covered in tools.test.ts).
 */
async function calendar(args: Record<string, unknown>): Promise<{ ok: boolean; output?: string; error?: string }> {
  return (await executeTool('control_calendar', args, {
    tier: 'free',
    bypassHitl: true,
    sensitiveApproved: true
  } as never)) as { ok: boolean; output?: string; error?: string }
}

beforeEach(() => {
  gcal.connected = false
  gcal.created = []
  gcal.listed = 0
  gcal.found = []
  gcal.deleted = []
  gcal.updated = []
  resetOutlookProbeForTests(null)
})

/** Same call, but WITHOUT pre-approval - the shape the agent loop first sees. */
async function calendarUnapproved(
  args: Record<string, unknown>
): Promise<{ ok: boolean; output?: string; error?: string; needsConfirmation?: { kind: string; label: string; choices?: string[] } }> {
  return (await executeTool('control_calendar', args, {
    tier: 'free',
    bypassHitl: true
  } as never)) as never
}

/**
 * Cancelling and rescheduling events - the destructive half of control_calendar.
 *
 * These paths email the other attendees, and a cancellation cannot be undone
 * from their point of view, so the invariant under test is not "does it delete"
 * but "what does it refuse to delete": nothing is cancelled without an explicit
 * approval, and an ambiguous name is never resolved by guessing.
 *
 * Google is the backend here because it is the one path with no OS dependency;
 * the Calendar.app and Outlook paths follow the same resolve -> confirm -> act
 * shape but need real hosts to exercise.
 */
describe('control_calendar delete / update - Google backend', () => {
  beforeEach(() => {
    gcal.connected = true
    resetOutlookProbeForTests(false) // force the Google path on every OS
  })

  it('cancels the single matching event once approved', async () => {
    if (IS_MAC) return // macOS has a local backend and takes the AppleScript path
    gcal.found = [{ id: 'evt-1', summary: 'Standup', start: '2026-09-04T14:00:00Z', htmlLink: '' }]
    const res = await calendar({ action: 'delete', eventDetails: { title: 'standup' } })
    expect(res.ok).toBe(true)
    expect(gcal.deleted).toEqual(['evt-1'])
  })

  it('SAFETY: cancels NOTHING until the user approves', async () => {
    if (IS_MAC) return
    gcal.found = [{ id: 'evt-1', summary: 'Standup', start: '2026-09-04T14:00:00Z', htmlLink: '' }]
    const res = await calendarUnapproved({ action: 'delete', eventDetails: { title: 'standup' } })
    expect(res.ok).toBe(false)
    expect(res.needsConfirmation?.kind).toBe('sensitive-action')
    // The confirmation names the resolved event, not the search term.
    expect(res.needsConfirmation?.label).toMatch(/Standup/)
    // The one that matters: no delete was issued.
    expect(gcal.deleted).toEqual([])
  })

  it('SAFETY: asks which event when several match, instead of picking one', async () => {
    if (IS_MAC) return
    gcal.found = [
      { id: 'evt-1', summary: 'Standup', start: '2026-09-04T14:00:00Z', htmlLink: '' },
      { id: 'evt-2', summary: 'Standup', start: '2026-09-11T14:00:00Z', htmlLink: '' }
    ]
    const res = await calendarUnapproved({ action: 'delete', eventDetails: { title: 'standup' } })
    expect(res.ok).toBe(false)
    expect(res.needsConfirmation?.kind).toBe('choice')
    expect(res.needsConfirmation?.choices).toHaveLength(2)
    expect(gcal.deleted).toEqual([])
  })

  it('deletes the event the user picked from the ambiguity list', async () => {
    if (IS_MAC) return
    gcal.found = [
      { id: 'evt-1', summary: 'Standup', start: '2026-09-04T14:00:00Z', htmlLink: '' },
      { id: 'evt-2', summary: 'Standup', start: '2026-09-11T14:00:00Z', htmlLink: '' }
    ]
    const res = await calendar({
      action: 'delete',
      eventDetails: { title: 'standup' },
      resolvedContact: 'Standup - Fri 11 Sep 14:00 [evt-2]'
    })
    expect(res.ok).toBe(true)
    expect(gcal.deleted).toEqual(['evt-2'])
  })

  it('REGRESSION: an approved-but-ambiguous match still asks, never picks the first', async () => {
    // The bug this pins: disambiguation used to be gated on !sensitiveApproved,
    // so once the user approved the action an ambiguous name fell through to
    // candidates[0] and cancelled the FIRST of several same-named meetings
    // without ever showing the picker. Identity and approval are independent.
    if (IS_MAC) return
    gcal.found = [
      { id: 'evt-1', summary: 'Standup', start: '2026-09-04T14:00:00Z', htmlLink: '' },
      { id: 'evt-2', summary: 'Standup', start: '2026-09-11T14:00:00Z', htmlLink: '' }
    ]
    // Approved, ambiguous, and NO pick supplied.
    const res = await calendar({ action: 'delete', eventDetails: { title: 'standup' } })
    expect(res.ok).toBe(false)
    expect(gcal.deleted).toEqual([])
  })

  it('reports no match without deleting anything, and tells the model not to retry', async () => {
    if (IS_MAC) return
    gcal.found = []
    const res = await calendar({ action: 'delete', eventDetails: { title: 'nonexistent' } })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/No calendar event matching/)
    expect(res.error).toMatch(/Do not retry/)
    expect(gcal.deleted).toEqual([])
  })

  it('requires a name to search for', async () => {
    if (IS_MAC) return
    const res = await calendar({ action: 'delete', eventDetails: {} })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/eventDetails\.title/)
    expect(gcal.deleted).toEqual([])
  })

  it('reschedules a matched event, passing the new start through', async () => {
    if (IS_MAC) return
    gcal.found = [{ id: 'evt-9', summary: 'Dentist', start: '2026-09-04T09:00:00Z', htmlLink: '' }]
    const res = await calendar({
      action: 'update',
      eventDetails: { title: 'dentist', start: 'next Wednesday 10:00' }
    })
    expect(res.ok).toBe(true)
    expect(gcal.updated).toHaveLength(1)
    expect(gcal.updated[0].id).toBe('evt-9')
    expect((gcal.updated[0].patch as { start: string }).start).toBe('next Wednesday 10:00')
  })

  it('rejects an unknown action by name, listing the real ones', async () => {
    if (IS_MAC) return
    const res = await calendar({ action: 'purge' })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/create/)
    expect(res.error).toMatch(/delete/)
  })
})

describe('control_calendar backend selection — no local calendar available', () => {
  beforeEach(() => {
    // Pretend Outlook COM is not registered (the real state on most Win 11 boxes,
    // and verified on this machine). On macOS Calendar.app always exists, so the
    // "no local backend" case is Windows/Linux only.
    resetOutlookProbeForTests(false)
  })

  it('routes a plain create to Google when Google is connected', async () => {
    if (IS_MAC) return // macOS always has a local backend; not the case under test
    gcal.connected = true
    const res = await calendar({
      action: 'create',
      eventDetails: { title: 'Design Review', start: 'tomorrow 3pm' }
    })
    expect(res.ok).toBe(true)
    expect(res.output).toBe('GOOGLE_CREATED')
    expect(gcal.created).toHaveLength(1)
  })

  it('routes a plain list to Google when Google is connected', async () => {
    if (IS_MAC) return
    gcal.connected = true
    const res = await calendar({ action: 'list' })
    expect(res.ok).toBe(true)
    expect(res.output).toBe('GOOGLE_LISTED')
  })

  // The headline fix: this used to be a raw HRESULT with no mention of the
  // integration that would actually work.
  it('explains how to fix it instead of returning a raw COM error', async () => {
    if (IS_MAC) return
    gcal.connected = false
    const res = await calendar({
      action: 'create',
      eventDetails: { title: 'Standup', start: 'tomorrow 9am' }
    })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/Google Calendar/)
    expect(res.error).not.toMatch(/REGDB_E_CLASSNOTREG/)
    if (IS_WIN) expect(res.error).toMatch(/Outlook/)
  })

  // An explicit backend request must not be silently redirected: the user asked
  // for the local calendar, so they get the local calendar's real error.
  it('honours an explicit backend:"system" and does not divert to Google', async () => {
    if (!IS_WIN) return
    gcal.connected = true
    const res = await calendar({
      action: 'list',
      backend: 'system'
    })
    expect(res.ok).toBe(false)
    expect(gcal.listed).toBe(0)
    expect(res.error).toMatch(/REGDB_E_CLASSNOTREG|Outlook/)
  })
})

describe('control_calendar backend selection — local calendar IS available', () => {
  it('prefers the local calendar for a plain event', async () => {
    if (!IS_WIN) return
    resetOutlookProbeForTests(true) // pretend classic Outlook is installed
    gcal.connected = true
    const res = await calendar({
      action: 'create',
      eventDetails: { title: 'Solo focus block', start: 'tomorrow 9am' }
    })
    // Reaches the Windows COM path (which our mock rejects) rather than Google —
    // proving the local backend still wins when it genuinely exists.
    expect(gcal.created).toHaveLength(0)
    expect(res.ok).toBe(false)
  })

  it('still uses Google when the request needs invites', async () => {
    if (!IS_WIN) return
    resetOutlookProbeForTests(true)
    gcal.connected = true
    const res = await calendar({
      action: 'create',
      eventDetails: {
        title: 'Kickoff',
        start: 'tomorrow 10am',
        attendees: ['a@example.com']
      }
    })
    expect(res.ok).toBe(true)
    expect(res.output).toBe('GOOGLE_CREATED')
  })

  it('routes to Google when explicitly asked, local backend or not', async () => {
    resetOutlookProbeForTests(true)
    gcal.connected = true
    const res = await calendar({ action: 'list', backend: 'google' })
    expect(res.ok).toBe(true)
    expect(res.output).toBe('GOOGLE_LISTED')
  })

  it('reports the missing connection when google is forced but not connected', async () => {
    resetOutlookProbeForTests(true)
    gcal.connected = false
    const res = await calendar({ action: 'list', backend: 'google' })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/not connected/i)
  })
})
