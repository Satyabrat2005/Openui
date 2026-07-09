/**
 * appKind — maps an agent tool name to the "app" it drives, plus a live status
 * phrase. Feeds two surfaces:
 *   • ThinkingStatus (#3) — the rotating "Reading the screen… / Running the tool…"
 *     line shown while a turn executes.
 *   • ActivityPanel (#5) — the live tile showing which app is being controlled.
 *
 * Built-in tools are matched by name; connected MCP tools (arbitrary names) fall
 * back to keyword heuristics (whatsapp/slack/telegram/…) so social connectors
 * still light up the right icon without a hard-coded list.
 */

export type AppKind =
  | 'browser'
  | 'github'
  | 'figma'
  | 'files'
  | 'clipboard'
  | 'calendar'
  | 'screen'
  | 'whatsapp'
  | 'messaging'
  | 'app'
  | 'thinking'

export interface AppMeta {
  kind: AppKind
  /** Short human label for the app, e.g. "Browser", "WhatsApp". */
  label: string
  /** Present-tense status phrase, e.g. "Browsing the web…". */
  phrase: string
}

const META: Record<AppKind, { label: string; phrase: string }> = {
  browser: { label: 'Browser', phrase: 'Browsing the web…' },
  github: { label: 'GitHub', phrase: 'Reviewing code on GitHub…' },
  figma: { label: 'Figma', phrase: 'Inspecting the design…' },
  files: { label: 'Files', phrase: 'Working with your files…' },
  clipboard: { label: 'Clipboard', phrase: 'Reading the clipboard…' },
  calendar: { label: 'Calendar', phrase: 'Checking your calendar…' },
  screen: { label: 'Screen', phrase: 'Reading the screen…' },
  whatsapp: { label: 'WhatsApp', phrase: 'Working in WhatsApp…' },
  messaging: { label: 'Messaging', phrase: 'Sending a message…' },
  app: { label: 'Desktop app', phrase: 'Controlling the app…' },
  thinking: { label: 'Thinking', phrase: 'Thinking…' }
}

/** Exact-name map for built-in tools. */
const BUILTIN: Record<string, AppKind> = {
  open_app: 'app',
  search_files: 'files',
  search_local_files: 'files',
  list_directory: 'files',
  read_file: 'files',
  write_file: 'files',
  create_folder: 'files',
  move_file: 'files',
  copy_file: 'files',
  delete_file: 'files',
  control_calendar: 'calendar',
  move_mouse: 'screen',
  left_click: 'screen',
  type_text: 'screen',
  read_screen: 'screen',
  read_clipboard: 'clipboard',
  write_clipboard: 'clipboard',
  browser_navigate: 'browser',
  browser_click: 'browser',
  browser_extract_text: 'browser',
  browser_fill_input: 'browser',
  list_open_prs: 'github',
  get_pr_diff: 'github',
  post_pr_comment: 'github',
  get_figma_file: 'figma',
  export_figma_frames: 'figma',
  create_figma_comment: 'figma',
  run_workflow: 'app'
}

/** Resolve a tool name to the app it drives. */
export function appKindForTool(tool: string): AppKind {
  const name = tool.toLowerCase()
  const exact = BUILTIN[name]
  if (exact) return exact
  if (name.startsWith('browser')) return 'browser'
  if (name.includes('whatsapp')) return 'whatsapp'
  if (name.includes('slack') || name.includes('telegram') || name.includes('discord') || name.includes('message'))
    return 'messaging'
  if (name.includes('figma')) return 'figma'
  if (name.includes('github') || name.includes('pr_') || name.includes('_pr')) return 'github'
  if (name.includes('file') || name.includes('dir') || name.includes('folder')) return 'files'
  if (name.includes('calendar') || name.includes('event')) return 'calendar'
  if (name.includes('clip')) return 'clipboard'
  if (name.includes('screen') || name.includes('click') || name.includes('mouse') || name.includes('type'))
    return 'screen'
  return 'app'
}

/**
 * Resolve a free-form app *hint* (e.g. a sub-agent's "netflix" / "amazon" /
 * "linkedin") to an app kind for its timeline row icon. Messaging/design apps
 * map to their own kinds; most connected web services are driven in the browser.
 */
export function appKindForName(name: string | undefined): AppKind {
  if (!name) return 'app'
  const n = name.toLowerCase()
  if (n.includes('whatsapp')) return 'whatsapp'
  if (n.includes('slack') || n.includes('telegram') || n.includes('discord') || n.includes('message'))
    return 'messaging'
  if (n.includes('figma')) return 'figma'
  if (n.includes('github')) return 'github'
  if (n.includes('calendar')) return 'calendar'
  if (n.includes('file') || n.includes('folder')) return 'files'
  // netflix, amazon, linkedin, gmail, spotify… → browser-driven web services.
  return 'browser'
}

/** Full metadata (label + status phrase) for a tool. */
export function appMetaForTool(tool: string): AppMeta {
  const kind = appKindForTool(tool)
  return { kind, ...META[kind] }
}

/** Metadata for an app kind directly (used by the activity tile). */
export function metaForKind(kind: AppKind): AppMeta {
  return { kind, ...META[kind] }
}
