/**
 * Telemetry event names.
 *
 * Central registry of the analytics events OpenUI emits. Values are the wire
 * names (snake_case) handed to whatever sink `trackEvent` is wired to; the keys
 * are the stable identifiers the rest of the codebase references, so renaming a
 * wire name never has to touch call sites.
 *
 * There is no analytics backend yet — `trackEvent` currently logs locally (see
 * ./index) — but pinning the contract here keeps event names consistent for
 * when one is added.
 */
export const EVENTS = {
  // ── Auto-update (electron-updater) ────────────────────────────────────────
  /** A newer version was found on the update feed. { current_version, new_version } */
  UPDATE_AVAILABLE: 'update_available',
  /** The update finished downloading and is ready to install. { current_version, new_version } */
  UPDATE_DOWNLOADED: 'update_downloaded',
  /** A download of an available update was started. { current_version } */
  UPDATE_DOWNLOAD_STARTED: 'update_download_started',
  /** The user chose to install the downloaded update and relaunch. { current_version } */
  UPDATE_INSTALL_RESTART: 'update_install_restart',
  /** An update check or download failed. { error_type } */
  UPDATE_ERROR: 'update_error'
} as const

export type EventName = (typeof EVENTS)[keyof typeof EVENTS]
