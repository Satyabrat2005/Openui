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
  listed: 0
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
  resetOutlookProbeForTests(null)
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
