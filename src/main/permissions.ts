/**
 * permissions.ts — OS-permission helpers for OpenUI (macOS + Windows).
 *
 * Uses Electron's built-in systemPreferences API so no additional native
 * dependency is required.
 *
 * Accessibility  — required by nut.js for mouse/keyboard synthesis.
 * Microphone     — required by the renderer's MediaRecorder voice input.
 *
 * All check functions return the "granted" state on unsupported platforms so
 * the rest of the codebase can call them unconditionally.
 */
import { systemPreferences, shell } from 'electron'

export type PermissionTarget = 'accessibility' | 'microphone'

// Deep-link URLs that open the correct settings pane per platform.
const SETTINGS_URLS: Record<PermissionTarget, Partial<Record<NodeJS.Platform, string>>> = {
  accessibility: {
    darwin: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    win32: 'ms-settings:easeofaccess'
  },
  microphone: {
    darwin: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
    win32: 'ms-settings:privacy-microphone'
  }
}

/**
 * Returns true if the app holds Accessibility (AX) permission.
 * On macOS, checks via isTrustedAccessibilityClient without prompting.
 * On Windows and Linux, nut.js manages its own access — returns true so the
 * caller proceeds and nut.js surfaces its own error on failure.
 */
export function checkAccessibility(): boolean {
  if (process.platform !== 'darwin') return true
  return systemPreferences.isTrustedAccessibilityClient(false)
}

/**
 * Returns the microphone permission status string.
 * On macOS, queries systemPreferences directly.
 * On other platforms, returns 'authorized' and lets the browser's
 * getUserMedia call surface any denial at the renderer level.
 */
export function checkMicrophone(): string {
  if (process.platform !== 'darwin') return 'authorized'
  return systemPreferences.getMediaAccessStatus('microphone')
}

/**
 * Open the OS settings pane for the given permission so the user can grant it
 * without hunting through the UI themselves.
 * macOS → System Settings deep-link (x-apple.systempreferences:…)
 * Windows → Settings URI (ms-settings:…)
 * Other platforms → no-op.
 */
export async function openSettingsPane(permission: PermissionTarget): Promise<void> {
  const url = SETTINGS_URLS[permission][process.platform as NodeJS.Platform]
  if (!url) return
  await shell.openExternal(url)
}
