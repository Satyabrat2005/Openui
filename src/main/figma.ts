/**
 * figma.ts — Figma design tools for the OpenUI agent.
 *
 * Inspect:
 *   get_figma_file(file_key)                      — file metadata + page/frame inventory
 *   get_figma_node_details(file_key, node_ids)    — exact geometry, auto-layout, fills, text
 *   get_figma_components(file_key)                — published component + style inventory
 *   list_figma_comments(file_key)                 — existing review threads
 *
 * Extract:
 *   get_figma_design_system(file_key)             — the real colour/type/spacing/shadow system
 *   export_figma_tokens(file_key, format)         — that system as CSS / SCSS / JSON / Tailwind / TS
 *
 * Review & build:
 *   export_figma_frames(file_key, node_ids?)      — render + Claude Vision design review
 *   figma_frame_to_code(file_key, node_id)        — frame → production HTML/CSS or React
 *
 * Comment:
 *   create_figma_comment(file_key, message, …)    — post feedback back into Figma
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WRITE ACCESS — READ THIS BEFORE ADDING A "CREATE DESIGN" TOOL
 *
 * The Figma REST API is read-only for file CONTENT. There is no endpoint that
 * creates or edits frames, layers, styles, components or variables. The only
 * write endpoints are comments (used below) and a few org/webhook admin routes.
 * Authoring inside a Figma file requires code running INSIDE Figma — a Plugin
 * or Widget against the `figma.*` scene-graph API — which is a separate
 * artifact that ships through Figma's plugin system, not something this
 * process can do over HTTPS.
 *
 * So the strategy here is deliberately the other direction: pull the design
 * out with full fidelity and generate real front-end code from it. Anything
 * claiming to "create a Figma design" from this file would be fabricating.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Authenticated with a per-user personal access token supplied in Settings →
 * Figma (falling back to the FIGMA_TOKEN env var for local dev). A Figma PAT is
 * an inherently user-owned credential, so — unlike OUR shared LLM keys — the
 * right fix is a Settings field, not a proxy. Vision analysis runs through the
 * `chat-proxy` Edge Function so OUR Anthropic key stays server-side.
 *
 * SECURITY:
 *   - file_key validated against FILE_KEY_RE before any API call.
 *   - node_ids list bounded + each ID validated against NODE_ID_RE.
 *   - API responses are capped to prevent context flooding.
 *   - Image downloads are HTTPS-only with a size cap and redirect limit.
 *   - The Figma token stays in the main process — never crosses the contextBridge.
 */

import { request as httpsRequest } from 'node:https'
import { join } from 'node:path'
import { shell } from 'electron'
import type { ExecutorContext, ToolResult, ToolSchema } from './tools'
import { database } from './database'
import { callChatProxyText } from './edgeFunctions'
import { writeSandboxFile, getWorkspaceDir } from './sandbox'
import type {
  FigmaCommentsResponse,
  FigmaFileResponse,
  FigmaImagesResponse,
  FigmaNode,
  FigmaNodesResponse,
  FigmaStyleMeta,
  FigmaVariablesResponse
} from './figmaTypes'
import {
  buildVariableIndex,
  emitTokens,
  emptyVariableIndex,
  extractDesignSystem,
  figmaColorToHex,
  summarizeDesignSystem,
  FORMAT_EXTENSION,
  type TokenFormat,
  type VariableIndex
} from './figmaDesignSystem'

// Figma file keys are base64url strings embedded in figma.com/file/{key}/…
const FILE_KEY_RE = /^[A-Za-z0-9_-]{4,256}$/

// Figma node IDs: "PARENT_ID:LOCAL_ID" — both parts are non-negative integers.
const NODE_ID_RE = /^\d+:\d+$/

// Caps to avoid context flooding / runaway Vision API calls.
const MAX_FILE_SUMMARY_CHARS = 6_000
const MAX_FRAMES = 3          // max frames analysed per export_figma_frames call
const MAX_DETAIL_NODES = 5    // max nodes inspected per get_figma_node_details call
const MAX_COMMENT_CHARS = 10_000
const MAX_SPEC_CHARS = 24_000 // node-tree spec handed to the code generator
const MAX_SPEC_DEPTH = 12
const MAX_SPEC_NODES = 400

// Settings key under which the user's Figma personal access token is stored
// (via Settings → Figma). Keep in sync with the renderer's SettingsModal.
export const FIGMA_TOKEN_SETTING_KEY = 'figma_token'

// Hard cap on how many bytes a single frame PNG may be.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024 // 10 MB

// ── Figma REST API helper ─────────────────────────────────────────────────────

/**
 * Resolve the Figma personal access token. A Figma PAT is a per-user credential
 * (unlike OUR shared, server-side LLM keys), so the user supplies their OWN in
 * Settings → Figma; the FIGMA_TOKEN env var remains a local-dev fallback.
 */
export function getFigmaToken(): string {
  // The settings read can throw — the DB isn't initialised yet during early
  // startup, and can fail outright on a corrupt file. The env-var fallback below
  // is documented to work regardless, so a storage failure has to degrade into
  // it rather than propagate: otherwise the caller gets an opaque "[db] Database
  // not initialized" instead of the actionable "configure a token" message, and
  // FIGMA_TOKEN silently stops working. Mirrors getToken() in github.ts.
  try {
    const stored = database.settings.getSetting(FIGMA_TOKEN_SETTING_KEY)
    if (typeof stored === 'string' && stored.trim()) return stored.trim()
  } catch {
    // Fall through to the environment variable.
  }
  return process.env.FIGMA_TOKEN?.trim() ?? ''
}

// ── retry policy ──────────────────────────────────────────────────────────────
//
// Two failure modes are worth retrying, and they are worth retrying differently:
//
//   429 rate limit — Figma enforces per-token limits, and a multi-frame export
//     or a design-system extraction on a large file can hit one in ordinary use.
//     The server tells us how long to wait via Retry-After, so we honour it
//     (capped, so a hostile or absurd header can't hang the agent) and retry.
//
//   Network-level errors — a dropped connection is transient and independent of
//     what we asked for. Retrying costs one round trip and saves a whole
//     multi-frame export whose earlier frames already downloaded.
//
// HTTP 4xx (other than 429) is deliberately NOT retried: a bad file key or a
// token without access will fail identically the second time.

const MAX_RETRY_AFTER_MS = 10_000 // cap on an honoured Retry-After header
const DEFAULT_RATE_LIMIT_WAIT_MS = 2_000 // used when 429 carries no Retry-After
const NETWORK_RETRY_ATTEMPTS = 2 // total attempts, not extra ones
const NETWORK_RETRY_BACKOFF_MS = 250

const sleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, ms))

/** Marker for a network-level (not HTTP-level) failure, so only those retry. */
class NetworkError extends Error {}

/**
 * Parse a Retry-After header. Figma sends delta-seconds; the HTTP spec also
 * permits an HTTP-date, so both are handled. Returns null when it is absent or
 * unparseable, letting the caller fall back to a default wait.
 */
export function parseRetryAfterMs(header: string | string[] | undefined): number | null {
  const raw = Array.isArray(header) ? header[0] : header
  if (typeof raw !== 'string' || !raw.trim()) return null

  const seconds = Number(raw.trim())
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)

  const when = Date.parse(raw)
  if (Number.isFinite(when)) return Math.max(0, when - Date.now())

  return null
}

/** One attempt at a Figma API request. Rejects with NetworkError on socket failures. */
function figmaFetchOnce(
  path: string,
  method: 'GET' | 'POST',
  token: string,
  bodyStr: string | undefined
): Promise<{ status: number; raw: string; retryAfterMs: number | null }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: 'api.figma.com',
        port: 443,
        path,
        method,
        headers: {
          'X-Figma-Token': token,
          Accept: 'application/json',
          'User-Agent': 'OpenUI/1.0',
          ...(bodyStr
            ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(bodyStr)
              }
            : {})
        }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 200,
            raw: Buffer.concat(chunks).toString('utf8'),
            retryAfterMs: parseRetryAfterMs(res.headers?.['retry-after'])
          })
        })
        res.on('error', (err: Error) => reject(new NetworkError(err.message)))
      }
    )
    req.on('error', (err: Error) => reject(new NetworkError(err.message)))
    if (bodyStr) req.write(bodyStr)
    req.end()
  })
}

/**
 * Make an authenticated GET or POST request to api.figma.com and return the
 * parsed JSON body.  Throws a descriptive Error on HTTP-level or API-level
 * failures so callers can surface the message without crashing.
 *
 * Retries once on 429 (honouring Retry-After) and once on a network-level
 * error — see the retry-policy note above.
 */
async function figmaFetch(
  path: string,
  method: 'GET' | 'POST' = 'GET',
  body?: unknown
): Promise<unknown> {
  const token = getFigmaToken()
  if (!token) {
    throw new Error(
      'No Figma token configured. Open Settings → Figma and paste a personal ' +
        'access token (figma.com → Settings → Security → Personal access tokens), ' +
        'or set the FIGMA_TOKEN environment variable.'
    )
  }

  const bodyStr = body != null ? JSON.stringify(body) : undefined
  let rateLimitRetried = false
  let networkAttempts = 0

  while (true) {
    let result: { status: number; raw: string; retryAfterMs: number | null }
    try {
      result = await figmaFetchOnce(path, method, token, bodyStr)
      networkAttempts += 1
    } catch (err) {
      networkAttempts += 1
      if (err instanceof NetworkError && networkAttempts < NETWORK_RETRY_ATTEMPTS) {
        await sleep(NETWORK_RETRY_BACKOFF_MS)
        continue
      }
      throw err instanceof NetworkError
        ? new Error(`Figma API request failed: ${err.message}`)
        : err
    }

    const { status, raw, retryAfterMs } = result

    if (status === 429 && !rateLimitRetried) {
      rateLimitRetried = true
      await sleep(Math.min(retryAfterMs ?? DEFAULT_RATE_LIMIT_WAIT_MS, MAX_RETRY_AFTER_MS))
      continue
    }

    if (status === 429) {
      throw new Error(
        'Figma API HTTP 429: rate limited. The request was retried once and still ' +
          'hit the limit — wait a minute before trying again, or reduce how many ' +
          'frames/files are being processed at once.'
      )
    }

    if (status >= 400) {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>
        throw new Error(
          `Figma API HTTP ${status}: ` + String(parsed.err ?? parsed.message ?? raw.slice(0, 200))
        )
      } catch (parseErr) {
        // Re-throw the descriptive error built above; only a JSON.parse failure
        // should fall through to the raw-body form.
        if (parseErr instanceof Error && parseErr.message.startsWith('Figma API HTTP')) throw parseErr
        throw new Error(`Figma API HTTP ${status}: ${raw.slice(0, 200)}`)
      }
    }

    try {
      return JSON.parse(raw)
    } catch {
      throw new Error(`Figma API returned non-JSON: ${raw.slice(0, 200)}`)
    }
  }
}

// ── whole-file cache ──────────────────────────────────────────────────────────
//
// get_figma_design_system, export_figma_tokens and figma_frame_to_code all need
// the same thing: the file, walked for its design values. In a normal session an
// agent calls two or three of them against one file_key within a minute, and
// each was re-fetching the entire document — the single most expensive request
// this module makes, and the one most likely to trip the rate limit above.
//
// This is a PERFORMANCE cache and nothing more. It lives in module memory, dies
// with the process, and has a short TTL, so a re-run after a design change picks
// up the new version rather than serving something stale for the session.

const FILE_CACHE_TTL_MS = 3 * 60 * 1000

/** A variable lookup plus, when it failed, why — see fetchLocalVariables. */
interface VariablesResult {
  index: VariableIndex
  note: string | null
}

interface CachedFile {
  data: FigmaFileResponse
  /** Depth the entry was fetched at; Infinity for an uncapped (full) fetch. */
  depth: number
  expiresAt: number
}

const fileCache = new Map<string, CachedFile>()

/** Same TTL, same rationale — see fetchLocalVariables. */
const variablesCache = new Map<string, { value: VariablesResult; expiresAt: number }>()

/** Drop every cached file. Exported for tests; nothing in the app needs it. */
export function clearFigmaFileCache(): void {
  fileCache.clear()
  variablesCache.clear()
}

/**
 * Fetch a whole file, reusing a recent response when one is available.
 *
 * `depth` is the Figma `depth` query param — omit it for the full document.
 * A cached entry only satisfies a request whose depth is no DEEPER than the
 * entry's, because a depth=4 response genuinely lacks nodes a full walk needs.
 * Serving one to extractDesignSystem would silently shrink the design system,
 * which is exactly the kind of quiet wrongness a cache must not introduce.
 */
async function fetchFileCached(fileKey: string, depth?: number): Promise<FigmaFileResponse> {
  const wanted = depth ?? Infinity
  const now = Date.now()

  const hit = fileCache.get(fileKey)
  if (hit && hit.expiresAt > now && hit.depth >= wanted) return hit.data

  const query = depth === undefined ? '' : `?depth=${depth}`
  const data = (await figmaFetch(
    `/v1/files/${encodeURIComponent(fileKey)}${query}`
  )) as FigmaFileResponse

  // Don't let a shallower fetch evict a deeper, still-valid entry.
  if (!hit || hit.expiresAt <= now || wanted >= hit.depth) {
    fileCache.set(fileKey, { data, depth: wanted, expiresAt: now + FILE_CACHE_TTL_MS })
  }
  return data
}

/** One download attempt. Rejects with NetworkError on socket failures only. */
function downloadBufferOnce(url: string, redirectDepth: number): Promise<Buffer> {
  if (redirectDepth > 5) {
    return Promise.reject(new Error('Too many redirects while downloading image.'))
  }
  if (!url.startsWith('https://')) {
    return Promise.reject(
      new Error(`downloadBuffer: only https:// URLs accepted (got "${url.slice(0, 80)}…")`)
    )
  }

  return new Promise<Buffer>((resolve, reject) => {
    const req = httpsRequest(url, (res) => {
      const status = res.statusCode ?? 200
      if (status >= 300 && status < 400 && res.headers.location) {
        // A redirect restarts the retry budget for the new URL, which is fine:
        // the redirect chain itself is bounded by redirectDepth.
        downloadBuffer(res.headers.location, redirectDepth + 1).then(resolve).catch(reject)
        return
      }
      if (status >= 400) {
        reject(new Error(`Image download failed with HTTP ${status}.`))
        return
      }
      const chunks: Buffer[] = []
      let totalBytes = 0
      res.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length
        if (totalBytes > MAX_IMAGE_BYTES) {
          req.destroy()
          reject(
            new Error(
              `Image exceeds the ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB download cap.`
            )
          )
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', (err: Error) => reject(new NetworkError(err.message)))
    })
    req.on('error', (err: Error) => reject(new NetworkError(err.message)))
    req.end()
  })
}

/**
 * Download a PNG buffer from an HTTPS URL, following up to 5 redirects.
 * Throws if the response exceeds MAX_IMAGE_BYTES or if the URL is non-HTTPS.
 *
 * Retries a network-level failure once: in a multi-frame export, one dropped
 * connection should not discard the frames that already downloaded.
 */
async function downloadBuffer(url: string, redirectDepth = 0): Promise<Buffer> {
  let lastErr: unknown
  for (let attempt = 0; attempt < NETWORK_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await downloadBufferOnce(url, redirectDepth)
    } catch (err) {
      lastErr = err
      // Only socket failures are transient. An HTTP 4xx, an oversized image or a
      // non-HTTPS URL will fail identically on a second attempt.
      if (!(err instanceof NetworkError)) throw err
      if (attempt < NETWORK_RETRY_ATTEMPTS - 1) await sleep(NETWORK_RETRY_BACKOFF_MS)
    }
  }
  throw new Error(
    `Image download failed: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`
  )
}

// ── shared validation ─────────────────────────────────────────────────────────

/** Validate a file key, returning an error ToolResult or null when it's fine. */
function badFileKey(tool: string, fileKey: string): ToolResult | null {
  if (!fileKey) return { ok: false, error: `${tool} requires a string "file_key".` }
  if (!FILE_KEY_RE.test(fileKey)) {
    return {
      ok: false,
      error:
        `${tool}: invalid file_key "${fileKey}". ` +
        'The file key is the alphanumeric string in the Figma URL: figma.com/file/{file_key}/…'
    }
  }
  return null
}

/**
 * Parse + validate a comma-separated node-id list, capped to `limit`.
 * Returns the ids, or an error ToolResult when any id is malformed.
 */
function parseNodeIds(
  tool: string,
  raw: string,
  limit: number
): { ids: string[] } | { error: ToolResult } {
  const ids = raw
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)

  for (const id of ids) {
    if (!NODE_ID_RE.test(id)) {
      return {
        error: {
          ok: false,
          error: `${tool}: invalid node_id "${id}". Expected "PARENT:LOCAL" format, e.g. "1:2".`
        }
      }
    }
  }
  return { ids: ids.slice(0, limit) }
}

/** The proxy clamps this to the caller's real entitlement; this is only a hint. */
function visionModelKey(context?: ExecutorContext): string {
  return context?.tier === 'enterprise' ? 'enterprise-default' : 'pro-default'
}

/** Wrap a tool body so any thrown error becomes a ToolResult, never a crash. */
async function guard(tool: string, fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn()
  } catch (err) {
    return { ok: false, error: `${tool} failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

// ── Document tree helpers ─────────────────────────────────────────────────────

interface FigmaFrame {
  id: string
  name: string
  page: string
  /** Enclosing Section name, when the frame lives inside one. */
  section?: string
}

/** Node types that count as a top-level frame in the inventory. */
function isFrameLike(node: FigmaNode): boolean {
  return node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'COMPONENT_SET'
}

/**
 * How many levels of SECTION nesting to descend through. Sections can contain
 * sections, but a canvas nested more than a couple deep is pathological, and an
 * unbounded walk here would re-implement the whole-document scan this function
 * exists to avoid.
 */
const MAX_SECTION_DEPTH = 3

/**
 * Walk a Figma document node and collect the top-level FRAME / COMPONENT nodes
 * of every page.
 *
 * SECTIONS: a page's direct children are not always frames. Figma's Section
 * feature groups frames on the canvas, so a sectioned page's children are
 * SECTION nodes with the real frames one level inside. Treating those as "not a
 * frame" reported zero frames for any file organised that way, which is now the
 * common case — so we descend through sections (bounded by MAX_SECTION_DEPTH)
 * and collect the frames within, tagged with the section they came from.
 *
 * This is why callers fetch at depth=3 rather than depth=2: depth=2 stops at the
 * SECTION nodes themselves and never returns their children.
 */
export function collectFrames(document: FigmaNode | undefined): FigmaFrame[] {
  const frames: FigmaFrame[] = []
  if (!document || !Array.isArray(document.children)) return frames

  const collect = (
    nodes: FigmaNode[],
    pageName: string,
    sectionName: string | undefined,
    depth: number
  ): void => {
    for (const child of nodes) {
      if (isFrameLike(child)) {
        frames.push({
          id: String(child.id ?? ''),
          name: typeof child.name === 'string' ? child.name : 'Unnamed Frame',
          page: pageName,
          ...(sectionName ? { section: sectionName } : {})
        })
      } else if (child.type === 'SECTION' && depth < MAX_SECTION_DEPTH && Array.isArray(child.children)) {
        const name = typeof child.name === 'string' ? child.name : 'Unnamed Section'
        collect(child.children, pageName, sectionName ? `${sectionName} / ${name}` : name, depth + 1)
      }
    }
  }

  for (const page of document.children) {
    const pageName = typeof page.name === 'string' ? page.name : 'Unknown Page'
    if (!Array.isArray(page.children)) continue
    collect(page.children, pageName, undefined, 0)
  }
  return frames
}

/** First visible solid fill of a node, as hex — or null when it has none. */
function primaryFill(node: FigmaNode): string | null {
  for (const paint of node.fills ?? []) {
    if (paint.visible === false) continue
    if (paint.color) return figmaColorToHex(paint.color, paint.opacity ?? 1)
  }
  return null
}

/**
 * Render a node subtree as an indented, human- and LLM-readable spec.
 *
 * This is what makes generated code faithful rather than approximate: it
 * carries the EXACT numbers (bounds, auto-layout direction, gap, padding,
 * radius, hex fills, font size/weight, and the literal text content) instead of
 * asking a model to eyeball them off a screenshot. The rendered PNG still goes
 * along for visual context, but the geometry here is ground truth.
 */
export function describeNodeTree(root: FigmaNode, maxDepth = MAX_SPEC_DEPTH): string {
  const lines: string[] = []
  let count = 0

  const walk = (node: FigmaNode, depth: number): void => {
    if (count >= MAX_SPEC_NODES || depth > maxDepth) return
    if (node.visible === false) return
    count += 1

    const pad = '  '.repeat(depth)
    const box = node.absoluteBoundingBox
    const parts: string[] = [`${node.type ?? 'NODE'} "${node.name ?? ''}"`]

    if (box && typeof box.width === 'number' && typeof box.height === 'number') {
      parts.push(`${Math.round(box.width)}×${Math.round(box.height)}`)
    }

    if (node.layoutMode && node.layoutMode !== 'NONE') {
      const dir = node.layoutMode === 'HORIZONTAL' ? 'row' : 'column'
      const padding = [
        node.paddingTop ?? 0,
        node.paddingRight ?? 0,
        node.paddingBottom ?? 0,
        node.paddingLeft ?? 0
      ]
      parts.push(
        `autolayout:${dir}`,
        `gap:${Math.round(node.itemSpacing ?? 0)}`,
        `padding:${padding.map(Math.round).join('/')}`
      )
      if (node.primaryAxisAlignItems) parts.push(`justify:${node.primaryAxisAlignItems}`)
      if (node.counterAxisAlignItems) parts.push(`align:${node.counterAxisAlignItems}`)
      // A wrapping auto-layout frame is `flex-wrap: wrap`. Without this the
      // generator emits a single non-wrapping row, which looks right at the
      // frame's own width and breaks at every other one.
      if (node.layoutWrap === 'WRAP') {
        parts.push('wrap')
        if (typeof node.counterAxisSpacing === 'number') {
          parts.push(`row-gap:${Math.round(node.counterAxisSpacing)}`)
        }
      }
    }

    // Set on the CHILD: this node is parented to an auto-layout frame but opts
    // out of its flow — a badge or overlay pinned over the stack. Reported for
    // every node with the flag, since the parent may be out of spec range.
    if (node.layoutPositioning === 'ABSOLUTE') parts.push('position:absolute')

    const fill = primaryFill(node)
    if (fill) parts.push(`fill:${fill}`)

    if (typeof node.cornerRadius === 'number' && node.cornerRadius > 0) {
      parts.push(`radius:${Math.round(node.cornerRadius)}`)
    } else if (node.rectangleCornerRadii?.some((r) => r > 0)) {
      parts.push(`radius:${node.rectangleCornerRadii.map(Math.round).join('/')}`)
    }

    if (node.strokes?.length && typeof node.strokeWeight === 'number' && node.strokeWeight > 0) {
      const strokeColor = node.strokes.find((s) => s.color)?.color
      parts.push(`border:${node.strokeWeight}px ${strokeColor ? figmaColorToHex(strokeColor) : ''}`)
    }

    if (node.effects?.length) {
      const shadows = node.effects.filter((e) => e.visible !== false && e.type?.includes('SHADOW'))
      if (shadows.length) parts.push(`shadows:${shadows.length}`)
    }

    if (typeof node.opacity === 'number' && node.opacity < 1) {
      parts.push(`opacity:${node.opacity.toFixed(2)}`)
    }

    if (node.type === 'TEXT') {
      const s = node.style
      if (s) {
        parts.push(
          `font:${s.fontFamily ?? '?'} ${Math.round(s.fontSize ?? 0)}px/${s.fontWeight ?? 400}` +
            (s.lineHeightPx ? ` lh:${Math.round(s.lineHeightPx)}` : '')
        )
        if (s.textAlignHorizontal && s.textAlignHorizontal !== 'LEFT') {
          parts.push(`text-align:${s.textAlignHorizontal.toLowerCase()}`)
        }
      }
      // The literal copy matters — generated markup should say what the design
      // says, not lorem ipsum the model invented.
      const text = (node.characters ?? '').replace(/\s+/g, ' ').trim()
      if (text) parts.push(`text: ${JSON.stringify(text.slice(0, 200))}`)
    }

    lines.push(`${pad}- ${parts.join('  ')}`)
    for (const child of node.children ?? []) walk(child, depth + 1)
  }

  walk(root, 0)
  if (count >= MAX_SPEC_NODES) {
    lines.push(`  … (truncated at ${MAX_SPEC_NODES} nodes — spec covers the top of the tree)`)
  }
  return lines.join('\n').slice(0, MAX_SPEC_CHARS)
}

/**
 * Fetch a file's local Figma Variables and index them by value.
 *
 * Returns an EMPTY index rather than throwing when the endpoint is unavailable.
 * That is the common case, not an error: /v1/files/{key}/variables/local
 * requires both the `file_variables:read` token scope and an Enterprise-plan
 * file, so most tokens get a 403 here. Variables are an enrichment — better
 * token names — and a design system extracted without them is still correct,
 * so a failure must degrade rather than take the whole tool call down.
 *
 * The reason is returned alongside so callers can tell the user WHY names are
 * missing instead of silently producing `--color-3`.
 */
async function fetchLocalVariables(fileKey: string): Promise<VariablesResult> {
  const now = Date.now()
  const hit = variablesCache.get(fileKey)
  if (hit && hit.expiresAt > now) return hit.value

  const remember = (value: VariablesResult): VariablesResult => {
    // Cache failures too — a 403 will still be a 403 in thirty seconds, and
    // three tools re-asking would cost three pointless round trips.
    variablesCache.set(fileKey, { value, expiresAt: Date.now() + FILE_CACHE_TTL_MS })
    return value
  }

  try {
    const data = (await figmaFetch(
      `/v1/files/${encodeURIComponent(fileKey)}/variables/local`
    )) as FigmaVariablesResponse
    return remember({ index: buildVariableIndex(data), note: null })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // 403 here means scope/plan, not a bad file — say so, because "no variables
    // found" would send the user looking in the wrong place.
    if (message.includes('403')) {
      return remember({
        index: emptyVariableIndex(),
        note:
          'Figma Variables were not readable (HTTP 403). The /variables/local endpoint needs a ' +
          'token with the "file_variables:read" scope on an Enterprise-plan file. Token names ' +
          'below come from published Styles and raw values only.'
      })
    }
    return remember({
      index: emptyVariableIndex(),
      note: `Figma Variables were not readable (${message.slice(0, 160)}).`
    })
  }
}

/** Fetch one node's full subtree via /v1/files/{key}/nodes. */
async function fetchNode(fileKey: string, nodeId: string): Promise<FigmaNode | null> {
  const data = (await figmaFetch(
    `/v1/files/${encodeURIComponent(fileKey)}/nodes?ids=${encodeURIComponent(nodeId)}`
  )) as FigmaNodesResponse
  return data.nodes?.[nodeId]?.document ?? null
}

// ── icon (SVG) extraction ─────────────────────────────────────────────────────
//
// A rasterised icon is the one part of frame-to-code that CANNOT come out right.
// The spec renderer describes a VECTOR as a box with a fill, and the PNG shows
// the model a 24×24 smudge, so the generator approximates: a unicode glyph, a
// CSS triangle, an emoji, a div with a border-radius. Fetching the real SVG and
// handing it over as markup turns "something icon-shaped" into the actual icon.

/** Node types that are vector geometry with no text or nested layout. */
const VECTOR_LEAF_TYPES = new Set([
  'VECTOR',
  'BOOLEAN_OPERATION',
  'ELLIPSE',
  'LINE',
  'POLYGON',
  'STAR',
  'RECTANGLE'
])

/** Containers that may wrap vector geometry to form one icon. */
const VECTOR_CONTAINER_TYPES = new Set(['GROUP', 'FRAME', 'COMPONENT', 'INSTANCE'])

/** Beyond this, a box of shapes is a layout, not an icon — export it as PNG. */
const MAX_ICON_DIMENSION = 128
const MAX_SVG_ICONS = 8
const MAX_SVG_CHARS = 4_000 // per icon; a bloated one is not worth the context

/**
 * Is this node an icon — i.e. pure vector geometry, small enough to be one?
 *
 * The container case matters: designers almost never leave a bare VECTOR on the
 * canvas, they leave a 24×24 frame or component named "icon/search" containing
 * a few paths. Exporting each path separately would yield fragments that have
 * lost their arrangement, so we export the highest node whose whole subtree is
 * vector geometry. The size cap is what stops a card made of rectangles from
 * being mistaken for an icon.
 */
function isIconNode(node: FigmaNode): boolean {
  if (node.visible === false) return false

  const box = node.absoluteBoundingBox
  if (box && ((box.width ?? 0) > MAX_ICON_DIMENSION || (box.height ?? 0) > MAX_ICON_DIMENSION)) {
    return false
  }

  if (VECTOR_LEAF_TYPES.has(node.type ?? '')) return true

  if (VECTOR_CONTAINER_TYPES.has(node.type ?? '')) {
    const children = (node.children ?? []).filter((c) => c.visible !== false)
    if (children.length === 0) return false
    return children.every(isIconNode)
  }

  return false
}

/**
 * Find the icon roots in a subtree, outermost first.
 *
 * Descent stops at each icon so its inner paths aren't also queued — one export
 * per icon, not one per path. The frame itself is never treated as an icon; the
 * caller wants the icons INSIDE what it asked for.
 */
export function collectIconNodes(root: FigmaNode, cap = MAX_SVG_ICONS): FigmaNode[] {
  const found: FigmaNode[] = []

  const walk = (node: FigmaNode, isRoot: boolean): void => {
    if (found.length >= cap) return
    if (node.visible === false) return

    if (!isRoot && node.id && isIconNode(node)) {
      found.push(node)
      return
    }
    for (const child of node.children ?? []) walk(child, false)
  }

  walk(root, true)
  return found
}

/**
 * Export a frame's icons as real SVG markup.
 *
 * Best-effort throughout: any failure just means the generator falls back to
 * approximating from the PNG, which is what it did before. Never throws.
 */
async function fetchIconSvgs(
  fileKey: string,
  root: FigmaNode
): Promise<{ name: string; svg: string }[]> {
  const icons = collectIconNodes(root)
  if (icons.length === 0) return []

  try {
    const ids = icons.map((n) => String(n.id)).filter((id) => NODE_ID_RE.test(id))
    if (ids.length === 0) return []

    // scale is meaningless for SVG, but the endpoint wants the param.
    const urls = await fetchImageUrls(fileKey, ids, 'svg', 1)

    const results = await Promise.all(
      icons.map(async (node) => {
        const url = urls[String(node.id)]
        if (!url) return null
        try {
          const buf = await downloadBuffer(url)
          const svg = buf.toString('utf8').trim()
          if (!svg.startsWith('<svg') || svg.length > MAX_SVG_CHARS) return null
          return { name: node.name ?? String(node.id), svg }
        } catch {
          return null
        }
      })
    )

    return results.filter((r): r is { name: string; svg: string } => r !== null)
  } catch {
    return []
  }
}

/** Render nodes to image URLs via /v1/images. */
async function fetchImageUrls(
  fileKey: string,
  nodeIds: string[],
  format: string,
  scale: number
): Promise<Record<string, string | null>> {
  // Node IDs contain ":" which is allowed unencoded in URL query values.
  const idsParam = nodeIds.join(',')
  const data = (await figmaFetch(
    `/v1/images/${encodeURIComponent(fileKey)}?ids=${idsParam}&format=${format}&scale=${scale}`
  )) as FigmaImagesResponse

  if (data.err) throw new Error(`Figma Images API error: ${String(data.err)}`)
  return data.images ?? {}
}

// ── tool implementations ──────────────────────────────────────────────────────

/**
 * Fetch a Figma file's name, last-modified date, page list and the complete
 * inventory of top-level frames.  Call this first so the agent knows which node
 * IDs to pass to the other tools.
 */
export async function get_figma_file(args: Record<string, unknown>): Promise<ToolResult> {
  const fileKey = typeof args.file_key === 'string' ? args.file_key.trim() : ''
  const invalid = badFileKey('get_figma_file', fileKey)
  if (invalid) return invalid

  return guard('get_figma_file', async () => {
    // depth=3 returns Document → Pages → page children → their children. The
    // third level is what makes frames inside a SECTION visible; depth=2 stops
    // at the section itself and reports an empty file. Still a small payload —
    // it is three levels of containers, not the whole scene graph.
    const data = (await figmaFetch(
      `/v1/files/${encodeURIComponent(fileKey)}?depth=3`
    )) as FigmaFileResponse

    const fileName = typeof data.name === 'string' ? data.name : '(unnamed)'
    const lastModified = typeof data.lastModified === 'string' ? data.lastModified : 'unknown'
    const frames = collectFrames(data.document)
    const pages = (data.document?.children ?? []).map((p) => p.name ?? 'Unnamed').filter(Boolean)

    const frameLines = frames
      .slice(0, 50)
      .map(
        (f) =>
          `  - "${f.name}" (id: ${f.id}, page: ${f.page}${f.section ? `, section: ${f.section}` : ''})`
      )
      .join('\n')

    const summary = [
      `Figma file: "${fileName}"`,
      `Last modified: ${lastModified}`,
      `Editor: ${data.editorType ?? 'unknown'}`,
      `Pages (${pages.length}): ${pages.slice(0, 20).join(', ') || '(none)'}`,
      `Published components: ${Object.keys(data.components ?? {}).length}`,
      `Published styles: ${Object.keys(data.styles ?? {}).length}`,
      `Top-level frames: ${frames.length}${frames.length > 50 ? ' (first 50 shown)' : ''}`,
      '',
      'Frames:',
      frameLines || '  (no frames found — file may be empty or use a non-standard structure)',
      '',
      'Next: get_figma_design_system for the colour/type/spacing system, ' +
        'get_figma_node_details for exact geometry, or figma_frame_to_code to build a frame.'
    ].join('\n')

    return { ok: true, output: summary.slice(0, MAX_FILE_SUMMARY_CHARS) }
  })
}

/**
 * Deep-inspect specific nodes: exact bounds, auto-layout config, fills, borders,
 * radii, shadows, and text content/styling for every descendant.
 *
 * This is the tool to reach for when "make it match the design" needs real
 * numbers — it reports what the file says rather than what a render looks like.
 */
export async function get_figma_node_details(args: Record<string, unknown>): Promise<ToolResult> {
  const fileKey = typeof args.file_key === 'string' ? args.file_key.trim() : ''
  const rawNodeIds = typeof args.node_ids === 'string' ? args.node_ids.trim() : ''

  const invalid = badFileKey('get_figma_node_details', fileKey)
  if (invalid) return invalid
  if (!rawNodeIds) {
    return {
      ok: false,
      error:
        'get_figma_node_details requires "node_ids" (comma-separated, e.g. "1:2,1:3"). ' +
        'Get IDs from get_figma_file.'
    }
  }

  const parsed = parseNodeIds('get_figma_node_details', rawNodeIds, MAX_DETAIL_NODES)
  if ('error' in parsed) return parsed.error

  return guard('get_figma_node_details', async () => {
    const idsParam = parsed.ids.join(',')
    const data = (await figmaFetch(
      `/v1/files/${encodeURIComponent(fileKey)}/nodes?ids=${idsParam}`
    )) as FigmaNodesResponse

    const sections: string[] = []
    for (const id of parsed.ids) {
      const doc = data.nodes?.[id]?.document
      if (!doc) {
        sections.push(`=== Node ${id} ===\n(not found — check the id, or it may be on a page you can't access)`)
        continue
      }
      sections.push(`=== Node ${id} — "${doc.name ?? ''}" ===\n${describeNodeTree(doc)}`)
    }

    return { ok: true, output: sections.join('\n\n') || 'No nodes returned.' }
  })
}

/**
 * List a file's published components, component sets and styles — the
 * reusable vocabulary of the design system.
 */
export async function get_figma_components(args: Record<string, unknown>): Promise<ToolResult> {
  const fileKey = typeof args.file_key === 'string' ? args.file_key.trim() : ''
  const invalid = badFileKey('get_figma_components', fileKey)
  if (invalid) return invalid

  return guard('get_figma_components', async () => {
    // depth=1 — we only need the top-level `components`/`styles` maps, which the
    // API returns alongside the document regardless of how deep we ask for.
    const data = (await figmaFetch(
      `/v1/files/${encodeURIComponent(fileKey)}?depth=1`
    )) as FigmaFileResponse

    const components = Object.entries(data.components ?? {})
    const sets = Object.entries(data.componentSets ?? {})
    const styles = Object.entries(data.styles ?? {})

    const byType = (t: string): [string, FigmaStyleMeta][] =>
      styles.filter(([, s]) => s.styleType === t)

    const out: string[] = [
      `Figma file: "${data.name ?? '(unnamed)'}"`,
      '',
      `COMPONENT SETS (${sets.length}):`,
      ...sets.slice(0, 40).map(([, s]) => `  - "${s.name ?? ''}"${s.description ? ` — ${s.description.slice(0, 100)}` : ''}`),
      '',
      `COMPONENTS (${components.length}):`,
      ...components
        .slice(0, 60)
        .map(([id, c]) => `  - "${c.name ?? ''}" (id: ${id})${c.description ? ` — ${c.description.slice(0, 80)}` : ''}`),
      '',
      `STYLES (${styles.length}) — colour: ${byType('FILL').length}, text: ${byType('TEXT').length}, effect: ${byType('EFFECT').length}, grid: ${byType('GRID').length}:`,
      ...styles.slice(0, 60).map(([, s]) => `  - [${s.styleType ?? '?'}] "${s.name ?? ''}"`)
    ]

    if (components.length === 0 && styles.length === 0) {
      out.push(
        '',
        'No published components or styles. This file may use local (unpublished) styles — ' +
          'get_figma_design_system still extracts the real values by walking the document.'
      )
    }

    return { ok: true, output: out.join('\n').slice(0, MAX_FILE_SUMMARY_CHARS * 2) }
  })
}

/**
 * Extract the file's actual design system — every colour, type style, spacing
 * step, radius and shadow it uses, ranked by how often it's used, with a WCAG
 * contrast check on the palette extremes.
 */
export async function get_figma_design_system(args: Record<string, unknown>): Promise<ToolResult> {
  const fileKey = typeof args.file_key === 'string' ? args.file_key.trim() : ''
  const invalid = badFileKey('get_figma_design_system', fileKey)
  if (invalid) return invalid

  return guard('get_figma_design_system', async () => {
    // No depth cap here: the whole point is to see every value the design uses,
    // and extractDesignSystem has its own node/depth guards for pathological files.
    // Variables are fetched alongside the document: a file that defines its
    // system in Variables has an empty `styles` map, and without this its real
    // token names never appear. Failure here is non-fatal — see fetchLocalVariables.
    const [data, variables] = await Promise.all([
      fetchFileCached(fileKey),
      fetchLocalVariables(fileKey)
    ])

    const ds = extractDesignSystem(data, data.styles ?? {}, variables.index)
    return {
      ok: true,
      output:
        summarizeDesignSystem(ds) +
        (variables.note ? `\n\nNote: ${variables.note}` : '') +
        '\n\nTo turn this into code, call export_figma_tokens with format ' +
        'css | scss | json | tailwind | ts.'
    }
  })
}

/**
 * Write the extracted design system into the workspace as real code.
 */
export async function export_figma_tokens(args: Record<string, unknown>): Promise<ToolResult> {
  const fileKey = typeof args.file_key === 'string' ? args.file_key.trim() : ''
  const rawFormat = typeof args.format === 'string' ? args.format.trim().toLowerCase() : 'css'

  const invalid = badFileKey('export_figma_tokens', fileKey)
  if (invalid) return invalid

  const allowed: TokenFormat[] = ['css', 'scss', 'json', 'tailwind', 'ts']
  if (!allowed.includes(rawFormat as TokenFormat)) {
    return {
      ok: false,
      error: `export_figma_tokens: invalid format "${rawFormat}". Expected one of: ${allowed.join(', ')}.`
    }
  }
  const format = rawFormat as TokenFormat

  return guard('export_figma_tokens', async () => {
    const [data, variables] = await Promise.all([
      fetchFileCached(fileKey),
      fetchLocalVariables(fileKey)
    ])

    const ds = extractDesignSystem(data, data.styles ?? {}, variables.index)
    if (ds.colors.length === 0 && ds.text.length === 0) {
      return {
        ok: false,
        error:
          'No design values found in this file — it may be empty, or every layer may be hidden. ' +
          'Run get_figma_file to confirm it has frames.'
      }
    }

    const content = emitTokens(ds, format)
    const relPath = await writeSandboxFile(
      `design-tokens/tokens.${FORMAT_EXTENSION[format]}`,
      content
    )
    const absPath = join(getWorkspaceDir(), relPath)

    return {
      ok: true,
      output:
        `Wrote ${format} design tokens to ${absPath}\n` +
        `${ds.colors.length} colours, ${ds.text.length} type styles, ` +
        `${ds.spacing.length} spacing steps, ${ds.radii.length} radii, ${ds.shadows.length} shadows ` +
        `(from ${ds.nodesScanned.toLocaleString()} nodes).\n\n` +
        content.slice(0, 2_000) +
        (content.length > 2_000 ? '\n… (truncated — full file is on disk)' : '')
    }
  })
}

/**
 * Export Figma frames as images and analyse each one with Claude Vision.
 * Returns a structured per-frame design review covering layout, colour/contrast,
 * typography, accessibility, and concrete improvement suggestions.
 *
 * If node_ids is omitted the first MAX_FRAMES top-level frames are used.
 */
export async function export_figma_frames(
  args: Record<string, unknown>,
  context?: ExecutorContext
): Promise<ToolResult> {
  const fileKey = typeof args.file_key === 'string' ? args.file_key.trim() : ''
  const rawNodeIds = typeof args.node_ids === 'string' ? args.node_ids.trim() : ''
  const rawScale = typeof args.scale === 'number' ? args.scale : Number(args.scale ?? 2)

  const invalid = badFileKey('export_figma_frames', fileKey)
  if (invalid) return invalid

  // 2× is the default because Vision reads small type far more reliably on a
  // retina-density render than at 1×, where 12px labels turn to mush.
  const scale = Number.isFinite(rawScale) ? Math.min(4, Math.max(1, rawScale)) : 2

  return guard('export_figma_frames', async () => {
    let nodeIds: string[]

    if (rawNodeIds) {
      const parsed = parseNodeIds('export_figma_frames', rawNodeIds, MAX_FRAMES)
      if ('error' in parsed) return parsed.error
      nodeIds = parsed.ids
    } else {
      // Auto-discover: fetch the file at depth=3 (see get_figma_file — depth 3 is
      // what surfaces frames nested inside Sections) and take the first MAX_FRAMES.
      const fileData = (await figmaFetch(
        `/v1/files/${encodeURIComponent(fileKey)}?depth=3`
      )) as FigmaFileResponse
      const frames = collectFrames(fileData.document)
      if (frames.length === 0) {
        return { ok: true, output: 'No top-level frames found in this Figma file.' }
      }
      nodeIds = frames.slice(0, MAX_FRAMES).map((f) => f.id)
    }

    const imageMap = await fetchImageUrls(fileKey, nodeIds, 'png', scale)
    const results: string[] = []

    for (const nodeId of nodeIds) {
      const imageUrl = imageMap[nodeId]
      if (!imageUrl) {
        results.push(
          `Frame ${nodeId}: No image URL returned (frame may be empty, invisible, or not yet rendered by Figma).`
        )
        continue
      }

      try {
        const imageBuffer = await downloadBuffer(imageUrl)
        const base64 = imageBuffer.toString('base64')

        // Vision analysis runs through chat-proxy so OUR Anthropic key stays
        // server-side (chat-proxy accepts Anthropic-style image content blocks).
        // The tier-scoped modelKey is clamped to the caller's entitlement by the
        // proxy; a non-signed-in / limit failure throws and is caught below.
        const analysis = await callChatProxyText({
          modelKey: visionModelKey(context),
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/png', data: base64 }
                },
                {
                  type: 'text',
                  text:
                    'You are a senior UI/UX designer reviewing a Figma design frame. Analyse this frame and provide:\n' +
                    '1. **Layout Summary**: Overall layout, spacing patterns, and visual hierarchy.\n' +
                    '2. **Colour & Contrast**: Colour palette; flag any WCAG AA failures (text contrast < 4.5:1).\n' +
                    '3. **Typography**: Font choices, size hierarchy, line-height, and readability.\n' +
                    '4. **Accessibility**: Missing alt text, small touch targets (< 44 px), unclear affordances.\n' +
                    '5. **Improvement Suggestions**: 3–5 specific, actionable recommendations with concrete values.'
                }
              ]
            }
          ]
        })

        results.push(`=== Frame ${nodeId} Analysis ===\n${analysis}`)
      } catch (frameErr) {
        results.push(
          `Frame ${nodeId}: download/analysis failed — ` +
            `${frameErr instanceof Error ? frameErr.message : String(frameErr)}`
        )
      }
    }

    return { ok: true, output: results.join('\n\n') || 'No frames were analysed.' }
  })
}

/** Frameworks figma_frame_to_code can target. */
const CODE_FRAMEWORKS = ['html', 'react', 'react-tailwind'] as const
type CodeFramework = (typeof CODE_FRAMEWORKS)[number]

const FRAMEWORK_INSTRUCTIONS: Record<CodeFramework, string> = {
  html:
    'Produce ONE self-contained HTML file with an inline <style> block. No build step, ' +
    'no external assets, no CDN links (it must render offline from the filesystem). ' +
    'Define the design tokens as CSS custom properties on :root and use them throughout.',
  react:
    'Produce ONE React function component in a .jsx file, with its styles in a co-located ' +
    '<style> tag via a CSS-in-JS-free approach: export the component and include a `styles` ' +
    'object or a template-literal stylesheet. No external UI library.',
  'react-tailwind':
    'Produce ONE React function component in a .jsx file styled entirely with Tailwind ' +
    'utility classes. Use arbitrary-value syntax (e.g. `w-[344px]`, `bg-[#1A1A2E]`) wherever ' +
    'the design uses a value outside the default scale, so the output is pixel-faithful.'
}

const FRAMEWORK_EXTENSION: Record<CodeFramework, string> = {
  html: 'html',
  react: 'jsx',
  'react-tailwind': 'jsx'
}

/**
 * Generate production front-end code for a single Figma frame.
 *
 * The generator gets three inputs, which is why the output tracks the design
 * instead of merely resembling it:
 *   1. the rendered PNG          — what it should look like
 *   2. the exact node-tree spec  — the real numbers (see describeNodeTree)
 *   3. the file's design tokens  — so it reuses the system's palette/scale
 *
 * HTML output is written into the workspace and opened in the browser, matching
 * the design_preview loop so the user can iterate on it immediately.
 */
export async function figma_frame_to_code(
  args: Record<string, unknown>,
  context?: ExecutorContext
): Promise<ToolResult> {
  const fileKey = typeof args.file_key === 'string' ? args.file_key.trim() : ''
  const nodeId = typeof args.node_id === 'string' ? args.node_id.trim() : ''
  const rawFramework =
    typeof args.framework === 'string' ? args.framework.trim().toLowerCase() : 'html'
  const rawName = typeof args.name === 'string' ? args.name.trim() : ''

  const invalid = badFileKey('figma_frame_to_code', fileKey)
  if (invalid) return invalid
  if (!nodeId || !NODE_ID_RE.test(nodeId)) {
    return {
      ok: false,
      error:
        `figma_frame_to_code requires a valid "node_id" (e.g. "1:2"), got "${nodeId}". ` +
        'Get frame IDs from get_figma_file.'
    }
  }
  if (!CODE_FRAMEWORKS.includes(rawFramework as CodeFramework)) {
    return {
      ok: false,
      error: `figma_frame_to_code: invalid framework "${rawFramework}". Expected one of: ${CODE_FRAMEWORKS.join(', ')}.`
    }
  }
  const framework = rawFramework as CodeFramework

  return guard('figma_frame_to_code', async () => {
    // 1. Exact geometry for this frame.
    const node = await fetchNode(fileKey, nodeId)
    if (!node) {
      return {
        ok: false,
        error: `figma_frame_to_code: node ${nodeId} not found in file ${fileKey}.`
      }
    }
    const spec = describeNodeTree(node)

    // 2. The design system, so generated code reuses the real palette/scale
    //    rather than inventing near-miss values per frame.
    let tokenSummary = ''
    try {
      // depth=4 is enough for a token summary, and a full-depth entry cached by
      // get_figma_design_system / export_figma_tokens satisfies it for free.
      const [fileData, variables] = await Promise.all([
        fetchFileCached(fileKey, 4),
        fetchLocalVariables(fileKey)
      ])
      const ds = extractDesignSystem(fileData, fileData.styles ?? {}, variables.index)
      tokenSummary = summarizeDesignSystem(ds)
    } catch {
      // Non-fatal: the node spec alone is still enough to generate from.
      tokenSummary = '(design-system extraction unavailable for this file)'
    }

    // 3. The real SVG for any icons in the frame, so they come out as actual
    //    vector markup instead of an approximation eyeballed off the PNG.
    const icons = await fetchIconSvgs(fileKey, node)

    // 4. The render, for visual context.
    let imageBlock: { type: 'image'; source: { type: 'base64'; media_type: 'image/png'; data: string } } | null =
      null
    try {
      const imageMap = await fetchImageUrls(fileKey, [nodeId], 'png', 2)
      const url = imageMap[nodeId]
      if (url) {
        const buf = await downloadBuffer(url)
        imageBlock = {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: buf.toString('base64') }
        }
      }
    } catch {
      // Non-fatal — generation proceeds from the spec alone, which is the
      // authoritative input anyway.
    }

    const prompt = [
      'You are a senior front-end engineer implementing a Figma frame as production code.',
      '',
      FRAMEWORK_INSTRUCTIONS[framework],
      '',
      'THE EXACT NODE SPEC BELOW IS GROUND TRUTH. The image is only for visual context —',
      'where they disagree, follow the spec. Use its exact px values, hex colours, gaps,',
      'padding, radii, font sizes and text content. Do not invent copy; use the literal',
      'text from the spec.',
      '',
      '=== NODE SPEC ===',
      spec,
      '',
      '=== FILE DESIGN SYSTEM (reuse these values) ===',
      tokenSummary,
      ...(icons.length
        ? [
            '',
            '=== ICON SVG (inline these verbatim) ===',
            'These are the frame\'s real icons, exported from Figma. Paste each <svg> inline at',
            'the matching layer from the spec. Do NOT substitute an emoji, a unicode glyph, a',
            'font icon, or a CSS-drawn shape. Set width/height from the spec and use',
            'fill="currentColor" where the icon is a single flat colour.',
            ...icons.map((i) => `\n-- ${i.name} --\n${i.svg}`)
          ]
        : []),
      '',
      'Requirements:',
      '- Semantic HTML (header/nav/main/section/button/ul), not div soup.',
      '- Accessible: real button/a elements, alt text, labelled inputs, visible :focus styles.',
      '- Responsive: the frame width is the desktop breakpoint; degrade sensibly below 768px.',
      '- Use flexbox/grid mirroring the auto-layout in the spec (direction, gap, padding, align).',
      '- A `wrap` marker on a frame means `flex-wrap: wrap` (with `row-gap:N` as the cross-axis gap).',
      '- A `position:absolute` marker means that child is pinned over its parent, outside the',
      '  flow — position it absolutely against a positioned ancestor, do not place it inline.',
      '',
      'Output ONLY the code. No markdown fences, no commentary before or after.'
    ].join('\n')

    const content: (
      | { type: 'text'; text: string }
      | { type: 'image'; source: { type: 'base64'; media_type: 'image/png'; data: string } }
    )[] = imageBlock ? [imageBlock, { type: 'text', text: prompt }] : [{ type: 'text', text: prompt }]

    const raw = await callChatProxyText({
      modelKey: visionModelKey(context),
      messages: [{ role: 'user', content }]
    })

    // Models often wrap output in fences despite being told not to; strip them
    // rather than writing a file that starts with ```html.
    const code = raw
      .replace(/^\s*```[a-zA-Z]*\n/, '')
      .replace(/\n```\s*$/, '')
      .trim()

    if (!code) {
      return { ok: false, error: 'figma_frame_to_code: the model returned no code.' }
    }

    const safeName =
      /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(rawName) && rawName
        ? rawName
        : `frame-${nodeId.replace(':', '-')}`
    const relPath = await writeSandboxFile(
      `designs/${safeName}.${FRAMEWORK_EXTENSION[framework]}`,
      code
    )
    const absPath = join(getWorkspaceDir(), relPath)

    // Only HTML is directly viewable; a .jsx file would open in an editor, which
    // is not what "preview" means here.
    let opened = ''
    if (framework === 'html') {
      const openErr = await shell.openPath(absPath)
      opened = openErr
        ? ` (could not auto-open: ${openErr} — open it manually)`
        : ' and opened in the default browser'
    }

    return {
      ok: true,
      output:
        `Generated ${framework} for frame ${nodeId} ("${node.name ?? ''}") → ${absPath}${opened}.\n` +
        `Built from the exact node spec (${spec.split('\n').length} layers) plus the file's design system` +
        (icons.length ? ` and ${icons.length} inline SVG icon${icons.length === 1 ? '' : 's'}` : '') +
        '.\n\n' +
        code.slice(0, 2_000) +
        (code.length > 2_000 ? '\n… (truncated — full file is on disk)' : '')
    }
  })
}

/**
 * Read existing comment threads on a Figma file — useful for picking up a
 * review conversation rather than starting a duplicate one.
 */
export async function list_figma_comments(args: Record<string, unknown>): Promise<ToolResult> {
  const fileKey = typeof args.file_key === 'string' ? args.file_key.trim() : ''
  const invalid = badFileKey('list_figma_comments', fileKey)
  if (invalid) return invalid

  return guard('list_figma_comments', async () => {
    const data = (await figmaFetch(
      `/v1/files/${encodeURIComponent(fileKey)}/comments`
    )) as FigmaCommentsResponse

    const comments = data.comments ?? []
    if (comments.length === 0) return { ok: true, output: 'No comments on this Figma file.' }

    const lines = comments.slice(0, 60).map((c) => {
      const who = c.user?.handle ?? 'unknown'
      const when = c.created_at ? c.created_at.slice(0, 10) : '?'
      const where = c.client_meta?.node_id ? ` @${c.client_meta.node_id}` : ''
      const state = c.resolved_at ? ' [resolved]' : ''
      const reply = c.parent_id ? ' ↳' : ''
      const msg = (c.message ?? '').replace(/\s+/g, ' ').slice(0, 300)
      return `${reply} ${when} ${who}${where}${state}: ${msg}`
    })

    return {
      ok: true,
      output: [
        `${comments.length} comment(s)${comments.length > 60 ? ' (first 60 shown)' : ''}:`,
        ...lines
      ].join('\n')
    }
  })
}

/**
 * Post a comment on a Figma file, optionally anchored to a specific node.
 * Use after export_figma_frames to leave AI-generated design feedback directly
 * in Figma, visible to the whole team.
 */
export async function create_figma_comment(args: Record<string, unknown>): Promise<ToolResult> {
  const fileKey = typeof args.file_key === 'string' ? args.file_key.trim() : ''
  const message = typeof args.message === 'string' ? args.message.trim() : ''
  const nodeId = typeof args.node_id === 'string' ? args.node_id.trim() : ''

  const invalid = badFileKey('create_figma_comment', fileKey)
  if (invalid) return invalid
  if (!message) {
    return { ok: false, error: 'create_figma_comment requires a non-empty string "message".' }
  }
  if (message.length > MAX_COMMENT_CHARS) {
    return {
      ok: false,
      error: `create_figma_comment "message" exceeds the ${MAX_COMMENT_CHARS.toLocaleString()}-character limit.`
    }
  }
  if (nodeId && !NODE_ID_RE.test(nodeId)) {
    return {
      ok: false,
      error: `create_figma_comment: invalid node_id "${nodeId}". Expected "PARENT:LOCAL" format, e.g. "1:2".`
    }
  }

  return guard('create_figma_comment', async () => {
    const body: Record<string, unknown> = { message }
    if (nodeId) body.client_meta = { node_id: nodeId }

    const data = (await figmaFetch(
      `/v1/files/${encodeURIComponent(fileKey)}/comments`,
      'POST',
      body
    )) as { id?: string | number }

    const commentId = String(data.id ?? 'unknown')
    return {
      ok: true,
      output:
        `Posted comment on Figma file "${fileKey}". Comment ID: ${commentId}` +
        (nodeId ? ` (anchored to node ${nodeId})` : '') +
        '.'
    }
  })
}

// ── schemas (LLM-facing surface) ─────────────────────────────────────────────

/** Every Figma tool takes this; declared once to keep the schemas readable. */
const FILE_KEY_PARAM = {
  type: 'string',
  description:
    'Figma file key — the alphanumeric string in the Figma URL: ' +
    'figma.com/file/{file_key}/… (e.g. "WBMHi3SnvS82HQ3UQnxiKZ").'
}

export const figmaToolSchemas: ToolSchema[] = [
  {
    name: 'get_figma_file',
    description:
      'Fetch metadata from a Figma file: name, last-modified date, pages, published component/style ' +
      'counts, and the full list of top-level frames with their node IDs. Call this FIRST to discover ' +
      'which frames to pass to the other Figma tools. Requires a Figma token (Settings → Figma).',
    parameters: {
      type: 'object',
      properties: { file_key: FILE_KEY_PARAM },
      required: ['file_key']
    }
  },
  {
    name: 'get_figma_node_details',
    description:
      'Deep-inspect specific Figma nodes and report EXACT values: bounds, auto-layout direction/gap/' +
      'padding/alignment, hex fills, borders, corner radii, shadows, opacity, and every text layer with ' +
      'its font, size, weight, line-height and literal content. Use this when code must match the design ' +
      'precisely — it reads the file rather than eyeballing a screenshot. Up to 5 nodes per call.',
    parameters: {
      type: 'object',
      properties: {
        file_key: FILE_KEY_PARAM,
        node_ids: {
          type: 'string',
          description:
            'Comma-separated node IDs to inspect (e.g. "1:2,1:3"). Get IDs from get_figma_file.'
        }
      },
      required: ['file_key', 'node_ids']
    }
  },
  {
    name: 'get_figma_components',
    description:
      "List a Figma file's published components, component sets and styles (colour, text, effect, grid) " +
      'with their names and descriptions — the reusable vocabulary of the design system. Use this to ' +
      'find out what building blocks exist before designing or building a new screen.',
    parameters: {
      type: 'object',
      properties: { file_key: FILE_KEY_PARAM },
      required: ['file_key']
    }
  },
  {
    name: 'get_figma_design_system',
    description:
      "Extract the design system a Figma file ACTUALLY uses: the colour palette (ranked by usage count, " +
      'ordered light→dark, with published style names), the type scale (family/size/weight/line-height), ' +
      'the spacing scale taken from auto-layout gaps and padding, corner radii, and shadows — plus a WCAG ' +
      'contrast check on the palette extremes. Use this to understand or audit a design system, or before ' +
      'building anything that has to look native to it.',
    parameters: {
      type: 'object',
      properties: { file_key: FILE_KEY_PARAM },
      required: ['file_key']
    }
  },
  {
    name: 'export_figma_tokens',
    description:
      "Extract a Figma file's design system and WRITE it into the workspace as real code: CSS custom " +
      'properties, SCSS variables, W3C-style JSON design tokens, a Tailwind theme config, or a typed TS ' +
      'module. Published Figma style names become the token names. Use this to make a website reuse the ' +
      "designer's exact palette, type scale and spacing instead of approximating them.",
    parameters: {
      type: 'object',
      properties: {
        file_key: FILE_KEY_PARAM,
        format: {
          type: 'string',
          description:
            'Output format. "css" writes :root custom properties + type classes (default), "scss" ' +
            'variables and maps, "json" W3C design tokens (Style Dictionary compatible), "tailwind" a ' +
            'theme.extend config, "ts" a typed const object.',
          enum: ['css', 'scss', 'json', 'tailwind', 'ts']
        }
      },
      required: ['file_key']
    }
  },
  {
    name: 'export_figma_frames',
    description:
      'Render Figma frames as PNG images and analyse each with Claude Vision. Returns a per-frame design ' +
      'review: layout, colour/contrast, typography, accessibility issues, and 3–5 concrete improvement ' +
      'suggestions. Use this for design CRITIQUE. To BUILD a frame instead, use figma_frame_to_code. ' +
      'If node_ids is omitted the first 3 top-level frames are analysed.',
    parameters: {
      type: 'object',
      properties: {
        file_key: FILE_KEY_PARAM,
        node_ids: {
          type: 'string',
          description:
            'Optional comma-separated frame node IDs (e.g. "1:2,1:3"). Up to 3 frames per call.'
        },
        scale: {
          type: 'string',
          description:
            'Optional render scale, 1–4 (default 2). Higher scales make small text legible to Vision.'
        }
      },
      required: ['file_key']
    }
  },
  {
    name: 'figma_frame_to_code',
    description:
      'Build a Figma frame as production front-end code and save it to the workspace. Combines the exact ' +
      'node geometry (auto-layout, gaps, padding, hex colours, font sizes, real text content) with the ' +
      "file's design tokens and the rendered image, so the output is pixel-faithful rather than an " +
      'approximation. Produces semantic, accessible, responsive markup. HTML output opens in the browser ' +
      'for immediate review. Use this to turn a design into a working website or component.',
    parameters: {
      type: 'object',
      properties: {
        file_key: FILE_KEY_PARAM,
        node_id: {
          type: 'string',
          description: 'The frame node ID to build (e.g. "1:2"). Get it from get_figma_file.'
        },
        framework: {
          type: 'string',
          description:
            'Target: "html" for one self-contained HTML file that opens in the browser (default), ' +
            '"react" for a JSX component, "react-tailwind" for a JSX component styled with Tailwind.',
          enum: ['html', 'react', 'react-tailwind']
        },
        name: {
          type: 'string',
          description:
            'Optional output filename stem (letters, digits, - and _). Defaults to "frame-<node-id>". ' +
            'Reuse the same name to overwrite when iterating.'
        }
      },
      required: ['file_key', 'node_id']
    }
  },
  {
    name: 'list_figma_comments',
    description:
      'Read existing comment threads on a Figma file — who said what, when, whether it is resolved, and ' +
      'which node it is anchored to. Use this before commenting to pick up the existing conversation ' +
      'rather than duplicating feedback that is already there.',
    parameters: {
      type: 'object',
      properties: { file_key: FILE_KEY_PARAM },
      required: ['file_key']
    }
  },
  {
    name: 'create_figma_comment',
    description:
      'Post a comment on a Figma file, optionally anchored to a specific frame or node. Use after ' +
      'export_figma_frames to leave design feedback directly in Figma, visible to the whole team. ' +
      'NOTE: comments are the only thing the Figma API can write — it cannot create or edit designs.',
    parameters: {
      type: 'object',
      properties: {
        file_key: FILE_KEY_PARAM,
        message: { type: 'string', description: 'The comment text to post on the Figma file.' },
        node_id: {
          type: 'string',
          description:
            'Optional frame or node ID to anchor the comment to (e.g. "1:2"). ' +
            'If omitted the comment appears at the file level.'
        }
      },
      required: ['file_key', 'message']
    }
  }
]

export const figmaRegistry: Record<
  string,
  (args: Record<string, unknown>, context?: ExecutorContext) => Promise<ToolResult>
> = {
  get_figma_file,
  get_figma_node_details,
  get_figma_components,
  get_figma_design_system,
  export_figma_tokens,
  export_figma_frames,
  figma_frame_to_code,
  list_figma_comments,
  create_figma_comment
}
