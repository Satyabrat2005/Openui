/**
 * channelMemory — cross-channel memory for the messaging surfaces.
 *
 * The problem this solves: every messaging tool is stateless. Telling OpenUI
 * "message Ashu that the design review moved to Thursday" sends the message and
 * forgets it, so a later "post the new design review time in #eng" has nothing
 * to work from and the model either asks again or — worse — invents a time.
 *
 * The layer is two hooks around the existing agent loop, and nothing else:
 *
 *   WRITE  after a messaging tool succeeds, {@link summarizeChannelAction}
 *          turns (tool, args, result) into one line filed under the contact or
 *          topic it concerns. See the call site in agent.ts.
 *   READ   before the turn's first model call, {@link recallForText} ranks the
 *          stored lines against the user's message and
 *          {@link renderMemoryBlock} renders the top few into the system
 *          prompt.
 *
 * Summaries are built deterministically from the tool call, NOT by asking a
 * model to summarise. That keeps the write path free (no extra inference on
 * every send), keeps it reliable on the local free-tier model, and keeps the
 * stored text something the user can read and verify in Settings → Memory.
 *
 * Ranking is lexical (token overlap, subject weighted above content). It is
 * deliberately simple and can be replaced wholesale without touching the
 * schema or either hook.
 */
import { database } from './database'
import type { MemoryRow, MemoryInput } from './database'
import type { ToolResult } from './tools'

/** The four surfaces this covers. Matches the toolGroups.ts group names. */
export type MemoryChannel = 'whatsapp' | 'telegram' | 'slack' | 'gmail'

/** Human-readable channel names for the prompt block and the UI. */
export const CHANNEL_LABELS: Record<MemoryChannel, string> = {
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  slack: 'Slack',
  gmail: 'Gmail'
}

/** How a single tool maps onto a memory row. */
interface ChannelAction {
  channel: MemoryChannel
  direction: 'sent' | 'read'
  /** Which arg names the contact/topic this action concerns. */
  subjectArg: string
  /** Which arg carries the content the user supplied, when there is one. */
  contentArg?: string
  /**
   * Renders the summary line. `subject` is the display label, `content` is the
   * content arg (empty when absent), `output` is the tool's own output.
   */
  summarize: (subject: string, content: string, output: string) => string
}

/**
 * The messaging tools that produce memory, and how. Anything not listed here
 * is not a channel action and is ignored by the write hook — that is what keeps
 * the store free of file writes, screenshots and browser navigation.
 *
 * Keep in sync with the whatsapp/telegram/slack/email groups in toolGroups.ts.
 */
export const CHANNEL_ACTIONS: Record<string, ChannelAction> = {
  send_whatsapp_message: {
    channel: 'whatsapp',
    direction: 'sent',
    subjectArg: 'contact',
    contentArg: 'message',
    summarize: (s, c) => `Sent a WhatsApp message to ${s}: "${c}"`
  },
  open_whatsapp_chat: {
    channel: 'whatsapp',
    direction: 'read',
    subjectArg: 'contact',
    summarize: (s) => `Opened the WhatsApp chat with ${s}`
  },
  create_whatsapp_group: {
    channel: 'whatsapp',
    direction: 'sent',
    subjectArg: 'name',
    summarize: (s, _c, o) =>
      `Created the WhatsApp group "${s}"${o ? ` (${firstLine(o)})` : ''}`
  },
  leave_whatsapp_group: {
    channel: 'whatsapp',
    direction: 'sent',
    subjectArg: 'group_name',
    summarize: (s) => `Left the WhatsApp group "${s}"`
  },
  send_telegram_message: {
    channel: 'telegram',
    direction: 'sent',
    subjectArg: 'chat_id',
    contentArg: 'text',
    summarize: (s, c) => `Sent a Telegram message to ${s}: "${c}"`
  },
  read_telegram_messages: {
    channel: 'telegram',
    direction: 'read',
    subjectArg: 'chat_id',
    summarize: (s, _c, o) => `Read the Telegram chat ${s}: ${condense(o)}`
  },
  send_slack_message: {
    channel: 'slack',
    direction: 'sent',
    subjectArg: 'channel',
    contentArg: 'text',
    summarize: (s, c) => `Posted in Slack ${hashed(s)}: "${c}"`
  },
  read_slack_channel: {
    channel: 'slack',
    direction: 'read',
    subjectArg: 'channel',
    summarize: (s, _c, o) => `Read Slack ${hashed(s)}: ${condense(o)}`
  },
  search_slack: {
    channel: 'slack',
    direction: 'read',
    subjectArg: 'query',
    summarize: (s, _c, o) => `Searched Slack for "${s}": ${condense(o)}`
  },
  send_email: {
    channel: 'gmail',
    direction: 'sent',
    subjectArg: 'to',
    contentArg: 'body',
    summarize: (s, c) => `Sent an email to ${s}: "${c}"`
  },
  send_summary_email: {
    channel: 'gmail',
    direction: 'sent',
    subjectArg: 'recipient',
    contentArg: 'summary',
    summarize: (s, c) => `Emailed a cross-channel summary to ${s}: "${c}"`
  },
  create_email_draft: {
    channel: 'gmail',
    direction: 'sent',
    subjectArg: 'to',
    contentArg: 'body',
    summarize: (s, c) => `Drafted an email to ${s}: "${c}"`
  },
  find_email_thread: {
    channel: 'gmail',
    direction: 'read',
    subjectArg: 'query',
    summarize: (s, _c, o) => `Looked up the email thread "${s}": ${condense(o)}`
  }
}

/** True when `tool` is one of the messaging tools that produce memory. */
export function isChannelAction(tool: string): boolean {
  return Object.prototype.hasOwnProperty.call(CHANNEL_ACTIONS, tool)
}

/** Longest content stored per memory line, so one long email can't fill the store. */
export const MAX_CONTENT_CHARS = 200

/** Longest tool output folded into a read-action summary. */
export const MAX_OUTPUT_CHARS = 180

function firstLine(text: string): string {
  return text.split('\n')[0].trim().slice(0, MAX_OUTPUT_CHARS)
}

/** Flatten a multi-line tool output into one clipped line. */
function condense(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > MAX_OUTPUT_CHARS ? `${flat.slice(0, MAX_OUTPUT_CHARS)}…` : flat
}

/** Slack channels read better with their "#" in the summary. */
function hashed(channel: string): string {
  return channel.startsWith('#') || /^C[A-Z0-9]{6,}$/.test(channel) ? channel : `#${channel}`
}

/** Clip user-supplied content to MAX_CONTENT_CHARS, collapsing whitespace. */
function clipContent(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > MAX_CONTENT_CHARS ? `${flat.slice(0, MAX_CONTENT_CHARS)}…` : flat
}

/**
 * The stable lookup key for a contact or topic.
 *
 * Lowercased, whitespace-collapsed, and stripped of the sigils that are an
 * artefact of the channel rather than part of the name ("#eng" and "eng" are
 * the same Slack channel; "@ashu" and "ashu" the same handle). Everything else
 * is preserved, so "priya@acme.com" stays a distinct key from "priya" — recall
 * bridges those two via token overlap, not by mangling the key.
 */
export function normalizeSubject(raw: string): string {
  return raw
    .trim()
    .replace(/^[#@]+/, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

/**
 * Turn one completed channel tool call into a memory row, or null when the tool
 * is not a channel action or carries no usable subject.
 *
 * Called only for calls that actually SUCCEEDED — a denied or failed send did
 * not happen, and recording it would let the model later claim it did.
 */
export function summarizeChannelAction(
  tool: string,
  args: Record<string, unknown>,
  result: ToolResult
): MemoryInput | null {
  const spec = CHANNEL_ACTIONS[tool]
  if (!spec || !result.ok) return null

  const rawSubject = typeof args[spec.subjectArg] === 'string' ? (args[spec.subjectArg] as string) : ''
  const subjectLabel = rawSubject.trim()
  if (!subjectLabel) return null

  const rawContent =
    spec.contentArg && typeof args[spec.contentArg] === 'string'
      ? (args[spec.contentArg] as string)
      : ''
  const content = clipContent(rawContent)
  const output = condense(result.output ?? '')

  return {
    subjectKey: normalizeSubject(subjectLabel),
    subjectLabel,
    channel: spec.channel,
    action: tool,
    direction: spec.direction,
    summary: spec.summarize(subjectLabel, content, output)
  }
}

/**
 * WRITE hook: record a completed channel action. Best-effort — a memory write
 * must never break a chat turn, so failures are logged and swallowed.
 * Returns the row id, or null when nothing was recorded.
 */
export function recordChannelAction(
  tool: string,
  args: Record<string, unknown>,
  result: ToolResult
): string | null {
  try {
    const input = summarizeChannelAction(tool, args, result)
    if (!input) return null
    return database.memory.recordMemory(input)
  } catch (err) {
    console.error('[channelMemory] failed to record action:', err)
    return null
  }
}

/**
 * Words carrying no retrieval signal. Kept deliberately small: it only needs to
 * stop the highest-frequency glue from clearing MIN_RECALL_SCORE on its own.
 */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'that', 'this', 'these', 'those',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
  'do', 'does', 'did', 'doing', 'done', 'have', 'has', 'had',
  'i', 'me', 'my', 'mine', 'you', 'your', 'yours', 'we', 'our', 'they', 'them', 'their',
  'he', 'him', 'his', 'she', 'her', 'hers', 'it', 'its',
  'to', 'of', 'in', 'on', 'at', 'for', 'with', 'from', 'by', 'about', 'as', 'into',
  'what', 'when', 'where', 'who', 'whom', 'which', 'how', 'why',
  'can', 'could', 'will', 'would', 'should', 'shall', 'may', 'might', 'must',
  'not', 'no', 'yes', 'so', 'just', 'also', 'again', 'said', 'say', 'says', 'tell',
  'told', 'send', 'sent', 'message', 'msg', 'reply', 'ask', 'asked', 'get', 'got',
  'please', 'thanks', 'hey', 'hi', 'let', 'know', 'need', 'want', 'up', 'out', 'now'
])

/** Lowercased content words of `text`, stopwords and 1-char tokens removed. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
}

/** A subject-token hit is worth this many content-token hits. */
export const SUBJECT_WEIGHT = 3

/**
 * Minimum score for a memory to be recalled. Equal to SUBJECT_WEIGHT so a
 * single named contact qualifies on its own, while a topic-only match needs
 * three distinct content words before it counts — enough to keep an unrelated
 * question from dragging in whatever was messaged most recently.
 */
export const MIN_RECALL_SCORE = 3

/** Most memories rendered into one prompt. Kept low: the prompt budget is tight. */
export const MAX_RECALL_ENTRIES = 4

/**
 * Bonus for a CONTIGUOUS two-word phrase shared by the question and the memory.
 *
 * Without it, "when is the design review?" scores 2 — one point each for
 * "design" and "review" — and falls below MIN_RECALL_SCORE, so a perfectly
 * clear topic question recalls nothing. Simply lowering the threshold to 2
 * would also admit any memory that happens to share two unrelated words, which
 * is how a memory feature starts leaking the wrong contact's messages.
 * Adjacency is the thing that separates those two cases: "design review" as a
 * phrase is strong evidence, two scattered words are not.
 */
export const PHRASE_BONUS = 2

/** Phrase bonuses counted per memory, so a long quote can't run the score up. */
export const MAX_PHRASE_MATCHES = 2

export interface ScoredMemory {
  row: MemoryRow
  score: number
}

/**
 * Rank `rows` against `text`, best first, dropping anything below
 * MIN_RECALL_SCORE. Subject tokens (the contact or topic the row is filed
 * under, plus its display label) count SUBJECT_WEIGHT each; summary tokens
 * count 1. Ties break toward the more recent row.
 *
 * Matching the LABEL as well as the key is what bridges channels whose
 * identifiers differ in form: a Gmail row filed under "priya@acme.com"
 * tokenizes to "priya"/"acme" and so answers a question that just says
 * "Priya", without the key itself being rewritten.
 *
 * Exported for tests and for the eval harness.
 */
export function scoreMemories(rows: MemoryRow[], text: string): ScoredMemory[] {
  const tokens = tokenize(text)
  const queryTokens = new Set(tokens)
  if (queryTokens.size === 0) return []
  // Adjacent content-word pairs from the question, e.g. "design review".
  const queryPhrases: string[] = []
  for (let i = 0; i < tokens.length - 1; i++) queryPhrases.push(`${tokens[i]} ${tokens[i + 1]}`)

  const scored: ScoredMemory[] = []
  for (const row of rows) {
    const subjectTokens = new Set([
      ...tokenize(row.subject_key),
      ...tokenize(row.subject_label)
    ])
    const summaryTokens = new Set(tokenize(row.summary))

    let score = 0
    for (const token of subjectTokens) {
      if (queryTokens.has(token)) score += SUBJECT_WEIGHT
    }
    for (const token of summaryTokens) {
      // Subject tokens already scored above; don't pay twice for the same word.
      if (queryTokens.has(token) && !subjectTokens.has(token)) score += 1
    }

    // Contiguity bonus — see PHRASE_BONUS. Matched against the memory's own
    // adjacent content-word pairs, so "design review" in the question only
    // scores against "design review" in the memory, not against a summary that
    // mentions "design" and "review" paragraphs apart.
    const rowPhrases = new Set<string>()
    const rowTokens = tokenize(`${row.subject_label} ${row.summary}`)
    for (let i = 0; i < rowTokens.length - 1; i++) {
      rowPhrases.add(`${rowTokens[i]} ${rowTokens[i + 1]}`)
    }
    let phraseHits = 0
    for (const phrase of queryPhrases) {
      if (phraseHits >= MAX_PHRASE_MATCHES) break
      if (rowPhrases.has(phrase)) {
        score += PHRASE_BONUS
        phraseHits++
      }
    }

    if (score >= MIN_RECALL_SCORE) scored.push({ row, score })
  }

  return scored.sort((a, b) => b.score - a.score || b.row.created_at - a.row.created_at)
}

/**
 * READ hook: the memories worth showing the model for a turn whose user message
 * is `text`. Best-effort — recall failure degrades to no memory, never to a
 * broken turn.
 */
export function recallForText(text: string, limit = MAX_RECALL_ENTRIES): MemoryRow[] {
  try {
    const keys = candidateKeys(text)
    const rows = database.memory.findMemories(keys)
    return scoreMemories(rows, text)
      .slice(0, limit)
      .map((s) => s.row)
  } catch (err) {
    console.error('[channelMemory] recall failed:', err)
    return []
  }
}

/**
 * Subject keys worth pulling from the store for `text`.
 *
 * These only widen the candidate set that scoreMemories() then ranks, so a
 * miss here costs recall of an OLD memory (one past the recent tail), never
 * correctness. Single content words cover "what did I tell Ashu", adjacent
 * pairs cover multi-word subjects like "design review".
 */
export function candidateKeys(text: string): string[] {
  const tokens = tokenize(text)
  const keys = new Set<string>(tokens)
  for (let i = 0; i < tokens.length - 1; i++) keys.add(`${tokens[i]} ${tokens[i + 1]}`)
  return [...keys]
}

/** Relative age like "2h ago", so the model can weigh staleness. */
function relativeAge(createdAt: number, now: number): string {
  const seconds = Math.max(0, now - createdAt)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/**
 * The block's opening line. Exported so tests can assert on the real string
 * rather than a copy that can drift out of sync with it.
 *
 * Deliberately prose, and deliberately NOT a bare capitalised keyword. An
 * earlier version opened with "MEMORY — things you did…" and the local model
 * read that token as a tool name, replying `{"tool": "MEMORY", "args": {}}`:
 * the block sits a few lines below "Available tools:", so a lone all-caps word
 * followed by a dash looks exactly like one more entry in that list. In the
 * real loop that costs a turn and falls through to the unknown-tool/MCP path.
 * Keep this phrased as a sentence.
 */
export const MEMORY_BLOCK_HEADER =
  'Earlier activity on the user\'s messaging channels, recorded from real actions'

/**
 * The clause that stops the block being read as licence to speculate. Kept on
 * ONE line — it is the line most worth asserting on, and a wrapped version
 * cannot be matched by a plain substring check.
 */
export const MEMORY_BLOCK_DISCLAIMER =
  'If a fact is not listed here, say you do not have it rather than inventing it.'

/**
 * Render recalled memories as a system-prompt block, or '' when there is
 * nothing to show (so the prompt is byte-identical to the pre-memory one on
 * turns with no relevant memory — which is what makes the feature's effect
 * measurable).
 *
 * Neither closing instruction is decoration. Without the "not tools" line the
 * model tries to CALL the block (see MEMORY_BLOCK_HEADER); without the last
 * one it reads the block as licence to speculate about channels it has not
 * read, which is the exact failure the feature exists to prevent.
 */
export function renderMemoryBlock(rows: MemoryRow[], now = Math.floor(Date.now() / 1000)): string {
  if (rows.length === 0) return ''
  const lines = rows.map((row) => {
    const channel = CHANNEL_LABELS[row.channel as MemoryChannel] ?? row.channel
    return `- [${channel} · ${relativeAge(row.created_at, now)}] ${row.summary}`
  })
  return [
    '',
    `${MEMORY_BLOCK_HEADER} you already took. These may be from a different`,
    'channel than the one in use now:',
    ...lines,
    'These are notes, not tools — never emit one as a tool call.',
    'Use them when they answer the request, but do NOT treat them as permission',
    'to guess about anything else.',
    MEMORY_BLOCK_DISCLAIMER,
    ''
  ].join('\n')
}

/**
 * Convenience for the agent loop: the memory block for this turn's message,
 * or '' when nothing is relevant.
 */
export function memoryBlockForText(text: string): string {
  return renderMemoryBlock(recallForText(text))
}
