/**
 * overleaf.ts — write LaTeX into the user's OWN Overleaf project, live, in a
 * browser they can watch.
 *
 * Built on the existing CDP automation stack (connect_browser → browser_navigate),
 * NOT beside it: that stack already attaches to the user's real Chrome profile, so
 * their Overleaf session is simply *already there*. Every guarantee below follows
 * from that one decision.
 *
 * Tools:
 *   overleaf_open_project(project)   — open a project and report whether we can edit it
 *   overleaf_write_latex(content, …) — type LaTeX into the open project's editor
 *   overleaf_read_latex()            — read back what the editor currently shows
 *   overleaf_recompile()             — rebuild the PDF preview (HITL-gated)
 *
 * ── WHY THERE IS NO LOGIN TOOL ───────────────────────────────────────────────
 * This module NEVER handles Overleaf credentials. There is deliberately no
 * sign-in path, no password argument, and no "log in for the user" fallback: if
 * the session is not already authenticated, every tool here STOPS and tells the
 * user to log in themselves in the automation browser. Typing a user's password
 * into a third-party site on their behalf is exactly the class of action this app
 * refuses everywhere else, and an agent that "helpfully" logs in is an agent that
 * has to hold the credential. Fail-closed is the whole design.
 *
 * ── WHY THERE IS NO SHARE / PUBLISH / SUBMIT TOOL ────────────────────────────
 * Also deliberate. Sharing a project, submitting to a journal/template gallery,
 * or publishing changes what OTHER people can see, and is not reliably reversible
 * from inside the editor. Those surfaces are simply not implemented, so the model
 * cannot reach for them at all — a stronger guarantee than gating them would be,
 * because a gate can be approved by a user who did not understand the prompt.
 * overleaf_recompile IS offered (rebuilding a PDF preview is local to the project
 * and shows the user their own output) but is still confirmation-gated, because
 * it is the one action here that spends the user's compile quota.
 *
 * ── LOGIN DETECTION (verified against the real site, not assumed) ────────────
 * Measured on www.overleaf.com while logged out:
 *   - `meta[name="ol-user_id"]` IS PRESENT on the logged-out login page, with a
 *     null/absent content attribute. Testing for the tag's EXISTENCE therefore
 *     reports "logged in" on the login page — a false positive that would send
 *     the whole flow onward into an editor that is not there.
 *   - `meta[name="ol-usersEmail"]` is present with content="" when logged out.
 *   - Requesting /project while logged out redirects to /login (observed:
 *     "https://www.overleaf.com/login?").
 * So the signal is: a NON-EMPTY user meta, AND a final URL that is not the
 * login/register page. Both, not either.
 *
 * ── WHY CodeMirror'S OWN CLASSES, AND insertText ─────────────────────────────
 * The editor is CodeMirror 6. This targets `.cm-editor` / `.cm-content` —
 * CodeMirror's own public DOM contract — rather than Overleaf's app-specific
 * class names, which are build-generated and change without notice.
 *
 * Text goes in via `keyboard.insertText()`, not `fill()`/`type()`:
 *   - `.cm-content` is a contenteditable, not an <input>; fill() does not drive it.
 *   - insertText dispatches a real `beforeinput` event, which is the documented
 *     path CM6 listens on, so the editor's own state updates (and Overleaf's
 *     autosave fires) exactly as if a human had typed.
 *   - Per-character type() on a large document is slow enough to look hung.
 */

import type { ExecutorContext, ToolResult, ToolSchema } from './tools'

/** Overleaf project ids are Mongo ObjectIds: 24 hex characters. */
const PROJECT_ID_RE = /^[a-f0-9]{24}$/i

/** Cap on a single write, so a runaway generation cannot paste a novel. */
const MAX_LATEX_CHARS = 100_000

/** CodeMirror 6's own public DOM contract — see the module header. */
export const CM_EDITOR_SELECTOR = '.cm-editor'
export const CM_CONTENT_SELECTOR = '.cm-content'

/** How long to wait for the editor to mount after a project URL loads. */
const EDITOR_WAIT_MS = 30_000

// ── pure helpers (exported for unit tests) ───────────────────────────────────

/**
 * Normalise whatever the user/model passed as "the project" into a project id.
 * Accepts a bare 24-hex id or any overleaf.com URL containing /project/<id>.
 * Returns null when it cannot find one, so callers fail closed rather than
 * navigating somewhere unintended.
 */
export function parseOverleafProjectRef(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  if (PROJECT_ID_RE.test(trimmed)) return trimmed.toLowerCase()

  try {
    const url = new URL(trimmed)
    // Only overleaf.com (and its subdomains). A project id lifted out of an
    // arbitrary host would send the automation browser to that host instead.
    if (!/(^|\.)overleaf\.com$/i.test(url.hostname)) return null
    const match = url.pathname.match(/\/project\/([a-f0-9]{24})/i)
    return match ? match[1].toLowerCase() : null
  } catch {
    return null
  }
}

/** The canonical editor URL for a project id. */
export function projectUrl(projectId: string): string {
  return `https://www.overleaf.com/project/${projectId}`
}

export interface PageSignals {
  /** The page's final URL after any redirect. */
  url: string
  /** content of meta[name="ol-user_id"], or null when the tag/content is absent. */
  userId: string | null
  /** content of meta[name="ol-usersEmail"], or null. */
  usersEmail: string | null
}

export type OverleafPageState =
  | { state: 'logged-out' }
  | { state: 'editor'; projectId: string }
  | { state: 'elsewhere'; where: string }

/**
 * Decide what the automation browser is actually looking at.
 *
 * Requires BOTH a non-empty user meta AND a non-auth URL. See the module header:
 * the user meta tag exists on the logged-out login page too, so presence alone
 * is a false positive.
 */
export function classifyOverleafPage(signals: PageSignals): OverleafPageState {
  let pathname = ''
  try {
    pathname = new URL(signals.url).pathname
  } catch {
    pathname = ''
  }

  const onAuthPage = /^\/(login|register|sso)/i.test(pathname)
  const hasUser =
    (typeof signals.userId === 'string' && signals.userId.trim() !== '') ||
    (typeof signals.usersEmail === 'string' && signals.usersEmail.trim() !== '')

  if (onAuthPage || !hasUser) return { state: 'logged-out' }

  const match = pathname.match(/^\/project\/([a-f0-9]{24})/i)
  if (match) return { state: 'editor', projectId: match[1].toLowerCase() }
  return { state: 'elsewhere', where: pathname || '/' }
}

/**
 * The one message every tool here uses when the session is not authenticated.
 * It tells the user to log in THEMSELVES and tells the model not to try — an
 * agent that reads "not logged in" and starts hunting for a password field is
 * the failure mode this whole module is shaped to prevent.
 */
export const NOT_LOGGED_IN_MESSAGE =
  'Not signed in to Overleaf in the automation browser. OpenUI will not sign in for you: ' +
  'please log in yourself in that browser window, then ask again. ' +
  'DO NOT attempt to enter credentials, click "Log in", or fill any password field on the user’s behalf.'

/** Reject empty/oversized payloads before touching the page. */
export function validateLatexPayload(content: unknown): string | null {
  if (typeof content !== 'string' || content.trim() === '') {
    return 'overleaf_write_latex requires non-empty "content" (the LaTeX to write).'
  }
  if (content.length > MAX_LATEX_CHARS) {
    return `overleaf_write_latex: "content" is ${content.length} characters, over the ${MAX_LATEX_CHARS} limit.`
  }
  return null
}

/**
 * Compare what we asked to write against what the editor reports back.
 *
 * CodeMirror VIRTUALISES its content: lines scrolled out of view are not in the
 * DOM at all, so a readback of a long document is legitimately shorter than what
 * was written. Reporting that as "content mismatch" would cry wolf on every
 * document taller than the viewport. So a prefix match counts as verified, and
 * anything else is reported as unverified rather than as failure — the tool says
 * what it actually knows.
 */
export function compareWrittenContent(
  written: string,
  readBack: string
): { verified: boolean; note: string } {
  const norm = (s: string): string => s.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim()
  const w = norm(written)
  const r = norm(readBack)

  if (r === w) return { verified: true, note: 'Editor content matches what was written exactly.' }
  if (r.length > 0 && w.startsWith(r)) {
    return {
      verified: true,
      note: `Editor shows the first ${r.length} of ${w.length} characters — the rest is scrolled out of CodeMirror's virtualised view, which is expected for a document longer than the window.`
    }
  }
  return {
    verified: false,
    note: 'Could NOT verify the editor content matches what was written — read it back on screen before relying on it.'
  }
}

// ── page plumbing ────────────────────────────────────────────────────────────

/**
 * The live Playwright page from the CDP attachment, or null.
 * Lazy-required so this module (and its unit tests) never pull in tools.ts —
 * which loads nut-js/playwright/electron — just to check a project id.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getPage(): any | null {
  try {
    const { getConnectedPage } = require('./tools') as typeof import('./tools')
    return getConnectedPage()
  } catch {
    return null
  }
}

const NOT_CONNECTED: ToolResult = {
  ok: false,
  error:
    'No browser session is connected. Call connect_browser first — the user must approve. ' +
    'Overleaf runs in the user’s own signed-in browser profile; OpenUI never signs in for them.'
}

/** Read the login/page signals out of the live page. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readSignals(page: any): Promise<PageSignals> {
  return (await page.evaluate(() => {
    const meta = (name: string): string | null => {
      const el = document.querySelector(`meta[name="${name}"]`)
      return el ? el.getAttribute('content') : null
    }
    return {
      url: window.location.href,
      userId: meta('ol-user_id'),
      usersEmail: meta('ol-usersEmail')
    }
  })) as PageSignals
}

/**
 * Resolve the page to an editor we are allowed to type into, or an explanatory
 * failure. Every write/read path goes through this, so the logged-out refusal
 * and the wrong-page refusal exist in exactly one place.
 */
async function requireEditor(): Promise<
  { ok: true; page: unknown; projectId: string } | { ok: false; result: ToolResult }
> {
  const page = getPage()
  if (!page) return { ok: false, result: NOT_CONNECTED }

  let signals: PageSignals
  try {
    signals = await readSignals(page)
  } catch (err) {
    return {
      ok: false,
      result: { ok: false, error: `Could not read the browser page: ${errText(err)}` }
    }
  }

  const state = classifyOverleafPage(signals)
  if (state.state === 'logged-out') return { ok: false, result: { ok: false, error: NOT_LOGGED_IN_MESSAGE } }
  if (state.state === 'elsewhere') {
    return {
      ok: false,
      result: {
        ok: false,
        error: `The browser is on Overleaf but not inside a project editor (currently ${state.where}). Call overleaf_open_project first.`
      }
    }
  }
  return { ok: true, page, projectId: state.projectId }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// ── tools ────────────────────────────────────────────────────────────────────

/**
 * Open one of the user's Overleaf projects in the automation browser and report
 * whether it is editable. Read-only: navigates and inspects, writes nothing.
 */
export async function overleaf_open_project(args: Record<string, unknown>): Promise<ToolResult> {
  const raw = typeof args.project === 'string' ? args.project : ''
  const projectId = parseOverleafProjectRef(raw)
  if (!projectId) {
    return {
      ok: false,
      error:
        'overleaf_open_project requires "project": either a project URL like ' +
        '"https://www.overleaf.com/project/65a1b2c3d4e5f60718293a4b" or the bare 24-character id. ' +
        'Ask the user which project to use — do not guess one.'
    }
  }

  const page = getPage()
  if (!page) return NOT_CONNECTED

  const url = projectUrl(projectId)
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: EDITOR_WAIT_MS })
  } catch (err) {
    return { ok: false, error: `overleaf_open_project could not load ${url}: ${errText(err)}` }
  }

  let signals: PageSignals
  try {
    signals = await readSignals(page)
  } catch (err) {
    return { ok: false, error: `overleaf_open_project could not inspect the page: ${errText(err)}` }
  }

  const state = classifyOverleafPage(signals)
  // The logged-out case is the important one: STOP, and say so, rather than
  // treating the login page as a document to type into.
  if (state.state === 'logged-out') return { ok: false, error: NOT_LOGGED_IN_MESSAGE }
  if (state.state === 'elsewhere') {
    return {
      ok: false,
      error:
        `Opening the project landed on ${state.where}, not the editor. The project id may be wrong, ` +
        'or this account may not have access to it. Ask the user to confirm the project URL.'
    }
  }

  // Wait for CodeMirror itself, not just the HTML document — Overleaf mounts the
  // editor client-side, so domcontentloaded does not mean "typeable yet".
  try {
    await page.waitForSelector(CM_CONTENT_SELECTOR, { timeout: EDITOR_WAIT_MS, state: 'visible' })
  } catch {
    return {
      ok: false,
      error:
        `Signed in and on project ${state.projectId}, but the CodeMirror editor never appeared. ` +
        'The project may still be loading, or it may have opened in a non-editor view.'
    }
  }

  return {
    ok: true,
    output:
      `Opened Overleaf project ${state.projectId} and the editor is ready. ` +
      'Nothing has been changed. Use overleaf_write_latex to write into it.'
  }
}

/**
 * Write LaTeX into the currently-open project's editor, where the user can watch
 * it happen. State-changing (it edits the user's real document), so it is
 * HITL-gated in tools.ts and always asks before running.
 *
 * mode "replace" (default) selects the whole document first; "append" puts the
 * caret at the end and adds to it.
 */
export async function overleaf_write_latex(args: Record<string, unknown>): Promise<ToolResult> {
  const invalid = validateLatexPayload(args.content)
  if (invalid) return { ok: false, error: invalid }
  const content = args.content as string

  const mode = args.mode === 'append' ? 'append' : 'replace'

  const gate = await requireEditor()
  if (!gate.ok) return gate.result
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const page = gate.page as any

  try {
    // Focus the contenteditable itself. Clicking the wrapper can land on the
    // gutter or a tooltip; the content node is the actual input target.
    await page.click(CM_CONTENT_SELECTOR, { timeout: 10_000 })

    // Select-all / caret-to-end via the keyboard so CodeMirror's own key
    // handlers run — reaching into its internal state would bypass them.
    if (mode === 'replace') {
      await page.keyboard.press('Control+A')
    } else {
      await page.keyboard.press('Control+End')
      await page.keyboard.press('Enter')
    }

    // insertText, not type(): see the module header.
    await page.keyboard.insertText(content)

    // Overleaf autosaves on a debounce; give it a beat so the user sees the
    // "saved" state settle rather than us reporting done mid-save.
    await page.waitForTimeout(1_200)
  } catch (err) {
    return { ok: false, error: `overleaf_write_latex failed while typing: ${errText(err)}` }
  }

  // Read back and say honestly whether it matched.
  let readBack = ''
  try {
    readBack = String(
      await page.evaluate((sel: string) => {
        const el = document.querySelector(sel)
        return el ? (el as HTMLElement).innerText : ''
      }, CM_CONTENT_SELECTOR)
    )
  } catch {
    readBack = ''
  }

  const { verified, note } = compareWrittenContent(content, readBack)
  return {
    ok: true,
    output:
      `Wrote ${content.length} characters of LaTeX into project ${gate.projectId} (mode: ${mode}). ${note} ` +
      (verified ? '' : 'Treat the write as unconfirmed. ') +
      'The PDF preview has NOT been rebuilt — call overleaf_recompile if the user wants that. ' +
      'Nothing has been shared, published, or submitted.'
  }
}

/** Read back what the open project's editor currently shows. Read-only. */
export async function overleaf_read_latex(): Promise<ToolResult> {
  const gate = await requireEditor()
  if (!gate.ok) return gate.result
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const page = gate.page as any

  try {
    const text = String(
      await page.evaluate((sel: string) => {
        const el = document.querySelector(sel)
        return el ? (el as HTMLElement).innerText : ''
      }, CM_CONTENT_SELECTOR)
    )
    if (!text.trim()) {
      return { ok: true, output: `Project ${gate.projectId}: the editor appears empty.` }
    }
    return {
      ok: true,
      output:
        `Project ${gate.projectId} editor content (only the lines CodeMirror currently has rendered — ` +
        `a longer document is virtualised and will be truncated here):\n\n${text.slice(0, 20_000)}`
    }
  } catch (err) {
    return { ok: false, error: `overleaf_read_latex failed: ${errText(err)}` }
  }
}

/**
 * Rebuild the project's PDF preview. HITL-gated in tools.ts: it is the only tool
 * here that consumes the user's compile quota, and the user should see it happen.
 * It does NOT share, publish, or submit anything — those have no tool at all.
 */
export async function overleaf_recompile(): Promise<ToolResult> {
  const gate = await requireEditor()
  if (!gate.ok) return gate.result
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const page = gate.page as any

  try {
    // Overleaf binds Ctrl+Enter to "recompile" as a first-class shortcut. Using
    // it avoids depending on the toolbar button's generated class names, which
    // are exactly the brittle selectors this module tries not to rely on.
    await page.click(CM_CONTENT_SELECTOR, { timeout: 10_000 })
    await page.keyboard.press('Control+Enter')
    await page.waitForTimeout(2_000)
    return {
      ok: true,
      output:
        `Triggered a recompile of project ${gate.projectId}. The PDF preview is rebuilding in the ` +
        'browser window — the user can watch it there. Nothing was shared or published.'
    }
  } catch (err) {
    return { ok: false, error: `overleaf_recompile failed: ${errText(err)}` }
  }
}

// ── schemas (LLM-facing surface) ─────────────────────────────────────────────

export const overleafToolSchemas: ToolSchema[] = [
  {
    name: 'overleaf_open_project',
    description:
      'Open one of the user’s own Overleaf projects in the automation browser, ready to edit. ' +
      'Call connect_browser first. REQUIRES the user to already be signed in to Overleaf in that browser — ' +
      'if they are not, this fails and you must ask them to sign in themselves. NEVER type an Overleaf ' +
      'password, click "Log in", or fill a login form for them. Read-only: opens and checks, changes nothing.',
    parameters: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description:
            'The project URL ("https://www.overleaf.com/project/<id>") or the bare 24-character project id. ' +
            'Ask the user which project — never guess.'
        }
      },
      required: ['project']
    }
  },
  {
    name: 'overleaf_write_latex',
    description:
      'Type LaTeX into the Overleaf project opened by overleaf_open_project, live, where the user can watch. ' +
      'This edits the user’s real document and always asks for confirmation first. ' +
      'It does NOT compile, share, publish, or submit anything.\n' +
      'CHOOSING BETWEEN THIS AND write_latex: use THIS one when the text must land in an EXISTING Overleaf ' +
      'project the user already has — they named a project, gave an overleaf.com/project/... URL, or asked ' +
      'to add to / edit "my Overleaf". Use write_latex instead to author a NEW paper as a local .tex file ' +
      'when no specific Overleaf project is involved.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The LaTeX source to write.' },
        mode: {
          type: 'string',
          description:
            '"replace" (default) overwrites the whole document; "append" adds to the end. ' +
            'Prefer "append" unless the user asked to start over.'
        }
      },
      required: ['content']
    }
  },
  {
    name: 'overleaf_read_latex',
    description:
      'Read back the LaTeX currently shown in the open Overleaf project’s editor. Read-only. ' +
      'Note that CodeMirror only renders the visible lines, so a long document is truncated.',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'overleaf_recompile',
    description:
      'Rebuild the PDF preview of the open Overleaf project so the user can see the rendered output. ' +
      'Asks for confirmation because it uses the user’s compile quota. ' +
      'This does NOT share, publish, or submit the project — OpenUI has no tool that can.',
    parameters: { type: 'object', properties: {}, required: [] }
  }
]

export const overleafRegistry: Record<
  string,
  (args: Record<string, unknown>, context?: ExecutorContext) => Promise<ToolResult>
> = {
  overleaf_open_project,
  overleaf_write_latex,
  overleaf_read_latex: () => overleaf_read_latex(),
  overleaf_recompile: () => overleaf_recompile()
}
