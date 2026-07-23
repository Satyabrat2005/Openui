/**
 * whatsappAutoReplyConfig.ts — the DB-backed edges of the auto-reply feature:
 * the single settings row it persists to, and the audit-trail append for every
 * composed draft. Kept out of the pure core (whatsappAutoReply.ts) because it
 * touches the settings store and the OS-automation audit log; kept out of the
 * watcher because the watcher takes these as injected deps for testability.
 */

import { database } from './database'
import { audit } from './osConsent'
import { normalizeAutoReplyConfig, type AutoReplyConfig } from './whatsappAutoReply'
import type { DraftReply } from './whatsappWatcher'

/** One JSON row holds the whole config (enabled, interval, allowlist, caps). */
export const AUTO_REPLY_SETTING_KEY = 'whatsapp_autoreply'

/** Read the persisted config, normalised/clamped (defaults to all-off). */
export function getAutoReplyConfig(): AutoReplyConfig {
  return normalizeAutoReplyConfig(database.settings.getSetting(AUTO_REPLY_SETTING_KEY))
}

/**
 * Normalise and persist a config write (from the Settings UI / IPC), returning
 * the value actually stored. Every write passes through normalizeAutoReplyConfig,
 * so an out-of-range interval, a garbage allowlist, or a non-boolean `enabled`
 * can never be persisted in a form the watcher would act on.
 */
export function setAutoReplyConfig(raw: unknown): AutoReplyConfig {
  const normalized = normalizeAutoReplyConfig(raw)
  database.settings.setSetting(AUTO_REPLY_SETTING_KEY, normalized)
  return normalized
}

/**
 * Append a composed draft to the OS-automation audit log — the same reviewable
 * trail osConsent uses for consent decisions. Records the contact and the exact
 * suggested text so the user can later see everything the watcher drafted, even
 * the drafts they never sent.
 */
export function auditDraftedReply(draft: DraftReply): void {
  audit('WHATSAPP_AUTOREPLY_DRAFT', {
    app: 'whatsapp',
    detail: `to="${draft.contact}" draft="${draft.draftText}"`
  })
}
