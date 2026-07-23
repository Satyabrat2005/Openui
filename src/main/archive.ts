/**
 * archive.ts — zip/unzip automation for the OpenUI agent (Part 6.2).
 *
 * Self-contained tool module (schemas + registry) mirroring spreadsheet.ts /
 * figma.ts. Three tools:
 *   create_zip(paths, output_path)      — compress files/folders into a .zip
 *   extract_zip(zip_path, dest_dir)     — decompress a .zip into a folder
 *   list_zip_contents(zip_path)         — read-only inventory of a .zip
 *
 * LIBRARY CHOICE — adm-zip:
 *   adm-zip is a single, pure-JS (no native build) dependency that handles BOTH
 *   directions cleanly with a synchronous, in-memory API — unlike the
 *   archiver + unzipper pair, which are two separate stream-only libraries (one
 *   write-only, one read-only) that would double the dependency surface and
 *   force a streaming state machine on us for no benefit at the file sizes a
 *   desktop assistant zips. adm-zip also exposes per-entry metadata
 *   (entryName, isDirectory, header.size) and per-entry getData(), which is
 *   exactly what the zip-slip and zip-bomb guards below need — extractAllTo()
 *   alone would give us no chance to vet an entry before it hits the disk.
 *
 * SECURITY / SAFETY:
 *   - Every path passes through resolveSafePath(): reads are blocked from
 *     sensitive dirs (SENSITIVE_PATH_RE); writes (the output zip, every
 *     extracted file, the dest dir) are additionally confined to the home tree.
 *   - ZIP-SLIP: each entry's resolved target is verified to stay inside the
 *     destination directory, so a crafted "../../.ssh/authorized_keys" entry
 *     cannot escape dest and overwrite files elsewhere.
 *   - ZIP-BOMB: extraction refuses once the cumulative UNCOMPRESSED size or the
 *     entry count crosses a hard cap, so a tiny hostile archive cannot fill the
 *     disk / exhaust memory. This is a real security control for a tool that
 *     decompresses untrusted input, not a cosmetic nicety.
 *   - create_zip / extract_zip are registered in STATE_CHANGING_TOOLS (tools.ts)
 *     so they are HITL-gated; list_zip_contents is read-only and is not.
 */

import { resolveSafePath } from './fs/pathSafety'
import type { ExecutorContext, ToolResult, ToolSchema } from './tools'
import { mkdir, writeFile, stat } from 'node:fs/promises'
import { resolve as resolvePath, join as joinPath, dirname, basename, sep } from 'node:path'

// Caps — keep a single accidental or hostile call from exhausting disk/memory.
const MAX_INPUT_PATHS = 512 // top-level paths accepted by create_zip
const MAX_ENTRIES = 20_000 // entries in an archive we will list/extract
const MAX_TOTAL_UNCOMPRESSED = 1024 * 1024 * 1024 // 1 GiB — zip-bomb ceiling
const MAX_LIST_LINES = 2_000
const MAX_OUTPUT_CHARS = 60_000

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Lazy require so unit tests importing this module never need adm-zip resolved
 *  until a tool actually runs (mirrors the native-dep pattern in tools.ts). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadAdmZip(): any {
  return require('adm-zip')
}

/** Human-readable byte size, e.g. 1536 → "1.5 KB". */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(1)} ${units[i]}`
}

/**
 * Normalise the `paths` argument (an array, or a comma / newline separated
 * string) into a trimmed, de-duplicated, capped list. Pure — exported for tests.
 */
export function coercePathList(raw: unknown): string[] {
  const list = Array.isArray(raw)
    ? raw.map((v) => String(v))
    : typeof raw === 'string'
      ? raw.split(/[\n,]/)
      : []
  const seen = new Set<string>()
  for (const item of list) {
    const p = item.trim()
    if (p) seen.add(p)
    if (seen.size >= MAX_INPUT_PATHS) break
  }
  return [...seen]
}

/**
 * True when `target` is the destination dir itself or lives inside it. This is
 * the zip-slip gate: an entry whose resolved path is NOT under dest is refused.
 * Pure — exported for tests.
 */
export function isInsideDir(dest: string, target: string): boolean {
  const d = resolvePath(dest)
  const t = resolvePath(target)
  return t === d || t.startsWith(d + sep)
}

// ── create_zip ─────────────────────────────────────────────────────────────────

async function create_zip(args: Record<string, unknown>): Promise<ToolResult> {
  const inputs = coercePathList(args.paths)
  if (inputs.length === 0) {
    return { ok: false, error: 'create_zip requires "paths": a file/folder path or an array of them.' }
  }
  let output: string
  try {
    output = resolveSafePath(args.output_path ?? args.output, { mutating: true })
  } catch (e) {
    return { ok: false, error: `create_zip: ${errText(e)}` }
  }
  if (!/\.zip$/i.test(output)) {
    return { ok: false, error: 'create_zip: "output_path" must end in .zip.' }
  }

  try {
    const AdmZip = loadAdmZip()
    const zip = new AdmZip()
    let added = 0
    for (const raw of inputs) {
      let abs: string
      try {
        abs = resolveSafePath(raw, { mutating: false })
      } catch (e) {
        return { ok: false, error: `create_zip: ${errText(e)}` }
      }
      let info
      try {
        info = await stat(abs)
      } catch {
        return { ok: false, error: `create_zip: path not found — "${raw}".` }
      }
      if (info.isDirectory()) {
        // Store the folder under its own name so the archive isn't a flat dump.
        zip.addLocalFolder(abs, basename(abs))
      } else {
        zip.addLocalFile(abs)
      }
      added++
    }
    await mkdir(dirname(output), { recursive: true })
    zip.writeZip(output)
    const size = (await stat(output)).size
    return {
      ok: true,
      output: `Created ${output} from ${added} path(s) — ${fmtBytes(size)} on disk.`
    }
  } catch (e) {
    return { ok: false, error: `create_zip failed: ${errText(e)}` }
  }
}

// ── extract_zip ────────────────────────────────────────────────────────────────

async function extract_zip(args: Record<string, unknown>): Promise<ToolResult> {
  let zipPath: string
  let dest: string
  try {
    zipPath = resolveSafePath(args.zip_path ?? args.path, { mutating: false })
  } catch (e) {
    return { ok: false, error: `extract_zip: ${errText(e)}` }
  }
  try {
    dest = resolveSafePath(args.dest_dir ?? args.dest ?? args.destination, { mutating: true })
  } catch (e) {
    return { ok: false, error: `extract_zip: ${errText(e)}` }
  }

  try {
    const AdmZip = loadAdmZip()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let entries: any[]
    try {
      const zip = new AdmZip(zipPath)
      entries = zip.getEntries()
    } catch (e) {
      return { ok: false, error: `extract_zip: could not read "${zipPath}" — ${errText(e)}` }
    }
    if (entries.length > MAX_ENTRIES) {
      return { ok: false, error: `extract_zip: archive has too many entries (${entries.length}, limit ${MAX_ENTRIES}).` }
    }

    await mkdir(dest, { recursive: true })
    let total = 0
    let written = 0
    for (const entry of entries) {
      const name = String(entry.entryName ?? '')
      // Zip-slip: resolve the target and confirm it stays inside dest.
      const targetAbs = resolvePath(joinPath(dest, name))
      if (!isInsideDir(dest, targetAbs)) {
        return {
          ok: false,
          error: `extract_zip: refused entry "${name}" — it escapes the destination folder (zip-slip).`
        }
      }
      // Defence in depth: still enforce the global filesystem boundary per entry.
      try {
        resolveSafePath(targetAbs, { mutating: true })
      } catch (e) {
        return { ok: false, error: `extract_zip: refused entry "${name}" — ${errText(e)}` }
      }

      if (entry.isDirectory) {
        await mkdir(targetAbs, { recursive: true })
        continue
      }
      // Zip-bomb: enforce the uncompressed-size ceiling BEFORE materialising data.
      total += Number(entry.header?.size ?? 0)
      if (total > MAX_TOTAL_UNCOMPRESSED) {
        return {
          ok: false,
          error: `extract_zip: aborted — uncompressed contents exceed the ${fmtBytes(MAX_TOTAL_UNCOMPRESSED)} safety cap (possible zip bomb).`
        }
      }
      await mkdir(dirname(targetAbs), { recursive: true })
      await writeFile(targetAbs, entry.getData())
      written++
    }
    return {
      ok: true,
      output: `Extracted ${written} file(s) (${fmtBytes(total)} uncompressed) from ${zipPath} into ${dest}.`
    }
  } catch (e) {
    return { ok: false, error: `extract_zip failed: ${errText(e)}` }
  }
}

// ── list_zip_contents ───────────────────────────────────────────────────────────

async function list_zip_contents(args: Record<string, unknown>): Promise<ToolResult> {
  let zipPath: string
  try {
    zipPath = resolveSafePath(args.zip_path ?? args.path, { mutating: false })
  } catch (e) {
    return { ok: false, error: `list_zip_contents: ${errText(e)}` }
  }
  try {
    const AdmZip = loadAdmZip()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let entries: any[]
    try {
      const zip = new AdmZip(zipPath)
      entries = zip.getEntries()
    } catch (e) {
      return { ok: false, error: `list_zip_contents: could not read "${zipPath}" — ${errText(e)}` }
    }

    let totalUncompressed = 0
    let fileCount = 0
    const lines: string[] = []
    for (const entry of entries) {
      const size = Number(entry.header?.size ?? 0)
      if (!entry.isDirectory) {
        totalUncompressed += size
        fileCount++
      }
      if (lines.length < MAX_LIST_LINES) {
        lines.push(
          entry.isDirectory
            ? `  ${String(entry.entryName)}  (dir)`
            : `  ${String(entry.entryName)}  (${fmtBytes(size)})`
        )
      }
    }
    const header =
      `${zipPath}: ${fileCount} file(s), ${entries.length} entr(y/ies), ` +
      `${fmtBytes(totalUncompressed)} uncompressed:`
    const extra = entries.length > MAX_LIST_LINES ? `\n… ${entries.length - MAX_LIST_LINES} more entr(y/ies) not shown.` : ''
    return { ok: true, output: `${header}\n${lines.join('\n')}${extra}`.slice(0, MAX_OUTPUT_CHARS) }
  } catch (e) {
    return { ok: false, error: `list_zip_contents failed: ${errText(e)}` }
  }
}

// ── schemas (LLM-facing surface) ─────────────────────────────────────────────

export const archiveToolSchemas: ToolSchema[] = [
  {
    name: 'create_zip',
    description:
      'Compress one or more files and/or folders into a single .zip archive. ' +
      'Use this to bundle files for sending or to back up a folder. Folders are added recursively. ' +
      'Prefer this over computer_use for zipping.',
    parameters: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          description:
            'The files/folders to compress: an array of paths (or a comma/newline-separated string). ' +
            'Each may be absolute, "~"-relative, or home-relative, e.g. ["~/Documents/report.pdf", "Downloads/photos"].',
          items: { type: 'string' }
        },
        output_path: {
          type: 'string',
          description: 'Destination .zip path inside your home folder, e.g. "~/Desktop/bundle.zip".'
        }
      },
      required: ['paths', 'output_path']
    }
  },
  {
    name: 'extract_zip',
    description:
      'Extract (decompress) a .zip archive into a destination folder. Use this to unpack a downloaded zip. ' +
      'Entries that would escape the destination folder are refused, and extraction stops if the uncompressed ' +
      'contents are implausibly large (zip-bomb protection).',
    parameters: {
      type: 'object',
      properties: {
        zip_path: { type: 'string', description: 'Path to the .zip file to extract.' },
        dest_dir: {
          type: 'string',
          description: 'Destination folder (created if missing) inside your home folder, e.g. "~/Downloads/unpacked".'
        }
      },
      required: ['zip_path', 'dest_dir']
    }
  },
  {
    name: 'list_zip_contents',
    description:
      'List the entries in a .zip archive (names, sizes, total uncompressed size) WITHOUT extracting anything. ' +
      'Read-only — use this to inspect a zip before deciding whether/where to extract it.',
    parameters: {
      type: 'object',
      properties: {
        zip_path: { type: 'string', description: 'Path to the .zip file to inspect.' }
      },
      required: ['zip_path']
    }
  }
]

export const archiveRegistry: Record<
  string,
  (args: Record<string, unknown>, context?: ExecutorContext) => Promise<ToolResult>
> = {
  create_zip,
  extract_zip,
  list_zip_contents
}
