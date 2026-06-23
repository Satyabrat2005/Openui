/**
 * permissions.ts — macOS OS-permission helpers for OpenUI.
 *
 * Uses Electron's built-in systemPreferences API (the equivalent of
 * node-mac-permissions), so no additional native dependency is required.
 *
 * Accessibility  — required by nut.js for mouse/keyboard synthesis.
 * Microphone     — required by the renderer's MediaRecorder voice input.
 *
 * All functions are no-ops (return the "granted" state) on non-macOS platforms
 * so the rest of the codebase can call them unconditionally.
 */
import { systemPreferences, shell } from 'electron'

export type PermissionTarget = 'accessibility' | 'microphone'

// macOS deep-link URLs that open the correct Privacy pane in System Settings.
const SETTINGS_URLS: Record<PermissionTarget, string> = {
  accessibility:
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  microphone:
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
}

/**
 * Returns true if the app holds Accessibility (AX) permission.
 * Passing false to isTrustedAccessibilityClient checks without prompting.
 * Always returns true on non-macOS platforms.
 */
export function checkAccessibility(): boolean {
  if (process.platform !== 'darwin') return true
  return systemPreferences.isTrustedAccessibilityClient(false)
}

/**
 * Returns the macOS microphone permission status string.
 * Returns 'authorized' on non-macOS platforms.
 */
export function checkMicrophone(): string {
  if (process.platform !== 'darwin') return 'authorized'
  return systemPreferences.getMediaAccessStatus('microphone')
}

/**
 * Open the System Settings pane for the given permission so the user can
 * grant it without hunting through the UI themselves.
 * No-op on non-macOS platforms.
 */
export async function openSettingsPane(permission: PermissionTarget): Promise<void> {
  if (process.platform !== 'darwin') return
  await shell.openExternal(SETTINGS_URLS[permission])
}
