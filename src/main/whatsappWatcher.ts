/**
 * whatsappWatcher.ts — background poller for the allowlisted auto-reply feature
 * (spec item #2), plus the per-poll orchestration (item #3, compose side).
 *
 * The class takes ALL of its side effects as injected dependencies (screenshot/
 * OCR of the chat list, opening+reading a chat, the chat-proxy compose call, the
 * draft/ audit sinks). That keeps this file free of Electron/native imports so
 * the tick logic — which senders trigger a draft, first-poll baselining, rate-
 * limit consumption, never-send — is unit-testable with fakes. The concrete
 * dependencies are assembled in whatsappWatcherService.ts.
 *
 * SAFETY: tick() COMPOSES and EMITS a suggested reply; it never sends. Sending
 * stays a human click through send_whatsapp_message. See whatsappAutoReply.ts.
 */

import {
  AutoReplyRateLimiter,
  decideAutoReply,
  newSenderCandidates,
  buildAutoReplyPrompt,
  type AutoReplyConfig,
  type DetectedMessage
} from './whatsappAutoReply'

/** A suggested reply surfaced to the user for review — NOT a sent message. */
export interface DraftReply {
  /** Allowlisted contact/group the draft is for. */
  contact: string
  /** What was read from the incoming message (for the user to sanity-check). */
  incomingPreview: string
  /** The composed suggestion. The user reviews and clicks to send it. */
  draftText: string
  /** ISO timestamp the draft was composed. */
  at: string
}

/** All side effects the watcher needs, injected so the orchestration is testable. */
export interface WatcherDeps {
  /**
   * Focus WhatsApp, OCR the chat list, and return the names of chats that
   * currently look UNREAD (an unread badge / bold row). A sender is treated as
   * having a new message when they ENTER this set between polls, so a returning
   * contact already visible in the list is still detected. Detection is
   * best-effort OCR — but a false positive is harmless here: it can only compose
   * a draft the user ignores, never send anything (see the safety model).
   */
  captureUnreadSenders(): Promise<string[]>
  /** Open a chat by name and OCR its latest text + a little prior context. */
  readChat(name: string): Promise<{ fullText: string; recentContext: string[] }>
  /** Compose a reply via chat-proxy (system + user prompt → reply text). */
  compose(system: string, user: string): Promise<string>
  /** Surface a composed draft to the user for review + click-to-send. */
  onDraft(draft: DraftReply): void
  /** Append the draft to the reviewable audit log. */
  onAudit(draft: DraftReply): void
  /** Notify the UI whenever the watcher starts/stops (drives the indicator). */
  onActiveChange?(active: boolean): void
  /** Optional diagnostic sink for skips/errors. */
  log?(msg: string): void
}

/**
 * Polls WhatsApp's chat list and, for a NEW message from an allowlisted sender,
 * composes a suggested reply for the user to review. Default-inert: it does
 * nothing until start() is called AND the config is enabled with a non-empty
 * allowlist. stop() is the kill switch and takes effect immediately.
 */
export class WhatsAppWatcher {
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private ticking = false
  /** The last poll's unread-sender set, diffed against to find new arrivals. */
  private lastLines: string[] = []
  /** False until the first poll after a start establishes the baseline. */
  private baselined = false
  private limiter: AutoReplyRateLimiter

  constructor(
    private readonly deps: WatcherDeps,
    private readonly getConfig: () => AutoReplyConfig
  ) {
    const c = getConfig()
    this.limiter = new AutoReplyRateLimiter(c.perContactHourlyCap, c.globalHourlyCap)
  }

  isActive(): boolean {
    return this.running
  }

  /**
   * Start polling — but only if the config is enabled with a non-empty
   * allowlist (the two conditions the spec requires the loop to pause on).
   * Idempotent; rebuilds the rate limiter from the current caps and resets the
   * baseline so the first poll after a start never acts on a stale screenful.
   */
  start(): void {
    const config = this.getConfig()
    if (!config.enabled || config.allowlist.length === 0) {
      this.stop()
      return
    }
    if (this.running) return
    this.running = true
    this.limiter = new AutoReplyRateLimiter(config.perContactHourlyCap, config.globalHourlyCap)
    this.lastLines = []
    this.baselined = false
    this.deps.onActiveChange?.(true)
    this.scheduleNext(0)
  }

  /** Stop immediately. This is the kill switch — idempotent, always reachable. */
  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.running) {
      this.running = false
      this.deps.onActiveChange?.(false)
    }
  }

  /** Re-evaluate against the latest config after a settings change. */
  reconcile(): void {
    const config = this.getConfig()
    if (config.enabled && config.allowlist.length > 0) this.start()
    else this.stop()
  }

  private scheduleNext(delayMs: number): void {
    if (!this.running) return
    this.timer = setTimeout(() => {
      void this.runTickThenSchedule()
    }, delayMs)
  }

  private async runTickThenSchedule(): Promise<void> {
    try {
      await this.tick()
    } catch (err) {
      this.deps.log?.(`whatsapp watcher tick failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (this.running) this.scheduleNext(this.getConfig().pollIntervalMs)
  }

  /**
   * One poll. Reads the chat list, diffs against the baseline to find newly-
   * appeared senders, and for each decides (enabled → allowlist → rate limit)
   * whether to draft. The FIRST poll only establishes the baseline and never
   * acts, so turning the feature on does not fire replies at everything already
   * unread on screen. Rate budget is consumed only once a non-empty draft is
   * actually produced. Exposed for unit testing.
   */
  async tick(now: number = Date.now()): Promise<void> {
    const config = this.getConfig()
    // Re-check at tick time: the config can flip off between polls.
    if (!config.enabled || config.allowlist.length === 0) {
      this.stop()
      return
    }
    if (this.ticking) return
    this.ticking = true
    try {
      const lines = await this.deps.captureUnreadSenders()
      const firstPoll = !this.baselined
      const candidates = firstPoll ? [] : newSenderCandidates(this.lastLines, lines)
      this.lastLines = lines
      this.baselined = true
      if (firstPoll) return

      for (const sender of candidates) {
        const decision = decideAutoReply(sender, config, this.limiter, now)
        if (decision.action !== 'draft') {
          this.deps.log?.(`skip "${sender}": ${decision.reason}`)
          continue
        }

        // Open the chat to read the actual message + a little context.
        let detected: DetectedMessage = { sender: decision.entry.name, preview: sender }
        try {
          const { fullText, recentContext } = await this.deps.readChat(decision.entry.name)
          detected = {
            sender: decision.entry.name,
            preview: (fullText || sender).slice(0, 120),
            fullText,
            recentContext
          }
        } catch (err) {
          this.deps.log?.(`readChat failed for "${decision.entry.name}": ${String(err)}`)
        }

        const { system, user } = buildAutoReplyPrompt(detected, decision.entry)
        let draftText = ''
        try {
          draftText = (await this.deps.compose(system, user)).trim()
        } catch (err) {
          this.deps.log?.(`compose failed for "${decision.entry.name}": ${String(err)}`)
          continue
        }
        if (!draftText) continue

        // Only now — a real draft exists — consume the rate-limit budget.
        this.limiter.record(decision.entry.name, now)

        const draft: DraftReply = {
          contact: decision.entry.name,
          incomingPreview: (detected.fullText || detected.preview || '').slice(0, 200),
          draftText,
          at: new Date(now).toISOString()
        }
        this.deps.onDraft(draft)
        this.deps.onAudit(draft)
      }
    } finally {
      this.ticking = false
    }
  }
}
