/**
 * print.ts — print support for the OpenUI agent (Part 6.6).
 *
 * Self-contained tool module (schema + registry). One tool:
 *   print_file(path)  — send a local file to the printer.
 *
 * APPROACH — deliberately two-path, and the split is the honest engineering call
 * the task asked for:
 *
 *   1. Web-renderable content (.html/.htm/.txt): loaded into a hidden Electron
 *      BrowserWindow and printed with webContents.print({ silent:false }). This
 *      is exactly what webContents.print() is good at — content the Chromium
 *      engine already renders — and silent:false shows the native print dialog
 *      so the user still picks the printer and confirms. Cross-platform, no
 *      external tooling.
 *
 *   2. Everything else (.pdf, images, .docx, .xlsx, …): opened in the OS default
 *      app via shell.openPath(), where the user prints with Ctrl/Cmd+P.
 *
 * WHY NOT rundll32 printui / a "silent print" of arbitrary files: Windows'
 * `rundll32 printui.dll` manages PRINTERS, not document printing; the only
 * generic file-print route is ShellExecute's "print" verb, which is registered
 * inconsistently per file type, silently no-ops for many, and gives no error
 * when it fails. Driving that would be exactly the fragile, hard-to-maintain
 * path the project avoids. For non-web formats, opening the file in the app that
 * owns it — and letting the human press Print — is both MORE reliable and more
 * honest about what actually happens, so that is what this tool does. (Reported
 * as such in the tool's own output so the agent can tell the user.)
 *
 * SECURITY: the path goes through resolveSafePath (read-only) — the same trust
 * boundary as read_file. print_file is registered in STATE_CHANGING_TOOLS so it
 * takes one HITL approval before anything opens. electron is imported lazily so
 * the module loads in the plain-Node unit-test environment.
 */

import { resolveSafePath } from './fs/pathSafety'
import type { ExecutorContext, ToolResult, ToolSchema } from './tools'
import { existsSync } from 'node:fs'
import { extname } from 'node:path'

// Formats Chromium renders directly, so webContents.print() can drive them.
const RENDERABLE_EXT = new Set(['.html', '.htm', '.txt'])
const PRINT_TIMEOUT_MS = 60_000

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Decide how a file should be printed from its extension:
 *   'render' → load + webContents.print (web content)
 *   'open'   → open in the default app for the user to print
 * Pure — exported for unit tests.
 */
export function classifyPrintTarget(path: string): 'render' | 'open' {
  return RENDERABLE_EXT.has(extname(path).toLowerCase()) ? 'render' : 'open'
}

/** Print an HTML/text file via a hidden BrowserWindow + the native print dialog. */
async function printViaBrowserWindow(path: string): Promise<ToolResult> {
  const { BrowserWindow } = await import('electron')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let win: any = null
  try {
    win = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true }
    })
    await win.loadFile(path)

    const outcome = await new Promise<{ ok: boolean; message: string }>((resolve) => {
      const timer = setTimeout(
        () => resolve({ ok: false, message: 'the print dialog did not complete in time.' }),
        PRINT_TIMEOUT_MS
      )
      // silent:false → the OS print dialog is shown; the user picks the printer
      // and confirms (or cancels). The callback reports the final outcome.
      win.webContents.print({ silent: false, printBackground: true }, (success: boolean, failureReason: string) => {
        clearTimeout(timer)
        resolve(
          success
            ? { ok: true, message: 'sent to the printer.' }
            : { ok: false, message: failureReason || 'printing was cancelled.' }
        )
      })
    })
    return outcome.ok
      ? { ok: true, output: `Printed ${path} — ${outcome.message}` }
      : { ok: false, error: `print_file: ${outcome.message}` }
  } catch (e) {
    return { ok: false, error: `print_file failed: ${errText(e)}` }
  } finally {
    try {
      if (win && !win.isDestroyed()) win.destroy()
    } catch {
      /* window already gone */
    }
  }
}

/** Open a non-web file in its default app so the user can print it (Ctrl/Cmd+P). */
async function printViaDefaultApp(path: string): Promise<ToolResult> {
  try {
    const { shell } = await import('electron')
    const err = await shell.openPath(path)
    if (err) return { ok: false, error: `print_file: could not open "${path}" — ${err}` }
    return {
      ok: true,
      output:
        `Opened ${path} in its default app for printing. This file type can't be sent to the printer ` +
        `directly, so press Ctrl/Cmd+P in the app that just opened to print it.`
    }
  } catch (e) {
    return { ok: false, error: `print_file failed: ${errText(e)}` }
  }
}

async function print_file(args: Record<string, unknown>): Promise<ToolResult> {
  let path: string
  try {
    path = resolveSafePath(args.path, { mutating: false })
  } catch (e) {
    return { ok: false, error: `print_file: ${errText(e)}` }
  }
  if (!existsSync(path)) return { ok: false, error: `print_file: file not found — "${path}".` }

  return classifyPrintTarget(path) === 'render'
    ? printViaBrowserWindow(path)
    : printViaDefaultApp(path)
}

// ── schema + registry ────────────────────────────────────────────────────────

export const printToolSchemas: ToolSchema[] = [
  {
    name: 'print_file',
    description:
      'Print a local file. HTML and text files are sent to the printer via the native print dialog ' +
      '(you pick the printer and confirm). Other formats (PDF, images, Office docs) are opened in their ' +
      'default app so you can print with Ctrl/Cmd+P. Use this when the user asks to print something.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to print (absolute, "~"-relative, or home-relative).' }
      },
      required: ['path']
    }
  }
]

export const printRegistry: Record<
  string,
  (args: Record<string, unknown>, context?: ExecutorContext) => Promise<ToolResult>
> = {
  print_file
}
