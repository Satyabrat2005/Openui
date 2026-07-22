/**
 * figmaBuild.ts — build designs INTO Figma, automatically.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS
 *
 * figma.ts reads Figma and writes code. This module is the reverse: the agent
 * describes a design as a BuildSpec and it appears as real, editable layers in
 * the user's Figma document — frames, auto-layout, text, shapes, shadows.
 *
 * The REST API cannot do this (see the WRITE ACCESS note in figma.ts), so the
 * path runs through a plugin the user imports once:
 *
 *   agent → validateBuildSpec → job queue → localhost bridge
 *                                              ↕ (plugin UI polls)
 *                                         Figma plugin → scene graph
 *
 * AUTOMATION BOUNDARY — the honest version. Figma exposes no API, deep link or
 * URL scheme that starts a plugin from outside. Nothing this process can do
 * will click "Run" for the user the first time. What IS achievable, and what
 * this implements, is that the plugin STAYS running and polling once started —
 * so it is one click ever, not one click per build. After that, `build_figma_design`
 * is genuinely hands-off: the design appears in Figma while the user watches.
 *
 * Anything claiming to fully automate that first launch would be lying about
 * what the platform permits.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * SECURITY
 *   - The bridge binds to 127.0.0.1 only — never 0.0.0.0. Nothing off-machine
 *     can reach it.
 *   - Every job endpoint requires a token, persisted in settings so a restart
 *     does not invalidate an already-imported plugin.
 *   - Specs are validated (figmaBuildSpec.ts) before they are queued, and the
 *     plugin interprets a fixed vocabulary rather than eval'ing anything.
 *   - The server starts on demand and is not running unless a build was asked
 *     for in this session.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { shell } from 'electron'
import type { ToolResult, ToolSchema } from './tools'
import { database } from './database'
import { writeSandboxFile, getWorkspaceDir } from './sandbox'
import {
  describeBuildSpec,
  validateBuildSpec,
  BuildSpecError,
  type ValidatedBuildSpec
} from './figmaBuildSpec'
import {
  PLUGIN_DIR_NAME,
  pluginCodeJs,
  pluginManifest,
  pluginUiHtml
} from './figmaPluginSource'

/**
 * Ports the bridge may bind to. Fixed rather than ephemeral because the
 * manifest's networkAccess.allowedDomains must name exact origins — Figma
 * rejects a fetch to a port that was not declared when the plugin was imported,
 * and we cannot rewrite an already-imported manifest.
 */
export const BRIDGE_PORTS = [3579, 3580, 3581, 3582, 3583]

/** Settings key for the bridge token. Stable across restarts by design. */
export const FIGMA_BRIDGE_TOKEN_KEY = 'figma_bridge_token'

/** A plugin poll within this window means the bridge is live at the far end. */
const PLUGIN_ALIVE_MS = 5_000

/** How long build_figma_design waits for the plugin to finish before reporting. */
const DEFAULT_BUILD_TIMEOUT_MS = 90_000

/** Completed jobs kept for figma_builder_status. */
const MAX_JOB_HISTORY = 20

/**
 * How long to let Figma bring a file to the front before queueing work for it.
 * The plugin builds into the ACTIVE document, so queueing into a file switch
 * that has not finished puts the design in the wrong place.
 */
const FILE_SWITCH_SETTLE_MS = 2_500

/**
 * Cap on unbuilt jobs. Without it, calling build repeatedly while the plugin is
 * closed accumulates work that all fires at once the moment it connects —
 * dumping every abandoned attempt into the user's document.
 */
const MAX_QUEUED_JOBS = 10

// ── job model ─────────────────────────────────────────────────────────────────

export interface BuildJob {
  id: string
  spec: ValidatedBuildSpec['spec']
  fonts: ValidatedBuildSpec['fonts']
  nodeCount: number
  status: 'queued' | 'building' | 'done' | 'failed'
  createdAt: number
  /** When set, the plugin refuses the job unless this file is the active one. */
  fileKey?: string
  result?: BuildResult
}

export interface BuildResult {
  jobId: string
  ok: boolean
  created?: number
  page?: string
  rootIds?: string[]
  rootNames?: string[]
  error?: string
}

interface BridgeState {
  server: Server | null
  port: number | null
  /** Timestamp of the most recent plugin poll — how we know it's connected. */
  lastPollAt: number
  queue: BuildJob[]
  history: BuildJob[]
  waiters: Map<string, (result: BuildResult) => void>
}

const bridge: BridgeState = {
  server: null,
  port: null,
  lastPollAt: 0,
  queue: [],
  history: [],
  waiters: new Map()
}

/** Reset everything. Exported for tests; the app never needs it. */
export function __resetBridgeForTest(): void {
  // close() stops new connections but leaves established keep-alive sockets
  // open, and the plugin holds one open permanently. Without this the old
  // server lingers and a client pooling that socket sees ECONNRESET.
  bridge.server?.closeAllConnections?.()
  bridge.server?.close()
  bridge.server = null
  bridge.port = null
  bridge.lastPollAt = 0
  bridge.queue = []
  bridge.history = []
  bridge.waiters.clear()
  // Deliberately NOT clearing cachedBridgeToken: the token is meant to outlive
  // a bridge restart, and a test that reset it would stop covering that.
}

/** Is a plugin currently polling us? */
export function isPluginConnected(now = Date.now()): boolean {
  return bridge.lastPollAt > 0 && now - bridge.lastPollAt < PLUGIN_ALIVE_MS
}

export function bridgePort(): number | null {
  return bridge.port
}

/**
 * Process-lifetime memo for the token.
 *
 * This is not an optimisation — it is required for correctness. getBridgeToken()
 * is called on every request to compare against, and by setup to bake into the
 * plugin. If persistence fails (DB not yet initialised, corrupt settings file),
 * a non-memoised implementation mints a NEW random token on each call, so the
 * token written into the plugin never equals the one the server checks and
 * every poll 403s forever — the bridge appears dead with no diagnosable cause.
 */
let cachedBridgeToken: string | null = null

/**
 * The bridge token, generated once and persisted.
 *
 * Stability matters more than rotation here: the token is baked into the
 * plugin the user imported, and a fresh token every launch would silently break
 * their install. It authorises building into a document the user is already
 * looking at, from a server only reachable from this machine.
 */
export function getBridgeToken(): string {
  if (cachedBridgeToken) return cachedBridgeToken

  try {
    const stored = database.settings.getSetting(FIGMA_BRIDGE_TOKEN_KEY)
    if (typeof stored === 'string' && stored.trim().length >= 16) {
      cachedBridgeToken = stored.trim()
      return cachedBridgeToken
    }
  } catch {
    // DB unavailable (early startup, or a test) — fall through to an ephemeral
    // token, which the memo above keeps stable for the life of the process.
  }

  const token = randomBytes(24).toString('hex')
  cachedBridgeToken = token
  try {
    database.settings.setSetting(FIGMA_BRIDGE_TOKEN_KEY, token)
  } catch {
    // Non-fatal: the token still works this session, but the user will need to
    // re-run setup_figma_builder after a restart to re-bake the new one.
  }
  return token
}

// ── HTTP bridge ───────────────────────────────────────────────────────────────

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    // A Figma plugin iframe has a null origin, so it cannot be allow-listed by
    // name. The token check below is what actually gates access.
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload)
  })
  res.end(payload)
}

function readBody(req: IncomingMessage, maxBytes = 256 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > maxBytes) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${bridge.port ?? 0}`)

  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {})
    return
  }

  // Unauthenticated on purpose: this is how the plugin discovers WHICH port the
  // bridge came up on. It reveals only that OpenUI is running on this machine.
  if (url.pathname === '/health') {
    sendJson(res, 200, { ok: true, service: 'openui-figma-bridge', port: bridge.port })
    return
  }

  const token = url.searchParams.get('token') ?? ''
  const expected = getBridgeToken()
  if (!token || token !== expected) {
    sendJson(res, 403, { error: 'bad token' })
    return
  }

  if (url.pathname === '/pending' && req.method === 'GET') {
    bridge.lastPollAt = Date.now()
    const job = bridge.queue.shift()
    if (job) {
      job.status = 'building'
      bridge.history.unshift(job)
      bridge.history = bridge.history.slice(0, MAX_JOB_HISTORY)
    }
    sendJson(res, 200, {
      job: job
        ? { id: job.id, spec: job.spec, fonts: job.fonts, ...(job.fileKey ? { fileKey: job.fileKey } : {}) }
        : null
    })
    return
  }

  if (url.pathname === '/result' && req.method === 'POST') {
    bridge.lastPollAt = Date.now()
    readBody(req)
      .then((raw) => {
        const result = JSON.parse(raw) as BuildResult
        const job = bridge.history.find((j) => j.id === result.jobId)
        if (job) {
          job.status = result.ok ? 'done' : 'failed'
          job.result = result
        }
        const waiter = bridge.waiters.get(result.jobId)
        if (waiter) {
          bridge.waiters.delete(result.jobId)
          waiter(result)
        }
        sendJson(res, 200, { ok: true })
      })
      .catch((err: unknown) => {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) })
      })
    return
  }

  sendJson(res, 404, { error: 'not found' })
}

/**
 * Start the bridge, trying each candidate port in turn.
 *
 * Idempotent: a second call while it is already listening is a no-op, so every
 * tool can just ensure-start without coordinating.
 */
export function ensureBridge(): Promise<number> {
  if (bridge.server && bridge.port) return Promise.resolve(bridge.port)

  return new Promise<number>((resolve, reject) => {
    const server = createServer(handleRequest)
    let attempt = 0

    const tryPort = (): void => {
      if (attempt >= BRIDGE_PORTS.length) {
        reject(
          new Error(
            `Could not bind the Figma bridge to any of ports ${BRIDGE_PORTS.join(', ')}. ` +
              'Something else is using them — close it and try again.'
          )
        )
        return
      }
      const port = BRIDGE_PORTS[attempt]
      attempt += 1
      server.once('error', tryPort)
      // 127.0.0.1, never 0.0.0.0 — this must not be reachable off-machine.
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', tryPort)
        bridge.server = server
        bridge.port = port
        resolve(port)
      })
    }

    tryPort()
  })
}

/** Queue a job and hand back a promise for its result. */
function enqueue(
  validated: ValidatedBuildSpec,
  timeoutMs: number,
  fileKey?: string
): { job: BuildJob; done: Promise<BuildResult | null> } {
  const job: BuildJob = {
    id: randomBytes(8).toString('hex'),
    spec: validated.spec,
    fonts: validated.fonts,
    nodeCount: validated.nodeCount,
    status: 'queued',
    createdAt: Date.now(),
    ...(fileKey ? { fileKey } : {})
  }

  // Drop the oldest rather than the newest: if the user gave up on earlier
  // attempts and retried, the most recent spec is the one they still want.
  bridge.queue.push(job)
  if (bridge.queue.length > MAX_QUEUED_JOBS) {
    bridge.queue.splice(0, bridge.queue.length - MAX_QUEUED_JOBS)
  }

  const done = new Promise<BuildResult | null>((resolve) => {
    const timer = setTimeout(() => {
      bridge.waiters.delete(job.id)
      resolve(null)
    }, timeoutMs)

    bridge.waiters.set(job.id, (result) => {
      clearTimeout(timer)
      resolve(result)
    })
  })

  return { job, done }
}

// ── opening Figma ─────────────────────────────────────────────────────────────

const FILE_KEY_RE = /^[A-Za-z0-9_-]{4,256}$/

/**
 * Bring Figma to the front.
 *
 * The desktop app registers the `figma://` scheme, which opens the real app
 * rather than a browser tab — that matters because the plugin the user imported
 * is a LOCAL development plugin and is only available in the desktop app. The
 * https:// form is the fallback when the scheme has no handler.
 */
async function openFigma(fileKey?: string): Promise<string> {
  const deepLink = fileKey ? `figma://file/${fileKey}` : 'figma://'
  const webUrl = fileKey ? `https://www.figma.com/file/${fileKey}` : 'https://www.figma.com/files'

  try {
    await shell.openExternal(deepLink)
    return 'Opened the Figma desktop app.'
  } catch {
    try {
      await shell.openExternal(webUrl)
      return (
        'Opened Figma in the browser (the desktop app did not respond to figma://). ' +
        'NOTE: locally-imported plugins only run in the DESKTOP app — open this file there to build.'
      )
    } catch {
      return `Could not open Figma automatically — open it manually: ${webUrl}`
    }
  }
}

// ── tools ─────────────────────────────────────────────────────────────────────

/** Wrap a tool body so a throw becomes a ToolResult. */
async function guard(tool: string, fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn()
  } catch (err) {
    return {
      ok: false,
      error: `${tool} failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}

/**
 * Generate the OpenUI Builder plugin and open its folder so the user can import
 * it into Figma. This is the one-time setup that makes every later build
 * hands-off.
 */
export async function setup_figma_builder(): Promise<ToolResult> {
  return guard('setup_figma_builder', async () => {
    const port = await ensureBridge()
    const token = getBridgeToken()

    const manifestPath = await writeSandboxFile(
      `${PLUGIN_DIR_NAME}/manifest.json`,
      pluginManifest(BRIDGE_PORTS)
    )
    await writeSandboxFile(`${PLUGIN_DIR_NAME}/code.js`, pluginCodeJs())
    await writeSandboxFile(`${PLUGIN_DIR_NAME}/ui.html`, pluginUiHtml(BRIDGE_PORTS, token))

    const absDir = join(getWorkspaceDir(), PLUGIN_DIR_NAME)
    const absManifest = join(getWorkspaceDir(), manifestPath)

    // Reveal the manifest specifically — the import dialog asks for that file.
    shell.showItemInFolder(absManifest)

    return {
      ok: true,
      output: [
        `OpenUI Builder plugin written to ${absDir} (bridge listening on 127.0.0.1:${port}).`,
        '',
        'ONE-TIME SETUP — do this once, then every build is automatic:',
        '  1. Open the Figma DESKTOP app (local plugins do not run in the browser).',
        '  2. Menu → Plugins → Development → Import plugin from manifest…',
        `  3. Choose:  ${absManifest}`,
        '  4. Run it: Plugins → Development → OpenUI Builder.',
        '',
        'Leave the small "OpenUI Builder" window open. While it is open it polls this',
        'app once a second, so build_figma_design lands in your document with no further',
        'clicks. Closing it stops the bridge until you run the plugin again.',
        '',
        'Then call build_figma_design with a design spec.'
      ].join('\n')
    }
  })
}

/**
 * Build a design into Figma.
 *
 * Validates the spec, queues it, brings Figma forward, and waits for the plugin
 * to report back — so the tool result describes what was ACTUALLY created
 * (layer count, page, node ids) rather than what was requested.
 */
export async function build_figma_design(args: Record<string, unknown>): Promise<ToolResult> {
  const rawSpec = args.spec
  const fileKey = typeof args.file_key === 'string' ? args.file_key.trim() : ''
  const rawTimeout = Number(args.timeout_seconds ?? 0)

  if (rawSpec === undefined || rawSpec === null) {
    return {
      ok: false,
      error:
        'build_figma_design requires "spec" — the design to build. It is an object with ' +
        '{ name, frames: [ … ] }. Each node has a type (FRAME | TEXT | RECTANGLE | ELLIPSE | LINE) ' +
        'and optional layout/fill/font/children. Call setup_figma_builder first if you have not.'
    }
  }
  if (fileKey && !FILE_KEY_RE.test(fileKey)) {
    return { ok: false, error: `build_figma_design: invalid file_key "${fileKey}".` }
  }

  // Parse a JSON string too — models frequently send the spec stringified.
  let specInput: unknown = rawSpec
  if (typeof rawSpec === 'string') {
    try {
      specInput = JSON.parse(rawSpec)
    } catch {
      return {
        ok: false,
        error: 'build_figma_design: "spec" was a string but not valid JSON.'
      }
    }
  }

  let validated: ValidatedBuildSpec
  try {
    validated = validateBuildSpec(specInput)
  } catch (err) {
    if (err instanceof BuildSpecError) {
      return { ok: false, error: `build_figma_design — invalid spec. ${err.message}` }
    }
    throw err
  }

  return guard('build_figma_design', async () => {
    await ensureBridge()

    const timeoutMs =
      Number.isFinite(rawTimeout) && rawTimeout > 0
        ? Math.min(300_000, Math.max(5_000, rawTimeout * 1_000))
        : DEFAULT_BUILD_TIMEOUT_MS

    const connectedBefore = isPluginConnected()

    // ORDER MATTERS. The plugin builds into whatever document is ACTIVE when it
    // picks a job up, and it polls once a second — so queueing before asking
    // Figma to switch files races the file switch and lands the design in the
    // previously-open document. Open first, let Figma settle, then queue.
    const openNote = await openFigma(fileKey || undefined)
    if (fileKey) await new Promise((r) => setTimeout(r, FILE_SWITCH_SETTLE_MS))

    // fileKey also travels with the job so the plugin can refuse outright if it
    // still has the wrong file open — belt and braces, since no delay can be
    // guaranteed sufficient on a slow machine or a large file.
    const { done } = enqueue(validated, timeoutMs, fileKey || undefined)
    const result = await done

    const outline = describeBuildSpec(validated)

    if (!result) {
      // Timed out. The distinction the user needs is "plugin never running" vs
      // "plugin running but the build stalled" — they have different fixes.
      const everConnected = bridge.lastPollAt > 0
      return {
        ok: false,
        error: everConnected
          ? `build_figma_design: queued "${validated.spec.name}" but the plugin did not report back ` +
            `within ${Math.round(timeoutMs / 1000)}s. Check the OpenUI Builder window in Figma — ` +
            'it may have been closed mid-build. The job is still queued and will run when it reconnects.'
          : 'build_figma_design: the OpenUI Builder plugin is not running, so nothing was built. ' +
            'Run setup_figma_builder, import the plugin into the Figma desktop app, and start it ' +
            '(Plugins → Development → OpenUI Builder). The job stays queued and builds the moment ' +
            'the plugin connects.'
      }
    }

    if (!result.ok) {
      return {
        ok: false,
        error:
          `build_figma_design: the plugin failed after creating ${result.created ?? 0} layers — ` +
          `${result.error ?? 'unknown error'}\n\nSpec was:\n${outline}`
      }
    }

    return {
      ok: true,
      output: [
        `Built "${validated.spec.name}" in Figma — ${result.created} layers on page "${result.page}".`,
        result.rootNames?.length
          ? `Top-level frames: ${result.rootNames.map((n) => `"${n}"`).join(', ')} ` +
            `(ids: ${(result.rootIds ?? []).join(', ')})`
          : '',
        openNote,
        connectedBefore ? '' : '(Plugin connected during this build.)',
        '',
        'What was created:',
        outline,
        '',
        'The layers are real and editable — nudge them in Figma, or call get_figma_file / ' +
          'figma_frame_to_code against this file to turn the result back into code.'
      ]
        .filter(Boolean)
        .join('\n')
    }
  })
}

/** Report bridge and plugin state — the first thing to check when a build is quiet. */
export async function figma_builder_status(): Promise<ToolResult> {
  return guard('figma_builder_status', async () => {
    const connected = isPluginConnected()
    const lines: string[] = [
      `Bridge: ${bridge.server ? `listening on 127.0.0.1:${bridge.port}` : 'not started'}`,
      `Plugin: ${
        connected
          ? 'connected (polling now)'
          : bridge.lastPollAt > 0
            ? `last seen ${Math.round((Date.now() - bridge.lastPollAt) / 1000)}s ago — the OpenUI Builder window is probably closed`
            : 'never connected — run setup_figma_builder, then start the plugin in Figma'
      }`,
      `Queued builds: ${bridge.queue.length}`
    ]

    if (bridge.history.length) {
      lines.push('', 'Recent builds:')
      for (const job of bridge.history.slice(0, 10)) {
        const detail =
          job.status === 'done'
            ? `${job.result?.created ?? 0} layers on "${job.result?.page ?? '?'}"`
            : job.status === 'failed'
              ? job.result?.error ?? 'unknown error'
              : `${job.nodeCount} nodes`
        lines.push(`  [${job.status}] "${job.spec.name}" — ${detail}`)
      }
    }

    return { ok: true, output: lines.join('\n') }
  })
}

// ── schemas ───────────────────────────────────────────────────────────────────

/**
 * The spec vocabulary, described for the model. This is deliberately detailed:
 * the model authors these specs blind, and a rejected spec costs a whole
 * round trip, so the schema doubles as the documentation.
 */
const SPEC_DESCRIPTION =
  'The design to build, as an object: { "name": "Landing page", "page": "Optional page name", ' +
  '"frames": [ node, … ] }.\n' +
  'A node is: { "type": "FRAME" | "TEXT" | "RECTANGLE" | "ELLIPSE" | "LINE", "name": "Hero", ' +
  '"x": 0, "y": 0, "width": 1440, "height": 900, "fill": "#1A1A2E", "radius": 12, "opacity": 1, ' +
  '"stroke": { "color": "#FFFFFF", "weight": 1 }, ' +
  '"shadows": [{ "x": 0, "y": 4, "blur": 12, "spread": 0, "color": "#00000029" }], ' +
  '"layout": { "mode": "VERTICAL"|"HORIZONTAL", "gap": 16, "padding": [top,right,bottom,left], ' +
  '"primaryAxis": "MIN"|"CENTER"|"MAX"|"SPACE_BETWEEN", "counterAxis": "MIN"|"CENTER"|"MAX"|"BASELINE", ' +
  '"wrap": true, "rowGap": 12 }, ' +
  '"sizing": { "horizontal": "FIXED"|"HUG"|"FILL", "vertical": … }, "grow": 0|1, ' +
  '"positioning": "AUTO"|"ABSOLUTE", "children": [ … ] }.\n' +
  'TEXT nodes additionally take "text" (required, the literal copy) and "font": ' +
  '{ "family": "Inter", "style": "Bold", "size": 32, "lineHeight": 40, "letterSpacing": 0, ' +
  '"align": "LEFT"|"CENTER"|"RIGHT" }.\n' +
  'Only FRAME nodes may have children. Top-level entries in "frames" must be FRAMEs. ' +
  'Prefer auto-layout over absolute x/y so the result is editable and responsive. ' +
  'Max 500 nodes and 16 levels of nesting per build.'

export const figmaBuildToolSchemas: ToolSchema[] = [
  {
    name: 'setup_figma_builder',
    description:
      'One-time setup that lets OpenUI BUILD designs inside Figma. Writes the OpenUI Builder plugin to ' +
      'the workspace and reveals it in the file manager with import instructions. Required before ' +
      'build_figma_design will work, because the Figma REST API cannot create layers — only a plugin ' +
      'running inside Figma can. Run this when the user wants to create or generate a design IN Figma ' +
      'and the builder is not connected yet.',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'build_figma_design',
    description:
      'BUILD a real design inside Figma — creates actual frames, auto-layout, text, shapes and shadows ' +
      'as editable layers in the user\'s document, then brings Figma to the front. Use this when the ' +
      'user asks to design, create, generate, mock up or lay something out IN Figma (as opposed to ' +
      'figma_frame_to_code, which reads an EXISTING frame and writes front-end code). Requires the ' +
      'OpenUI Builder plugin to be running — call setup_figma_builder first if it is not. Waits for ' +
      'the build to finish and reports the layers actually created.',
    parameters: {
      type: 'object',
      properties: {
        spec: { type: 'string', description: SPEC_DESCRIPTION },
        file_key: {
          type: 'string',
          description:
            'Optional Figma file key to open before building. Omit to build into whatever file is ' +
            'already open — the plugin always builds into the active document.'
        },
        timeout_seconds: {
          type: 'string',
          description: 'Optional seconds to wait for the build (default 90, max 300).'
        }
      },
      required: ['spec']
    }
  },
  {
    name: 'figma_builder_status',
    description:
      'Check whether the Figma build bridge is running and whether the OpenUI Builder plugin is ' +
      'connected, plus recent build history. Use this to diagnose a build that produced nothing.',
    parameters: { type: 'object', properties: {}, required: [] }
  }
]

export const figmaBuildRegistry: Record<
  string,
  (args: Record<string, unknown>) => Promise<ToolResult>
> = {
  setup_figma_builder,
  build_figma_design,
  figma_builder_status
}
