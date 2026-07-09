/**
 * designFlow.ts — the "design in browser" path (Task 2), deliberately separate
 * from the GitHub tools. Designing is a local, iterative loop: write an HTML
 * page into the workspace, open it in the user's default browser, refine on
 * feedback. Publishing to GitHub is a DIFFERENT decision the user takes later
 * via the repo automation tools (create_repo → push_files → open_pull_request);
 * nothing here touches the network or a remote.
 */
import { join } from 'node:path'
import { shell } from 'electron'
import { writeSandboxFile, getWorkspaceDir } from './sandbox'
import type { ToolResult, ToolSchema } from './tools'

// One design page per named slot; re-preview with the same name to iterate.
const DESIGN_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const MAX_DESIGN_HTML_CHARS = 400_000

/**
 * Write a self-contained HTML page to the workspace (designs/<name>.html) and
 * open it in the user's default browser. Calling it again with the same name
 * overwrites the file, so the user refreshes the tab to see the new revision.
 */
async function design_preview(args: Record<string, unknown>): Promise<ToolResult> {
  const name = typeof args.name === 'string' ? args.name.trim() : ''
  const html = typeof args.html === 'string' ? args.html : ''
  if (!DESIGN_NAME_RE.test(name)) {
    return {
      ok: false,
      error: 'design_preview requires a short alphanumeric "name" (letters, digits, - or _).'
    }
  }
  if (!html.trim()) return { ok: false, error: 'design_preview requires non-empty "html".' }
  if (html.length > MAX_DESIGN_HTML_CHARS) {
    return {
      ok: false,
      error: `design_preview "html" exceeds the ${MAX_DESIGN_HTML_CHARS}-character limit — split assets or trim the page.`
    }
  }
  try {
    const relPath = await writeSandboxFile(`designs/${name}.html`, html)
    const absPath = join(getWorkspaceDir(), relPath)
    const openErr = await shell.openPath(absPath)
    return {
      ok: true,
      output:
        `Design "${name}" written to ${absPath}` +
        (openErr
          ? ` (could not auto-open: ${openErr} — the user can open the file manually).`
          : ' and opened in the default browser.') +
        ` To iterate, call design_preview again with the same name and the revised HTML; the user just refreshes the tab.`
    }
  } catch (err) {
    return {
      ok: false,
      error: `design_preview failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}

export const designToolSchemas: ToolSchema[] = [
  {
    name: 'design_preview',
    description:
      'DESIGN-IN-BROWSER: write a self-contained HTML page (inline CSS/JS) into the workspace and open it in the user’s ' +
      'default browser for review. Use this when the user asks you to design, mock up, or prototype a page/site — iterate by ' +
      'calling it again with the SAME name after feedback. This is a local preview only: publish to GitHub later (and only if ' +
      'the user asks) with create_repo → push_files → open_pull_request.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Short identifier for this design, e.g. "landing-page". Reuse it to update the same preview.'
        },
        html: {
          type: 'string',
          description: 'The complete HTML document (inline all CSS/JS — no external build step).'
        }
      },
      required: ['name', 'html']
    }
  }
]

export const designRegistry = { design_preview }
