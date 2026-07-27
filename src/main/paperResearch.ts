/**
 * paperResearch.ts — the academic-research pipeline for the OpenUI agent.
 *
 * "Researcher gives a query → find, download, and summarise the relevant papers."
 *
 * Four self-contained tools (schemas + registry), mirroring figma.ts /
 * spreadsheet.ts so registration in tools.ts is a single import + spread:
 *
 *   search_papers(query, max_results?)      — arXiv + Semantic Scholar REST APIs
 *   download_paper(pdf_url, dest_folder?)   — HTTPS-only, size-capped PDF download
 *   summarize_paper(pdf_path, dest_folder?) — read_pdf → chat-proxy → <slug>.md
 *   research_papers(query, max_results?)     — the end-to-end orchestrator
 *
 * WHY REAL APIS, NOT SCRAPING: arXiv (export.arxiv.org/api/query, Atom XML) and
 * Semantic Scholar (api.semanticscholar.org/graph/v1) both expose free, documented
 * REST endpoints — far more reliable than browsing search results and guessing
 * which links are papers. No auth is needed at reasonable volumes on either API;
 * a conservative delay is inserted between repeated calls.
 *
 * SECURITY / SAFETY:
 *   - PDF downloads are HTTPS-only, follow ≤5 redirects, and are byte-capped
 *     (mirrors figma.ts's downloadBuffer). No file: / http: / data: URLs.
 *   - Every write path passes through resolveSafePath({ mutating: true }) so the
 *     agent can only write inside the user's home tree, never over credentials.
 *   - Summaries route through the chat-proxy Edge Function (callChatProxyText),
 *     so OUR Anthropic key stays server-side — never a direct API key.
 *   - Result / paper / text counts are capped so one call can't become a bulk
 *     downloader or flood the model context.
 *   - research_papers (the batch orchestrator) is registered in
 *     STATE_CHANGING_TOOLS with a SINGLE approval covering the whole run, so a
 *     10-paper request is one click, not ten.
 */

import { request as httpsRequest } from 'node:https'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join as joinPath, basename, extname } from 'node:path'
import { resolveSafePath } from './fs/pathSafety'
import { callChatProxyText } from './edgeFunctions'
import type { ExecutorContext, ToolResult, ToolSchema } from './tools'

// ── Caps ──────────────────────────────────────────────────────────────────────

/** Max results a single search_papers call returns / research_papers processes. */
const MAX_RESULTS = 10
/** Default when the caller omits max_results. */
const DEFAULT_RESULTS = 10
/** Hard cap on a downloaded PDF (papers are bigger than the 10 MB image cap). */
const MAX_PDF_BYTES = 50 * 1024 * 1024
/** How much extracted PDF text we feed the model — keeps the prompt bounded. */
const MAX_PDF_TEXT_CHARS = 24_000
/** Reject absurd queries early. */
const MAX_QUERY_CHARS = 500
/** Conservative delay between repeated network calls (arXiv asks for ~3s; PDF
 *  fetches are lighter). Applied between the two search backends and between
 *  each paper in the orchestrator so we never hammer either host. */
const REQUEST_DELAY_MS = 1_000

/** Default folder (relative to home) papers + summaries are saved into. Sits in
 *  the same research area as research_audit / write_latex. */
const DEFAULT_DEST_FOLDER = 'OpenUI Research/papers'

// ── small helpers ───────────────────────────────────────────────────────────

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Lowercase, hyphenated, length-capped slug safe for a filename. */
export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return slug || 'paper'
}

/** Collapse runs of whitespace (Atom titles/abstracts wrap across lines). */
function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/** Decode the handful of XML entities arXiv's Atom feed uses. */
export function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&') // last, so "&amp;lt;" → "&lt;" not "<"
}

/** Normalise a title for dedupe: lowercase alphanumerics only. */
function titleKey(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

// ── shared paper shape ────────────────────────────────────────────────────────

export interface PaperResult {
  title: string
  authors: string[]
  abstract: string
  /** Publication / submission date (ISO-ish string as the API returns it). */
  published: string
  /** Direct PDF URL (https), or '' when no open-access PDF is available. */
  pdfUrl: string
  source: 'arxiv' | 'semanticscholar'
  /** arXiv id or Semantic Scholar paperId. */
  id: string
  /** Human-facing landing page. */
  url: string
}

// ── network plumbing ──────────────────────────────────────────────────────────

/** GET a text body from an HTTPS host (used for arXiv's Atom XML). */
function httpsGetText(hostname: string, path: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname,
        port: 443,
        path,
        method: 'GET',
        headers: { Accept: 'application/atom+xml, application/xml, text/xml', 'User-Agent': 'OpenUI/1.0' }
      },
      (res) => {
        const status = res.statusCode ?? 200
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          if (status >= 400) {
            reject(new Error(`${hostname} HTTP ${status}: ${raw.slice(0, 200)}`))
            return
          }
          resolve(raw)
        })
        res.on('error', reject)
      }
    )
    req.on('error', reject)
    req.end()
  })
}

/** GET and JSON-parse a body from an HTTPS host (used for Semantic Scholar). */
function httpsGetJson(hostname: string, path: string): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname,
        port: 443,
        path,
        method: 'GET',
        headers: { Accept: 'application/json', 'User-Agent': 'OpenUI/1.0' }
      },
      (res) => {
        const status = res.statusCode ?? 200
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          if (status >= 400) {
            reject(new Error(`${hostname} HTTP ${status}: ${raw.slice(0, 200)}`))
            return
          }
          try {
            resolve(JSON.parse(raw))
          } catch {
            reject(new Error(`${hostname} returned non-JSON: ${raw.slice(0, 200)}`))
          }
        })
        res.on('error', reject)
      }
    )
    req.on('error', reject)
    req.end()
  })
}

/**
 * Download a PDF into a Buffer over HTTPS, following ≤5 redirects and enforcing
 * MAX_PDF_BYTES. Mirrors figma.ts's downloadBuffer redirect-limit + size-cap
 * pattern exactly; rejects any non-HTTPS URL so a redirect can't downgrade us to
 * http: or a file: URL.
 */
export function downloadPdfBuffer(url: string, redirectDepth = 0): Promise<Buffer> {
  if (redirectDepth > 5) {
    return Promise.reject(new Error('Too many redirects while downloading the PDF.'))
  }
  if (!url.startsWith('https://')) {
    return Promise.reject(
      new Error(`download_paper: only https:// URLs are accepted (got "${url.slice(0, 80)}…").`)
    )
  }

  return new Promise<Buffer>((resolve, reject) => {
    const req = httpsRequest(url, (res) => {
      const status = res.statusCode ?? 200
      if (status >= 300 && status < 400 && res.headers.location) {
        // Resolve relative redirects against the current URL; force https below.
        let next: string
        try {
          next = new URL(res.headers.location, url).toString()
        } catch {
          reject(new Error('Bad redirect location while downloading the PDF.'))
          return
        }
        res.resume()
        downloadPdfBuffer(next, redirectDepth + 1).then(resolve).catch(reject)
        return
      }
      if (status >= 400) {
        reject(new Error(`PDF download failed with HTTP ${status}.`))
        return
      }
      const chunks: Buffer[] = []
      let total = 0
      res.on('data', (chunk: Buffer) => {
        total += chunk.length
        if (total > MAX_PDF_BYTES) {
          req.destroy()
          reject(new Error(`PDF exceeds the ${Math.round(MAX_PDF_BYTES / 1024 / 1024)} MB download cap.`))
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

// ── arXiv ─────────────────────────────────────────────────────────────────────

/** Build the arXiv API query path. Searches all fields, newest first. */
export function buildArxivQueryPath(query: string, maxResults: number): string {
  const n = Math.max(1, Math.min(MAX_RESULTS, Math.floor(maxResults) || DEFAULT_RESULTS))
  const q = encodeURIComponent(`all:${query}`)
  return `/api/query?search_query=${q}&start=0&max_results=${n}&sortBy=relevance&sortOrder=descending`
}

/** Force an http(s) arXiv link to https (the Atom feed emits http:// links). */
function toHttps(url: string): string {
  return url.startsWith('http://') ? 'https://' + url.slice('http://'.length) : url
}

/**
 * Parse an arXiv Atom feed into PaperResult[]. Pure + regex-based (no XML dep):
 * arXiv's Atom is flat and predictable, so we split on <entry> and pull the few
 * fields we need. Every arXiv entry has a PDF, so pdfUrl is always populated.
 */
export function parseArxivAtom(xml: string): PaperResult[] {
  const results: PaperResult[] = []
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g
  let m: RegExpExecArray | null
  while ((m = entryRe.exec(xml)) !== null) {
    const entry = m[1]

    const titleRaw = /<title>([\s\S]*?)<\/title>/.exec(entry)?.[1] ?? ''
    const title = collapseWhitespace(unescapeXml(titleRaw))
    if (!title) continue

    const abstractRaw = /<summary>([\s\S]*?)<\/summary>/.exec(entry)?.[1] ?? ''
    const abstract = collapseWhitespace(unescapeXml(abstractRaw))

    const published = (/<published>([\s\S]*?)<\/published>/.exec(entry)?.[1] ?? '').trim()

    const idRaw = (/<id>([\s\S]*?)<\/id>/.exec(entry)?.[1] ?? '').trim()
    // …/abs/2101.00001v1 → 2101.00001v1
    const arxivId = idRaw.split('/abs/')[1] ?? idRaw

    const authors: string[] = []
    const nameRe = /<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g
    let a: RegExpExecArray | null
    while ((a = nameRe.exec(entry)) !== null) {
      const name = collapseWhitespace(unescapeXml(a[1]))
      if (name) authors.push(name)
    }

    // Prefer the declared PDF link; else derive it from the id.
    let pdfUrl = ''
    const linkRe = /<link\b([^>]*)\/?>/g
    let l: RegExpExecArray | null
    while ((l = linkRe.exec(entry)) !== null) {
      const attrs = l[1]
      const href = /href="([^"]*)"/.exec(attrs)?.[1] ?? ''
      const type = /type="([^"]*)"/.exec(attrs)?.[1] ?? ''
      const titleAttr = /title="([^"]*)"/.exec(attrs)?.[1] ?? ''
      if (href && (type === 'application/pdf' || titleAttr === 'pdf')) {
        pdfUrl = toHttps(href)
        break
      }
    }
    if (!pdfUrl && arxivId) pdfUrl = `https://arxiv.org/pdf/${arxivId}`

    results.push({
      title,
      authors,
      abstract,
      published,
      pdfUrl,
      source: 'arxiv',
      id: arxivId,
      url: toHttps(idRaw) || (arxivId ? `https://arxiv.org/abs/${arxivId}` : '')
    })
  }
  return results
}

async function searchArxiv(query: string, maxResults: number): Promise<PaperResult[]> {
  const xml = await httpsGetText('export.arxiv.org', buildArxivQueryPath(query, maxResults))
  return parseArxivAtom(xml)
}

// ── Semantic Scholar ──────────────────────────────────────────────────────────

/** Build the Semantic Scholar paper-search path with the fields we surface. */
export function buildSemanticScholarPath(query: string, maxResults: number): string {
  const n = Math.max(1, Math.min(MAX_RESULTS, Math.floor(maxResults) || DEFAULT_RESULTS))
  const q = encodeURIComponent(query)
  const fields = encodeURIComponent('title,authors,abstract,publicationDate,openAccessPdf,externalIds,url')
  return `/graph/v1/paper/search?query=${q}&limit=${n}&fields=${fields}`
}

/**
 * Parse a Semantic Scholar /paper/search JSON response into PaperResult[].
 * Pure + defensive: the API omits fields freely, so every access is guarded.
 * pdfUrl comes from openAccessPdf.url when present (else '').
 */
export function parseSemanticScholarJson(body: unknown): PaperResult[] {
  const out: PaperResult[] = []
  const data = (body as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) return out
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') continue
    const p = raw as Record<string, unknown>
    const title = typeof p.title === 'string' ? collapseWhitespace(p.title) : ''
    if (!title) continue
    const abstract = typeof p.abstract === 'string' ? collapseWhitespace(p.abstract) : ''
    const published = typeof p.publicationDate === 'string' ? p.publicationDate : ''
    const id = typeof p.paperId === 'string' ? p.paperId : ''
    const authors = Array.isArray(p.authors)
      ? p.authors
          .map((au) => (au && typeof au === 'object' ? (au as { name?: unknown }).name : undefined))
          .filter((n): n is string => typeof n === 'string' && n.trim() !== '')
      : []
    const oa = p.openAccessPdf
    const pdfUrlRaw =
      oa && typeof oa === 'object' && typeof (oa as { url?: unknown }).url === 'string'
        ? (oa as { url: string }).url
        : ''
    const pdfUrl = pdfUrlRaw.startsWith('https://') ? pdfUrlRaw : '' // https-only downloads
    const url = typeof p.url === 'string' ? p.url : id ? `https://www.semanticscholar.org/paper/${id}` : ''
    out.push({ title, authors, abstract, published, pdfUrl, source: 'semanticscholar', id, url })
  }
  return out
}

async function searchSemanticScholar(query: string, maxResults: number): Promise<PaperResult[]> {
  const body = await httpsGetJson('api.semanticscholar.org', buildSemanticScholarPath(query, maxResults))
  return parseSemanticScholarJson(body)
}

/**
 * Merge two result lists, arXiv first, de-duplicating by normalised title, and
 * cap the total. arXiv results always have a PDF; Semantic Scholar fills the
 * remainder (and only its entries with an open-access PDF are worth downloading).
 */
export function mergePapers(primary: PaperResult[], secondary: PaperResult[], cap: number): PaperResult[] {
  const seen = new Set<string>()
  const merged: PaperResult[] = []
  for (const p of [...primary, ...secondary]) {
    const key = titleKey(p.title)
    if (!key || seen.has(key)) continue
    seen.add(key)
    merged.push(p)
    if (merged.length >= cap) break
  }
  return merged
}

// ── PDF text extraction ───────────────────────────────────────────────────────

/**
 * Extract text from a PDF buffer using pdf-parse (v2's PDFParse class API).
 * Isolated here so the tool code doesn't depend on the library's shape.
 */
async function extractPdfText(buf: Buffer): Promise<string> {
  // pdf-parse pulls in pdfjs at require time; keep it lazy so importing this
  // module (and its tests) stays cheap.
  const { PDFParse } = require('pdf-parse') as { PDFParse: new (o: unknown) => PdfParser }
  const parser = new PDFParse({ data: new Uint8Array(buf) })
  try {
    const result = await parser.getText()
    return typeof result?.text === 'string' ? result.text : ''
  } finally {
    try {
      await parser.destroy?.()
    } catch {
      /* best-effort cleanup */
    }
  }
}

interface PdfParser {
  getText(): Promise<{ text?: string }>
  destroy?(): Promise<void> | void
}

// ── summary prompt ────────────────────────────────────────────────────────────

/**
 * Build the structured-summary prompt. The response MUST start with a single
 * `Takeaway: …` line (parsed for the index) followed by the full markdown.
 */
export function buildSummaryPrompt(title: string, pdfText: string): string {
  const clipped = pdfText.slice(0, MAX_PDF_TEXT_CHARS)
  return (
    `You are summarising an academic paper for a researcher. Title: "${title}".\n\n` +
    'Write your answer in GitHub-flavoured Markdown with EXACTLY this shape:\n' +
    '1. A single first line: `Takeaway: <one sentence, the single most important finding>`\n' +
    '2. A blank line, then these sections as `##` headings:\n' +
    '   - Research Question\n' +
    '   - Method\n' +
    '   - Key Findings\n' +
    '   - Limitations\n' +
    'Be concise and faithful to the text; do not invent results not present.\n\n' +
    '--- PAPER TEXT (may be truncated) ---\n' +
    clipped
  )
}

/** Pull the one-line takeaway out of a generated summary (for index.md). */
export function extractTakeaway(summary: string): string {
  for (const line of summary.split('\n')) {
    const t = line.trim().replace(/^[>#*\-\s]+/, '')
    const m = /^takeaway:\s*(.+)$/i.exec(t)
    if (m) return collapseWhitespace(m[1])
    if (t) break // first non-empty line wasn't a takeaway; give up cheaply
  }
  // Fallback: first non-empty, non-heading line.
  for (const line of summary.split('\n')) {
    const t = line.trim()
    if (t && !t.startsWith('#')) return collapseWhitespace(t).slice(0, 200)
  }
  return '(no summary)'
}

// ── internal shared steps (used by tools AND the orchestrator) ─────────────────

/** Resolve + create the destination folder, returning its absolute path. */
async function ensureDestFolder(destFolder: unknown): Promise<string> {
  const raw = typeof destFolder === 'string' && destFolder.trim() ? destFolder.trim() : DEFAULT_DEST_FOLDER
  const abs = resolveSafePath(raw, { mutating: true })
  await mkdir(abs, { recursive: true })
  return abs
}

/** Derive a safe, .pdf-suffixed filename from a URL (fallback: a slug). */
function pdfFilenameFromUrl(url: string, fallback: string): string {
  let base = ''
  try {
    base = basename(new URL(url).pathname)
  } catch {
    base = ''
  }
  base = base.replace(/[^a-zA-Z0-9._-]/g, '')
  if (!base || base === '.pdf') base = `${slugify(fallback)}.pdf`
  if (extname(base).toLowerCase() !== '.pdf') base += '.pdf'
  return base
}

/** Download one PDF to an absolute folder; returns the saved absolute path. */
async function downloadOnePaper(pdfUrl: string, destAbs: string, fallbackName: string): Promise<string> {
  const buf = await downloadPdfBuffer(pdfUrl)
  const filePath = joinPath(destAbs, pdfFilenameFromUrl(pdfUrl, fallbackName))
  await writeFile(filePath, buf)
  return filePath
}

/** Summarise one already-downloaded PDF; writes <slug>.md, returns both. */
async function summarizeOnePaper(
  pdfAbsPath: string,
  destAbs: string,
  title: string,
  context?: ExecutorContext
): Promise<{ summary: string; mdPath: string }> {
  const buf = Buffer.from(await readFile(pdfAbsPath))
  const text = await extractPdfText(buf)
  if (!text.trim()) throw new Error('no extractable text (the PDF may be scanned images).')

  const summary = await callChatProxyText({
    modelKey: context?.tier === 'enterprise' ? 'enterprise-default' : 'pro-default',
    messages: [{ role: 'user', content: buildSummaryPrompt(title, text) }]
  })
  if (!summary.trim()) throw new Error('the summariser returned an empty response.')

  const slug = slugify(title || basename(pdfAbsPath, extname(pdfAbsPath)))
  const mdPath = joinPath(destAbs, `${slug}.md`)
  const md = `# ${title || slug}\n\nSource PDF: ${basename(pdfAbsPath)}\n\n${summary.trim()}\n`
  await writeFile(mdPath, md, 'utf8')
  return { summary: summary.trim(), mdPath }
}

// ── tool: search_papers ───────────────────────────────────────────────────────

export async function search_papers(args: Record<string, unknown>): Promise<ToolResult> {
  const query = typeof args.query === 'string' ? args.query.trim() : ''
  if (!query) return { ok: false, error: 'search_papers requires a non-empty "query".' }
  if (query.length > MAX_QUERY_CHARS) return { ok: false, error: 'search_papers "query" is too long.' }
  const maxResults = clampResults(args.max_results)

  try {
    let papers: PaperResult[] = []
    const notes: string[] = []

    // Primary: arXiv (always has a downloadable PDF).
    try {
      papers = await searchArxiv(query, maxResults)
    } catch (err) {
      notes.push(`arXiv search failed: ${errText(err)}`)
    }

    // Fill the remainder from Semantic Scholar when arXiv came up short.
    if (papers.length < maxResults) {
      await sleep(REQUEST_DELAY_MS)
      try {
        const s2 = await searchSemanticScholar(query, maxResults)
        papers = mergePapers(papers, s2, maxResults)
      } catch (err) {
        notes.push(`Semantic Scholar search failed: ${errText(err)}`)
      }
    }

    if (papers.length === 0) {
      return {
        ok: true,
        output: `No papers found for "${query}".${notes.length ? '\n\n' + notes.join('\n') : ''}`
      }
    }

    return { ok: true, output: formatSearchResults(query, papers, notes) }
  } catch (err) {
    return { ok: false, error: `search_papers failed: ${errText(err)}` }
  }
}

function clampResults(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
  if (!Number.isFinite(n)) return DEFAULT_RESULTS
  return Math.max(1, Math.min(MAX_RESULTS, Math.floor(n)))
}

function formatSearchResults(query: string, papers: PaperResult[], notes: string[]): string {
  const lines = [`Found ${papers.length} paper(s) for "${query}":`, '']
  papers.forEach((p, i) => {
    const authors =
      p.authors.length > 3 ? `${p.authors.slice(0, 3).join(', ')}, et al.` : p.authors.join(', ') || 'Unknown authors'
    lines.push(`${i + 1}. ${p.title}`)
    lines.push(`   ${authors}${p.published ? ` · ${p.published.slice(0, 10)}` : ''} · ${p.source}`)
    lines.push(`   ${p.pdfUrl ? `PDF: ${p.pdfUrl}` : 'No open-access PDF'}${p.url ? ` · ${p.url}` : ''}`)
    if (p.abstract) lines.push(`   ${p.abstract.slice(0, 240)}${p.abstract.length > 240 ? '…' : ''}`)
    lines.push('')
  })
  if (notes.length) lines.push(...notes)
  return lines.join('\n').trim()
}

// ── tool: download_paper ──────────────────────────────────────────────────────

export async function download_paper(args: Record<string, unknown>): Promise<ToolResult> {
  const pdfUrl = typeof args.pdf_url === 'string' ? args.pdf_url.trim() : ''
  if (!pdfUrl) return { ok: false, error: 'download_paper requires a "pdf_url".' }
  if (!pdfUrl.startsWith('https://')) {
    return { ok: false, error: 'download_paper: "pdf_url" must be an https:// URL.' }
  }
  try {
    const destAbs = await ensureDestFolder(args.dest_folder)
    const saved = await downloadOnePaper(pdfUrl, destAbs, pdfUrl)
    return { ok: true, output: `Downloaded PDF to:\n${saved}` }
  } catch (err) {
    return { ok: false, error: `download_paper failed: ${errText(err)}` }
  }
}

// ── tool: summarize_paper ─────────────────────────────────────────────────────

export async function summarize_paper(
  args: Record<string, unknown>,
  context?: ExecutorContext
): Promise<ToolResult> {
  const rawPath = typeof args.pdf_path === 'string' ? args.pdf_path.trim() : ''
  if (!rawPath) return { ok: false, error: 'summarize_paper requires a "pdf_path".' }
  let pdfAbs: string
  try {
    pdfAbs = resolveSafePath(rawPath, { mutating: false })
  } catch (err) {
    return { ok: false, error: `summarize_paper: ${errText(err)}` }
  }
  if (extname(pdfAbs).toLowerCase() !== '.pdf') {
    return { ok: false, error: 'summarize_paper: "pdf_path" must point to a .pdf file.' }
  }

  try {
    // Write the summary alongside the PDF unless dest_folder overrides it.
    const destAbs =
      typeof args.dest_folder === 'string' && args.dest_folder.trim()
        ? await ensureDestFolder(args.dest_folder)
        : joinPath(pdfAbs, '..')
    const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : basename(pdfAbs, '.pdf')
    const { summary, mdPath } = await summarizeOnePaper(pdfAbs, destAbs, title, context)
    return { ok: true, output: `Summary written to:\n${mdPath}\n\n${summary}` }
  } catch (err) {
    return { ok: false, error: `summarize_paper failed: ${errText(err)}` }
  }
}

// ── tool: research_papers (orchestrator) ──────────────────────────────────────

export async function research_papers(
  args: Record<string, unknown>,
  context?: ExecutorContext
): Promise<ToolResult> {
  const query = typeof args.query === 'string' ? args.query.trim() : ''
  if (!query) return { ok: false, error: 'research_papers requires a non-empty "query".' }
  if (query.length > MAX_QUERY_CHARS) return { ok: false, error: 'research_papers "query" is too long.' }
  const maxResults = clampResults(args.max_results)

  try {
    // 1. Search (arXiv, then Semantic Scholar for any shortfall).
    let papers: PaperResult[] = []
    try {
      papers = await searchArxiv(query, maxResults)
    } catch {
      /* fall through to S2 */
    }
    if (papers.length < maxResults) {
      await sleep(REQUEST_DELAY_MS)
      try {
        papers = mergePapers(papers, await searchSemanticScholar(query, maxResults), maxResults)
      } catch {
        /* keep whatever arXiv gave us */
      }
    }
    // Only papers with a downloadable PDF can be summarised.
    papers = papers.filter((p) => p.pdfUrl).slice(0, maxResults)
    if (papers.length === 0) {
      return { ok: true, output: `No papers with a downloadable PDF were found for "${query}".` }
    }

    // 2. Dedicated timestamped folder for this run.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const base = typeof args.dest_folder === 'string' && args.dest_folder.trim() ? args.dest_folder.trim() : DEFAULT_DEST_FOLDER
    const runFolder = `${base}/${slugify(query)}-${stamp}`
    const destAbs = await ensureDestFolder(runFolder)

    // 3. Download + summarise each paper sequentially (a delay between each so we
    //    never hammer arXiv / the summariser).
    const entries: { paper: PaperResult; takeaway: string; mdFile?: string; error?: string }[] = []
    for (let i = 0; i < papers.length; i++) {
      const paper = papers[i]
      const prefix = String(i + 1).padStart(2, '0')
      try {
        const pdfPath = await downloadOnePaper(paper.pdfUrl, destAbs, `${prefix}-${paper.title}`)
        const { summary, mdPath } = await summarizeOnePaper(pdfPath, destAbs, paper.title, context)
        entries.push({ paper, takeaway: extractTakeaway(summary), mdFile: basename(mdPath) })
      } catch (err) {
        entries.push({ paper, takeaway: '', error: errText(err) })
      }
      if (i < papers.length - 1) await sleep(REQUEST_DELAY_MS)
    }

    // 4. index.md linking every paper's own summary file.
    const indexPath = joinPath(destAbs, 'index.md')
    await writeFile(indexPath, buildIndexMarkdown(query, entries), 'utf8')

    const ok = entries.filter((e) => e.mdFile).length
    return {
      ok: true,
      output:
        `Researched "${query}": ${ok}/${papers.length} paper(s) downloaded + summarised.\n` +
        `Index: ${indexPath}\n\n` +
        entries
          .map((e, i) =>
            e.mdFile
              ? `${i + 1}. ${e.paper.title}\n   → ${e.takeaway || '(summary written)'}`
              : `${i + 1}. ${e.paper.title}\n   ⚠ ${e.error}`
          )
          .join('\n')
    }
  } catch (err) {
    return { ok: false, error: `research_papers failed: ${errText(err)}` }
  }
}

/** Build the index.md body listing every paper + a link to its summary file. */
export function buildIndexMarkdown(
  query: string,
  entries: { paper: PaperResult; takeaway: string; mdFile?: string; error?: string }[]
): string {
  const lines = [`# Research: ${query}`, '', `Generated ${new Date().toISOString()}`, '', `${entries.length} paper(s).`, '']
  entries.forEach((e, i) => {
    const { paper } = e
    const authors = paper.authors.length > 3 ? `${paper.authors.slice(0, 3).join(', ')}, et al.` : paper.authors.join(', ')
    lines.push(`## ${i + 1}. ${paper.title}`)
    if (authors) lines.push(`*${authors}*${paper.published ? ` · ${paper.published.slice(0, 10)}` : ''}`)
    if (paper.url) lines.push(`Source: ${paper.url}`)
    if (e.mdFile) {
      lines.push(`Summary: [${e.mdFile}](./${e.mdFile})`)
      if (e.takeaway) lines.push('', `> ${e.takeaway}`)
    } else {
      lines.push(`⚠ Not summarised: ${e.error}`)
    }
    lines.push('')
  })
  return lines.join('\n')
}

// ── schemas (LLM-facing surface) ──────────────────────────────────────────────

export const paperResearchToolSchemas: ToolSchema[] = [
  {
    name: 'search_papers',
    description:
      'Search academic papers via the arXiv and Semantic Scholar REST APIs (no scraping). Returns ' +
      'title, authors, abstract, publication date, and a PDF URL for each result. Read-only — it ' +
      'downloads nothing. This is the FIRST and ONLY tool to use for ANY "find / search for / look up a ' +
      'paper (or research/study/publication) about X" request — call it directly with the topic. Do NOT ' +
      'open a browser (open_app, browser_navigate, computer_use, browser_vision_act) to search Google ' +
      'Scholar/arXiv/the web for papers: this API does that for you instantly, works on every tier, and ' +
      'the vision/browser path is Pro-gated and will just fail on the free tier — opening a blank browser ' +
      'that goes nowhere. Use this to discover papers, then download_paper / summarize_paper for the ones ' +
      'you want. If the user says "find papers on X AND summarize them", use research_papers instead.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The topic or keywords to search for.' },
        max_results: {
          type: 'string',
          description: `How many results to return (1–${MAX_RESULTS}, default ${DEFAULT_RESULTS}).`
        }
      },
      required: ['query']
    }
  },
  {
    name: 'download_paper',
    description:
      'Download a single paper PDF from an https:// URL (e.g. a pdf_url from search_papers) into the ' +
      'workspace. HTTPS-only and size-capped. Saves under "OpenUI Research/papers/" unless dest_folder ' +
      'is given.',
    parameters: {
      type: 'object',
      properties: {
        pdf_url: { type: 'string', description: 'Direct https:// URL to the paper PDF.' },
        dest_folder: {
          type: 'string',
          description: 'Optional folder (relative to home) to save into. Default "OpenUI Research/papers".'
        }
      },
      required: ['pdf_url']
    }
  },
  {
    name: 'summarize_paper',
    description:
      'Read a downloaded PDF and write a structured Markdown summary (research question, method, key ' +
      'findings, limitations, one-line takeaway) as its own <slug>.md file next to the PDF. Returns the ' +
      'summary text too.',
    parameters: {
      type: 'object',
      properties: {
        pdf_path: { type: 'string', description: 'Path to a local .pdf file (e.g. from download_paper).' },
        title: { type: 'string', description: 'Optional paper title (used for the summary heading + filename).' },
        dest_folder: {
          type: 'string',
          description: 'Optional folder to write the .md into. Defaults to the PDF’s own folder.'
        }
      },
      required: ['pdf_path']
    }
  },
  {
    name: 'research_papers',
    description:
      'END-TO-END: find papers on a topic AND summarise them in one call. This is the tool to use when a ' +
      'user says "find papers on X and summarize them" — do NOT hand-chain search_papers + download_paper ' +
      '+ summarize_paper yourself, and never open a browser (open_app / browser_navigate / computer_use / ' +
      'browser_vision_act) to hunt for papers on the web: this searches real academic APIs directly and ' +
      `works on every tier. It searches (arXiv + Semantic Scholar), downloads up to ${MAX_RESULTS} PDFs, ` +
      'writes one <slug>.md summary per paper, and an index.md linking them all, into a timestamped folder ' +
      'under "OpenUI Research/papers/". One approval covers the whole batch.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The research topic to find and summarise papers for.' },
        max_results: {
          type: 'string',
          description: `Max papers to download + summarise (1–${MAX_RESULTS}, default ${DEFAULT_RESULTS}).`
        },
        dest_folder: {
          type: 'string',
          description: 'Optional base folder. Default "OpenUI Research/papers".'
        }
      },
      required: ['query']
    }
  }
]

export const paperResearchRegistry: Record<
  string,
  (args: Record<string, unknown>, context?: ExecutorContext) => Promise<ToolResult>
> = {
  search_papers,
  download_paper,
  summarize_paper,
  research_papers
}
