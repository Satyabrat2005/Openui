import { app, BrowserWindow, Notification, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import { trackEvent, EVENTS } from '../telemetry'

/**
 * Auto-update for OpenUI, backed by electron-updater + GitHub Releases.
 *
 * electron-updater only operates inside a packaged build. In development
 * (`npm run dev`) every entry point here early-returns, which is the correct
 * behaviour — there is no embedded `app-update.yml` to read and nothing to
 * update. This is intentional and must not be "fixed".
 *
 * Windows flow (NSIS, works unsigned):
 *   check → `update-available` → user clicks Download → `downloadUpdate()` →
 *   `download-progress` → `update-downloaded` → user clicks Restart →
 *   `quitAndInstall()`.
 *
 * macOS is currently UNSIGNED. Squirrel.Mac refuses to apply an unsigned,
 * un-notarized update (Gatekeeper), so we never auto-download there: the
 * update is surfaced and the "Download" action is diverted to the GitHub
 * Releases page in the user's browser (see `downloadUpdate` / `openReleasesPage`
 * and the `canAutoUpdate: false` flag sent to the renderer). Once the macOS
 * build is signed + notarized, flip `canAutoUpdate` and the in-app flow works
 * unchanged.
 */

const RELEASES_LATEST_URL = 'https://github.com/Satyabrat2005/Openui/releases/latest'
const isMac = process.platform === 'darwin'

/** electron-updater can only silently auto-update on a signed platform. */
const canAutoUpdate = !isMac

/** Don't re-hit the feed on every window focus — throttle focus-driven checks. */
const FOCUS_CHECK_THROTTLE_MS = 60 * 60 * 1000 // 1 hour

let mainWindow: BrowserWindow | null = null
let lastCheckAt = 0

export function initUpdater(window: BrowserWindow): void {
  mainWindow = window

  // The updater is inert outside a packaged build; bail before wiring any
  // timers or listeners so dev runs stay completely untouched.
  if (!app.isPackaged) {
    console.log('[Updater] Disabled in development — autoUpdater only runs in packaged builds.')
    return
  }

  // We drive download + install by hand so the UI can prompt first, and so the
  // unsigned-macOS path can divert to the browser instead of a doomed install.
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  if (isMac) {
    console.warn(
      `[Updater] macOS builds are unsigned for v${app.getVersion()}; silent auto-update is ` +
        'unavailable (requires code signing + notarization). Falling back to a browser ' +
        'download of the latest GitHub release.'
    )
  }

  autoUpdater.on('checking-for-update', () => {
    console.log('[Updater] Checking for updates…')
  })

  autoUpdater.on('update-available', (info) => {
    console.log(`[Updater] Update available: v${info.version}`)
    trackEvent(EVENTS.UPDATE_AVAILABLE, {
      current_version: app.getVersion(),
      new_version: info.version
    })
    mainWindow?.webContents.send('openui:update-available', {
      version: info.version,
      // The renderer picks "Download Update" (in-app) vs "Open Download Page"
      // (browser) from this flag, so the unsigned-macOS path is honoured in UI.
      canAutoUpdate
    })
    showUpdateNotification(info.version)
  })

  autoUpdater.on('update-not-available', () => {
    console.log('[Updater] No update available — already on the latest version.')
    mainWindow?.webContents.send('openui:update-not-available', {
      version: app.getVersion()
    })
  })

  autoUpdater.on('download-progress', (progressInfo) => {
    mainWindow?.webContents.send('openui:update-download-progress', {
      percent: progressInfo.percent,
      bytesPerSecond: progressInfo.bytesPerSecond,
      transferred: progressInfo.transferred,
      total: progressInfo.total
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    console.log(`[Updater] Update downloaded: v${info.version}`)
    trackEvent(EVENTS.UPDATE_DOWNLOADED, {
      current_version: app.getVersion(),
      new_version: info.version
    })
    mainWindow?.webContents.send('openui:update-downloaded', {
      version: info.version
    })
  })

  autoUpdater.on('error', (error) => {
    console.error('[Updater] Error:', error)
    trackEvent(EVENTS.UPDATE_ERROR, {
      error_type: error?.message?.includes('net::ERR') ? 'network' : 'unknown'
    })
    mainWindow?.webContents.send('openui:update-error', {
      message: error?.message ?? 'Unknown update error'
    })
  })

  // First check 30s after launch so it never competes with startup work.
  setTimeout(() => {
    void checkForUpdates()
  }, 30_000)

  // Then poll every 4 hours for long-running sessions.
  setInterval(() => {
    void checkForUpdates()
  }, 4 * 60 * 60 * 1000)

  // Also check when the app regains focus (the user may have been offline and
  // reconnected) — but at most once an hour so we don't hammer the feed.
  app.on('browser-window-focus', () => {
    if (Date.now() - lastCheckAt < FOCUS_CHECK_THROTTLE_MS) return
    void checkForUpdates()
  })
}

export async function checkForUpdates(): Promise<void> {
  if (!app.isPackaged) return
  lastCheckAt = Date.now()
  try {
    await autoUpdater.checkForUpdates()
  } catch (error) {
    // Silently fail — a failed update check must never crash the app.
    console.error('[Updater] Check failed:', error)
  }
}

export async function downloadUpdate(): Promise<void> {
  if (!app.isPackaged) return

  // Unsigned macOS can't apply an in-app update; send the user to the release
  // page to grab the new .dmg manually rather than starting a doomed download.
  if (isMac) {
    await openReleasesPage()
    return
  }

  try {
    trackEvent(EVENTS.UPDATE_DOWNLOAD_STARTED, { current_version: app.getVersion() })
    await autoUpdater.downloadUpdate()
  } catch (error) {
    console.error('[Updater] Download failed:', error)
  }
}

export function installUpdateAndRestart(): void {
  if (!app.isPackaged) return
  trackEvent(EVENTS.UPDATE_INSTALL_RESTART, { current_version: app.getVersion() })
  // setImmediate lets the triggering IPC reply reach the renderer before the
  // app tears itself down to swap in the new version.
  setImmediate(() => {
    autoUpdater.quitAndInstall()
  })
}

/** Open the GitHub Releases "latest" page in the user's default browser. */
export async function openReleasesPage(): Promise<void> {
  await shell.openExternal(RELEASES_LATEST_URL)
}

function showUpdateNotification(version: string): void {
  if (!Notification.isSupported()) return
  const notification = new Notification({
    title: 'OpenUI Update Available',
    body: `Version ${version} is ready${canAutoUpdate ? ' to download' : ' on GitHub'}.`,
    silent: false
  })
  // Clicking the toast reveals the overlay; its update banner is already
  // populated by the update-available event, so it's immediately actionable.
  notification.on('click', () => mainWindow?.show())
  notification.show()
}
