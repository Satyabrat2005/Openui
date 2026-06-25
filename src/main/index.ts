import { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, session, shell } from 'electron'
import { join } from 'path'
import { registerAgentIPC, registerConversationIPC } from './agent'
import { registerVoiceIPC } from './voice'
import { registerInterviewerIPC } from './interviewer'
import { startScheduler } from './scheduler'
import { openSettingsPane, type PermissionTarget } from './permissions'
import { registerStripeIPC, isPaymentFlowWebContents } from './stripe/checkout'
import { registerWaitlistIPC } from './waitlist'
import { closeBrowser } from './tools'
import { initDatabase } from './database'
import { registerDeepLinkProtocol, setupDeepLinkHandlers } from './auth/deeplink'
import { openAuthWindow, isAuthWebContents, isAuthWindowOpen } from './auth/authWindow'
import { logout, getCurrentUser, getUserTier, startTokenRefreshLoop, stopTokenRefreshLoop } from './auth/sessionManager'
import { initTelemetry, enableTelemetryAfterConsent, shutdownTelemetry, setTelemetryOptOut, isTelemetryActive, trackEvent } from './telemetry/posthog'
import { grantConsent, denyConsent, getConsentStatus, recordPendingEvent, ConsentStatus } from './telemetry/consent'
import { initUpdater, checkForUpdates, downloadUpdate, installUpdateAndRestart, openReleasesPage } from './updater/updater'
import { Events } from './telemetry/events'

let tray: Tray | null = null
let win: BrowserWindow | null = null

const isDev = !app.isPackaged

const PERMISSION_TARGETS: readonly PermissionTarget[] = ['accessibility', 'microphone']

/**
 * Content-Security-Policy applied to every renderer response.
 *
 * The renderer makes NO direct network requests (every LLM/API call is proxied
 * through the main process over IPC), so production can lock everything down to
 * `'self'`. `style-src 'unsafe-inline'` is required because the UI uses React
 * inline `style={{…}}` attributes and Tailwind's injected styles; `media-src`
 * allows the recorded-audio blob URLs; `img-src data:` covers inline SVG/data
 * images. In dev we additionally permit the Vite dev server, its HMR websocket
 * and `'unsafe-eval'` (React Fast Refresh), which production never allows.
 */
function contentSecurityPolicy(): string {
  if (isDev) {
    return [
      "default-src 'self' 'unsafe-inline' data: blob:",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "connect-src 'self' ws: http: https:",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:"
    ].join('; ')
  }
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'"
  ].join('; ')
}

/**
 * Apply process-wide security hardening that is independent of any single
 * window: a Content-Security-Policy on all renderer responses, and a blanket
 * ban on navigation, popups and <webview> embedding. Even if the renderer is
 * somehow compromised (e.g. XSS), it cannot navigate away, open new windows,
 * or attach a privileged webview.
 */
function applySecurityHardening(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [contentSecurityPolicy()]
      }
    })
  })

  app.on('web-contents-created', (_event, contents) => {
    // Block all attempts to open new windows; route genuine external links to
    // the OS browser instead of a privileged Electron window. Payment windows
    // (Stripe checkout/portal) deny popups too, but WITHOUT leaking the URL to
    // the external browser mid-flow.
    contents.setWindowOpenHandler(({ url }) => {
      if (isPaymentFlowWebContents(contents)) return { action: 'deny' }
      if (url.startsWith('https://')) void shell.openExternal(url)
      return { action: 'deny' }
    })

    // Disallow navigating the main frame anywhere except the app's own origin
    // (the Vite dev URL in development, file:// when packaged). Two windows are
    // exempt and roam external origins: the OAuth window (Supabase/Google) and
    // the Stripe payment window (Stripe/bank). Each has its own handler that
    // captures the openui:// callback / success+cancel redirects.
    contents.on('will-navigate', (event, url) => {
      if (isAuthWebContents(contents) || isPaymentFlowWebContents(contents)) return
      const devUrl = process.env['ELECTRON_RENDERER_URL']
      const allowed = (isDev && devUrl && url.startsWith(devUrl)) || url.startsWith('file://')
      if (!allowed) event.preventDefault()
    })

    // Never allow <webview> tags to be created.
    contents.on('will-attach-webview', (event) => event.preventDefault())
  })
}

/**
 * Resolve a file inside the project's `resources/` folder.
 * In dev the compiled main lives in `out/main`, so resources sit two levels up.
 * When packaged they are copied next to the app via electron-builder's
 * `extraResources` (configure that when you add packaging).
 */
function resourcePath(...segments: string[]): string {
  return isDev
    ? join(__dirname, '../../resources', ...segments)
    : join(process.resourcesPath, 'resources', ...segments)
}

function overlayBounds(): Electron.Rectangle {
  // The popups are positioned with CSS against the full work area (the design
  // places the assistant centered and the task list bottom-right), so the
  // window itself spans the whole usable screen as a transparent canvas.
  return screen.getPrimaryDisplay().workArea
}

function createWindow(): void {
  const { x, y, width, height } = overlayBounds()

  win = new BrowserWindow({
    x,
    y,
    width,
    height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    roundedCorners: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The preload only uses contextBridge + ipcRenderer, both available in a
      // sandboxed renderer — so we run fully sandboxed. nodeIntegrationInWorker
      // stays off and webSecurity stays on (defaults, set explicitly).
      sandbox: true,
      webSecurity: true,
      nodeIntegrationInWorker: false
    }
  })

  // Float above normal windows like a real overlay panel.
  // On Windows the 'screen-saver' level is clamped to 'floating' by Electron,
  // which still places the window above normal app windows — the desired effect.
  // setVisibleOnAllWorkspaces is a no-op on Windows (no virtual-desktop API).
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // Dismiss when focus is lost — but only when packaged, so DevTools stay
  // usable during development. Never hide while the OAuth window is open: it is
  // a child of this overlay, so hiding the parent would hide the sign-in window.
  win.on('blur', () => {
    if (app.isPackaged && win && !win.webContents.isDevToolsOpened() && !isAuthWindowOpen()) hideWindow()
  })

  win.on('closed', () => {
    win = null
  })
}

function showWindow(): void {
  if (!win) return
  const { x, y, width, height } = overlayBounds()
  win.setBounds({ x, y, width, height })
  win.show()
  win.focus()
}

function hideWindow(): void {
  win?.hide()
}

function toggleWindow(): void {
  if (!win) {
    createWindow()
    showWindow()
    return
  }
  if (win.isVisible()) hideWindow()
  else showWindow()
}

function createTray(): void {
  let icon: Electron.NativeImage
  if (process.platform === 'darwin') {
    icon = nativeImage.createFromPath(resourcePath('trayTemplate.png'))
    icon.setTemplateImage(true)
  } else {
    icon = nativeImage.createFromPath(resourcePath('tray.png'))
  }

  tray = new Tray(icon)
  tray.setToolTip('OpenUI')

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show / Hide OpenUI', click: () => toggleWindow() },
    { type: 'separator' },
    { label: 'Quit OpenUI', click: () => app.quit() }
  ])

  // Left click toggles the popup; right click opens the context menu.
  tray.on('click', () => toggleWindow())
  tray.on('right-click', () => tray?.popUpContextMenu(contextMenu))
}

// Claim the single-instance lock and register the openui:// protocol BEFORE the
// app is ready, so a second launch (e.g. the OS delivering a deep link on
// Windows) exits immediately and hands its argv to the primary instance.
registerDeepLinkProtocol()

app.whenReady().then(async () => {
  initDatabase()
  await initTelemetry()

  // True menu-bar app: no Dock icon on macOS.
  if (process.platform === 'darwin') app.dock?.hide()

  applySecurityHardening()
  trackEvent(Events.APP_STARTED, { platform: process.platform, version: app.getVersion() })

  createWindow()
  createTray()

  // Route deep links to the main window and keep the access token fresh.
  setupDeepLinkHandlers(win)
  startTokenRefreshLoop(win)

  ipcMain.on('openui:hide', () => hideWindow())
  ipcMain.on('openui:quit', () => app.quit())

  // Open the OS settings pane for the requested permission so the user can
  // grant it without navigating the Settings UI manually.
  // macOS → System Settings deep-link; Windows → ms-settings: URI.
  // The permission value is validated against a fixed allowlist before it is
  // used to look up the URL (defence against a malformed/forged IPC message
  // reaching shell.openExternal).
  ipcMain.on('openui:permission:open-settings', (_event, permission: unknown) => {
    if (!PERMISSION_TARGETS.includes(permission as PermissionTarget)) {
      console.error('[openui] Ignored open-settings for invalid permission:', permission)
      return
    }
    openSettingsPane(permission as PermissionTarget).catch((err) =>
      console.error('[openui] Failed to open System Settings:', err)
    )
  })

  // ── Authentication IPC ──────────────────────────────────────────────────────
  // Open the Google OAuth window. Returns whether it opened (false when Supabase
  // is unconfigured) so the renderer can surface a setup hint.
  ipcMain.handle('openui:login', () => Boolean(openAuthWindow(win)))
  // Sign out, clearing local tokens and revoking the Supabase session.
  ipcMain.handle('openui:logout', () => logout(win))
  // Current user profile (id, email, display_name, avatar_url, tier) or null.
  ipcMain.handle('openui:get-user', () => getCurrentUser())
  // Cached subscription tier ('free' when unknown/expired).
  ipcMain.handle('openui:get-tier', () => getUserTier())

  // ── Telemetry IPC ────────────────────────────────────────────────────────────
  ipcMain.handle('openui:set-telemetry-opt-out', (_event, optOut: unknown) => {
    setTelemetryOptOut(optOut === true)
  })
  ipcMain.handle('openui:get-telemetry-status', () => isTelemetryActive())

  // ── Privacy consent IPC (Sub-Phase 4C) ───────────────────────────────────────
  // Both the first-launch ConsentModal and the Settings analytics toggle flow
  // through these channels, so the grant/deny logic lives in exactly one place.

  // Opt in: persist consent, bring PostHog online (initTelemetry left it off
  // until now), then send the opt-in event — the FIRST event a new user emits.
  ipcMain.handle('openui:grant-consent', async () => {
    await grantConsent()
    enableTelemetryAfterConsent()
    trackEvent(Events.TELEMETRY_OPT_IN)
    win?.webContents.send('openui:consent-updated', ConsentStatus.GRANTED)
    return ConsentStatus.GRANTED
  })

  // Opt out: the opt-out event is the LAST thing sent. If telemetry is live it is
  // captured now and flushed by the shutdown below; if it was never started
  // (first-launch "Skip"), it is stashed locally to batch-send on a later opt-in.
  ipcMain.handle('openui:deny-consent', async () => {
    if (isTelemetryActive()) {
      trackEvent(Events.TELEMETRY_OPT_OUT)
    } else {
      recordPendingEvent(Events.TELEMETRY_OPT_OUT)
    }
    await denyConsent()
    shutdownTelemetry()
    win?.webContents.send('openui:consent-updated', ConsentStatus.DENIED)
    return ConsentStatus.DENIED
  })

  // Current consent status — drives whether the renderer shows the ConsentModal
  // on launch and the initial state of the Settings analytics toggle.
  ipcMain.handle('openui:get-consent-status', () => getConsentStatus())

  // Pro-tier waitlist: post an email to the Mailchimp-proxy Edge Function.
  registerWaitlistIPC()

  // ── Auto-update IPC (electron-updater) ──────────────────────────────────────
  // All of these are no-ops in development (autoUpdater only runs packaged) —
  // see ./updater/updater. The renderer surfaces them via the UpdateBanner.
  ipcMain.handle('openui:get-app-version', () => app.getVersion())
  ipcMain.handle('openui:check-for-updates', async () => {
    await checkForUpdates()
    return { currentVersion: app.getVersion() }
  })
  ipcMain.handle('openui:download-update', () => downloadUpdate())
  ipcMain.handle('openui:install-update-restart', () => installUpdateAndRestart())
  // macOS (unsigned) fallback: open the GitHub Releases page in the browser.
  ipcMain.handle('openui:open-releases-page', () => openReleasesPage())

  if (win) {
    registerAgentIPC(win)
    registerConversationIPC(win)
    registerVoiceIPC(win)
    registerInterviewerIPC(win)
    // Phase 8: activity monitor + Autonomous Coding Mode IPC.
    startScheduler(win)
    // Stripe/subscription IPC + periodic sync loop (idles until a user signs in).
    registerStripeIPC(win)
    // Auto-update via electron-updater + GitHub Releases. Schedules its own
    // checks (30s after launch, every 4h, and on focus) and is inert in dev.
    initUpdater(win)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  trackEvent(Events.APP_CLOSED)
  shutdownTelemetry()
})

// Keep the app alive in the tray when the popup window is hidden/closed.
app.on('window-all-closed', () => {
  // Intentionally do not quit — the tray icon keeps OpenUI running.
})

// Gracefully close the Playwright browser (if open) and flush PostHog before the process exits.
app.on('before-quit', () => {
  closeBrowser().catch(() => {})
  shutdownTelemetry()
})

// Release auth resources on shutdown: stop the proactive token-refresh timer.
app.on('will-quit', () => {
  stopTokenRefreshLoop()
})
