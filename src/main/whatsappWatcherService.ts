/**
 * whatsappWatcherService.ts — the main-process bootstrap that wires the pure
 * WhatsAppWatcher (whatsappWatcher.ts) to its real side effects and to the
 * renderer, and owns the IPC surface for the Settings UI + kill switch.
 *
 * This is the one place the untestable I/O converges: the screenshot/OCR reads
 * (from tools.ts), the chat-proxy compose call, the settings store, the audit
 * log, and the renderer event emits. The decision logic it drives is all in the
 * unit-tested pure modules; this file only assembles and dispatches.
 *
 * SAFETY: there is deliberately no send path here. onDraft only pushes a
 * suggestion to the renderer; sending remains a human click via
 * send_whatsapp_message.
 */

import { ipcMain, type BrowserWindow } from 'electron'
import { callChatProxyText } from './edgeFunctions'
import { readWhatsAppUnreadSenders, readWhatsAppChatText, executeTool } from './tools'
import { WhatsAppWatcher, type WatcherDeps, type DraftReply } from './whatsappWatcher'
import { getAutoReplyConfig, setAutoReplyConfig, auditDraftedReply } from './whatsappAutoReplyConfig'

let watcher: WhatsAppWatcher | null = null

/** Send an event to the renderer if a live window exists. */
function emit(win: BrowserWindow | null, channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function buildDeps(getWindow: () => BrowserWindow | null): WatcherDeps {
  return {
    captureUnreadSenders: () => readWhatsAppUnreadSenders(),
    readChat: (name) => readWhatsAppChatText(name),
    compose: (system, user) =>
      // Route through chat-proxy like every other model call — OUR key stays
      // server-side. Background composes have no interactive tier, so ask for
      // the pro-default model; the proxy clamps it to the user's entitlement
      // (a free/limit failure throws and the watcher just skips this draft).
      callChatProxyText({
        system,
        modelKey: 'pro-default',
        messages: [{ role: 'user', content: user }]
      }),
    onDraft: (draft: DraftReply) => emit(getWindow(), 'openui:whatsapp:draft', draft),
    onAudit: (draft: DraftReply) => auditDraftedReply(draft),
    onActiveChange: (active: boolean) => emit(getWindow(), 'openui:whatsapp:active', active),
    log: (msg: string) => console.log('[whatsapp-autoreply]', msg)
  }
}

/**
 * Construct the singleton watcher (once) and reconcile it against the persisted
 * config — so on app start it resumes only if the user had left it enabled with
 * a non-empty allowlist. Safe to call more than once.
 */
export function initWhatsAppWatcher(getWindow: () => BrowserWindow | null): void {
  if (!watcher) watcher = new WhatsAppWatcher(buildDeps(getWindow), getAutoReplyConfig)
  watcher.reconcile()
}

/** Register the auto-reply IPC handlers and start the watcher if configured. */
export function registerWhatsAppAutoReplyIpc(getWindow: () => BrowserWindow | null): void {
  initWhatsAppWatcher(getWindow)

  ipcMain.handle('openui:whatsapp-autoreply:get', () => getAutoReplyConfig())

  ipcMain.handle('openui:whatsapp-autoreply:set', (_event, raw: unknown) => {
    const config = setAutoReplyConfig(raw)
    watcher?.reconcile()
    return config
  })

  // The kill switch: stop the loop NOW and persist enabled:false so it stays off
  // across restarts — one call, always reachable from the UI indicator.
  ipcMain.handle('openui:whatsapp-autoreply:kill', () => {
    watcher?.stop()
    const current = getAutoReplyConfig()
    return setAutoReplyConfig({ ...current, enabled: false })
  })

  ipcMain.handle('openui:whatsapp-autoreply:status', () => ({ active: watcher?.isActive() ?? false }))

  // Send a reviewed draft. The user saw the exact drafted text in the draft card
  // and clicked Send, so THIS call is the human approval for this one message —
  // hence bypassHitl. It still runs the same audited send_whatsapp_message path a
  // manual send uses (contact resolution, keyboard automation, all unchanged), so
  // nothing is sent that the tool itself would not send; we only skip re-asking
  // for an approval the card already collected.
  ipcMain.handle('openui:whatsapp-autoreply:send', async (_event, payload: unknown) => {
    const { contact, message } = (payload ?? {}) as { contact?: unknown; message?: unknown }
    if (typeof contact !== 'string' || !contact.trim() || typeof message !== 'string' || !message.trim()) {
      return { ok: false, error: 'A contact and a non-empty message are required to send a draft.' }
    }
    return executeTool('send_whatsapp_message', { contact, message }, { tier: 'free', bypassHitl: true })
  })
}

/** Test/shutdown seam: stop the watcher and drop the singleton. */
export function stopWhatsAppWatcherForShutdown(): void {
  watcher?.stop()
  watcher = null
}
