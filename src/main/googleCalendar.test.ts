import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  buildAuthUrl,
  buildTokenExchangeBody,
  buildRefreshBody,
  buildEventResource,
  normalizeAttendees,
  isGoogleCalendarConnected,
  googleCreateEvent
} from './googleCalendar'

describe('buildAuthUrl', () => {
  it('requests offline access, the calendar.events scope, and forced consent', () => {
    const u = buildAuthUrl('cid.apps.googleusercontent.com', 'http://127.0.0.1:5555/callback')
    expect(u).toContain('accounts.google.com')
    expect(u).toContain('client_id=cid.apps.googleusercontent.com')
    expect(u).toContain('response_type=code')
    expect(u).toContain('access_type=offline')
    expect(u).toContain('prompt=consent')
    const decoded = decodeURIComponent(u)
    expect(decoded).toContain('https://www.googleapis.com/auth/calendar.events')
    expect(decoded).toContain('http://127.0.0.1:5555/callback')
  })
})

describe('token request bodies', () => {
  const cfg = { clientId: 'cid', clientSecret: 'secret' }

  it('exchange body carries the code and authorization_code grant', () => {
    const b = buildTokenExchangeBody(cfg, 'the-code', 'http://127.0.0.1:1/callback')
    expect(b.get('grant_type')).toBe('authorization_code')
    expect(b.get('code')).toBe('the-code')
    expect(b.get('client_secret')).toBe('secret')
    expect(b.get('redirect_uri')).toBe('http://127.0.0.1:1/callback')
  })

  it('refresh body carries the refresh_token grant', () => {
    const b = buildRefreshBody(cfg, 'rt')
    expect(b.get('grant_type')).toBe('refresh_token')
    expect(b.get('refresh_token')).toBe('rt')
    expect(b.get('client_id')).toBe('cid')
  })
})

describe('buildEventResource', () => {
  it('maps attendees to {email} objects and sets start/end dateTime', () => {
    const e = buildEventResource({
      title: 'Sync',
      start: 'June 24, 2026 11:00 AM',
      end: 'June 24, 2026 12:00 PM',
      attendees: ['a@x.com', 'b@y.com']
    })
    expect(e.summary).toBe('Sync')
    expect((e.start as { dateTime: string }).dateTime).toMatch(/T/)
    expect((e.end as { dateTime: string }).dateTime).toMatch(/T/)
    expect(e.attendees).toEqual([{ email: 'a@x.com' }, { email: 'b@y.com' }])
  })

  it('attaches a Google Meet conference request when addMeetLink is set', () => {
    const e = buildEventResource({ title: 'Call', start: 'June 24, 2026 11:00 AM', addMeetLink: true })
    const conf = e.conferenceData as { createRequest: { conferenceSolutionKey: { type: string } } }
    expect(conf.createRequest.conferenceSolutionKey.type).toBe('hangoutsMeet')
  })

  it('defaults the end time to one hour after start', () => {
    const e = buildEventResource({ title: 'X', start: '2026-06-24T11:00:00Z' })
    expect((e.end as { dateTime: string }).dateTime).toBe('2026-06-24T12:00:00.000Z')
  })

  it('throws on an unparseable start', () => {
    expect(() => buildEventResource({ title: 'X', start: 'not a date' })).toThrow(/unparseable/)
  })

  it('requires a title', () => {
    expect(() => buildEventResource({ title: '', start: '2026-06-24T11:00:00Z' })).toThrow(/title/)
  })
})

describe('normalizeAttendees', () => {
  it('accepts arrays and comma/semicolon strings, lowercasing + deduping + validating', () => {
    expect(normalizeAttendees(['A@x.com', 'a@x.com', 'bad', 'b@y.com'])).toEqual(['a@x.com', 'b@y.com'])
    expect(normalizeAttendees('a@x.com, b@y.com; c@z.com')).toEqual(['a@x.com', 'b@y.com', 'c@z.com'])
    expect(normalizeAttendees(null)).toEqual([])
  })
})

describe('connection gating (no creds → not connected, never hits the network)', () => {
  const keys = ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_CALENDAR_REFRESH_TOKEN']
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const k of keys) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  })
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('isGoogleCalendarConnected is false without credentials', () => {
    expect(isGoogleCalendarConnected()).toBe(false)
  })

  it('googleCreateEvent surfaces a friendly error before any request when title is missing', async () => {
    const r = await googleCreateEvent({ title: '', start: '2026-06-24T11:00:00Z' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/title/)
  })
})
