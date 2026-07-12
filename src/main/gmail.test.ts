import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  buildAuthUrl,
  buildTokenExchangeBody,
  buildRefreshBody,
  buildMimeMessage,
  normalizeRecipients,
  deriveSubject,
  isGmailConnected,
  sendGmailMessage,
  findEmailThread
} from './gmail'

describe('buildAuthUrl', () => {
  it('requests offline access, both gmail scopes, and forced consent', () => {
    const u = buildAuthUrl('cid.apps.googleusercontent.com', 'http://127.0.0.1:5555/callback')
    expect(u).toContain('accounts.google.com')
    expect(u).toContain('client_id=cid.apps.googleusercontent.com')
    expect(u).toContain('response_type=code')
    expect(u).toContain('access_type=offline')
    expect(u).toContain('prompt=consent')
    const decoded = decodeURIComponent(u)
    expect(decoded).toContain('https://www.googleapis.com/auth/gmail.send')
    expect(decoded).toContain('https://www.googleapis.com/auth/gmail.readonly')
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

describe('normalizeRecipients', () => {
  it('accepts arrays and comma/semicolon strings, deduping + validating', () => {
    expect(normalizeRecipients(['a@x.com', 'a@x.com', 'bad', 'b@y.com'])).toEqual(['a@x.com', 'b@y.com'])
    expect(normalizeRecipients('a@x.com, b@y.com; c@z.com')).toEqual(['a@x.com', 'b@y.com', 'c@z.com'])
    expect(normalizeRecipients(null)).toEqual([])
  })

  it('caps the recipient count', () => {
    const many = Array.from({ length: 30 }, (_, i) => `u${i}@x.com`)
    expect(normalizeRecipients(many).length).toBe(25)
  })
})

describe('deriveSubject', () => {
  it('cuts at the first sentence break', () => {
    expect(deriveSubject('Hi there. Just following up on my application.')).toBe('Hi there.')
  })

  it('falls back to the first 60 chars when there is no sentence break', () => {
    const body = 'a'.repeat(100)
    expect(deriveSubject(body)).toBe('a'.repeat(60))
  })

  it('skips leading blank lines', () => {
    expect(deriveSubject('\n\nHello world!')).toBe('Hello world!')
  })

  it('falls back to a placeholder for an empty body', () => {
    expect(deriveSubject('   ')).toBe('(no subject)')
  })
})

describe('buildMimeMessage', () => {
  it('produces a base64url string (no +, /, or = padding)', () => {
    const raw = buildMimeMessage({ to: ['a@x.com'], subject: 'Hi', body: 'Hello' })
    expect(raw).not.toMatch(/[+/=]/)
  })

  it('decodes to headers + body for a plain message', () => {
    const raw = buildMimeMessage({ to: ['a@x.com', 'b@y.com'], subject: 'Hi', body: 'Hello there' })
    const decoded = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    expect(decoded).toContain('To: a@x.com, b@y.com')
    expect(decoded).toContain('Subject: Hi')
    expect(decoded).toContain('Hello there')
  })

  it('includes In-Reply-To/References when replying into a thread', () => {
    const raw = buildMimeMessage({ to: ['a@x.com'], subject: 'Re: Hi', body: 'Following up', inReplyTo: '<abc@mail.gmail.com>' })
    const decoded = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    expect(decoded).toContain('In-Reply-To: <abc@mail.gmail.com>')
    expect(decoded).toContain('References: <abc@mail.gmail.com>')
  })

  it('embeds an attachment as a base64 multipart section', () => {
    const raw = buildMimeMessage({
      to: ['a@x.com'],
      subject: 'Resume',
      body: 'See attached.',
      attachment: { filename: 'resume.pdf', contentType: 'application/pdf', data: Buffer.from('PDF-DATA') }
    })
    const decoded = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    expect(decoded).toContain('multipart/mixed')
    expect(decoded).toContain('filename="resume.pdf"')
    expect(decoded).toContain(Buffer.from('PDF-DATA').toString('base64'))
  })

  it('throws when there are no recipients', () => {
    expect(() => buildMimeMessage({ to: [], subject: 'Hi', body: 'Hello' })).toThrow(/recipient/)
  })
})

describe('connection gating (no creds → not connected, never hits the network)', () => {
  const keys = ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN']
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

  it('isGmailConnected is false without credentials', () => {
    expect(isGmailConnected()).toBe(false)
  })

  it('sendGmailMessage surfaces a friendly validation error before any request when "to" is empty', async () => {
    const r = await sendGmailMessage({ to: [], body: 'hello' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/to/)
  })

  it('sendGmailMessage surfaces a friendly validation error before any request when body is empty', async () => {
    const r = await sendGmailMessage({ to: ['a@x.com'], body: '' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/body/)
  })

  it('findEmailThread surfaces a friendly validation error before any request for an empty query', async () => {
    const r = await findEmailThread('')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/query/)
  })
})
