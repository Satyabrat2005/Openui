/**
 * cloudFreeTier.ts — usage-counter plumbing for the renderer.
 *
 * OpenUI's chat/planning/agent loop is fully local (see `callModel` in
 * `agent.ts`, which always routes through Ollama). Local turns cost us nothing
 * to serve, but a tier may still carry a daily allowance so that Free means
 * something — so this module's job is to keep the `openui:usage-update`
 * contract in one place and report whatever the meter actually says, rather
 * than duplicating that shape at each call site.
 */
import type { BrowserWindow } from 'electron'
import type { Tier } from './tools'
import { checkAllowance } from './usageMeter'

/** Payload pushed to the renderer so it can show "15/20 messages today". */
export interface UsageUpdate {
  tier: Tier
  /** Daily cloud-message cap, or null when unlimited (Enterprise / local AI). */
  limit: number | null
  /** Messages remaining today, or null when unlimited. */
  remaining: number | null
  /** True when this turn is not metered (Enterprise, or local Ollama). */
  unlimited: boolean
}

/** Send to the renderer, guarding a destroyed window. */
function send(win: BrowserWindow, channel: string, ...args: unknown[]): void {
  if (!win.isDestroyed()) win.webContents.send(channel, ...args)
}

/**
 * Push the current usage state for a local (Ollama) turn.
 *
 * This used to report every turn as `unlimited: true`, which was true when
 * nothing metered local inference. Now that a tier can carry a local daily
 * allowance (see usageMeter.ts) the counter has to reflect the real one —
 * otherwise this call, which runs inside `callModel` on every turn, would
 * immediately overwrite the accurate figure `handleChat` just sent and the
 * user's "3 left today" would flicker back to unlimited mid-answer.
 *
 * An unlimited tier still reports unlimited; nothing changes for Pro.
 */
export function emitLocalUsage(win: BrowserWindow, tier: Tier): void {
  const a = checkAllowance(tier)
  send(win, 'openui:usage-update', {
    tier,
    limit: a.limit,
    remaining: a.remaining,
    unlimited: a.unlimited
  } satisfies UsageUpdate)
}
