/**
 * secretStore.ts — encryption at rest for credential settings.
 *
 * THE PROBLEM THIS FIXES. Every channel credential the app holds — Gmail,
 * Google Calendar, Google Drive refresh tokens, Slack and Telegram bot tokens,
 * GitHub and Figma tokens, the Anthropic API key — was written to
 * `settings.value` as plaintext JSON in `%APPDATA%/OpenUI/openui.db`. Any
 * process running as the user, anything that reads a backup or a synced folder,
 * and anyone with the laptop, could lift all of them from one file. For a
 * product whose pitch is "connect all your accounts", that file is the
 * highest-value target in the install.
 *
 * THE FIX. Electron's `safeStorage`, which is backed by DPAPI on Windows, the
 * Keychain on macOS, and libsecret/kwallet on Linux — so the key is held by the
 * OS and tied to the user account, and no key material lives in the repo or in
 * the database. This is the same guarantee `openui-web` already gives its
 * GitHub PAT with AES-256-GCM; the desktop app was behind its own sibling.
 *
 * COMPATIBILITY, both directions:
 *   • Reading an existing PLAINTEXT value still works, and re-encrypts it on the
 *     next write. No migration step, no reconnect prompt, nothing for the user
 *     to do — an installed app keeps working across the upgrade.
 *   • Reading an ENCRYPTED value on a build without safeStorage returns null
 *     rather than a corrupt string, so the caller treats the channel as not
 *     connected and asks the user to reconnect. That is the safe failure.
 *
 * WHEN ENCRYPTION IS UNAVAILABLE (a Linux box with no keyring, or before
 * `app.whenReady()`), the value is stored as plaintext exactly as before and the
 * reason is logged ONCE. Refusing to store the credential would break the
 * feature outright, which is a worse outcome than the status quo it replaces —
 * but it is logged, not silent, so it can never be mistaken for encrypted.
 */
import { safeStorage } from 'electron'

/** Marks a stored value as an encrypted envelope rather than plain JSON. */
const ENVELOPE_PREFIX = 'enc:v1:'

let warnedUnavailable = false

/**
 * Is OS-backed encryption usable right now?
 *
 * Wrapped in try/catch because `safeStorage` throws rather than returning false
 * when touched before the app is ready, and because the unit suite mocks
 * `electron` with a partial module where it is undefined.
 */
export function isEncryptionAvailable(): boolean {
  try {
    return typeof safeStorage?.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

/** True when a stored string is one of our encrypted envelopes. */
export function isEncrypted(stored: string): boolean {
  return typeof stored === 'string' && stored.startsWith(ENVELOPE_PREFIX)
}

/**
 * Encrypt a serialised setting value. Returns the input unchanged, and logs
 * once, when the platform cannot encrypt — see the header for why that is
 * preferred over refusing to store the credential at all.
 */
export function encryptValue(serialised: string): string {
  if (!isEncryptionAvailable()) {
    if (!warnedUnavailable) {
      warnedUnavailable = true
      console.warn(
        '[secretStore] OS-backed encryption is unavailable on this system; ' +
          'credentials are being stored UNENCRYPTED. On Linux this usually means ' +
          'no keyring (libsecret/kwallet) is installed or unlocked.'
      )
    }
    return serialised
  }
  try {
    return ENVELOPE_PREFIX + safeStorage.encryptString(serialised).toString('base64')
  } catch (err) {
    console.warn('[secretStore] encryptString failed; storing unencrypted:', err)
    return serialised
  }
}

/**
 * Decrypt a stored setting value.
 *
 * Returns `null` for an envelope we cannot open — a different OS user, a
 * restored-from-backup profile, or a build without safeStorage. Null makes the
 * caller treat the credential as absent and re-prompt, which is right; handing
 * back a mangled string would send a broken token to a live API.
 */
export function decryptValue(stored: string): string | null {
  if (!isEncrypted(stored)) return stored
  if (!isEncryptionAvailable()) return null
  try {
    return safeStorage.decryptString(Buffer.from(stored.slice(ENVELOPE_PREFIX.length), 'base64'))
  } catch {
    return null
  }
}
