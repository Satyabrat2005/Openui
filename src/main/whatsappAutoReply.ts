/**
 * whatsappAutoReply.ts — PURE core for the allowlisted WhatsApp auto-reply
 * feature (spec items #2/#3). No Electron, no DB, no native deps, no I/O, so
 * every safety-relevant decision — who is on the allowlist, whether a draft is
 * rate-limited, whether a detected message should be drafted at all — is
 * unit-testable without ever touching WhatsApp.
 *
 * SAFETY MODEL (decided with the user, the conservative option): this feature
 * NEVER sends autonomously. The background watcher COMPOSES a suggested reply
 * and surfaces it for a human click; the actual send always goes through
 * send_whatsapp_message's existing approval. Everything here — allowlist,
 * per-contact + global rate limits, default-OFF, fail-closed matching — is
 * defense-in-depth AROUND that human-click core, not a replacement for it.
 *
 * The wiring that has real side effects (screenshot/OCR of the chat list, the
 * chat-proxy compose call, the settings store, the IPC surface, the audit log,
 * the setInterval loop) lives in whatsappWatcher.ts and imports this module —
 * so the risky, untestable I/O stays separate from the logic that decides
 * whether an unattended action is allowed at all.
 */

import { normalizeAppName, scoreAppName } from './appResolver'
import { textDelta } from './osLoop/frameState'

/** One allowlisted contact/group the user has explicitly opted in to auto-DRAFT for. */
export interface AllowlistEntry {
  /** Contact or group name, as it appears in WhatsApp. */
  name: string
  /**
   * Optional per-contact instruction steering the drafted reply, e.g.
   * "reply as if I'm busy at work, keep it short". Free text, capped on write.
   */
  instruction?: string
}

/** The full auto-reply configuration, persisted as one JSON settings row. */
export interface AutoReplyConfig {
  /**
   * Master switch. Default OFF — the watcher never runs, polls, or drafts
   * unless the user has explicitly turned this on. Normalised fail-safe: only a
   * literal `true` enables it (see normalizeAutoReplyConfig).
   */
  enabled: boolean
  /** Chat-list poll interval, ms. Clamped to [MIN_POLL_MS, MAX_POLL_MS]. */
  pollIntervalMs: number
  /** Contacts/groups the user opted in to. Empty ⇒ the watcher idles/pauses. */
  allowlist: AllowlistEntry[]
  /** Max drafts composed per contact per hour — the reply-loop guard. */
  perContactHourlyCap: number
  /** Max drafts composed across ALL contacts per hour — the spam-shape guard. */
  globalHourlyCap: number
}

// A deliberately unhurried default cadence: this is a desktop-app screenshot
// loop running in the background, not a push hook, so seconds-scale polling is
// the right order of magnitude for both CPU/battery and ban-risk.
export const DEFAULT_POLL_MS = 20_000
export const MIN_POLL_MS = 15_000
export const MAX_POLL_MS = 120_000

export const DEFAULT_PER_CONTACT_HOURLY_CAP = 3
export const DEFAULT_GLOBAL_HOURLY_CAP = 15
/** Sliding-window length for the rate limiter (one hour). */
export const RATE_WINDOW_MS = 60 * 60 * 1000

export const MAX_ALLOWLIST_ENTRIES = 50
/** Longest per-contact instruction we persist (kept short so it can't dominate the prompt). */
export const MAX_INSTRUCTION_LEN = 500

/** The all-off starting state — what a first run (no stored config) resolves to. */
export const DEFAULT_AUTO_REPLY_CONFIG: AutoReplyConfig = {
  enabled: false,
  pollIntervalMs: DEFAULT_POLL_MS,
  allowlist: [],
  perContactHourlyCap: DEFAULT_PER_CONTACT_HOURLY_CAP,
  globalHourlyCap: DEFAULT_GLOBAL_HOURLY_CAP
}

/**
 * Normalise a raw allowlist value (from settings JSON or an IPC write, so it may
 * be anything) into clean AllowlistEntry[]: accepts either bare name strings or
 * `{name, instruction}` objects, strips control chars (a stray newline would
 * submit a WhatsApp search early), drops blanks and over-long names, de-dupes
 * case-insensitively, caps the instruction length, and caps the list size.
 */
export function normalizeAllowlist(raw: unknown): AllowlistEntry[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: AllowlistEntry[] = []
  for (const item of raw) {
    let rawName = ''
    let instruction: string | undefined
    if (typeof item === 'string') {
      rawName = item
    } else if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>
      if (typeof o.name === 'string') rawName = o.name
      if (typeof o.instruction === 'string' && o.instruction.trim()) {
        // eslint-disable-next-line no-control-regex -- strips C0/DEL control chars
        instruction = o.instruction.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, MAX_INSTRUCTION_LEN)
      }
    }
    // eslint-disable-next-line no-control-regex -- strips C0/DEL control chars
    const name = rawName.replace(/[\x00-\x1f\x7f]/g, '').trim()
    if (!name || name.length > 128) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(instruction ? { name, instruction } : { name })
    if (out.length >= MAX_ALLOWLIST_ENTRIES) break
  }
  return out
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
  return Math.min(max, Math.max(min, n))
}

/**
 * Turn a raw stored/IPC config value into a valid AutoReplyConfig, applying
 * every clamp and the fail-safe enable rule. This is the single choke point both
 * the settings reader and the settings writer pass through, so an out-of-range
 * or malformed value can never reach the watcher.
 */
export function normalizeAutoReplyConfig(raw: unknown): AutoReplyConfig {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    // Fail safe: anything other than a literal true leaves the feature OFF.
    enabled: o.enabled === true,
    pollIntervalMs: clampInt(o.pollIntervalMs, MIN_POLL_MS, MAX_POLL_MS, DEFAULT_POLL_MS),
    allowlist: normalizeAllowlist(o.allowlist),
    perContactHourlyCap: clampInt(o.perContactHourlyCap, 1, 60, DEFAULT_PER_CONTACT_HOURLY_CAP),
    globalHourlyCap: clampInt(o.globalHourlyCap, 1, 200, DEFAULT_GLOBAL_HOURLY_CAP)
  }
}

/**
 * Match an OCR'd sender name against the allowlist, fail-closed. Reuses the same
 * fuzzy scorer send_whatsapp_message uses, but with a STRICTER confidence bar
 * (floor 80, not 70, and must clear the runner-up) — this is an UNATTENDED
 * match deciding whether to act without the user in the loop, so a near-miss
 * ("John A" vs allowlisted "John B") must resolve to "no match", never a guess.
 * Returns the matched entry, or null when no allowlisted contact is clearly it.
 */
export function matchAllowlist(sender: string, allowlist: readonly AllowlistEntry[]): AllowlistEntry | null {
  const qn = normalizeAppName(sender)
  if (!qn) return null
  const scored = allowlist
    .map((entry) => ({ entry, score: scoreAppName(qn, normalizeAppName(entry.name)) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
  if (scored.length === 0) return null
  const [top, second] = scored
  const confident = top.score === 100 || (top.score >= 80 && (!second || top.score - second.score >= 15))
  return confident ? top.entry : null
}

/**
 * Sliding-window rate limiter for composed drafts. Two independent caps over a
 * rolling one-hour window: per-contact (stops a two-bot reply loop from spinning
 * against one chat) and global (stops the account from producing a spam-shaped
 * burst across many chats). Pure and time-injectable, so the windows are tested
 * deterministically without waiting real time.
 */
export class AutoReplyRateLimiter {
  private events: { contactKey: string; at: number }[] = []

  constructor(
    private readonly perContactCap: number,
    private readonly globalCap: number,
    private readonly windowMs: number = RATE_WINDOW_MS
  ) {}

  private prune(now: number): void {
    const cutoff = now - this.windowMs
    if (this.events.length && this.events[0].at <= cutoff) {
      this.events = this.events.filter((e) => e.at > cutoff)
    }
  }

  private static key(contact: string): string {
    return contact.trim().toLowerCase()
  }

  /** Whether a draft for `contact` is allowed right now. Does NOT record it. */
  allow(contact: string, now: number = Date.now()): boolean {
    this.prune(now)
    if (this.events.length >= this.globalCap) return false
    const key = AutoReplyRateLimiter.key(contact)
    const perContact = this.events.reduce((n, e) => (e.contactKey === key ? n + 1 : n), 0)
    return perContact < this.perContactCap
  }

  /** Record that a draft was composed for `contact`. */
  record(contact: string, now: number = Date.now()): void {
    this.prune(now)
    this.events.push({ contactKey: AutoReplyRateLimiter.key(contact), at: now })
  }

  /** allow() + record() as one step; returns whether it was allowed. */
  tryConsume(contact: string, now: number = Date.now()): boolean {
    if (!this.allow(contact, now)) return false
    this.record(contact, now)
    return true
  }
}

/** A new incoming message the detector noticed, assembled from OCR. */
export interface DetectedMessage {
  /** Sender/group name read from the changed chat-list row. */
  sender: string
  /** Short preview text from the chat-list row (may be partial). */
  preview: string
  /** Full message text OCR'd after opening the chat, when available. */
  fullText?: string
  /** A few prior OCR'd lines from the open chat, oldest first, for context. */
  recentContext?: string[]
}

/** The watcher's per-detection decision, produced purely for testability. */
export type AutoReplyDecision =
  | { action: 'skip'; reason: string }
  | { action: 'draft'; entry: AllowlistEntry }

/**
 * Decide whether a detected message should be drafted for. Ordered so the
 * cheapest and most decisive OFF-switches win first: disabled ⇒ empty allowlist
 * ⇒ sender not confidently on the allowlist ⇒ rate-limited. Only a message from
 * a clearly-allowlisted sender, under both caps, yields {action:'draft'}. Does
 * not mutate the limiter — the caller records a draft only once it is actually
 * composed and surfaced, so a compose failure never consumes budget.
 */
export function decideAutoReply(
  sender: string,
  config: AutoReplyConfig,
  limiter: AutoReplyRateLimiter,
  now: number = Date.now()
): AutoReplyDecision {
  if (!config.enabled) return { action: 'skip', reason: 'auto-reply is turned off' }
  if (config.allowlist.length === 0) return { action: 'skip', reason: 'allowlist is empty' }
  const entry = matchAllowlist(sender, config.allowlist)
  if (!entry) return { action: 'skip', reason: `sender "${sender}" is not on the allowlist` }
  if (!limiter.allow(entry.name, now)) {
    return { action: 'skip', reason: `hourly draft limit reached for "${entry.name}"` }
  }
  return { action: 'draft', entry }
}

/**
 * Build the system + user prompt for the compose call. Kept pure (returns the
 * strings; the wiring layer wraps them for callChatProxyText) so the prompt
 * shape is testable. The prompt is explicit that the output is a SUGGESTION a
 * human will review, and that only the raw reply text should be produced.
 */
export function buildAutoReplyPrompt(
  msg: DetectedMessage,
  entry: AllowlistEntry
): { system: string; user: string } {
  const system = [
    'You are drafting a SUGGESTED reply on behalf of the user in a WhatsApp chat.',
    'Output ONLY the reply text itself — no quotation marks, no preamble, no explanation, no sign-off unless natural.',
    "Keep it natural, concise, and in the user's likely voice. Reply in the same language as the incoming message.",
    entry.instruction ? `The user's standing instruction for this contact: ${entry.instruction}` : '',
    'This is only a suggestion; the user will review it before it is ever sent, so never assume it will be sent as-is.'
  ]
    .filter(Boolean)
    .join('\n')

  const contextBlock =
    msg.recentContext && msg.recentContext.length > 0
      ? `Recent conversation (oldest first), for context:\n${msg.recentContext.join('\n')}\n\n`
      : ''
  const incoming = (msg.fullText?.trim() || msg.preview.trim() || '').slice(0, 2000)
  const user = `${contextBlock}The latest incoming message from "${msg.sender}" is:\n"${incoming}"\n\nDraft a reply.`
  return { system, user }
}

/**
 * From two OCR passes of the chat list, return the name-like lines that newly
 * appeared — the candidate senders of new messages. Uses frameState.textDelta
 * (pure) for the diff, then keeps only plausible name lines (same permissive
 * filter ocrWhatsAppCandidates uses: 2–60 chars, contains a letter), de-duped.
 * The wiring layer resolves these against the allowlist; this only narrows the
 * OCR noise down to things that could be a chat name.
 */
export function newSenderCandidates(beforeLines: readonly string[], afterLines: readonly string[]): string[] {
  const { added } = textDelta(beforeLines, afterLines)
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of added) {
    const line = raw.trim()
    if (line.length < 2 || line.length > 60 || !/[a-zA-Z]/.test(line)) continue
    const key = line.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(line)
  }
  return out
}
