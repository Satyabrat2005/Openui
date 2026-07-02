/**
 * authWindow.ts — Google OAuth via system browser (PRIMARY path).
 *
 * WHY THIS APPROACH:
 * Google's OAuth policy blocks sign-in inside embedded user agents — which
 * includes ALL Electron BrowserWindows. Loading the Google consent screen
 * inside Electron produces "Sign-in is temporarily unavailable" because Google
 * fingerprints the Electron/Chrome user-agent string and blocks it.
 *
 * THE FIX: shell.openExternal() opens the Supabase authorize URL in the user's
 * real system browser (Chrome, Firefox, Edge, Safari). Google allows this.
 * The callback token arrives via the openui:// deep link — handled in deeplink.ts.
 *
 * FLOW:
 *   1. openAuthWindow() → shell.openExternal(supabaseAuthorizeUrl)
 *   2. User completes Google sign-in in their real browser
 *   3. Supabase redirects to openui://auth-callback#access_token=…
 *   4. OS delivers deep link to this Electron process
 *   5. deeplink.ts → completeAuth() → tokens saved → renderer notified
 *
 * A small "waiting" overlay window is shown while the user is in their browser
 * so they know the app is listening. It closes automatically on success/failure.
 */
import { BrowserWindow, shell, type WebContents } from 'electron'
import { handleDeepLink } from './deeplink'
import { isSupabaseConfigured } from './supabaseClient'

let authWindow: BrowserWindow | null = null

const authContents = new WeakSet<WebContents>()

/** True if the given webContents belongs to an auth waiting window we opened. */
export function isAuthWebContents(contents: WebContents): boolean {
  return authContents.has(contents)
}

/** True while an auth flow is in progress (keeps the overlay from auto-hiding). */
export function isAuthWindowOpen(): boolean {
  return Boolean(authWindow && !authWindow.isDestroyed())
}

/**
 * Start the Google OAuth flow via the system browser.
 * Returns the waiting-window BrowserWindow, or null if SUPABASE_URL is missing.
 */
export function openAuthWindow(parent?: BrowserWindow | null): BrowserWindow | null {
  // Both SUPABASE_URL and SUPABASE_ANON_KEY are required: the URL builds the
  // authorize link below, and the anon key is needed later by completeAuth() to
  // adopt the session. Checking both up front means a missing key fails fast
  // (renderer shows "Sign-in is temporarily unavailable") instead of opening the
  // browser and only erroring after the user has signed in with Google.
  if (!isSupabaseConfigured()) {
    console.error(
      '[openui] Cannot start auth — SUPABASE_URL / SUPABASE_ANON_KEY are not set. ' +
        'Copy .env.example to .env and fill both in (see README → Environment Variables), ' +
        'then add openui://auth-callback to Supabase Auth → URL Configuration and enable the Google provider.'
    )
    return null
  }
  const supabaseUrl = process.env.SUPABASE_URL as string

  if (authWindow && !authWindow.isDestroyed()) {
    authWindow.focus()
    return authWindow
  }

  const parentWindow =
    parent && !parent.isDestroyed()
      ? parent
      : BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null

  // ── Build the authorize URL ─────────────────────────────────────────────────
  const authorizeUrl = new URL('/auth/v1/authorize', supabaseUrl)
  authorizeUrl.searchParams.set('provider', 'google')
  authorizeUrl.searchParams.set('redirect_to', 'openui://auth-callback')

  // ── PRIMARY: open in system browser (bypasses Google embedded-UA block) ────
  void shell.openExternal(authorizeUrl.toString())

  // ── Waiting overlay (shown while user signs in on system browser) ───────────
  const isMac = process.platform === 'darwin'
  const chrome = isMac
    ? ({ titleBarStyle: 'hiddenInset', frame: false } as const)
    : ({ frame: true } as const)

  authWindow = new BrowserWindow({
    width: 400,
    height: 220,
    center: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'Signing in to OpenUI…',
    autoHideMenuBar: true,
    parent: parentWindow ?? undefined,
    modal: Boolean(parentWindow),
    show: false,
    ...chrome,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    }
  })

  authContents.add(authWindow.webContents)

  // Inline waiting-page HTML — no external file needed
  const waitingHtml = `data:text/html;charset=utf-8,${encodeURIComponent(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{
    background:#0f0f13;color:#e2e8f0;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    display:flex;flex-direction:column;align-items:center;justify-content:center;
    height:100vh;gap:14px;user-select:none;-webkit-app-region:drag;
  }
  .spinner{
    width:32px;height:32px;
    border:3px solid rgba(167,139,250,0.2);
    border-top-color:#a78bfa;border-radius:50%;
    animation:spin 0.75s linear infinite;
  }
  @keyframes spin{to{transform:rotate(360deg)}}
  h2{font-size:14px;font-weight:600;color:#f1f5f9}
  p{font-size:11px;color:#64748b;text-align:center;max-width:280px;line-height:1.5}
  .hint{font-size:10px;color:#475569;margin-top:4px}
</style>
</head>
<body>
  <div class="spinner"></div>
  <h2>Complete sign-in in your browser</h2>
  <p>A Google sign-in page has opened in your default browser.<br/>This window closes automatically when done.</p>
  <p class="hint">Didn't see it? Check your taskbar.</p>
</body>
</html>`)}`

  // FALLBACK: intercept openui:// if OS delivers the deep link into this window
  const onNavigate = (event: Electron.Event, url: string): void => {
    if (url.startsWith('openui://')) {
      event.preventDefault()
      void handleDeepLink(url, parentWindow)
    }
  }
  authWindow.webContents.on('will-redirect', onNavigate)
  authWindow.webContents.on('will-navigate', onNavigate)

  authWindow.once('ready-to-show', () => authWindow?.show())
  authWindow.on('closed', () => { authWindow = null })

  void authWindow.loadURL(waitingHtml)
  return authWindow
}

/** Close the waiting window. Called by completeAuth() on success or failure. */
export function closeAuthWindow(): void {
  if (authWindow && !authWindow.isDestroyed()) {
    authWindow.close()
  }
  authWindow = null
}
