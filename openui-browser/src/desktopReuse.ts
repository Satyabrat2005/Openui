// Bridge to the desktop app's PROVEN document/paper logic. Rather than writing
// thinner reimplementations of docx/pdf/pptx/arXiv generation, the web service
// imports the exact modules the desktop ships (Openui/src/main/{worddoc,pdf,
// presentation,paperResearch}.ts) and drives them. Those modules are headless-
// importable: they only `import type` from the Electron-coupled `./tools` (erased
// at runtime) and otherwise depend on clean libraries (docx, pdf-lib, pptxgenjs)
// resolved from the desktop node_modules. Verified by round-trip tests.
//
// The desktop tools write to disk (confined to the home tree by resolveSafePath)
// and return a text summary. The web needs BYTES to serve, so we point them at a
// short-lived staging file under the home dir, read the bytes back, then delete
// the staging artefacts. The caller (server.ts) serves the bytes via putFile.

import { pathToFileURL, fileURLToPath } from 'node:url'
import { mkdir, readFile, rm, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname, isAbsolute } from 'node:path'
import { randomBytes } from 'node:crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * Where the desktop main-process source lives. Defaults to the sibling checkout
 * (Downloads/Openui-main/src/main relative to Downloads/openui-web/src), and is
 * overridable so a deployment can point at a vendored copy. Reuse is only
 * possible when this path resolves — the server logs a clear error at boot if not.
 */
export const DESKTOP_MAIN =
  process.env.OPENUI_DESKTOP_MAIN?.trim() || join(__dirname, '..', '..', 'Openui-main', 'src', 'main')

function modUrl(file: string): string {
  return pathToFileURL(join(DESKTOP_MAIN, file)).href
}

// Lazily import each desktop module once. `any` because we cross a package
// boundary with no shared type project; the shapes are exercised by tests.
/* eslint-disable @typescript-eslint/no-explicit-any */
const cache = new Map<string, Promise<any>>()
function load(file: string): Promise<any> {
  let p = cache.get(file)
  if (!p) {
    p = import(modUrl(file))
    cache.set(file, p)
  }
  return p
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface GeneratedFile {
  filename: string
  bytes: Buffer
}

interface DesktopToolResult {
  ok: boolean
  output?: string
  error?: string
}

/** A fresh staging directory under the home tree (resolveSafePath confines
 *  mutating writes to home, so /tmp on another volume would be refused). */
async function stageDir(): Promise<string> {
  const dir = join(homedir(), '.openui-web-stage', randomBytes(8).toString('hex'))
  await mkdir(dir, { recursive: true })
  return dir
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}

function safeLeaf(name: string, fallback: string, ext: string): string {
  const base = (typeof name === 'string' ? name : '').trim().replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120) || fallback
  return base.toLowerCase().endsWith(ext) ? base : `${base}${ext}`
}

// ── create_document → real .docx (reuses worddoc.writeDocFromSpec / renderDoc) ──
export async function generateDocx(args: { title?: string; paragraphs?: unknown; body?: unknown }): Promise<GeneratedFile> {
  const worddoc = await load('worddoc.ts')
  const title = typeof args.title === 'string' ? args.title.trim() : ''
  const paras = Array.isArray(args.paragraphs)
    ? args.paragraphs.map((p) => String(p ?? ''))
    : typeof args.body === 'string'
      ? [args.body]
      : []
  // Build the same DocSpec shape the desktop create_document/add_paragraph build,
  // then let the SHARED renderer (renderDoc, incl. the mkdir fix from PR #152)
  // produce the .docx — no reimplementation of docx construction here.
  const blocks: unknown[] = []
  if (title) blocks.push({ kind: 'heading', text: title, level: 1 })
  for (const p of paras) if (p) blocks.push({ kind: 'paragraph', runs: [{ text: p }] })
  if (blocks.length === 0) blocks.push({ kind: 'paragraph', runs: [{ text: '' }] })

  const dir = await stageDir()
  const filename = safeLeaf(title, 'Document', '.docx')
  const file = join(dir, filename)
  try {
    await worddoc.writeDocFromSpec(file, { version: 1, title: title || undefined, blocks })
    return { filename, bytes: await readFile(file) }
  } finally {
    await cleanup(dir)
  }
}

// ── create_pdf → real .pdf (reuses pdfRegistry.create_pdf → renderDocSpec/savePdf) ──
export async function generatePdf(args: { title?: string; content?: unknown }): Promise<GeneratedFile> {
  const pdf = await load('pdf.ts')
  const dir = await stageDir()
  const filename = safeLeaf(typeof args.title === 'string' ? args.title : '', 'Document', '.pdf')
  const file = join(dir, filename)
  try {
    const res: DesktopToolResult = await pdf.pdfRegistry.create_pdf({
      path: file,
      title: args.title,
      content: args.content
    })
    if (!res.ok) throw new Error(res.error || 'create_pdf failed')
    return { filename, bytes: await readFile(file) }
  } finally {
    await cleanup(dir)
  }
}

// ── create_presentation → real .pptx (reuses create_presentation + add_slide) ──
export async function generatePptx(args: { title?: string; slides?: unknown }): Promise<GeneratedFile> {
  const pres = await load('presentation.ts')
  const dir = await stageDir()
  const filename = safeLeaf(typeof args.title === 'string' ? args.title : '', 'Presentation', '.pptx')
  const file = join(dir, filename)
  try {
    const created: DesktopToolResult = await pres.presentationRegistry.create_presentation({
      path: file,
      title: args.title
    })
    if (!created.ok) throw new Error(created.error || 'create_presentation failed')
    // Each content slide flows through the SAME add_slide logic the desktop uses.
    const slides = Array.isArray(args.slides) ? args.slides : []
    for (const raw of slides) {
      const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
      const content: Record<string, unknown> = {
        heading: s.heading ?? s.title,
        subtitle: s.subtitle,
        bullets: s.bullets ?? s.body,
        notes: s.notes
      }
      const layout = typeof s.layout === 'string' ? s.layout : 'title+content'
      const added: DesktopToolResult = await pres.presentationRegistry.add_slide({ path: file, layout, content })
      if (!added.ok) throw new Error(added.error || 'add_slide failed')
    }
    return { filename, bytes: await readFile(file) }
  } finally {
    await cleanup(dir)
  }
}

// ── search_papers → arXiv + Semantic Scholar (reuses paperResearch.search_papers) ──
export async function searchPapers(args: { query?: string; max_results?: number }): Promise<DesktopToolResult> {
  const pr = await load('paperResearch.ts')
  return pr.search_papers({ query: args.query, max_results: args.max_results })
}

// ── download_paper → real .pdf bytes (reuses paperResearch.download_paper) ──
export async function downloadPaper(args: { pdf_url?: string }): Promise<GeneratedFile> {
  const pr = await load('paperResearch.ts')
  // Relative dest_folder resolves under home (resolveSafePath); use a unique leaf.
  const rel = join('.openui-web-stage', randomBytes(8).toString('hex'))
  const absDir = join(homedir(), rel)
  try {
    const res: DesktopToolResult = await pr.download_paper({ pdf_url: args.pdf_url, dest_folder: rel })
    if (!res.ok) throw new Error(res.error || 'download_paper failed')
    // The desktop tool reports "Downloaded PDF to:\n<absolute path>". Read it back;
    // fall back to scanning the folder if the format ever changes.
    const line = (res.output || '').split('\n').map((l) => l.trim()).filter(Boolean).pop() || ''
    let file = line && isAbsolute(line) ? line : ''
    if (!file) {
      const names = await readdir(absDir)
      const pdfName = names.find((n) => n.toLowerCase().endsWith('.pdf'))
      if (!pdfName) throw new Error('download_paper produced no PDF')
      file = join(absDir, pdfName)
    }
    const filename = safeLeaf(file.split(/[\\/]/).pop() || '', 'paper', '.pdf')
    return { filename, bytes: await readFile(file) }
  } finally {
    await cleanup(absDir)
  }
}

/** True when the desktop reuse modules resolve — logged at server boot. */
export async function desktopReuseAvailable(): Promise<boolean> {
  try {
    await load('worddoc.ts')
    return true
  } catch {
    return false
  }
}
