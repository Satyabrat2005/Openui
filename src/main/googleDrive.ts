/**
 * googleDrive.ts — dedicated Google Drive backend for the agent's cloud-storage
 * tools (upload_to_drive / download_from_drive / list_drive_files /
 * share_drive_file).
 *
 * Mirrors gmail.ts / googleCalendar.ts exactly: the SAME OAuth "Desktop app"
 * client (Client ID / Secret entered in Settings → Google Calendar, or the
 * GOOGLE_OAUTH_CLIENT_ID / _SECRET env vars, shared across every Google
 * feature), its OWN refresh token (GDRIVE_REFRESH_TOKEN_KEY), and the
 * loopback-redirect flow Google mandates for desktop apps. All REST calls use
 * node:https — no googleapis dependency.
 *
 * SCOPE — deliberately the NARROW https://www.googleapis.com/auth/drive.file,
 * NOT the broad .../auth/drive. drive.file only grants access to files this app
 * itself creates, or that the user explicitly opens with it; it can never read
 * or enumerate the user's whole Drive. That is the minimal-privilege choice and
 * matches the security posture the rest of this codebase already holds itself to
 * (Figma's per-user token, GitHub's scoped PAT). include_granted_scopes is set
 * on the auth URL, so connecting Drive is an INCREMENTAL grant layered on top of
 * whatever Calendar/Gmail access already exists rather than a re-auth from
 * scratch.
 *
 * SECURITY / SAFETY:
 *   - Client secret + refresh token stay in the main process (never cross the
 *     contextBridge); the renderer only triggers "connect" and reads a boolean.
 *   - Every local path passes through resolveSafePath(): upload reads (blocked
 *     from sensitive dirs), download writes (additionally confined to home).
 *   - File size is capped at 100 MB for both upload and download, with a clear
 *     error above that rather than a silent hang.
 *   - The pure request/payload builders are exported for unit testing without a
 *     network, database, or electron dependency.
 *   - upload_to_drive / download_from_drive / share_drive_file are registered in
 *     STATE_CHANGING_TOOLS (tools.ts) so they are HITL-gated; share_drive_file is
 *     ALSO in DESTRUCTIVE_TOOLS — it grants another person standing access to a
 *     file and emails them, the same outward-facing category as send_email.
 */

import { request as httpsRequest } from 'node:https'
import { createServer } from 'node:http'
import { readFile, writeFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { GCAL_CLIENT_ID_KEY, GCAL_CLIENT_SECRET_KEY } from './googleCalendar'
import { resolveSafePath } from './fs/pathSafety'
import type { ExecutorContext, ToolResult, ToolSchema } from './tools'

// Settings keys — client id/secret are the SAME keys Calendar/Gmail use (shared
// credentials); only the refresh token is Drive's own.
export { GCAL_CLIENT_ID_KEY, GCAL_CLIENT_SECRET_KEY }
export const GDRIVE_REFRESH_TOKEN_KEY = 'google_drive_refresh_token'

const SCOPE = 'https://www.googleapis.com/auth/drive.file'
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const API_BASE = 'https://www.googleapis.com/drive/v3'
const UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3'
const CONNECT_TIMEOUT_MS = 300_000

/** Largest file we will upload or download in one call. Above this we refuse up
 *  front with a clear message instead of streaming a huge file (or timing out). */
export const MAX_DRIVE_FILE_BYTES = 100 * 1024 * 1024 // 100 MB
/** Cap on files returned by list_drive_files, so a broad query can't flood context. */
const MAX_LIST_RESULTS = 100

/** The Drive sharing roles we allow. Owner/organizer/fileOrganizer are omitted —
 *  they transfer control and are not appropriate for an assistant to grant. */
export const SHARE_ROLES = ['reader', 'commenter', 'writer'] as const
export type ShareRole = (typeof SHARE_ROLES)[number]

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

interface OAuthConfig {
  clientId: string
  clientSecret: string
}
interface TokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  error?: string
  error_description?: string
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// ── settings access (lazy-required so unit tests never boot better-sqlite3) ───

function readSetting(key: string): string {
  try {
    const { database } = require('./database') as typeof import('./database')
    const v: unknown = database.settings.getSetting(key)
    return typeof v === 'string' ? v.trim() : ''
  } catch {
    return ''
  }
}

function writeSetting(key: string, value: string): void {
  const { database } = require('./database') as typeof import('./database')
  database.settings.setSetting(key, value)
}

/** Resolve the user's OAuth client (env wins for dev, else Settings). Shared with Calendar/Gmail. */
export function getOAuthConfig(): OAuthConfig | null {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim() || readSetting(GCAL_CLIENT_ID_KEY)
  const clientSecret =
    process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() || readSetting(GCAL_CLIENT_SECRET_KEY)
  if (!clientId || !clientSecret) return null
  return { clientId, clientSecret }
}

function getRefreshToken(): string {
  return process.env.GOOGLE_DRIVE_REFRESH_TOKEN?.trim() || readSetting(GDRIVE_REFRESH_TOKEN_KEY)
}

/** True only when both an OAuth client and a Drive refresh token are available. */
export function isGoogleDriveConnected(): boolean {
  return getOAuthConfig() !== null && getRefreshToken() !== ''
}

// ── pure builders (exported for unit tests) ───────────────────────────────────

export function buildAuthUrl(clientId: string, redirectUri: string): string {
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true'
  })
  return `${AUTH_ENDPOINT}?${p.toString()}`
}

export function buildTokenExchangeBody(
  cfg: OAuthConfig,
  code: string,
  redirectUri: string
): URLSearchParams {
  return new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code'
  })
}

export function buildRefreshBody(cfg: OAuthConfig, refreshToken: string): URLSearchParams {
  return new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  })
}

/** Validate a caller-supplied sharing role, defaulting to the safest (reader). */
export function normalizeShareRole(raw: unknown): ShareRole | null {
  if (raw === undefined || raw === null || raw === '') return 'reader'
  const r = String(raw).trim().toLowerCase()
  return (SHARE_ROLES as readonly string[]).includes(r) ? (r as ShareRole) : null
}

/** Single-quotes are the string delimiter in Drive's query language; escape them. */
function escapeDriveQuery(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

/**
 * Build the `q` parameter for files.list from an optional name filter and an
 * optional parent folder id. Always excludes trashed files. Exported pure so the
 * query construction is unit-tested without a network.
 */
export function buildListQuery(nameContains?: string, folderId?: string): string {
  const clauses: string[] = ['trashed = false']
  if (nameContains && nameContains.trim()) {
    clauses.push(`name contains '${escapeDriveQuery(nameContains.trim())}'`)
  }
  if (folderId && folderId.trim()) {
    clauses.push(`'${escapeDriveQuery(folderId.trim())}' in parents`)
  }
  return clauses.join(' and ')
}

const MULTIPART_BOUNDARY = 'openui_drive_boundary_7c1e'

/**
 * Build a Drive multipart/related upload body (metadata part + base64 media
 * part). Kept as a pure string builder — the media is base64-encoded with a
 * Content-Transfer-Encoding header, which Drive accepts — so it can be unit
 * tested without a network and reuses the string-based httpsSend below.
 */
export function buildUploadMultipartBody(
  metadata: Record<string, unknown>,
  mediaBase64: string,
  contentType: string,
  boundary: string = MULTIPART_BOUNDARY
): string {
  return (
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${contentType}\r\n` +
    'Content-Transfer-Encoding: base64\r\n\r\n' +
    `${mediaBase64}\r\n` +
    `--${boundary}--`
  )
}

// ── HTTPS helpers ─────────────────────────────────────────────────────────────

/** Send a request whose body is a UTF-8 string (or none) and read a text response. */
function httpsSend(
  method: string,
  urlStr: string,
  headers: Record<string, string>,
  payload?: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr)
    const req = httpsRequest(
      { method, hostname: url.hostname, path: `${url.pathname}${url.search}`, headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c as Buffer))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
        )
      }
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

/**
 * GET a binary response (for file downloads). Aborts and rejects once more than
 * `maxBytes` have arrived, so a file that turns out to be larger than the cap
 * (Drive does not always report size up front) can't exhaust memory.
 */
function httpsGetBuffer(
  urlStr: string,
  headers: Record<string, string>,
  maxBytes: number
): Promise<{ status: number; buffer: Buffer }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr)
    const req = httpsRequest(
      { method: 'GET', hostname: url.hostname, path: `${url.pathname}${url.search}`, headers },
      (res) => {
        const chunks: Buffer[] = []
        let total = 0
        res.on('data', (c: Buffer) => {
          total += c.length
          if (total > maxBytes) {
            req.destroy()
            reject(new Error(`file exceeds the ${Math.round(maxBytes / (1024 * 1024))} MB download limit`))
            return
          }
          chunks.push(c)
        })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, buffer: Buffer.concat(chunks) }))
      }
    )
    req.on('error', reject)
    req.end()
  })
}

async function postToken(body: URLSearchParams): Promise<TokenResponse> {
  const payload = body.toString()
  const { status, body: text } = await httpsSend(
    'POST',
    TOKEN_ENDPOINT,
    {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': String(Buffer.byteLength(payload))
    },
    payload
  )
  let json: TokenResponse
  try {
    json = JSON.parse(text) as TokenResponse
  } catch {
    throw new Error(`Google token endpoint returned non-JSON (HTTP ${status}).`)
  }
  if (status >= 400 || json.error) {
    throw new Error(`Google token error: ${json.error_description || json.error || `HTTP ${status}`}`)
  }
  return json
}

let cachedToken: { value: string; expiresAt: number } | null = null

async function getAccessToken(): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000)
  if (cachedToken && cachedToken.expiresAt > nowSec + 60) return cachedToken.value
  const cfg = getOAuthConfig()
  if (!cfg) throw new Error('Google OAuth client is not configured (Settings → Google Calendar).')
  const refresh = getRefreshToken()
  if (!refresh) throw new Error('Google Drive is not connected.')
  const tok = await postToken(buildRefreshBody(cfg, refresh))
  if (!tok.access_token) throw new Error('Google did not return an access token.')
  cachedToken = { value: tok.access_token, expiresAt: nowSec + (tok.expires_in ?? 3600) }
  return cachedToken.value
}

async function apiJson(
  method: string,
  path: string,
  query?: string,
  body?: unknown
): Promise<{ status: number; json: Record<string, unknown> }> {
  const token = await getAccessToken()
  const payload = body === undefined ? undefined : JSON.stringify(body)
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
  if (payload) {
    headers['Content-Type'] = 'application/json'
    headers['Content-Length'] = String(Buffer.byteLength(payload))
  }
  const { status, body: text } = await httpsSend(
    method,
    `${API_BASE}${path}${query ? `?${query}` : ''}`,
    headers,
    payload
  )
  let json: Record<string, unknown> = {}
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  } catch {
    /* leave json empty */
  }
  return { status, json }
}

function driveApiError(json: Record<string, unknown>, status: number): string {
  return (json.error as { message?: string } | undefined)?.message || `HTTP ${status}`
}

/**
 * POST a multipart/related create to the Drive upload endpoint (metadata + media)
 * and return the parsed status/json. Shared by upload_to_drive (raw bytes) and
 * export_to_google_doc (source bytes + a Google-Doc target mimeType that makes
 * Drive convert on upload). `contentType` is the SOURCE media type; `fields`
 * selects which file fields Drive echoes back.
 */
async function driveMultipartUpload(
  data: Buffer,
  metadata: Record<string, unknown>,
  contentType: string,
  fields: string
): Promise<{ status: number; json: Record<string, unknown> }> {
  const body = buildUploadMultipartBody(metadata, data.toString('base64'), contentType)
  const token = await getAccessToken()
  const { status, body: text } = await httpsSend(
    'POST',
    `${UPLOAD_BASE}/files?uploadType=multipart&fields=${fields}`,
    {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${MULTIPART_BOUNDARY}`,
      'Content-Length': String(Buffer.byteLength(body))
    },
    body
  )
  let json: Record<string, unknown> = {}
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  } catch {
    /* leave empty */
  }
  return { status, json }
}

// ── upload_to_drive ───────────────────────────────────────────────────────────

async function upload_to_drive(args: Record<string, unknown>): Promise<ToolResult> {
  let file: string
  try {
    file = resolveSafePath(args.local_path ?? args.path, { mutating: false })
  } catch (e) {
    return { ok: false, error: `upload_to_drive: ${errText(e)}` }
  }

  let data: Buffer
  try {
    const info = await stat(file)
    if (!info.isFile()) return { ok: false, error: `upload_to_drive: "${file}" is not a file.` }
    if (info.size > MAX_DRIVE_FILE_BYTES) {
      return {
        ok: false,
        error: `upload_to_drive: "${file}" is ${(info.size / (1024 * 1024)).toFixed(1)} MB, over the ${MAX_DRIVE_FILE_BYTES / (1024 * 1024)} MB limit.`
      }
    }
    data = await readFile(file)
  } catch (e) {
    return { ok: false, error: `upload_to_drive: could not read file — ${errText(e)}` }
  }

  const metadata: Record<string, unknown> = { name: basename(file) }
  const folder = typeof args.folder === 'string' ? args.folder.trim() : ''
  if (folder) metadata.parents = [folder]

  try {
    const { status, json } = await driveMultipartUpload(
      data,
      metadata,
      'application/octet-stream',
      'id,name,webViewLink'
    )
    if (status >= 400) return { ok: false, error: `Google Drive rejected the upload: ${driveApiError(json, status)}` }
    const id = String(json.id ?? '')
    const link = typeof json.webViewLink === 'string' ? `\n${json.webViewLink}` : ''
    return {
      ok: true,
      output: `Uploaded "${basename(file)}" to Google Drive (file id ${id}${folder ? `, in folder ${folder}` : ''}).${link}`
    }
  } catch (e) {
    return { ok: false, error: `upload_to_drive failed: ${errText(e)}` }
  }
}

// ── export_to_google_doc ──────────────────────────────────────────────────────

/** The native Google Docs mimeType. Setting it as the TARGET metadata mimeType on
 *  an upload makes Drive convert the source content into a real, editable Doc. */
export const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document'

/** Google's max SOURCE size for converting a file to a Google Document (50 MB) —
 *  stricter than the module's general 100 MB transfer cap, enforced up front so an
 *  oversized file is refused with a clear message instead of an opaque API reject. */
export const MAX_DOC_CONVERT_BYTES = 50 * 1024 * 1024

/**
 * Local file extensions Drive can convert into a native Google Doc, mapped to the
 * source Content-Type to declare in the multipart media part. Anything outside
 * this set (images, PDFs, binaries) would produce a garbage Doc, so it is refused.
 */
const DOC_SOURCE_TYPES: Record<string, string> = {
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.rtf': 'application/rtf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.odt': 'application/vnd.oasis.opendocument.text'
}
export const DOC_SOURCE_EXTENSIONS = Object.keys(DOC_SOURCE_TYPES)

/** Source Content-Type for a filename Drive can convert to a Doc, or null if the
 *  extension is unsupported. Pure/exported for unit testing. */
export function sourceMimeTypeForDoc(filename: string): string | null {
  const ext = extname(filename).toLowerCase()
  return DOC_SOURCE_TYPES[ext] ?? null
}

async function export_to_google_doc(args: Record<string, unknown>): Promise<ToolResult> {
  let file: string
  try {
    file = resolveSafePath(args.local_path ?? args.path, { mutating: false })
  } catch (e) {
    return { ok: false, error: `export_to_google_doc: ${errText(e)}` }
  }

  const sourceType = sourceMimeTypeForDoc(file)
  if (!sourceType) {
    return {
      ok: false,
      error: `export_to_google_doc: cannot convert "${basename(file)}" to a Google Doc. Supported source types: ${DOC_SOURCE_EXTENSIONS.join(', ')} (e.g. a .md or .docx summary).`
    }
  }

  let data: Buffer
  try {
    const info = await stat(file)
    if (!info.isFile()) return { ok: false, error: `export_to_google_doc: "${file}" is not a file.` }
    if (info.size > MAX_DOC_CONVERT_BYTES) {
      return {
        ok: false,
        error: `export_to_google_doc: "${file}" is ${(info.size / (1024 * 1024)).toFixed(1)} MB, over Google's ${MAX_DOC_CONVERT_BYTES / (1024 * 1024)} MB document-conversion limit.`
      }
    }
    data = await readFile(file)
  } catch (e) {
    return { ok: false, error: `export_to_google_doc: could not read file — ${errText(e)}` }
  }

  // A Google Doc carries no file extension — name it after the source, sans suffix.
  const docName = basename(file, extname(file)) || basename(file)
  const metadata: Record<string, unknown> = { name: docName, mimeType: GOOGLE_DOC_MIME }
  const folder = typeof args.folder === 'string' ? args.folder.trim() : ''
  if (folder) metadata.parents = [folder]

  try {
    const { status, json } = await driveMultipartUpload(
      data,
      metadata,
      sourceType,
      'id,name,webViewLink,mimeType'
    )
    if (status >= 400) {
      return { ok: false, error: `export_to_google_doc: Google Drive rejected the conversion — ${driveApiError(json, status)}` }
    }
    const id = String(json.id ?? '')
    // webViewLink is the canonical Doc URL; fall back to the standard /edit URL.
    const url =
      typeof json.webViewLink === 'string' && json.webViewLink
        ? json.webViewLink
        : `https://docs.google.com/document/d/${id}/edit`
    return {
      ok: true,
      output: `Exported "${basename(file)}" to a Google Doc "${docName}"${folder ? ` (in folder ${folder})` : ''} — id ${id}.\n${url}`
    }
  } catch (e) {
    return { ok: false, error: `export_to_google_doc failed: ${errText(e)}` }
  }
}

// ── download_from_drive ───────────────────────────────────────────────────────

async function download_from_drive(args: Record<string, unknown>): Promise<ToolResult> {
  const fileId = typeof args.file_id === 'string' ? args.file_id.trim() : ''
  if (!fileId) return { ok: false, error: 'download_from_drive: "file_id" is required.' }

  let dest: string
  try {
    dest = resolveSafePath(args.dest_path ?? args.path, { mutating: true })
  } catch (e) {
    return { ok: false, error: `download_from_drive: ${errText(e)}` }
  }

  try {
    // Check the reported size first so an oversized file is refused before we
    // start streaming (the streaming guard in httpsGetBuffer is the backstop for
    // files Drive doesn't report a size for, e.g. Google-native docs).
    const { status: metaStatus, json: meta } = await apiJson(
      'GET',
      `/files/${encodeURIComponent(fileId)}`,
      'fields=size,name'
    )
    if (metaStatus >= 400) {
      return { ok: false, error: `download_from_drive: ${driveApiError(meta, metaStatus)}` }
    }
    const reported = Number(meta.size ?? 0)
    if (reported > MAX_DRIVE_FILE_BYTES) {
      return {
        ok: false,
        error: `download_from_drive: file is ${(reported / (1024 * 1024)).toFixed(1)} MB, over the ${MAX_DRIVE_FILE_BYTES / (1024 * 1024)} MB limit.`
      }
    }

    const token = await getAccessToken()
    const { status, buffer } = await httpsGetBuffer(
      `${API_BASE}/files/${encodeURIComponent(fileId)}?alt=media`,
      { Authorization: `Bearer ${token}` },
      MAX_DRIVE_FILE_BYTES
    )
    if (status >= 400) {
      // A JSON error body came back instead of file bytes.
      let msg = `HTTP ${status}`
      try {
        msg = driveApiError(JSON.parse(buffer.toString('utf8')) as Record<string, unknown>, status)
      } catch {
        /* keep HTTP status */
      }
      return { ok: false, error: `download_from_drive: ${msg}` }
    }
    await writeFile(dest, buffer)
    return {
      ok: true,
      output: `Downloaded Drive file ${fileId} (${(buffer.length / 1024).toFixed(1)} KB) to ${dest}.`
    }
  } catch (e) {
    return { ok: false, error: `download_from_drive failed: ${errText(e)}` }
  }
}

// ── list_drive_files ──────────────────────────────────────────────────────────

async function list_drive_files(args: Record<string, unknown>): Promise<ToolResult> {
  const nameContains = typeof args.query === 'string' ? args.query : undefined
  const folder = typeof args.folder === 'string' ? args.folder : undefined
  const q = buildListQuery(nameContains, folder)
  const query = new URLSearchParams({
    q,
    pageSize: String(MAX_LIST_RESULTS),
    fields: 'files(id,name,mimeType,size,modifiedTime),incompleteSearch',
    orderBy: 'modifiedTime desc'
  }).toString()

  try {
    const { status, json } = await apiJson('GET', '/files', query)
    if (status >= 400) return { ok: false, error: `list_drive_files: ${driveApiError(json, status)}` }
    const files = Array.isArray(json.files) ? (json.files as Array<Record<string, unknown>>) : []
    if (files.length === 0) {
      return {
        ok: true,
        output:
          'No matching files. Note: the drive.file scope only sees files OpenUI created or you explicitly opened with it — not your whole Drive.'
      }
    }
    const lines = files.map((f) => {
      const size = f.size ? ` — ${(Number(f.size) / 1024).toFixed(1)} KB` : ''
      const isFolder = f.mimeType === 'application/vnd.google-apps.folder' ? ' [folder]' : ''
      return `- ${String(f.name ?? '(unnamed)')}${isFolder} (id ${String(f.id ?? '')})${size}`
    })
    return { ok: true, output: `${files.length} Drive file(s):\n${lines.join('\n')}` }
  } catch (e) {
    return { ok: false, error: `list_drive_files failed: ${errText(e)}` }
  }
}

// ── share_drive_file ──────────────────────────────────────────────────────────

async function share_drive_file(args: Record<string, unknown>): Promise<ToolResult> {
  const fileId = typeof args.file_id === 'string' ? args.file_id.trim() : ''
  if (!fileId) return { ok: false, error: 'share_drive_file: "file_id" is required.' }
  const email = typeof args.email === 'string' ? args.email.trim() : ''
  if (!EMAIL_RE.test(email)) {
    return { ok: false, error: 'share_drive_file: a valid "email" address is required.' }
  }
  const role = normalizeShareRole(args.role)
  if (role === null) {
    return { ok: false, error: `share_drive_file: "role" must be one of ${SHARE_ROLES.join(', ')}.` }
  }

  try {
    const { status, json } = await apiJson(
      'POST',
      `/files/${encodeURIComponent(fileId)}/permissions`,
      'sendNotificationEmail=true',
      { type: 'user', role, emailAddress: email }
    )
    if (status >= 400) return { ok: false, error: `share_drive_file: ${driveApiError(json, status)}` }
    return { ok: true, output: `Shared Drive file ${fileId} with ${email} as ${role}.` }
  } catch (e) {
    return { ok: false, error: `share_drive_file failed: ${errText(e)}` }
  }
}

// ── schemas (LLM-facing surface) ─────────────────────────────────────────────

export const driveToolSchemas: ToolSchema[] = [
  {
    name: 'upload_to_drive',
    description:
      'Upload a local file to the user\'s Google Drive and return its file id and link. ' +
      'The app uses the narrow drive.file scope, so it can later see/manage only the files it uploads. ' +
      'Requires Google Drive to be connected in Settings.',
    parameters: {
      type: 'object',
      properties: {
        local_path: { type: 'string', description: 'Path to the existing local file to upload (e.g. "~/Documents/report.pdf").' },
        folder: { type: 'string', description: 'Optional Drive folder id (as shown by list_drive_files) to upload into.' }
      },
      required: ['local_path']
    }
  },
  {
    name: 'export_to_google_doc',
    description:
      'Convert a local document — a .md, .docx, .txt, .html, .rtf, .doc or .odt file — into a REAL, editable Google Doc in the ' +
      'user\'s Drive, and return the document URL. This is the "make it a Google Doc instead of a local .md" output option: it ' +
      'uploads the file with a Google-Docs target type so Drive converts it on the way in (no separate Docs step). ' +
      'Uses the narrow drive.file scope; requires Google Drive to be connected in Settings.',
    parameters: {
      type: 'object',
      properties: {
        local_path: {
          type: 'string',
          description: 'Path to the local summary/document to convert (e.g. "~/OpenUI Research/summary.md" or a .docx).'
        },
        folder: { type: 'string', description: 'Optional Drive folder id (from list_drive_files) to create the Doc in.' }
      },
      required: ['local_path']
    }
  },
  {
    name: 'download_from_drive',
    description:
      'Download a Google Drive file (by id) to a local path inside your home folder. Files up to 100 MB.',
    parameters: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'The Drive file id (as shown by list_drive_files or upload_to_drive).' },
        dest_path: { type: 'string', description: 'Destination path inside your home folder, e.g. "~/Downloads/report.pdf".' }
      },
      required: ['file_id', 'dest_path']
    }
  },
  {
    name: 'list_drive_files',
    description:
      'List Google Drive files this app can access (files it created or the user opened with it — the drive.file scope). ' +
      'Optionally filter by a name substring and/or a parent folder id.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional case-insensitive substring the file name must contain.' },
        folder: { type: 'string', description: 'Optional parent folder id to list the contents of.' }
      },
      required: []
    }
  },
  {
    name: 'share_drive_file',
    description:
      'Grant another person access to a Google Drive file by email. This emails them a notification and gives them ' +
      'standing access, so it always asks for confirmation.',
    parameters: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'The Drive file id to share.' },
        email: { type: 'string', description: 'The email address to share with.' },
        role: { type: 'string', description: 'Access level to grant.', enum: [...SHARE_ROLES] }
      },
      required: ['file_id', 'email', 'role']
    }
  }
]

export const driveRegistry: Record<
  string,
  (args: Record<string, unknown>, context?: ExecutorContext) => Promise<ToolResult>
> = {
  upload_to_drive,
  export_to_google_doc,
  download_from_drive,
  list_drive_files,
  share_drive_file
}

// ── OAuth connect (loopback flow) ─────────────────────────────────────────────

/**
 * Run the desktop loopback OAuth flow for Google Drive: spin a 127.0.0.1 server
 * on an ephemeral port, open the Google consent screen in the system browser,
 * capture the authorization code on the callback, exchange it for tokens, and
 * persist the refresh token. Resolves { ok } — never rejects. electron is
 * imported lazily so this module stays unit-testable without an electron mock.
 */
export async function connectGoogleDrive(): Promise<ToolResult> {
  const cfg = getOAuthConfig()
  if (!cfg) {
    return {
      ok: false,
      error: 'Enter your Google OAuth Client ID and Client Secret in Settings → Google Calendar first.'
    }
  }
  const { shell } = await import('electron')

  return new Promise<ToolResult>((resolve) => {
    let settled = false
    let port = 0
    const finish = (result: ToolResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        server.close()
      } catch {
        /* already closing */
      }
      resolve(result)
    }

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (!url.pathname.startsWith('/callback')) {
        res.writeHead(404)
        res.end()
        return
      }
      const code = url.searchParams.get('code')
      const oauthErr = url.searchParams.get('error')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(
        '<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;background:#0f0f13;' +
          'color:#e2e8f0;text-align:center;padding-top:80px"><h2>Google Drive connected</h2>' +
          '<p>You can close this tab and return to OpenUI.</p></body>'
      )
      if (oauthErr || !code) {
        finish({ ok: false, error: `Google authorization failed: ${oauthErr || 'no code returned'}.` })
        return
      }
      const redirectUri = `http://127.0.0.1:${port}/callback`
      postToken(buildTokenExchangeBody(cfg, code, redirectUri))
        .then((tok) => {
          if (!tok.refresh_token) {
            finish({
              ok: false,
              error:
                'Google did not return a refresh token. Revoke OpenUI at myaccount.google.com/permissions and reconnect.'
            })
            return
          }
          writeSetting(GDRIVE_REFRESH_TOKEN_KEY, tok.refresh_token)
          cachedToken = tok.access_token
            ? { value: tok.access_token, expiresAt: Math.floor(Date.now() / 1000) + (tok.expires_in ?? 3600) }
            : null
          finish({ ok: true, output: 'Google Drive connected.' })
        })
        .catch((e) => finish({ ok: false, error: errText(e) }))
    })

    const timer = setTimeout(
      () => finish({ ok: false, error: 'Timed out waiting for Google authorization.' }),
      CONNECT_TIMEOUT_MS
    )

    server.on('error', (e) => finish({ ok: false, error: `Loopback server failed: ${errText(e)}` }))
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      port = typeof addr === 'object' && addr ? addr.port : 0
      const redirectUri = `http://127.0.0.1:${port}/callback`
      void shell.openExternal(buildAuthUrl(cfg.clientId, redirectUri))
    })
  })
}
