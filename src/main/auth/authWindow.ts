/**
 * authWindow.ts — the Google OAuth sign-in window.
 *
 * `openAuthWindow()` opens a dedicated BrowserWindow at Supabase's
 * `/auth/v1/authorize` endpoint for Google. The primary way the flow finishes is
 * the `openui://auth-callback` deep link (see deeplink.ts); the navigation
 * listeners here are a FALLBACK that captures the callback URL directly from the
 * window in case the OS does not route the deep link back to us (common on
 * first-time setup, especially on Windows).
 *
 * Cross-platform: window chrome is chosen per `process.platform` — a clean
 * hidden-inset title bar on macOS, standard frame controls on Windows/Linux.
 *
 * NOTE on embedded OAuth: Google may reject sign-in inside an embedded user
 * agent. The deep-link path (system browser) is the robust route; this window is
 * the in-app convenience/fallback the task requires.
 */
import { BrowserWindow, type WebContents } from 'electron'
import { handleDeepLink } from './deeplink'

let authWindow: BrowserWindow | null = null

// webContents we created for OAuth, so the global navigation lock in index.ts
// can let them roam across the Supabase/Google origins the flow needs.
const authContents = new WeakSet<WebContents>()

/** True if the given webContents belongs to an OAuth window we opened. */
export function isAuthWebContents(contents: WebContents): boolean {
  return authContents.has(contents)
}

/** True while an OAuth window is open (used to keep the overlay from hiding). */
export function isAuthWindowOpen(): boolean {
  return Boolean(authWindow && !authWindow.isDestroyed())
}

/**
 * Open (or focus) the Google OAuth window.
 *
 * @param parent the main overlay window. Passing it makes the OAuth window a
 *   modal child, which both grabs input and — importantly — stacks above the
 *   always-on-top transparent overlay (a standalone window would render behind
 *   it). Falls back to the first live window when omitted.
 * @returns the window, or null when Supabase is not configured.
 */
export function openAuthWindow(parent?: BrowserWindow | null): BrowserWindow | null {
  const supabaseUrl = process.env.SUPABASE_URL
  if (!supabaseUrl) {
    console.error('[openui] Cannot open auth window — SUPABASE_URL is not set.')
    return null
  }

  if (authWindow && !authWindow.isDestroyed()) {
    authWindow.focus()
    return authWindow
  }

  const parentWindow =
    parent && !parent.isDestroyed()
      ? parent
      : BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null

  const isMac = process.platform === 'darwin'
  // Platform-specific chrome — the only place the auth flow branches on OS.
  const chrome = isMac
    ? ({ titleBarStyle: 'hiddenInset', frame: false } as const)
    : ({ frame: true } as const)

  authWindow = new BrowserWindow({
    width: 800,
    height: 700,
    center: true,
    resizable: true,
    title: 'Sign in to OpenUI',
    autoHideMenuBar: true,
    parent: parentWindow ?? undefined,
    modal: Boolean(parentWindow),
    show: false,
    ...chrome,
    webPreferences: {
      // External web content: no node, isolated, sandboxed. A separate session
      // partition keeps Google/Supabase cookies out of the app's own session.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: 'persist:openui-auth'
    }
  })

  authContents.add(authWindow.webContents)

  // Build `${SUPABASE_URL}/auth/v1/authorize?provider=google&redirect_to=openui://auth-callback`
  // (URLSearchParams percent-encodes redirect_to, which Supabase decodes).
  const authorizeUrl = new URL('/auth/v1/authorize', supabaseUrl)
  authorizeUrl.searchParams.set('provider', 'google')
  authorizeUrl.searchParams.set('redirect_to', 'openui://auth-callback')

  // FALLBACK interception: if the window itself navigates to openui://… (because
  // the OS deep link didn't fire), grab the URL here. will-redirect catches the
  // 302 to the custom scheme; will-navigate catches form/link navigations. IPC
  // results go to the main window, not this OAuth window.
  const onNavigate = (event: Electron.Event, url: string): void => {
    if (url.startsWith('openui://')) {
      event.preventDefault()
      void handleDeepLink(url, parentWindow)
    }
  }
  authWindow.webContents.on('will-redirect', onNavigate)
  authWindow.webContents.on('will-navigate', onNavigate)

  authWindow.once('ready-to-show', () => authWindow?.show())
  authWindow.on('closed', () => {
    authWindow = null
  })

  void authWindow.loadURL(authorizeUrl.toString())
  return authWindow
}

/** Close the OAuth window if it is open. Safe to call at any time. */
export function closeAuthWindow(): void {
  if (authWindow && !authWindow.isDestroyed()) {
    authWindow.close()
  }
  authWindow = null
}
