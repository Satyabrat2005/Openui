/**
 * secretKeys.ts — which settings hold credentials, and therefore must never be
 * written to the database in plaintext.
 *
 * WHY AN EXPLICIT LIST RATHER THAN A `/token|secret/` HEURISTIC. A heuristic
 * decides silently, and it is wrong in both directions: it would encrypt
 * `export_figma_tokens` (a boolean UI preference) and it would miss a future key
 * called `slack_app_credential`. An explicit list is reviewable in a diff — you
 * can see what is protected — and the guard test alongside it fails the build
 * when a new secret-looking key appears that nobody added here. So the heuristic
 * still runs; it just raises a build failure instead of making the call itself.
 *
 * These are long-lived credentials, not session tokens: a Gmail refresh token is
 * persistent access to somebody's email, and a Slack bot token can read and post
 * across a workspace. They are the highest-value thing the app stores.
 */

/** Settings keys whose values are credentials. Encrypted at rest. */
export const SECRET_SETTING_KEYS: ReadonlySet<string> = new Set([
  'anthropic_api_key',
  'figma_bridge_token',
  'figma_token',
  'github_token',
  'gmail_refresh_token',
  'google_calendar_refresh_token',
  'google_drive_refresh_token',
  'google_oauth_client_secret',
  'slack_token',
  'telegram_bot_token'
])

/**
 * Keys that LOOK like secrets to the guard test but deliberately are not, with
 * the reason. Anything matching the pattern and absent from both sets fails the
 * test, which is the point: adding a credential without protecting it should not
 * be possible by accident.
 */
export const NON_SECRET_TOKEN_LIKE_KEYS: ReadonlySet<string> = new Set([
  // A boolean: "also export design tokens when exporting from Figma".
  'export_figma_tokens'
])

/** Does this settings key hold a credential? */
export function isSecretKey(key: string): boolean {
  return SECRET_SETTING_KEYS.has(key)
}

/** The pattern the guard test uses to find keys that should have been declared. */
export const SECRET_LOOKING = /(^|_)(token|secret|api_key|apikey|password|credential|refresh)(_|$)/i
