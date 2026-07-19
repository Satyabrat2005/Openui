/**
 * figma.ts — Figma design tools for the OpenUI agent (Phase 11).
 *
 * Three tools for the Designer use case:
 *   get_figma_file(file_key)                          — file metadata + frame inventory
 *   export_figma_frames(file_key, node_ids?)          — PNG export + Claude Vision analysis
 *   create_figma_comment(file_key, message, node_id?) — leave feedback on a file or frame
 *
 * Uses the Figma REST API, authenticated with a per-user personal access token
 * that the user supplies in Settings → Figma (falling back to the FIGMA_TOKEN
 * env var for local dev). A Figma PAT is an inherently user-owned credential, so
 * — unlike OUR shared LLM keys — the right fix is a Settings field, not a proxy.
 * Vision analysis runs through the `chat-proxy` Edge Function so OUR Anthropic
 * key stays server-side (never shipped in the client).
 *
 * SECURITY:
 *   - file_key validated against FILE_KEY_RE before any API call.
 *   - node_ids list bounded + each ID validated against NODE_ID_RE.
 *   - API responses are capped to prevent context flooding.
 *   - Image downloads are HTTPS-only with a size cap and redirect limit.
 *   - The Figma token stays in the main process — never crosses the contextBridge.
 */

import { request as httpsRequest } from 'node:https'
import type { ExecutorContext, ToolResult, ToolSchema } from './tools'
import { database } from './database'
import { callChatProxyText } from './edgeFunctions'

// Figma file keys are base64url strings embedded in figma.com/file/{key}/…
const FILE_KEY_RE = /^[A-Za-z0-9_-]{4,256}$/

// Figma node IDs: "PARENT_ID:LOCAL_ID" — both parts are non-negative integers.
const NODE_ID_RE = /^\d+:\d+$/

// Caps to avoid context flooding / runaway Vision API calls.
const MAX_FILE_SUMMARY_CHARS = 6_000
const MAX_FRAMES = 3          // max frames analysed per export_figma_frames call
const MAX_COMMENT_CHARS = 10_000

// Settings key under which the user's Figma personal access token is stored
// (via Settings → Figma). Keep in sync with the renderer's SettingsModal.
export const FIGMA_TOKEN_SETTING_KEY = 'figma_token'

// Hard cap on how many bytes a single frame PNG may be.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024 // 10 MB

// ── Figma REST API helper ─────────────────────────────────────────────────────

/**
 * Make an authenticated GET or POST request to api.figma.com and return the
 * parsed JSON body.  Throws a descriptive Error on HTTP-level or API-level
 * failures so callers can surface the message without crashing.
 */
/**
 * Resolve the Figma personal access token. A Figma PAT is a per-user credential
 * (unlike OUR shared, server-side LLM keys), so the user supplies their OWN in
 * Settings → Figma; the FIGMA_TOKEN env var remains a local-dev fallback.
 */
export function getFigmaToken(): string {
  const stored = database.settings.getSetting(FIGMA_TOKEN_SETTING_KEY)
  if (typeof stored === 'string' && stored.trim()) return stored.trim()
  return process.env.FIGMA_TOKEN?.trim() ?? ''
}

function figmaFetch(
  path: string,
  method: 'GET' | 'POST' = 'GET',
  body?: unknown
): Promise<unknown> {
  const token = getFigmaToken()
  if (!token) {
    return Promise.reject(
      new Error(
        'No Figma token configured. Open Settings → Figma and paste a personal ' +
          'access token (figma.com → Settings → Security → Personal access tokens), ' +
          'or set the FIGMA_TOKEN environment variable.'
      )
    )
  }

  const bodyStr = body != null ? JSON.stringify(body) : undefined

  return new Promise<unknown>((resolve, reject) => {
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
          const raw = Buffer.concat(chunks).toString('utf8')
          const httpStatus = res.statusCode ?? 200
          if (httpStatus >= 400) {
            try {
              const parsed = JSON.parse(raw) as Record<string, unknown>
              reject(
                new Error(
                  `Figma API HTTP ${httpStatus}: ` +
                    String(parsed.err ?? parsed.message ?? raw.slice(0, 200))
                )
              )
            } catch {
              reject(new Error(`Figma API HTTP ${httpStatus}: ${raw.slice(0, 200)}`))
            }
            return
          }
          try {
            resolve(JSON.parse(raw))
          } catch {
            reject(new Error(`Figma API returned non-JSON: ${raw.slice(0, 200)}`))
          }
        })
        res.on('error', reject)
      }
    )
    req.on('error', reject)
    if (bodyStr) req.write(bodyStr)
    req.end()
  })
}

/**
 * Download a PNG buffer from an HTTPS URL, following up to 5 redirects.
 * Throws if the response exceeds MAX_IMAGE_BYTES or if the URL is non-HTTPS.
 */
function downloadBuffer(url: string, redirectDepth = 0): Promise<Buffer> {
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
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}

// ── Document tree helpers ─────────────────────────────────────────────────────

interface FigmaFrame {
  id: string
  name: string
  page: string
}

/**
 * Walk a Figma document node and collect all top-level FRAME / COMPONENT nodes
 * (direct children of CANVAS pages).  With depth=2 from the Figma API this is
 * the complete top-level frame inventory — no deeper recursion needed.
 */
function collectFrames(document: unknown): FigmaFrame[] {
  const frames: FigmaFrame[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const doc = document as any
  if (!doc || !Array.isArray(doc.children)) return frames

  for (const page of doc.children as unknown[]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = page as any
    const pageName: string = typeof p.name === 'string' ? p.name : 'Unknown Page'
    if (!Array.isArray(p.children)) continue

    for (const child of p.children as unknown[]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c = child as any
      if (c.type === 'FRAME' || c.type === 'COMPONENT' || c.type === 'COMPONENT_SET') {
        frames.push({
          id: String(c.id ?? ''),
          name: typeof c.name === 'string' ? c.name : 'Unnamed Frame',
          page: pageName
        })
      }
    }
  }
  return frames
}

// ── tool implementations ──────────────────────────────────────────────────────

/**
 * Fetch a Figma file's name, last-modified date, and the complete list of
 * top-level frames.  Call this first so the agent knows which node IDs to pass
 * to export_figma_frames.
 */
export async function get_figma_file(args: Record<string, unknown>): Promise<ToolResult> {
  const fileKey = typeof args.file_key === 'string' ? args.file_key.trim() : ''
  if (!fileKey) return { ok: false, error: 'get_figma_file requires a string "file_key".' }
  if (!FILE_KEY_RE.test(fileKey)) {
    return {
      ok: false,
      error:
        `get_figma_file: invalid file_key "${fileKey}". ` +
        'The file key is the alphanumeric string in the Figma URL: figma.com/file/{file_key}/…'
    }
  }

  try {
    // depth=2 returns Document → Pages → top-level frames; keeps the payload small.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = (await figmaFetch(`/v1/files/${encodeURIComponent(fileKey)}?depth=2`)) as any

    const fileName: string = typeof data.name === 'string' ? data.name : '(unnamed)'
    const lastModified: string = typeof data.lastModified === 'string' ? data.lastModified : 'unknown'
    const frames = collectFrames(data.document)

    const frameLines = frames
      .slice(0, 50)
      .map((f) => `  - "${f.name}" (id: ${f.id}, page: ${f.page})`)
      .join('\n')

    const summary = [
      `Figma file: "${fileName}"`,
      `Last modified: ${lastModified}`,
      `Top-level frames: ${frames.length}${frames.length > 50 ? ' (first 50 shown)' : ''}`,
      '',
      'Frames:',
      frameLines || '  (no frames found — file may be empty or use a non-standard structure)'
    ].join('\n')

    return { ok: true, output: summary.slice(0, MAX_FILE_SUMMARY_CHARS) }
  } catch (err) {
    return {
      ok: false,
      error: `get_figma_file failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}

/**
 * Export Figma frames as PNG images and analyse each one with Claude Vision
 * (claude-sonnet-4-6).  Returns a structured per-frame design review covering
 * layout, colour/contrast, typography, accessibility, and concrete improvement
 * suggestions.
 *
 * If node_ids is omitted the first MAX_FRAMES top-level frames are used.
 */
export async function export_figma_frames(
  args: Record<string, unknown>,
  context?: ExecutorContext
): Promise<ToolResult> {
  const fileKey = typeof args.file_key === 'string' ? args.file_key.trim() : ''
  const rawNodeIds = typeof args.node_ids === 'string' ? args.node_ids.trim() : ''

  if (!fileKey) return { ok: false, error: 'export_figma_frames requires a string "file_key".' }
  if (!FILE_KEY_RE.test(fileKey)) {
    return { ok: false, error: `export_figma_frames: invalid file_key "${fileKey}".` }
  }

  try {
    let nodeIds: string[]

    if (rawNodeIds) {
      nodeIds = rawNodeIds
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
      for (const id of nodeIds) {
        if (!NODE_ID_RE.test(id)) {
          return {
            ok: false,
            error: `export_figma_frames: invalid node_id "${id}". Expected "PARENT:LOCAL" format, e.g. "1:2".`
          }
        }
      }
      nodeIds = nodeIds.slice(0, MAX_FRAMES)
    } else {
      // Auto-discover: fetch the file at depth=2 and take the first MAX_FRAMES frames.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fileData = (await figmaFetch(`/v1/files/${encodeURIComponent(fileKey)}?depth=2`)) as any
      const frames = collectFrames(fileData.document)
      if (frames.length === 0) {
        return { ok: true, output: 'No top-level frames found in this Figma file.' }
      }
      nodeIds = frames.slice(0, MAX_FRAMES).map((f) => f.id)
    }

    // Request PNG exports from the Figma Images API.
    // Node IDs contain ":" which is allowed unencoded in URL query values.
    const idsParam = nodeIds.join(',')
     
    const imagesData = (await figmaFetch(
      `/v1/images/${encodeURIComponent(fileKey)}?ids=${idsParam}&format=png&scale=1`
    )) as any

    if (imagesData.err && imagesData.err !== null) {
      return { ok: false, error: `Figma Images API error: ${String(imagesData.err)}` }
    }

    const imageMap: Record<string, string | null> =
      (imagesData.images as Record<string, string | null>) ?? {}
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
          modelKey: context?.tier === 'enterprise' ? 'enterprise-default' : 'pro-default',
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
  } catch (err) {
    return {
      ok: false,
      error: `export_figma_frames failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }
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

  if (!fileKey) return { ok: false, error: 'create_figma_comment requires a string "file_key".' }
  if (!FILE_KEY_RE.test(fileKey)) {
    return { ok: false, error: `create_figma_comment: invalid file_key "${fileKey}".` }
  }
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

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: Record<string, any> = { message }
    if (nodeId) {
      body.client_meta = { node_id: nodeId }
    }

     
    const data = (await figmaFetch(
      `/v1/files/${encodeURIComponent(fileKey)}/comments`,
      'POST',
      body
    )) as any

    const commentId = String(data.id ?? 'unknown')
    return {
      ok: true,
      output:
        `Posted comment on Figma file "${fileKey}". Comment ID: ${commentId}` +
        (nodeId ? ` (anchored to node ${nodeId})` : '') +
        '.'
    }
  } catch (err) {
    return {
      ok: false,
      error: `create_figma_comment failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}

// ── schemas (LLM-facing surface) ─────────────────────────────────────────────

export const figmaToolSchemas: ToolSchema[] = [
  {
    name: 'get_figma_file',
    description:
      'Fetch metadata from a Figma file: its name, last-modified date, and the full list of ' +
      'top-level frames (with node IDs and page names). Call this first to discover which frames ' +
      'to pass to export_figma_frames. Requires a Figma token (set it in Settings → Figma).',
    parameters: {
      type: 'object',
      properties: {
        file_key: {
          type: 'string',
          description:
            'Figma file key — the alphanumeric string in the Figma URL: ' +
            'figma.com/file/{file_key}/… (e.g. "WBMHi3SnvS82HQ3UQnxiKZ").'
        }
      },
      required: ['file_key']
    }
  },
  {
    name: 'export_figma_frames',
    description:
      'Export Figma frames as PNG images and analyse each one with Claude Vision (claude-sonnet-4-6). ' +
      'Returns a structured per-frame design review: layout, colour/contrast, typography, ' +
      'accessibility issues, and 3–5 concrete improvement suggestions. ' +
      'Requires a Figma token (set it in Settings → Figma); vision analysis runs server-side. ' +
      'If node_ids is omitted the first 3 top-level frames are analysed automatically.',
    parameters: {
      type: 'object',
      properties: {
        file_key: {
          type: 'string',
          description: 'Figma file key from the URL (see get_figma_file).'
        },
        node_ids: {
          type: 'string',
          description:
            'Optional comma-separated list of frame node IDs to export (e.g. "1:2,1:3"). ' +
            'Get IDs from get_figma_file. Up to 3 frames per call.'
        }
      },
      required: ['file_key']
    }
  },
  {
    name: 'create_figma_comment',
    description:
      'Post a comment on a Figma file, optionally anchored to a specific frame or node. ' +
      'Use after export_figma_frames to leave AI-generated design feedback directly in Figma, ' +
      'visible to the whole design team. Requires a Figma token (set it in Settings → Figma).',
    parameters: {
      type: 'object',
      properties: {
        file_key: {
          type: 'string',
          description: 'Figma file key from the URL (see get_figma_file).'
        },
        message: {
          type: 'string',
          description: 'The comment text to post on the Figma file.'
        },
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
  export_figma_frames,
  create_figma_comment
}
