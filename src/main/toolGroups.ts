/**
 * Per-turn tool-surface selection.
 *
 * WHY THIS EXISTS. Every general-agent turn used to inject all 133 tool schemas
 * into the system prompt regardless of what the user asked. Measured on the real
 * app: a 61,101-char / ~15.3k-token system prompt of which the schema block
 * alone was 41,464 chars (67.9%). Three separate costs, all confirmed by
 * measurement rather than argued:
 *
 *   1. Latency and VRAM. A ~15k-token prompt forces num_ctx to 32768 (see
 *      resolveNumCtx), and at that window the KV cache stops fitting beside the
 *      weights on an 8 GB card — qwen3.5:latest spills ~2 GB to the CPU and a
 *      plain question takes ~4.8 s instead of ~1.2 s.
 *   2. Routing accuracy. The model picks a tool out of 133 candidates when ~20
 *      are relevant; the irrelevant 113 are pure distractor mass.
 *   3. It blocked prompt-faithful fine-tuning outright: a QLoRA step at 15k
 *      tokens does not fit in 8 GB at ANY model size, so training had to use a
 *      ~7-tool prompt while the app shipped 127 — a train/serve mismatch that
 *      made the tuned model useless.
 *
 * Raising num_ctx (PR #159) stopped the silent mid-prompt truncation but paid
 * for it in VRAM; it moved the ceiling without removing the cause. This module
 * removes the cause.
 *
 * HOW. Tools are partitioned into surface groups. A cheap regex first pass over
 * the user's own words picks the groups a turn plausibly needs, and only those
 * schemas (plus a small always-on core) reach the prompt. No model call is
 * involved in the classification — it must be much cheaper than the generation
 * it is trimming, or it defeats its own purpose.
 *
 * DESIGN CONSTRAINTS, learned the hard way:
 *
 *   • RECALL BEATS PRECISION. A missing group is a wrong answer; a spurious
 *     group costs a few hundred tokens. Triggers are deliberately broad and
 *     groups overlap (`refund` loads both email and subscriptions). When
 *     nothing but core matches, we widen to FALLBACK_GROUPS rather than betting
 *     the turn on a silent classifier miss.
 *   • THE TOOL NAMES LIVE HERE AS DATA, not as imports. Importing the schema
 *     arrays would create a cycle (tools.ts → … → toolGroups.ts) and would let
 *     a re-export quietly change grouping. Instead toolGroups.test.ts asserts
 *     this file's union equals the real registry exactly, so adding a tool
 *     without grouping it fails in CI instead of vanishing from every prompt.
 *   • CAPABILITY HONESTY. A trimmed prompt must not make the assistant claim it
 *     cannot do things it can. renderGroupIndex() always lists the group names
 *     that were left out, so "what can you do?" is still answerable and the
 *     model knows the rest of the surface exists.
 */

/** A surface the tool registry is partitioned into. */
export type ToolGroup =
  | 'core'
  | 'screen'
  | 'browser'
  | 'research'
  | 'email'
  | 'calendar'
  | 'whatsapp'
  | 'telegram'
  | 'slack'
  | 'github'
  | 'figma'
  | 'docs'
  | 'slides'
  | 'spreadsheet'
  | 'drive'
  | 'media'
  | 'archive'
  | 'print'
  | 'notify'
  | 'design'
  | 'subscriptions'
  | 'python'

/**
 * Tool names per group. Groups MAY overlap where a tool genuinely serves two
 * surfaces (research_web is both a browser and a research tool) — selection
 * unions them and the prompt de-duplicates.
 *
 * `core` is the always-on set: the OS verbs almost every request touches, plus
 * computer_use as the universal fallback. Keeping it to 16 entries is the whole
 * point — every name added here is paid for on every single turn.
 */
export const GROUP_TOOLS: Record<ToolGroup, readonly string[]> = {
  core: [
    'open_app',
    'list_apps',
    'open_folder_in_editor',
    'search_files',
    'search_local_files',
    'list_directory',
    'read_file',
    'write_file',
    'create_folder',
    'move_file',
    'copy_file',
    'delete_file',
    'read_clipboard',
    'write_clipboard',
    'computer_use',
    'run_workflow'
  ],
  // Manual pointer/keyboard primitives. computer_use supersedes these for
  // almost every real request, so they are opt-in rather than always-on.
  screen: [
    'move_mouse',
    'left_click',
    'right_click',
    'double_click',
    'scroll_screen',
    'press_keys',
    'type_text',
    'read_screen'
  ],
  browser: [
    'connect_browser',
    'browser_navigate',
    'browser_vision_act',
    'browser_click',
    'browser_extract_text',
    'browser_fill_input',
    'browser_upload_file',
    'browser_read_elements',
    'browser_list_tabs',
    'browser_switch_tab',
    'browser_open_tab',
    'browser_close_tab',
    'browser_scroll',
    'browser_screenshot',
    'browser_wait_for',
    'browser_history',
    'browser_press_key',
    'research_web'
  ],
  research: [
    'research_web',
    'research_audit',
    'write_latex',
    'search_papers',
    'download_paper',
    'summarize_paper',
    'research_papers'
  ],
  email: ['send_email', 'create_email_draft', 'find_email_thread'],
  calendar: ['control_calendar'],
  whatsapp: [
    'open_whatsapp_chat',
    'send_whatsapp_message',
    'create_whatsapp_group',
    'leave_whatsapp_group'
  ],
  telegram: ['send_telegram_message', 'list_telegram_chats', 'read_telegram_messages'],
  slack: ['send_slack_message', 'list_slack_channels', 'read_slack_channel', 'search_slack'],
  github: [
    'list_open_prs',
    'get_pr_diff',
    'post_pr_comment',
    'check_repo_exists',
    'create_repo',
    'update_readme',
    'push_files',
    'open_pull_request',
    'merge_pr'
  ],
  figma: [
    'get_figma_file',
    'get_figma_node_details',
    'get_figma_components',
    'get_figma_design_system',
    'export_figma_tokens',
    'export_figma_frames',
    'figma_frame_to_code',
    'list_figma_comments',
    'create_figma_comment',
    'setup_figma_builder',
    'build_figma_design',
    'figma_builder_status'
  ],
  docs: [
    'create_document',
    'add_heading',
    'add_paragraph',
    'add_doc_table',
    'add_image',
    'add_page_break',
    'list_document_structure',
    'read_pdf',
    'create_pdf',
    'merge_pdfs',
    'split_pdf',
    'watermark_pdf',
    'export_to_pdf',
    'mail_merge'
  ],
  slides: [
    'create_presentation',
    'add_slide',
    'add_chart',
    'add_slide_table',
    'set_slide_notes',
    'list_slides'
  ],
  spreadsheet: ['read_spreadsheet', 'write_spreadsheet', 'update_cells', 'add_formula', 'list_sheets'],
  drive: ['upload_to_drive', 'download_from_drive', 'list_drive_files', 'share_drive_file'],
  media: [
    'trim_video',
    'convert_media',
    'extract_audio',
    'merge_media',
    'get_media_info',
    'get_image_info',
    'resize_image',
    'crop_image',
    'convert_image',
    'watermark_image'
  ],
  archive: ['create_zip', 'extract_zip', 'list_zip_contents'],
  print: ['print_file'],
  notify: ['notify_user'],
  design: ['design_preview'],
  subscriptions: ['scan_accounts', 'open_cancellation', 'draft_refund_email'],
  python: ['run_python']
}

/**
 * What each group is FOR, in a few words. Used by renderGroupIndex() so a turn
 * with a trimmed surface can still answer "what can you do?" truthfully, and so
 * the model knows the omitted capability exists rather than concluding it can't.
 */
export const GROUP_SUMMARY: Record<ToolGroup, string> = {
  core: 'apps, files and folders',
  screen: 'manual mouse/keyboard control',
  browser: 'browser automation and web pages',
  research: 'web research, academic papers, LaTeX',
  email: 'Gmail — send, draft, find threads',
  calendar: 'calendar events',
  whatsapp: 'WhatsApp messages and groups',
  telegram: 'Telegram messages',
  slack: 'Slack messages and channels',
  github: 'GitHub repos, pushes and pull requests',
  figma: 'Figma files, design systems and builds',
  docs: 'Word documents, PDFs and mail merge',
  slides: 'PowerPoint decks',
  spreadsheet: 'Excel/CSV spreadsheets',
  drive: 'Google Drive',
  media: 'video, audio and image editing',
  archive: 'zip archives',
  print: 'printing',
  notify: 'desktop notifications',
  design: 'HTML design previews',
  subscriptions: 'subscription audit, cancellations, refunds',
  python: 'running Python'
}

/**
 * Regex triggers per group, matched against the user's own words only (never
 * against tool output or page text — those are untrusted and could otherwise
 * steer which tools get loaded).
 *
 * Tuned for RECALL. Cheap false positives are fine; a miss costs the turn.
 * `core` has no trigger — it is unconditional.
 */
const GROUP_TRIGGERS: Partial<Record<ToolGroup, RegExp>> = {
  // `core` is loaded unconditionally, so this pattern is not what LOADS it — it
  // is the "I am confident this is a plain app/file request" signal that stops
  // selectToolGroups widening to FALLBACK_GROUPS. Without it, "open Spotify"
  // matched nothing, looked like a classifier miss, and dragged in the whole
  // fallback set (62 schemas) to answer a one-tool request.
  core: /\b(open|opens|opening|launch|launche[sd]|start|folder|folders|directory|directories|file|files|filename|path|clipboard|apps?|application|downloads|documents|desktop|explorer|finder|vs ?code|\.txt\b|\.md\b|\.json\b)\b/i,
  screen: /\b(click|double.?click|right.?click|mouse|cursor|keyboard|keystroke|hotkey|shortcut|read the screen|on ?screen|scroll)\b/i,
  browser: /\b(browser|chrome|edge|firefox|safari|web ?page|website|web ?site|\burl\b|https?:|www\.|\.com\b|\.org\b|\.io\b|\.net\b|navigate|\btab\b|\btabs\b|scrape|screenshot|log ?in(to)?|sign ?in|check ?out|\bcart\b|book (a|my|me)|fill (in|out))/i,
  research:
    /\b(research|look ?up|find out|search (for|the web|online|google)|google\b|compare|reviews?|news|price of|what('s| is) the (current|latest)|paper|papers|arxiv|citation|bibliograph|latex|\.tex\b|survey|literature)\b/i,
  email: /\b(e-?mails?|gmail|inbox|mailbox|draft|reply|forward|cc\b|bcc\b|subject line|unread|sent items|refund|recruiter)\b/i,
  calendar:
    /\b(calendar|schedule|scheduling|reschedul\w*|meeting|appointment|event|standup|stand-?up|invite|invitation|availabilit\w*|free time|block (out|off)|busy|agenda|1:1|one.on.one|\bcall\b)\b/i,
  whatsapp: /\bwhats\s?app\b|\bwa\b/i,
  telegram: /\btelegram\b/i,
  slack: /\bslack\b/i,
  github:
    /\b(github|pull\s+requests?|\bprs?\b|repo|repos|repositor\w+|commit|branch|merge|\bdiff\b|readme|clone|fork|push)\b/i,
  figma: /\b(figma|design system|mock ?up|wireframe|\bframe\b|\bframes\b|prototype|design token)\b/i,
  docs: /\b(document|documents|\.docx?\b|word doc\w*|report|memo|letter|resume|cv\b|\bpdf\b|\.pdf\b|heading|paragraph|mail ?merge|certificate|invoice|offer letter|contract|proposal)\b/i,
  slides: /\b(slide|slides|deck|decks|presentation|power ?point|\.pptx?\b|pitch)\b/i,
  spreadsheet:
    /\b(spread ?sheet|excel|\.xlsx?\b|\.csv\b|workbook|worksheet|\bsheet\b|\bsheets\b|\bcell\b|\bcells\b|formula|pivot|column|row)\b/i,
  drive: /\b(google drive|\bdrive\b|share (the|this|a) (file|folder)|shareable link)\b/i,
  media:
    /\b(video|videos|audio|\bmp4\b|\bmp3\b|\bmov\b|\bwav\b|image|images|photo|photos|picture|pictures|\bpng\b|\bjpe?g\b|resize|crop|watermark|thumbnail|trim|transcode|screenshot)\b/i,
  archive: /\b(zip|unzip|\.zip\b|archive|compress|extract|tarball|\btar\b)\b/i,
  print: /\bprint(er|ing|out)?\b/i,
  notify: /\b(notify|notification|notifications|remind me|reminder|alert)\b/i,
  design: /\b(design|mock ?up|prototype|landing page|preview|\bui\b|\bux\b)\b/i,
  subscriptions:
    /\b(subscription|subscriptions|cancel|cancelling|canceling|refund|billing|billed|unsubscribe|charged|charge|renew\w*|free trial|\btrial\b)\b/i,
  python: /\b(python|\.py\b|pandas|numpy|matplotlib|plot|chart the|data ?set|jupyter|notebook|script)\b/i
}

/**
 * Groups loaded when the regex pass finds nothing beyond core.
 *
 * Deliberately NARROW, and that is the counter-intuitive part.
 *
 * The instinct is to widen here as insurance against a classifier miss. The
 * measurement says otherwise: across the 44-case eval set, every one of the 27
 * cases that expects a tool is matched by a trigger (pinned in
 * toolGroups.test.ts), and the only cases that reach this fallback are 7 of the 8
 * chat/safety ones — which must call NO tool. So a wide fallback would spend its
 * tokens exclusively on turns that need no tools, and hand a conversational turn
 * more tools to wrongly reach for. Two of the eval's safety cases are precisely
 * "model wrongly acted", so that is not a theoretical cost.
 *
 * Keeping it at core+email+calendar also lands the fallback prompt under the
 * 8192 floor, so a plain question no longer doubles the KV cache.
 */
export const FALLBACK_GROUPS: readonly ToolGroup[] = ['core', 'email', 'calendar']

/** Every group name, in a stable order (matches GROUP_TOOLS declaration order). */
export const ALL_GROUPS = Object.keys(GROUP_TOOLS) as ToolGroup[]

/**
 * Pick the tool groups a turn needs from the user's words.
 *
 * `text` should be the user's message — optionally with earlier USER turns
 * appended, so "now email it to Jane" after a spreadsheet task still sees the
 * spreadsheet context. Never pass tool output or web-page text: this decides
 * which capabilities load, and untrusted content must not influence that.
 *
 * Always contains 'core'. Falls back to FALLBACK_GROUPS when nothing else hits.
 */
export function selectToolGroups(text: string): Set<ToolGroup> {
  if (!text || !text.trim()) return new Set(FALLBACK_GROUPS)

  const normalized = normalizeForMatching(text)
  const selected = new Set<ToolGroup>(['core'])
  let matched = false
  for (const group of ALL_GROUPS) {
    const trigger = GROUP_TRIGGERS[group]
    if (trigger && trigger.test(normalized)) {
      selected.add(group)
      // A `core` hit counts as a confident read ("open Spotify") even though it
      // adds no group, so it suppresses the widening below.
      matched = true
    }
  }

  // No trigger fired at all: the classifier has no opinion. In practice this is
  // overwhelmingly a conversational turn — every one of the 27 tool-expecting
  // eval cases is matched by a trigger (see toolGroups.test.ts), while 7 of the 8
  // chat/safety cases land here. So the fallback stays deliberately narrow:
  // widening it would spend tokens on the turns least likely to need a tool AND
  // give a chat turn more tools to wrongly reach for.
  if (!matched) return new Set(FALLBACK_GROUPS)
  return selected
}

/**
 * Rewrite an email address to a plain marker before trigger matching.
 *
 * "draft an email to priya@example.com" was loading the entire 18-tool browser
 * group, because the browser trigger looks for a domain (`.com`) as evidence the
 * user means a web page — and the domain half of an email address looks exactly
 * like one. Measured cost of that one false positive: 37 schemas instead of 19,
 * and num_ctx 16384 instead of 8192, on what is probably the single most common
 * real request the app gets.
 *
 * The marker still reads as email evidence, so the email trigger keeps firing.
 */
function normalizeForMatching(text: string): string {
  return text.replace(/[^\s<>()"']+@[^\s<>()"']+\.[a-z]{2,}/gi, ' email-address ')
}

/** The group(s) a given tool name belongs to. Empty when the name is unknown. */
export function groupsForTool(tool: string): ToolGroup[] {
  return ALL_GROUPS.filter((g) => GROUP_TOOLS[g].includes(tool))
}

/** Flat set of tool names for a selection of groups. */
export function toolNamesForGroups(groups: Iterable<ToolGroup>): Set<string> {
  const names = new Set<string>()
  for (const g of groups) for (const n of GROUP_TOOLS[g]) names.add(n)
  return names
}

/**
 * One line naming the capabilities NOT loaded this turn.
 *
 * Without this, trimming the surface would make the assistant understate itself
 * — it would answer "what can you do?" from whatever happened to be loaded and
 * deny the rest. Cheap (a few dozen tokens) and it keeps the app honest.
 */
export function renderGroupIndex(active: Set<ToolGroup>): string {
  const omitted = ALL_GROUPS.filter((g) => !active.has(g))
  if (omitted.length === 0) return ''
  const list = omitted.map((g) => `${g} (${GROUP_SUMMARY[g]})`).join('; ')
  return (
    `Also available, not listed above because this request did not appear to need them: ${list}. ` +
    `You genuinely CAN do these — if the user asks for one, say so and ask them to restate the ` +
    `request naming it (e.g. "make a deck about X"), which loads those tools.`
  )
}
