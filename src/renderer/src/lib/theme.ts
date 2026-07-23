/**
 * Theme preference plumbing. The renderer is styled by CSS custom properties
 * (see index.css); a `data-theme` attribute on <html> selects the light token
 * overrides. This module is the single source of truth for the *active*
 * preference so the OS-change listener and the Settings toggle stay in sync.
 *
 *   'dark'   — always dark (the default; also the look when no attribute is set)
 *   'light'  — always light
 *   'system' — follow the OS colour scheme, live
 */
export type ThemePref = 'system' | 'light' | 'dark'

let currentPref: ThemePref = 'dark'

/** Coerce an untrusted persisted value to a known preference (defaults to dark). */
export function coerceThemePref(value: unknown): ThemePref {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'dark'
}

function resolve(pref: ThemePref): 'light' | 'dark' {
  if (pref === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return pref
}

/** Apply a preference immediately and remember it as the active one. */
export function applyTheme(pref: ThemePref): void {
  currentPref = pref
  document.documentElement.dataset.theme = resolve(pref)
}

/**
 * Keep the applied theme in step with the OS scheme while the preference is
 * 'system'. Returns an unsubscribe function. No-op for explicit light/dark.
 */
export function watchSystemTheme(): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  const onChange = (): void => {
    if (currentPref === 'system') document.documentElement.dataset.theme = resolve(currentPref)
  }
  mq.addEventListener('change', onChange)
  return () => mq.removeEventListener('change', onChange)
}
