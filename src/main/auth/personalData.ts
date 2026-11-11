/**
 * personalData.ts — what belongs to the person signed in, not to the computer.
 *
 * Channel connections (Gmail, Telegram, Slack… tokens), the cross-channel
 * memory, the contact book and the training/feedback log are stored once per
 * install, not per account. When a DIFFERENT account signs in on the same
 * computer (see setActiveUser) all of it is removed, so the new person never
 * reads, sends from, or is answered with the last person's accounts and chats.
 *
 * Conversations are already per account (conversations.user_id) and stay.
 */
import { database } from '../database'
import { SECRET_SETTING_KEYS } from '../database/repositories/secretKeys'

/**
 * The WhatsApp auto-reply settings (its allowlist names real contacts).
 * Same value as whatsappAutoReplyConfig's AUTO_REPLY_SETTING_KEY — not imported,
 * to keep the sign-in code free of the automation modules; a test pins them equal.
 */
export const AUTO_REPLY_KEY = 'whatsapp_autoreply'

/** Every settings key that holds one person's connection or preferences. */
export const PERSONAL_SETTING_KEYS: readonly string[] = [...SECRET_SETTING_KEYS, AUTO_REPLY_KEY]

export function clearPersonalData(): void {
  for (const key of PERSONAL_SETTING_KEYS) {
    try {
      database.settings.deleteSetting(key)
    } catch (err) {
      console.error(`[openui] could not remove setting ${key}:`, err)
    }
  }
  try {
    database.personal.clearPersonalTables()
  } catch (err) {
    console.error('[openui] could not clear the previous account’s memory and contacts:', err)
  }
}
