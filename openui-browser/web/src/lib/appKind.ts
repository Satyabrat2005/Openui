// Web-scoped appKind mapping: which "app" a web tool drives, for the TOUCHED
// audit rows and run-row chips. Smaller than the desktop map because the browser
// product only exposes the portable tool surface (docs, papers, github).
import type { AppKind } from '../types'

const BUILTIN: Record<string, AppKind> = {
  create_document: 'files',
  create_pdf: 'files',
  create_presentation: 'files',
  write_spreadsheet: 'files',
  read_spreadsheet: 'files',
  search_papers: 'browser',
  download_paper: 'browser',
  summarize_paper: 'browser',
  research_papers: 'browser',
  create_repo: 'github',
  push_files: 'github',
  open_pull_request: 'github'
}

export function appKindForTool(tool: string): AppKind {
  if (BUILTIN[tool]) return BUILTIN[tool]
  const t = tool.toLowerCase()
  if (t.includes('github') || t.includes('repo') || t.includes('pull')) return 'github'
  if (t.includes('paper') || t.includes('search') || t.includes('web')) return 'browser'
  if (t.includes('doc') || t.includes('pdf') || t.includes('sheet') || t.includes('file')) return 'files'
  return 'app'
}
