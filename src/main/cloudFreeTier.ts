/**
 * cloudFreeTier.ts — usage-counter plumbing for the renderer.
 *
 * OpenUI's chat/planning/agent loop is fully local (see `callModel` in
 * `agent.ts`, which always routes through Ollama). Local inference is never
 * metered, so the only job left here is to tell the renderer's usage counter
 * that every turn is unlimited — it keeps the `openui:usage-update` contract
 * in one place instead of duplicating it at each call site.
 */
import type { BrowserWindow } from 'electron'
import type { Tier } from './tools'

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

/** Push a usage update for a non-metered (local Ollama) turn. */
export function emitLocalUsage(win: BrowserWindow, tier: Tier): void {
  send(win, 'openui:usage-update', { tier, limit: null, remaining: null, unlimited: true } satisfies UsageUpdate)
}
