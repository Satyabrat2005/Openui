import { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, session, shell } from 'electron'
import { join } from 'path'
import { registerAgentIPC, registerConversationIPC } from './agent'
import { startPromptRefiner, stopPromptRefiner } from './promptRefiner'
import { registerVoiceIPC } from './voice'
import { registerInterviewerIPC } from './interviewer'
import { startScheduler } from './scheduler'
import { openSettingsPane, type PermissionTarget } from './permissions'
import { registerStripeIPC, isPaymentFlowWebContents } from './stripe/checkout'
import { registerWaitlistIPC } from './waitlist'
import { closeBrowser } from './tools'
import { connectMcpServer, disconnectAll, type McpServerConfig } from './mcp-client'
import { initDatabase, database } from './database'
import { registerDeepLinkProtocol, setupDeepLinkHandlers } from './auth/deeplink'
import { openAuthWindow, isAuthWebContents } from './auth/authWindow'
import { logout, getCurrentUser, getUserTier, startTokenRefreshLoop, stopTokenRefreshLoop, ensureGuestSession } from './auth/sessionManager'
import { initTelemetry, enableTelemetryAfterConsent, shutdownTelemetry, setTelemetryOptOut, isTelemetryActive, trackEvent } from './telemetry/posthog'
import { grantConsent, denyConsent, getConsentStatus, recordPendingEvent, ConsentStatus } from './telemetry/consent'
import { initUpdater, checkForUpdates, downloadUpdate, installUpdateAndRestart, openReleasesPage } from './updater/updater'
import { Events } from './telemetry/events'
import { exportWorkflow, importWorkflow, getWorkflows, deleteWorkflow, type Workflow } from './workflows'
import { indexDirectory } from './rag'
import {
  startRecording,
  stopRecording,
  playRecording,
  recordClickAction,
  recordKeypressAction,
  loadMacros,
  saveMacro,
  deleteMacro,
  isRecording,
  type RecorderAction,
} from './recorder'

let tray: Tray | null = null
let win: BrowserWindow | null = null

// True once app.quit()/before-quit has actually started — lets the window's
// 'close' handler tell a real quit apart from the user clicking the close
// button (native red traffic light on macOS, our custom button elsewhere),
// which should hide to the tray instead of destroying the window.
let isQuitting = false

const isMac = process.platform === 'darwin'

// Timestamp of the on-launch reveal, used only to make revealWindow() idempotent
// so the 'ready-to-show' / 'did-finish-load' pair can't show the window twice.
let launchRevealedAt = 0

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

// Default window geometry for the real, resizable app window. The window opens
// centered at this size and the user can freely resize, maximize, or full-screen
// it from there; the last two values clamp how small it can get.
const DEFAULT_WIDTH = 1120
const DEFAULT_HEIGHT = 760
const MIN_WIDTH = 720
const MIN_HEIGHT = 480

function createWindow(): void {
  win = new BrowserWindow({
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    center: true,
    show: false,
    // Windows/Linux: fully frameless — the renderer draws its own dark title
    // bar with minimize/maximize/close buttons and a drag region. macOS: keep
    // the native traffic-light buttons (red/yellow/green) via titleBarStyle so
    // window management still feels native, just inset into our custom drag
    // region instead of a native title bar; the renderer skips drawing its own
    // controls there. Either way it's a fully normal, resizable, taskbar/Dock
    // -present app window — not the old overlay.
    ...(isMac
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 18 } }
      : { frame: false }),
    transparent: false,
    backgroundColor: '#000000',
    resizable: true,
    movable: true,
    minimizable: true,
    maximizable: true,
    fullscreenable: true,
    skipTaskbar: false,
    hasShadow: true,
    roundedCorners: true,
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

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // Keep the renderer's custom maximize/restore button icon in sync with the
  // actual window state (the user can also maximize via the OS, e.g. Win+Up or
  // double-clicking the drag region / snapping to a screen edge).
  win.on('maximize', () => win?.webContents.send('openui:window:maximized', true))
  win.on('unmaximize', () => win?.webContents.send('openui:window:maximized', false))

  // Clicking the close control — our custom button on Windows/Linux, the
  // native red traffic light on macOS, or Alt+F4/Cmd+Q's window-level close —
  // all funnel through this single 'close' event. Hide to the tray instead of
  // destroying the window unless a real quit is in progress, so behaviour is
  // identical across platforms and matches the tray's "Quit OpenUI" being the
  // only real exit.
  win.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    hideWindow()
  })

  win.on('closed', () => {
    win = null
  })
}

function showWindow(): void {
  if (!win) return
  // Bring the window back from a minimized/hidden state and focus it. Unlike the
  // old overlay we do NOT force it to fill the work area — the user's chosen size
  // and position are preserved across hide/show and app restarts within a session.
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/**
 * Reveal the overlay once on launch. Bound to both 'ready-to-show' and
 * 'did-finish-load' (whichever fires first wins); the `launchRevealedAt` guard
 * makes the second call a no-op. Records the reveal time so the blur→hide
 * handler leaves a short grace period before it can dismiss the window — without
 * this an installed app could appear to "not open" because its window flashed
 * up and was hidden again on the first stray focus change.
 */
function revealWindow(): void {
  if (launchRevealedAt !== 0) return
  launchRevealedAt = Date.now()
  showWindow()
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
  // Startup init is guarded so a failure in any single subsystem (for example
  // the native better-sqlite3 module failing to load on a freshly installed
  // machine) cannot abort the whole launch and leave the user staring at an
  // app that "opened" but shows nothing. Each guard logs and continues so the
  // window is still created and revealed below.
  try {
    initDatabase()
  } catch (err) {
    console.error('[openui] Database initialisation failed:', err)
  }
  try {
    await initTelemetry()
  } catch (err) {
    console.error('[openui] Telemetry initialisation failed:', err)
  }

  applySecurityHardening()
  trackEvent(Events.APP_STARTED, { platform: process.platform, version: app.getVersion() })

  createWindow()
  createTray()

  // Reveal the overlay as soon as it has painted so OpenUI is visibly "open"
  // the instant it launches (first run shows the onboarding wizard, later runs
  // show the assistant). The window is created hidden (show: false) only to
  // avoid a flash of unpainted content — WITHOUT this reveal it would never
  // appear unless the user happened to click the system-tray icon, which makes
  // a freshly installed app look like it failed to open entirely. 'ready-to-show'
  // is the no-flash path; 'did-finish-load' is a fallback in case it doesn't
  // fire for the transparent window. showWindow() is idempotent, so the
  // duplicate call is harmless.
  if (win) {
    win.once('ready-to-show', () => revealWindow())
    win.webContents.once('did-finish-load', () => revealWindow())
  }

  // Route deep links to the main window and keep the access token fresh.
  setupDeepLinkHandlers(win)
  startTokenRefreshLoop(win)

  // Zero-setup guarantee: if nobody is signed in, mint a silent anonymous cloud
  // session so OpenUI works the instant it launches — no account screen, no local
  // model to download. Best-effort and non-blocking; if it can't (offline / dev
  // without Supabase) the app still launches and the user is never shown an error.
  void ensureGuestSession(win)

  ipcMain.on('openui:hide', () => hideWindow())
  ipcMain.on('openui:quit', () => app.quit())

  // ── Window controls (custom frameless title bar) ────────────────────────────
  // The renderer draws its own minimize / maximize / close buttons since the OS
  // frame is disabled. Close hides to the tray (the app keeps running in the
  // background, matching the tray "Quit OpenUI" being the only real exit).
  ipcMain.on('openui:window:minimize', () => win?.minimize())
  ipcMain.on('openui:window:maximize-toggle', () => {
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on('openui:window:close', () => hideWindow())
  ipcMain.handle('openui:window:is-maximized', () => win?.isMaximized() ?? false)

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

  // ── Privacy consent IPC ───────────────────────────────────────────────────────
  ipcMain.handle('openui:grant-consent', async () => {
    await grantConsent()
    enableTelemetryAfterConsent()
    trackEvent(Events.TELEMETRY_OPT_IN)
    win?.webContents.send('openui:consent-updated', ConsentStatus.GRANTED)
    return ConsentStatus.GRANTED
  })

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

  ipcMain.handle('openui:get-consent-status', () => getConsentStatus())

  // Pro-tier waitlist: post an email to the Mailchimp-proxy Edge Function.
  registerWaitlistIPC()

  // ── Auto-update IPC (electron-updater) ──────────────────────────────────────
  ipcMain.handle('openui:get-app-version', () => app.getVersion())
  ipcMain.handle('openui:check-for-updates', async () => {
    await checkForUpdates()
    return { currentVersion: app.getVersion() }
  })
  ipcMain.handle('openui:download-update', () => downloadUpdate())
  ipcMain.handle('openui:install-update-restart', () => installUpdateAndRestart())
  ipcMain.handle('openui:open-releases-page', () => openReleasesPage())

  // ── App settings IPC (key/value in the SQLite settings table) ───────────────
  // Used by onboarding (`onboarding_complete`) and any future persisted prefs.
  // ── Legal pages IPC ────────────────────────────────────────────────────────
  // Open the bundled privacy / terms HTML with the OS default browser.
  ipcMain.handle('open-privacy', async () => {
    const filePath = isDev
      ? join(__dirname, '../../src/renderer/privacy.html')
      : join(__dirname, '../renderer/privacy.html')
    await shell.openPath(filePath)
  })

  ipcMain.handle('open-terms', async () => {
    const filePath = isDev
      ? join(__dirname, '../../src/renderer/terms.html')
      : join(__dirname, '../renderer/terms.html')
    await shell.openPath(filePath)
  })

  ipcMain.handle('openui:get-setting', (_event, key: unknown) =>
    typeof key === 'string' ? database.settings.getSetting(key) : null
  )
  ipcMain.handle('openui:set-setting', (_event, payload: unknown) => {
    const { key, value } = (payload ?? {}) as { key?: unknown; value?: unknown }
    if (typeof key === 'string') database.settings.setSetting(key, value)
  })

  // ── Local RAG knowledge base ──────────────────────────────────────────────
  // Index a local directory of .txt/.pdf files and store embeddings in the
  // user-data folder.  Embeddings are generated by Ollama (nomic-embed-text)
  // so no document content is sent to the cloud.
  // Resolves to { indexed, chunks, error? }.
  ipcMain.handle('openui:rag:index', async (_event, payload: unknown) => {
    const { dirPath } = (payload ?? {}) as { dirPath?: unknown }
    if (typeof dirPath !== 'string' || !dirPath.trim()) {
      return { indexed: 0, chunks: 0, error: 'openui:rag:index requires a "dirPath" string.' }
    }
    return indexDirectory(dirPath.trim())
  })

  // ── Action Recorder / Macros IPC ───────────────────────────────────────────
  ipcMain.handle('openui:recorder:start', () => startRecording())

  ipcMain.handle('openui:recorder:stop', () => stopRecording())

  ipcMain.handle('openui:recorder:play', (_e, payload: unknown) => {
    const { actions } = payload as { actions: RecorderAction[] }
    return playRecording(actions)
  })

  ipcMain.handle('openui:recorder:record-click', (_e, payload: unknown) => {
    const { x, y, button } = payload as { x: number; y: number; button?: 'left' | 'right' }
    recordClickAction(x, y, button)
  })

  ipcMain.handle('openui:recorder:record-keypress', (_e, payload: unknown) => {
    const { text } = payload as { text: string }
    recordKeypressAction(text)
  })

  ipcMain.handle('openui:recorder:get-macros', () => loadMacros())

  ipcMain.handle('openui:recorder:save-macro', (_e, payload: unknown) => {
    const { name, actions } = payload as { name: string; actions: RecorderAction[] }
    return saveMacro(name, actions)
  })

  ipcMain.handle('openui:recorder:delete-macro', (_e, payload: unknown) => {
    const { name } = payload as { name: string }
    return deleteMacro(name)
  })

  ipcMain.handle('openui:recorder:is-recording', () => isRecording())

  // ── Workflow IPC ─────────────────────────────────────────────────────────────
  ipcMain.handle('openui:workflow:list', () => getWorkflows())

  ipcMain.handle('openui:workflow:export', async (_event, payload: unknown) => {
    const { workflow } = (payload ?? {}) as { workflow?: Workflow }
    if (!workflow || typeof workflow !== 'object') return { ok: false, error: 'Invalid workflow payload.' }
    return exportWorkflow(workflow)
  })

  ipcMain.handle('openui:workflow:import', () => importWorkflow())

  ipcMain.handle('openui:workflow:delete', async (_event, payload: unknown) => {
    const { name } = (payload ?? {}) as { name?: unknown }
    if (typeof name !== 'string' || !name.trim()) return { ok: false, error: 'Invalid workflow name.' }
    return deleteWorkflow(name)
  })

  if (win) {
    registerAgentIPC(win)
    registerConversationIPC(win)
    registerVoiceIPC(win)
    registerInterviewerIPC(win)
    // Phase 8: activity monitor + Autonomous Coding Mode IPC.
    startScheduler(win)
    // Weekly local self-improvement: refine the system prompt from feedback.
    startPromptRefiner(win)
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

ipcMain.handle('openui:mcp:connect', async (_event, config: unknown) => {
  return connectMcpServer(config as McpServerConfig)
})

app.on('before-quit', () => {
  isQuitting = true
  disconnectAll()
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

// Release auth resources on shutdown: stop the proactive token-refresh timer
// and the weekly prompt-refinement scheduler.
app.on('will-quit', () => {
  stopTokenRefreshLoop()
  stopPromptRefiner()
})
