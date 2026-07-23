import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  buildAuthUrl,
  buildTokenExchangeBody,
  buildRefreshBody,
  buildListQuery,
  buildUploadMultipartBody,
  normalizeShareRole,
  isGoogleDriveConnected,
  sourceMimeTypeForDoc,
  driveToolSchemas,
  driveRegistry,
  MAX_DRIVE_FILE_BYTES,
  MAX_DOC_CONVERT_BYTES,
  GOOGLE_DOC_MIME,
  DOC_SOURCE_EXTENSIONS,
  SHARE_ROLES
} from './googleDrive'

describe('buildAuthUrl', () => {
  it('requests offline access, the NARROW drive.file scope, and incremental grant', () => {
    const u = buildAuthUrl('cid.apps.googleusercontent.com', 'http://127.0.0.1:5555/callback')
    expect(u).toContain('accounts.google.com')
    expect(u).toContain('client_id=cid.apps.googleusercontent.com')
    expect(u).toContain('response_type=code')
    expect(u).toContain('access_type=offline')
    expect(u).toContain('include_granted_scopes=true')
    const decoded = decodeURIComponent(u)
    expect(decoded).toContain('https://www.googleapis.com/auth/drive.file')
    // Must NOT request the broad, read-everything drive scope.
    expect(decoded).not.toContain('auth/drive ')
    expect(decoded).not.toMatch(/auth\/drive(&|$)/)
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
  })

  it('refresh body carries the refresh_token grant', () => {
    const b = buildRefreshBody(cfg, 'rt')
    expect(b.get('grant_type')).toBe('refresh_token')
    expect(b.get('refresh_token')).toBe('rt')
  })
})

describe('buildListQuery', () => {
  it('always excludes trashed files', () => {
    expect(buildListQuery()).toBe('trashed = false')
  })
  it('adds a name-contains clause and a parent-folder clause', () => {
    const q = buildListQuery('budget', 'FOLDER123')
    expect(q).toContain("name contains 'budget'")
    expect(q).toContain("'FOLDER123' in parents")
    expect(q.startsWith('trashed = false')).toBe(true)
  })
  it('escapes single quotes to prevent query injection', () => {
    const q = buildListQuery("a' or name contains 'b")
    expect(q).toContain("name contains 'a\\' or name contains \\'b'")
  })
})

describe('buildUploadMultipartBody', () => {
  it('round-trips the metadata JSON and base64 media inside the multipart envelope', () => {
    const media = Buffer.from('hello drive').toString('base64')
    const body = buildUploadMultipartBody({ name: 'note.txt', parents: ['F1'] }, media, 'text/plain', 'BND')
    expect(body).toContain('--BND')
    expect(body).toContain('--BND--')
    expect(body).toContain('Content-Type: application/json')
    expect(body).toContain('"name":"note.txt"')
    expect(body).toContain('"parents":["F1"]')
    expect(body).toContain('Content-Transfer-Encoding: base64')
    expect(body).toContain(media)
    // The base64 payload decodes back to the original bytes.
    expect(Buffer.from(media, 'base64').toString('utf8')).toBe('hello drive')
  })
})

describe('normalizeShareRole', () => {
  it('defaults to the safest role and accepts the three valid roles', () => {
    expect(normalizeShareRole(undefined)).toBe('reader')
    expect(normalizeShareRole('')).toBe('reader')
    for (const r of SHARE_ROLES) expect(normalizeShareRole(r.toUpperCase())).toBe(r)
  })
  it('rejects roles that transfer control', () => {
    expect(normalizeShareRole('owner')).toBeNull()
    expect(normalizeShareRole('organizer')).toBeNull()
    expect(normalizeShareRole('nonsense')).toBeNull()
  })
})

describe('sourceMimeTypeForDoc', () => {
  it('maps convertible extensions to their source Content-Type (case-insensitive)', () => {
    expect(sourceMimeTypeForDoc('summary.md')).toBe('text/markdown')
    expect(sourceMimeTypeForDoc('Report.DOCX')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    )
    expect(sourceMimeTypeForDoc('notes.txt')).toBe('text/plain')
    expect(sourceMimeTypeForDoc('page.html')).toBe('text/html')
    expect(sourceMimeTypeForDoc('/home/me/a.rtf')).toBe('application/rtf')
  })
  it('returns null for types that would not convert to a clean Doc', () => {
    expect(sourceMimeTypeForDoc('scan.pdf')).toBeNull()
    expect(sourceMimeTypeForDoc('photo.png')).toBeNull()
    expect(sourceMimeTypeForDoc('archive.zip')).toBeNull()
    expect(sourceMimeTypeForDoc('noextension')).toBeNull()
  })
  it('every advertised extension resolves to a source type', () => {
    for (const ext of DOC_SOURCE_EXTENSIONS) {
      expect(sourceMimeTypeForDoc(`file${ext}`)).toBeTruthy()
    }
  })
})

describe('validation gates (no network, no credentials)', () => {
  const keys = ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_DRIVE_REFRESH_TOKEN']
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

  it('isGoogleDriveConnected is false without credentials', () => {
    expect(isGoogleDriveConnected()).toBe(false)
  })

  it('download_from_drive requires a file_id (fails before any request)', async () => {
    const r = await driveRegistry.download_from_drive({ dest_path: join(homedir(), 'x.bin') })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/file_id/)
  })

  it('download_from_drive refuses a destination outside the home tree', async () => {
    const r = await driveRegistry.download_from_drive({
      file_id: 'abc',
      dest_path: join(homedir(), '..', 'escape.bin')
    })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/home folder/)
  })

  it('upload_to_drive refuses a sensitive local path before reading it', async () => {
    const r = await driveRegistry.upload_to_drive({ local_path: '~/.ssh/id_rsa' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/off-limits/)
  })

  it('export_to_google_doc refuses an unsupported file type before any request', async () => {
    const r = await driveRegistry.export_to_google_doc({ local_path: join(homedir(), 'scan.pdf') })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/cannot convert/)
    expect(r.error).toMatch(/\.md/)
  })

  it('export_to_google_doc refuses a sensitive local path before reading it', async () => {
    const r = await driveRegistry.export_to_google_doc({ local_path: '~/.ssh/config.md' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/off-limits/)
  })

  it('share_drive_file validates email and role before any request', async () => {
    expect((await driveRegistry.share_drive_file({ file_id: 'f', email: 'nope', role: 'reader' })).ok).toBe(false)
    const badRole = await driveRegistry.share_drive_file({ file_id: 'f', email: 'a@b.com', role: 'owner' })
    expect(badRole.ok).toBe(false)
    expect(badRole.error).toMatch(/role/)
  })
})

describe('tool surface', () => {
  it('exposes exactly the five Drive schemas', () => {
    const names = driveToolSchemas.map((s) => s.name).sort()
    expect(names).toEqual(
      [
        'download_from_drive',
        'export_to_google_doc',
        'list_drive_files',
        'share_drive_file',
        'upload_to_drive'
      ].sort()
    )
  })
  it('registry has an executor for every schema', () => {
    for (const s of driveToolSchemas) expect(typeof driveRegistry[s.name]).toBe('function')
  })
  it('caps files at 100 MB, and Doc conversion at Google\'s 50 MB', () => {
    expect(MAX_DRIVE_FILE_BYTES).toBe(100 * 1024 * 1024)
    expect(MAX_DOC_CONVERT_BYTES).toBe(50 * 1024 * 1024)
  })
  it('targets the native Google Docs mimeType for conversion', () => {
    expect(GOOGLE_DOC_MIME).toBe('application/vnd.google-apps.document')
  })
})
