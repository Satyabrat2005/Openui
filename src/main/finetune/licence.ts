/**
 * licence.ts — the in-app half of the base-model licence guard.
 *
 * scripts/finetune/licence_guard.py stops a non-commercially licensed base from
 * being trained on or packaged from the command line. The scheduled fine-tune
 * pass (pipeline.ts) has its own route onto the GPU: it builds
 * `FROM <BASE_OLLAMA_MODEL>`, and that base is overridable by OLLAMA_CODE_MODEL.
 * Pointed at `qwen2.5-coder:3b`, it would quietly produce a research-licensed
 * derivative on a user's machine and promote it into service — the same way
 * openui-splen:v2 ended up carrying the Qwen RESEARCH licence in its manifest.
 *
 * The classifier is a port of the Python one, in the same order (non-commercial
 * terms are checked FIRST), and both are pinned to the same fixture file
 * (scripts/finetune/licence-fixtures.json) so they cannot drift apart.
 *
 * It reads the licence Ollama actually attached to the weights (`/api/show`),
 * never the model's name.
 */

export type LicenceVerdict = 'research' | 'apache' | 'mit' | 'unknown'

const RESEARCH_RE =
  /research\s+licen[cs]e|non[-\s]?commercial|research\s+or\s+evaluation\s+purposes\s+only|^\s*licen[cs]e_name:\s*\S*research\S*\s*$/im
const APACHE_RE = /apache\s+licen[cs]e,?\s*(version\s*)?2\.0|^\s*license:\s*apache-2\.0\s*$/im
const MIT_RE = /\bMIT\s+Licen[cs]e\b|^\s*license:\s*mit\s*$/im

export function classifyLicence(text: string | null | undefined): LicenceVerdict {
  if (!text || !text.trim()) return 'unknown'
  if (RESEARCH_RE.test(text)) return 'research'
  if (APACHE_RE.test(text)) return 'apache'
  if (MIT_RE.test(text)) return 'mit'
  return 'unknown'
}

/** Only these may be fine-tuned into something that ships. */
export function isCommercialLicence(verdict: LicenceVerdict): boolean {
  return verdict === 'apache' || verdict === 'mit'
}

/**
 * Ask Ollama for the licence text attached to `model`. Returns null when it
 * cannot be read at all, which callers must treat as NOT allowed.
 */
export async function fetchOllamaLicence(baseUrl: string, model: string): Promise<string | null> {
  try {
    const res = await fetch(`${baseUrl}/api/show`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(5000)
    })
    if (!res.ok) return null
    const body = (await res.json()) as { license?: unknown }
    const lic = body.license
    if (typeof lic === 'string') return lic
    if (Array.isArray(lic)) return lic.filter((l) => typeof l === 'string').join('\n')
    return ''
  } catch {
    return null
  }
}
