import { useEffect, useState } from 'react'
import type { AutonomyLevel, ChannelMemory, ConsentStatus, WhatsAppAutoReplyConfig } from '../env'
import type { UpdateStatus } from '../hooks/useUpdater'
import { applyTheme, coerceThemePref, type ThemePref } from '../lib/theme'

const THEME_OPTIONS: { value: ThemePref; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' }
]

const AUTONOMY_OPTIONS: { value: AutonomyLevel; label: string; hint: string }[] = [
  { value: 'ask-each', label: 'Ask each', hint: 'Confirm every action before it runs.' },
  { value: 'approve-plan', label: 'Approve plan', hint: 'Review the plan once, then it runs on its own.' },
  { value: 'full-auto', label: 'Full auto', hint: 'Run everything without asking. Highest risk.' }
]

// Languages the local (free-tier) screen OCR can read. "auto" detects from the
// OS locale. Keep the codes/labels in sync with OCR_LANGUAGES in src/main/ocr.ts
// and the download list in scripts/fetch-traineddata.cjs.
const OCR_LANGUAGE_OPTIONS: { value: string; label: string }[] = [
  { value: 'auto', label: 'Auto (detect from system)' },
  { value: 'eng', label: 'English' },
  { value: 'spa', label: 'Spanish' },
  { value: 'fra', label: 'French' },
  { value: 'deu', label: 'German' },
  { value: 'por', label: 'Portuguese' },
  { value: 'hin', label: 'Hindi' },
  { value: 'jpn', label: 'Japanese' },
  { value: 'chi_sim', label: 'Chinese (Simplified)' }
]

// Display names + accent colours for the four channels cross-channel memory
// covers. Keys match MemoryChannel in src/main/channelMemory.ts.
// (--ou-violet is folded onto the accent in index.css — purple is banned — so
// the four colours are drawn from success / accent / warn / danger instead.)
const MEMORY_CHANNELS: Record<string, { label: string; color: string }> = {
  whatsapp: { label: 'WhatsApp', color: 'var(--ou-success)' },
  telegram: { label: 'Telegram', color: 'var(--ou-accent-text)' },
  slack: { label: 'Slack', color: 'var(--ou-warn)' },
  gmail: { label: 'Gmail', color: 'var(--ou-danger-text)' }
}

/** "2h ago" from a unix-seconds timestamp, for the memory list. */
function memoryAge(createdAt: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - createdAt)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

// Launch switch for the bring-your-own-key Cloud AI section. OFF for the
// Ollama-only launch — the shipped app shows no API-key field and no cloud
// toggle, so it presents as fully local. Mirrors isCloudTierEnabled() /
// OPENUI_ENABLE_CLOUD in the main process (models.ts). Flip both back to restore
// the frontier tier (built under PR #107).
const CLOUD_TIER_ENABLED = false

interface Props {
  onClose: () => void
  appVersion?: string
  updateStatus?: UpdateStatus
  onCheckForUpdates?: () => void
}

/**
 * Lightweight settings sheet. Currently hosts the privacy controls — the
 * "Anonymous Usage Analytics" toggle, which mirrors the first-launch consent
 * choice and lets the user change their mind at any time. Flipping it ON grants
 * consent (and brings PostHog online); flipping it OFF denies consent (and shuts
 * PostHog down). The toggle stays in sync with changes made elsewhere via the
 * onConsentUpdated event.
 */
export default function SettingsModal({ onClose, appVersion, updateStatus, onCheckForUpdates }: Props): JSX.Element {
  const [enabled, setEnabled] = useState(false)
  const [busy, setBusy] = useState(false)
  // Appearance: light / dark / follow-OS. Default matches the app default (dark).
  const [theme, setTheme] = useState<ThemePref>('dark')
  // AI Improvement (local self-improvement loop). Default ON: absent setting → on.
  const [aiImprovement, setAiImprovement] = useState(true)
  // Automation autonomy. Default matches the main-process default (approve-plan).
  const [autonomy, setAutonomy] = useState<AutonomyLevel>('approve-plan')
  // Figma personal access token — a per-user credential the user supplies here
  // (persisted to the local settings store, read by the main-process Figma tool).
  const [figmaToken, setFigmaToken] = useState('')
  const [figmaSaved, setFigmaSaved] = useState(false)
  // Local screen-OCR language (free tier). "auto" ⇒ detect from the OS locale;
  // read by configuredOcrLang() in the main process (tools.ts).
  const [ocrLanguage, setOcrLanguage] = useState('auto')
  const [ocrLangSaved, setOcrLangSaved] = useState(false)
  // GitHub personal access token — read by the main-process GitHub tools when
  // the GITHUB_TOKEN env var is absent (the normal case for end users).
  const [githubToken, setGithubToken] = useState('')
  const [githubSaved, setGithubSaved] = useState(false)
  // Telegram bot token — a per-user credential the user creates via @BotFather
  // and pastes here; read by the main-process Telegram tools (never a proxy —
  // a bot token is inherently user-owned, like the Figma/GitHub PATs).
  const [telegramToken, setTelegramToken] = useState('')
  const [telegramSaved, setTelegramSaved] = useState(false)
  // Slack bot/user token — read by the main-process Slack tools when the
  // SLACK_TOKEN env var is absent. Same per-user credential reasoning as Figma/GitHub.
  const [slackToken, setSlackToken] = useState('')
  const [slackSaved, setSlackSaved] = useState(false)
  // Cloud AI (bring-your-own-key): an Anthropic key plus an explicit routing
  // toggle. BOTH are required before any turn leaves the machine — the key is
  // capability, the toggle is intent (see shouldRouteToCloud in models.ts).
  const [anthropicKey, setAnthropicKey] = useState('')
  const [anthropicSaved, setAnthropicSaved] = useState(false)
  const [cloudRouting, setCloudRouting] = useState(false)
  // Google Calendar — a dedicated OAuth "Desktop app" client (id/secret) the
  // user supplies here; the main process runs the loopback OAuth flow on Connect
  // and stores only the resulting refresh token.
  const [gcalClientId, setGcalClientId] = useState('')
  const [gcalClientSecret, setGcalClientSecret] = useState('')
  const [gcalConnected, setGcalConnected] = useState(false)
  const [gcalConnecting, setGcalConnecting] = useState(false)
  const [gcalMessage, setGcalMessage] = useState('')
  // Local calendar automation (Calendar.app / Outlook COM). Default OFF: its
  // delete/reschedule path is new, unit-tested only, and has never run against
  // a real calendar app — a mistake there cancels or moves a real meeting.
  // Absent setting ⇒ off, the inverse of most toggles here.
  const [localCalendarEnabled, setLocalCalendarEnabled] = useState(false)
  // Gmail — shares the Google Calendar OAuth client id/secret above (one
  // Google Cloud client, multiple scopes) but has its own refresh token and
  // Connect button, since it's a separate OAuth grant.
  const [gmailConnected, setGmailConnected] = useState(false)
  const [gmailConnecting, setGmailConnecting] = useState(false)
  const [gmailMessage, setGmailMessage] = useState('')
  // Google Drive — same shared OAuth client as Calendar/Gmail, own refresh token
  // and Connect button (the narrow drive.file scope is its own OAuth grant).
  const [driveConnected, setDriveConnected] = useState(false)
  const [driveConnecting, setDriveConnecting] = useState(false)
  const [driveMessage, setDriveMessage] = useState('')
  // WhatsApp allowlisted auto-reply. The whole config lives in one object; the
  // watcher only ever COMPOSES a suggested reply for these contacts — sending
  // stays a human click. Default-off; empty allowlist means nothing runs.
  const [waConfig, setWaConfig] = useState<WhatsAppAutoReplyConfig | null>(null)
  const [waSaved, setWaSaved] = useState(false)
  const [waNewName, setWaNewName] = useState('')
  const [waNewInstruction, setWaNewInstruction] = useState('')
  // Cross-channel memory. Every stored line is listed here because the feature's
  // whole risk is invisibility: carrying something said on WhatsApp into a Slack
  // reply is only acceptable if the user can see exactly what is remembered and
  // delete any of it. Read-only from the renderer — the agent loop is the sole
  // writer (see channelMemory.ts).
  const [memories, setMemories] = useState<ChannelMemory[]>([])
  const [memoryConfirmClear, setMemoryConfirmClear] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.openui
      .getConsentStatus()
      .then((status) => {
        if (!cancelled) setEnabled(status === 'granted')
      })
      .catch(() => {})

    window.openui
      .getSetting('theme')
      .then((value) => {
        if (!cancelled) setTheme(coerceThemePref(value))
      })
      .catch(() => {})

    window.openui
      .getSetting('ai_improvement_enabled')
      .then((value) => {
        if (!cancelled) setAiImprovement(value !== false) // null/undefined ⇒ on
      })
      .catch(() => {})

    window.openui
      .getSetting('autonomy_level')
      .then((value) => {
        if (!cancelled && (value === 'ask-each' || value === 'approve-plan' || value === 'full-auto')) {
          setAutonomy(value)
        }
      })
      .catch(() => {})

    window.openui
      .getSetting('figma_token')
      .then((value) => {
        if (!cancelled && typeof value === 'string') setFigmaToken(value)
      })
      .catch(() => {})

    window.openui
      .getSetting('github_token')
      .then((value) => {
        if (!cancelled && typeof value === 'string') setGithubToken(value)
      })
      .catch(() => {})

    window.openui
      .getSetting('telegram_bot_token')
      .then((value) => {
        if (!cancelled && typeof value === 'string') setTelegramToken(value)
      })
      .catch(() => {})

    window.openui
      .getSetting('ocr_language')
      .then((value) => {
        if (!cancelled && typeof value === 'string' && value.trim()) setOcrLanguage(value)
      })
      .catch(() => {})

    window.openui
      .getSetting('slack_token')
      .then((value) => {
        if (!cancelled && typeof value === 'string') setSlackToken(value)
      })
      .catch(() => {})

    window.openui
      .getWhatsAppAutoReply()
      .then((cfg) => {
        if (!cancelled) setWaConfig(cfg)
      })
      .catch(() => {})

    window.openui
      .getSetting('anthropic_api_key')
      .then((value) => {
        if (!cancelled && typeof value === 'string') setAnthropicKey(value)
      })
      .catch(() => {})

    window.openui
      .getSetting('cloud_routing_enabled')
      .then((value) => {
        if (!cancelled) setCloudRouting(value === true)
      })
      .catch(() => {})

    window.openui
      .getSetting('google_oauth_client_id')
      .then((value) => {
        if (!cancelled && typeof value === 'string') setGcalClientId(value)
      })
      .catch(() => {})

    window.openui
      .getSetting('google_oauth_client_secret')
      .then((value) => {
        if (!cancelled && typeof value === 'string') setGcalClientSecret(value)
      })
      .catch(() => {})

    window.openui
      .googleCalendarStatus()
      .then((s) => {
        if (!cancelled) setGcalConnected(Boolean(s?.connected))
      })
      .catch(() => {})

    window.openui
      .getSetting('local_calendar_backend_enabled')
      .then((value) => {
        if (!cancelled) setLocalCalendarEnabled(value === true) // absent/null/undefined ⇒ off
      })
      .catch(() => {})

    window.openui
      .gmailStatus()
      .then((s) => {
        if (!cancelled) setGmailConnected(Boolean(s?.connected))
      })
      .catch(() => {})

    window.openui
      .googleDriveStatus()
      .then((s) => {
        if (!cancelled) setDriveConnected(Boolean(s?.connected))
      })
      .catch(() => {})

    window.openui
      .listMemories()
      .then((rows) => {
        if (!cancelled) setMemories(rows)
      })
      .catch(() => {})

    const off = window.openui.onConsentUpdated((status: ConsentStatus) => {
      setEnabled(status === 'granted')
    })
    return () => {
      cancelled = true
      off()
    }
  }, [])

  /**
   * Forget one memory. Optimistic: the row disappears immediately and is put
   * back only if the main process reports it did not actually delete it —
   * a "Forget" that visibly does nothing for a second reads as a broken
   * promise on exactly the control the user is here to trust.
   */
  const forgetMemory = (id: string): void => {
    const prev = memories
    setMemories((rows) => rows.filter((r) => r.id !== id))
    void window.openui
      .deleteMemory(id)
      .then((ok) => {
        if (!ok) setMemories(prev)
      })
      .catch(() => setMemories(prev))
  }

  /** Forget everything filed under one contact or topic. */
  const forgetSubject = (subjectKey: string): void => {
    const prev = memories
    setMemories((rows) => rows.filter((r) => r.subject_key !== subjectKey))
    void window.openui.clearMemorySubject(subjectKey).catch(() => setMemories(prev))
  }

  /** Forget all of it. Two-step, since it is not recoverable. */
  const forgetAllMemories = (): void => {
    if (!memoryConfirmClear) {
      setMemoryConfirmClear(true)
      return
    }
    const prev = memories
    setMemories([])
    setMemoryConfirmClear(false)
    void window.openui.clearAllMemories().catch(() => setMemories(prev))
  }

  const chooseAutonomy = (value: AutonomyLevel): void => {
    const prev = autonomy
    setAutonomy(value) // optimistic; reverted on failure
    void window.openui.setSetting('autonomy_level', value).catch(() => setAutonomy(prev))
  }

  const chooseTheme = (value: ThemePref): void => {
    const prev = theme
    setTheme(value)
    applyTheme(value) // apply live so the change is visible immediately
    void window.openui.setSetting('theme', value).catch(() => {
      setTheme(prev)
      applyTheme(prev)
    })
  }

  const toggleAiImprovement = (): void => {
    const next = !aiImprovement
    setAiImprovement(next) // optimistic; persisted below
    void window.openui.setSetting('ai_improvement_enabled', next).catch(() => {
      setAiImprovement(!next)
    })
  }

  // Persist the screen-OCR language, with a brief "Saved" confirmation.
  const chooseOcrLanguage = (value: string): void => {
    const prev = ocrLanguage
    setOcrLanguage(value) // optimistic; reverted on failure
    void window.openui
      .setSetting('ocr_language', value)
      .then(() => {
        setOcrLangSaved(true)
        window.setTimeout(() => setOcrLangSaved(false), 1500)
      })
      .catch(() => setOcrLanguage(prev))
  }

  // Persist the Figma token (trimmed) on blur, with a brief "Saved" confirmation.
  const saveFigmaToken = (): void => {
    void window.openui
      .setSetting('figma_token', figmaToken.trim())
      .then(() => {
        setFigmaSaved(true)
        window.setTimeout(() => setFigmaSaved(false), 1500)
      })
      .catch(() => {})
  }

  const saveGithubToken = (): void => {
    void window.openui
      .setSetting('github_token', githubToken.trim())
      .then(() => {
        setGithubSaved(true)
        window.setTimeout(() => setGithubSaved(false), 1500)
      })
      .catch(() => {})
  }

  const saveTelegramToken = (): void => {
    void window.openui
      .setSetting('telegram_bot_token', telegramToken.trim())
      .then(() => {
        setTelegramSaved(true)
        window.setTimeout(() => setTelegramSaved(false), 1500)
      })
      .catch(() => {})
  }

  const saveSlackToken = (): void => {
    void window.openui
      .setSetting('slack_token', slackToken.trim())
      .then(() => {
        setSlackSaved(true)
        window.setTimeout(() => setSlackSaved(false), 1500)
      })
      .catch(() => {})
  }

  // Persist a whole WhatsApp auto-reply config change (the main process
  // normalises + clamps it and reconciles the watcher, then returns what it
  // actually stored, which we adopt so the UI reflects the clamped truth).
  const persistWaConfig = (next: WhatsAppAutoReplyConfig): void => {
    setWaConfig(next) // optimistic
    void window.openui
      .setWhatsAppAutoReply(next)
      .then((saved) => {
        setWaConfig(saved)
        setWaSaved(true)
        window.setTimeout(() => setWaSaved(false), 1500)
      })
      .catch(() => {})
  }

  const toggleWaEnabled = (): void => {
    if (!waConfig) return
    persistWaConfig({ ...waConfig, enabled: !waConfig.enabled })
  }

  const addWaContact = (): void => {
    if (!waConfig) return
    const name = waNewName.trim()
    if (!name) return
    const instruction = waNewInstruction.trim()
    // Skip a case-insensitive duplicate; main de-dupes too, but this keeps the UI honest.
    if (waConfig.allowlist.some((e) => e.name.toLowerCase() === name.toLowerCase())) {
      setWaNewName('')
      setWaNewInstruction('')
      return
    }
    const entry = instruction ? { name, instruction } : { name }
    persistWaConfig({ ...waConfig, allowlist: [...waConfig.allowlist, entry] })
    setWaNewName('')
    setWaNewInstruction('')
  }

  const removeWaContact = (name: string): void => {
    if (!waConfig) return
    persistWaConfig({ ...waConfig, allowlist: waConfig.allowlist.filter((e) => e.name !== name) })
  }

  const saveAnthropicKey = (): void => {
    void window.openui
      .setSetting('anthropic_api_key', anthropicKey.trim())
      .then(() => {
        setAnthropicSaved(true)
        window.setTimeout(() => setAnthropicSaved(false), 1500)
      })
      .catch(() => {})
  }

  const toggleCloudRouting = (): void => {
    const next = !cloudRouting
    setCloudRouting(next)
    void window.openui
      .setSetting('cloud_routing_enabled', next)
      .catch(() => setCloudRouting(!next))
  }

  const toggleLocalCalendar = (): void => {
    const next = !localCalendarEnabled
    setLocalCalendarEnabled(next)
    void window.openui
      .setSetting('local_calendar_backend_enabled', next)
      .catch(() => setLocalCalendarEnabled(!next))
  }

  const saveGcalClientId = (): void => {
    void window.openui.setSetting('google_oauth_client_id', gcalClientId.trim()).catch(() => {})
  }
  const saveGcalClientSecret = (): void => {
    void window.openui.setSetting('google_oauth_client_secret', gcalClientSecret.trim()).catch(() => {})
  }

  const connectGoogleCalendar = async (): Promise<void> => {
    if (gcalConnecting) return
    setGcalConnecting(true)
    setGcalMessage('Waiting for Google sign-in in your browser…')
    try {
      // Persist the latest id/secret first so the main-process flow can read them.
      await window.openui.setSetting('google_oauth_client_id', gcalClientId.trim())
      await window.openui.setSetting('google_oauth_client_secret', gcalClientSecret.trim())
      const result = await window.openui.connectGoogleCalendar()
      setGcalConnected(result.ok)
      setGcalMessage(result.ok ? 'Connected.' : result.error || 'Connection failed.')
    } catch {
      setGcalMessage('Connection failed.')
    } finally {
      setGcalConnecting(false)
    }
  }

  const connectGmail = async (): Promise<void> => {
    if (gmailConnecting) return
    setGmailConnecting(true)
    setGmailMessage('Waiting for Google sign-in in your browser…')
    try {
      // Same shared client id/secret as Google Calendar — persist the latest
      // values first so the main-process flow can read them.
      await window.openui.setSetting('google_oauth_client_id', gcalClientId.trim())
      await window.openui.setSetting('google_oauth_client_secret', gcalClientSecret.trim())
      const result = await window.openui.connectGmail()
      setGmailConnected(result.ok)
      setGmailMessage(result.ok ? 'Connected.' : result.error || 'Connection failed.')
    } catch {
      setGmailMessage('Connection failed.')
    } finally {
      setGmailConnecting(false)
    }
  }

  const connectGoogleDrive = async (): Promise<void> => {
    if (driveConnecting) return
    setDriveConnecting(true)
    setDriveMessage('Waiting for Google sign-in in your browser…')
    try {
      // Same shared client id/secret as Google Calendar — persist the latest
      // values first so the main-process flow can read them.
      await window.openui.setSetting('google_oauth_client_id', gcalClientId.trim())
      await window.openui.setSetting('google_oauth_client_secret', gcalClientSecret.trim())
      const result = await window.openui.connectGoogleDrive()
      setDriveConnected(result.ok)
      setDriveMessage(result.ok ? 'Connected.' : result.error || 'Connection failed.')
    } catch {
      setDriveMessage('Connection failed.')
    } finally {
      setDriveConnecting(false)
    }
  }

  const toggle = async (): Promise<void> => {
    if (busy) return
    const next = !enabled
    setBusy(true)
    setEnabled(next) // optimistic; reverted on failure
    try {
      if (next) await window.openui.grantConsent()
      else await window.openui.denyConsent()
    } catch {
      setEnabled(!next)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      className="ou-settings-scrim"
      onMouseDown={(e) => {
        // Click outside the card dismisses; clicks inside are stopped below.
        e.stopPropagation()
        onClose()
      }}
    >
      <div className="ou-settings" onMouseDown={(e) => e.stopPropagation()}>
        <div className="ou-settings-head">
          <h3 className="ou-settings-title">Settings</h3>
          <button
            type="button"
            aria-label="Close settings"
            className="ou-settings-close"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        {/* Appearance: light / dark / follow-OS */}
        <div>
          <div className="ou-settings-label">Appearance</div>
          <div className="ou-settings-desc" style={{ marginBottom: 10 }}>
            Choose a light or dark look, or follow your system setting.
          </div>
          <div className="ou-seg" role="radiogroup" aria-label="Appearance">
            {THEME_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                role="radio"
                aria-checked={theme === opt.value}
                onClick={() => chooseTheme(opt.value)}
                className={`ou-seg-btn${theme === opt.value ? ' active' : ''}`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Privacy: anonymous usage analytics */}
        <div className="ou-settings-row ou-settings-section">
          <div className="ou-settings-grow">
            <div className="ou-settings-label">Anonymous Usage Analytics</div>
            <div className="ou-settings-desc">
              Help us improve OpenUI by sharing anonymous usage data. No personal data is ever
              collected.
            </div>
          </div>
          <Switch
            on={enabled}
            disabled={busy}
            label="Anonymous Usage Analytics"
            onClick={() => void toggle()}
          />
        </div>

        {/* AI Improvement: local self-improvement loop */}
        <div className="ou-settings-row ou-settings-section">
          <div className="ou-settings-grow">
            <div className="ou-settings-label">AI Improvement</div>
            <div className="ou-settings-desc">
              OpenUI learns from your usage patterns to improve its responses over time. No data
              leaves your machine — improvement happens locally.
            </div>
          </div>
          <Switch
            on={aiImprovement}
            disabled={false}
            label="AI Improvement"
            onClick={toggleAiImprovement}
          />
        </div>

        {/* Automation: how autonomous the agent is when carrying out tasks */}
        <div className="ou-settings-section">
          <div className="ou-settings-label">Automation</div>
          <div className="ou-settings-desc" style={{ marginBottom: 10 }}>
            How much OpenUI does on its own when running a multi-step task.
          </div>
          <div className="ou-seg">
            {AUTONOMY_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => chooseAutonomy(opt.value)}
                className={`ou-seg-btn${autonomy === opt.value ? ' active' : ''}`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <div className="ou-seg-hint">
            {AUTONOMY_OPTIONS.find((o) => o.value === autonomy)?.hint}
          </div>
        </div>

        {/* Integrations: Figma personal access token */}
        <div className="ou-settings-section">
          <div className="ou-settings-headrow">
            <div className="ou-settings-label">Figma</div>
            {figmaSaved && <span className="ou-settings-saved">Saved</span>}
          </div>
          <div className="ou-settings-desc" style={{ marginBottom: 8 }}>
            Paste a personal access token to let OpenUI review your Figma designs, export their
            design tokens, and build frames as code. Create one at figma.com → Settings → Security →
            Personal access tokens. Read-only access is enough. Stored locally on this device.
          </div>
          <input
            type="password"
            className="ou-settings-input"
            value={figmaToken}
            onChange={(e) => setFigmaToken(e.target.value)}
            onBlur={saveFigmaToken}
            placeholder="figd_…"
            aria-label="Figma personal access token"
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        {/* Screen OCR language (free-tier local OCR) */}
        <div className="ou-settings-section">
          <div className="ou-settings-headrow">
            <div className="ou-settings-label">Screen OCR language</div>
            {ocrLangSaved && <span className="ou-settings-saved">Saved</span>}
          </div>
          <div className="ou-settings-desc" style={{ marginBottom: 8 }}>
            Language used to read your screen with local OCR (free tier). Pick the language your
            apps are in so non-English text is read correctly; “Auto” follows your system language.
          </div>
          <select
            className="ou-settings-input"
            value={ocrLanguage}
            onChange={(e) => chooseOcrLanguage(e.target.value)}
            aria-label="Screen OCR language"
          >
            {OCR_LANGUAGE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        {/* WhatsApp allowlisted auto-reply. Compose-and-click by design: the
            watcher only drafts suggestions for these contacts; sending is always
            a human click. Default-off; empty allowlist = nothing runs. */}
        {waConfig && (
          <div className="ou-settings-section">
            <div className="ou-settings-headrow">
              <div className="ou-settings-label">WhatsApp auto-reply</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {waSaved && <span className="ou-settings-saved">Saved</span>}
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: waConfig.enabled ? 'var(--ou-success)' : 'var(--ou-text-faint)',
                    background: waConfig.enabled ? 'var(--ou-success-soft)' : 'var(--ou-surface-2)',
                    borderRadius: 999,
                    padding: '2px 8px'
                  }}
                >
                  {waConfig.enabled ? 'ON' : 'OFF'}
                </span>
              </div>
            </div>
            <div className="ou-settings-desc" style={{ marginBottom: 10 }}>
              When on, OpenUI watches for new WhatsApp messages from the contacts you list below and{' '}
              <strong style={{ color: 'var(--ou-text)' }}>drafts a suggested reply</strong> for each. It never sends on its
              own — you review every draft and click to send. Nothing runs for anyone not on this list.
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', marginBottom: 12 }}>
              <input type="checkbox" checked={waConfig.enabled} onChange={toggleWaEnabled} />
              <span style={{ fontSize: 12.5, color: 'var(--ou-text)' }}>
                Enable the background watcher {waConfig.allowlist.length === 0 && '(add a contact below first)'}
              </span>
            </label>

            {/* Current allowlist */}
            {waConfig.allowlist.length > 0 && (
              <div style={{ marginBottom: 10 }}>
                {waConfig.allowlist.map((entry) => (
                  <div
                    key={entry.name}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      justifyContent: 'space-between',
                      gap: 8,
                      border: '1px solid var(--ou-border)',
                      borderRadius: 8,
                      padding: '7px 10px',
                      marginBottom: 6
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ou-text)' }}>{entry.name}</div>
                      {entry.instruction && (
                        <div style={{ fontSize: 11.5, color: 'var(--ou-text-dim)', lineHeight: 1.4, marginTop: 2 }}>
                          {entry.instruction}
                        </div>
                      )}
                    </div>
                    <button
                      onClick={() => removeWaContact(entry.name)}
                      aria-label={`Remove ${entry.name} from the auto-reply allowlist`}
                      style={{
                        border: 'none',
                        background: 'transparent',
                        color: 'var(--ou-danger)',
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: 'pointer',
                        flexShrink: 0
                      }}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Add a contact */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <input
                type="text"
                className="ou-settings-input"
                value={waNewName}
                onChange={(e) => setWaNewName(e.target.value)}
                placeholder="Contact or group name (exactly as in WhatsApp)"
                aria-label="Contact or group name to allow auto-reply drafts for"
                spellCheck={false}
              />
              <input
                type="text"
                className="ou-settings-input"
                value={waNewInstruction}
                onChange={(e) => setWaNewInstruction(e.target.value)}
                placeholder="Optional instruction, e.g. “reply as if I'm busy, keep it short”"
                aria-label="Optional per-contact reply instruction"
                spellCheck={false}
              />
              <button
                onClick={addWaContact}
                disabled={!waNewName.trim()}
                style={{
                  alignSelf: 'flex-start',
                  border: '1px solid var(--ou-border)',
                  borderRadius: 8,
                  padding: '7px 14px',
                  fontSize: 12.5,
                  fontWeight: 600,
                  color: waNewName.trim() ? 'var(--ou-text)' : 'var(--ou-text-faint)',
                  background: 'var(--ou-surface-2)',
                  cursor: waNewName.trim() ? 'pointer' : 'default'
                }}
              >
                Add to allowlist
              </button>
            </div>
          </div>
        )}

        {/* Cross-channel memory. Listed in full and individually deletable by
            design: the feature carries what happened on one channel into a
            reply on another, and that is only acceptable if the user can see
            every line of it. Nothing here writes memory — the agent loop is the
            sole writer (channelMemory.ts). */}
        <div className="ou-settings-section">
          <div className="ou-settings-headrow">
            <div className="ou-settings-label">Memory</div>
            <span className="ou-settings-status">
              {memories.length === 0
                ? 'Nothing stored'
                : `${memories.length} ${memories.length === 1 ? 'memory' : 'memories'}`}
            </span>
          </div>
          <div className="ou-settings-desc" style={{ marginBottom: 10 }}>
            After OpenUI sends or reads a message on WhatsApp, Telegram, Slack or Gmail, it keeps a
            one-line note of what happened, filed under that contact or topic. Those notes are
            offered back as context on later requests — including on a{' '}
            <strong style={{ color: 'var(--ou-text)' }}>different channel</strong>, which is how
            &ldquo;tell #eng what I promised Ashu&rdquo; works. Stored locally in this app&rsquo;s
            database; never uploaded. Delete anything below and it stops being used immediately.
          </div>

          {memories.length === 0 ? (
            <div className="ou-settings-desc" style={{ fontStyle: 'italic' }}>
              Nothing remembered yet. Notes appear here after OpenUI acts on one of your messaging
              channels.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
              {memories.map((m) => {
                const chan = MEMORY_CHANNELS[m.channel] ?? {
                  label: m.channel,
                  color: 'var(--ou-text-faint)'
                }
                return (
                  <div
                    key={m.id}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 10,
                      padding: '8px 10px',
                      border: '1px solid var(--ou-border)',
                      borderRadius: 8,
                      background: 'var(--ou-surface-2)'
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          marginBottom: 3,
                          flexWrap: 'wrap'
                        }}
                      >
                        <span
                          style={{
                            fontSize: 10.5,
                            fontWeight: 700,
                            letterSpacing: 0.3,
                            textTransform: 'uppercase',
                            color: chan.color
                          }}
                        >
                          {chan.label}
                        </span>
                        <span style={{ fontSize: 11, color: 'var(--ou-text)', fontWeight: 600 }}>
                          {m.subject_label}
                        </span>
                        <span style={{ fontSize: 11, color: 'var(--ou-text-faint)' }}>
                          {memoryAge(m.created_at)}
                        </span>
                      </div>
                      <div style={{ fontSize: 12.5, color: 'var(--ou-text)', wordBreak: 'break-word' }}>
                        {m.summary}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => forgetMemory(m.id)}
                      aria-label={`Forget: ${m.summary}`}
                      title="Forget this"
                      style={{
                        flexShrink: 0,
                        border: '1px solid var(--ou-border)',
                        borderRadius: 6,
                        padding: '4px 9px',
                        fontSize: 11.5,
                        fontWeight: 600,
                        color: 'var(--ou-text-faint)',
                        background: 'transparent',
                        cursor: 'pointer'
                      }}
                    >
                      Forget
                    </button>
                  </div>
                )
              })}
            </div>
          )}

          {memories.length > 0 && (
            <div className="ou-settings-btnrow" style={{ marginTop: 0, flexWrap: 'wrap' }}>
              {/* Per-subject clear: "stop remembering this person" is a more
                  common intent than clearing the whole store. */}
              {[...new Map(memories.map((m) => [m.subject_key, m.subject_label])).entries()]
                .slice(0, 6)
                .map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    className="ou-settings-btn"
                    onClick={() => forgetSubject(key)}
                    title={`Forget everything stored about ${label}`}
                  >
                    Forget all: {label}
                  </button>
                ))}
              <button
                type="button"
                className="ou-settings-btn"
                onClick={forgetAllMemories}
                onBlur={() => setMemoryConfirmClear(false)}
                style={memoryConfirmClear ? { color: 'var(--ou-danger-text)' } : undefined}
              >
                {memoryConfirmClear ? 'Click again to confirm' : 'Forget everything'}
              </button>
            </div>
          )}
        </div>

        {/* Cloud AI: bring-your-own-key frontier model (opt-in). Hidden for the
            Ollama-only launch; see CLOUD_TIER_ENABLED above. */}
        {CLOUD_TIER_ENABLED && (
        <div className="ou-settings-section">
          <div className="ou-settings-row">
            <div className="ou-settings-grow">
              <div className="ou-settings-label">Cloud AI</div>
              <div className="ou-settings-desc">
                By default OpenUI runs entirely on your local model — nothing leaves this machine.
                Turn this on to route turns to a frontier Claude model instead, using your own
                Anthropic key. Local stays the fallback if the cloud call fails.
              </div>
            </div>
            <Switch
              on={cloudRouting}
              disabled={!anthropicKey.trim()}
              label="Cloud AI routing"
              onClick={toggleCloudRouting}
            />
          </div>
          <div className="ou-settings-headrow" style={{ marginTop: 12 }}>
            <div className="ou-settings-label">Anthropic API key</div>
            {anthropicSaved && <span className="ou-settings-saved">Saved</span>}
          </div>
          <div className="ou-settings-desc" style={{ marginBottom: 8 }}>
            Get one at console.anthropic.com → API keys. Stored locally on this device; the toggle
            above stays off until a key is saved.
          </div>
          <input
            type="password"
            className="ou-settings-input"
            value={anthropicKey}
            onChange={(e) => setAnthropicKey(e.target.value)}
            onBlur={saveAnthropicKey}
            placeholder="sk-ant-…"
            aria-label="Anthropic API key"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        )}

        {/* Integrations: GitHub personal access token */}
        <div className="ou-settings-section">
          <div className="ou-settings-headrow">
            <div className="ou-settings-label">GitHub</div>
            {githubSaved && <span className="ou-settings-saved">Saved</span>}
          </div>
          <div className="ou-settings-desc" style={{ marginBottom: 8 }}>
            Paste a personal access token with &quot;repo&quot; scope to let OpenUI create repos,
            push code, and open pull requests for you. Create one at github.com → Settings →
            Developer settings → Personal access tokens. Stored locally on this device.
          </div>
          <input
            type="password"
            className="ou-settings-input"
            value={githubToken}
            onChange={(e) => setGithubToken(e.target.value)}
            onBlur={saveGithubToken}
            placeholder="ghp_…"
            aria-label="GitHub personal access token"
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        {/* Integrations: Telegram bot token (created via @BotFather) */}
        <div className="ou-settings-section">
          <div className="ou-settings-headrow">
            <div className="ou-settings-label">Telegram</div>
            {telegramSaved && <span className="ou-settings-saved">Saved</span>}
          </div>
          <div className="ou-settings-desc" style={{ marginBottom: 8 }}>
            Paste a bot token to let OpenUI send and read Telegram messages through your own bot.
            Create one by messaging @BotFather → /newbot. Note: a bot can only message people who have
            started a chat with it first. Stored locally on this device.
          </div>
          <input
            type="password"
            className="ou-settings-input"
            value={telegramToken}
            onChange={(e) => setTelegramToken(e.target.value)}
            onBlur={saveTelegramToken}
            placeholder="123456789:AA…"
            aria-label="Telegram bot token"
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        {/* Integrations: Slack bot/user token */}
        <div className="ou-settings-section">
          <div className="ou-settings-headrow">
            <div className="ou-settings-label">Slack</div>
            {slackSaved && <span className="ou-settings-saved">Saved</span>}
          </div>
          <div className="ou-settings-desc" style={{ marginBottom: 8 }}>
            Paste a Slack token to let OpenUI send, read, and search Slack messages. A bot token
            (xoxb-) with chat:write, channels:read and channels:history covers most tasks; search
            needs a user token (xoxp-) with search:read. Create one at api.slack.com/apps. Stored
            locally on this device.
          </div>
          <input
            type="password"
            className="ou-settings-input"
            value={slackToken}
            onChange={(e) => setSlackToken(e.target.value)}
            onBlur={saveSlackToken}
            placeholder="xoxb-…"
            aria-label="Slack token"
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        {/* Integrations: Google Calendar (dedicated OAuth for invites + Meet links) */}
        <div className="ou-settings-section">
          <div className="ou-settings-headrow">
            <div className="ou-settings-label">Google Calendar</div>
            <span className={`ou-settings-status${gcalConnected ? ' ok' : ''}`}>
              {gcalConnected ? 'Connected' : 'Not connected'}
            </span>
          </div>
          <div className="ou-settings-desc" style={{ marginBottom: 8 }}>
            Lets OpenUI email calendar invites and attach Google Meet links. Create an OAuth
            &quot;Desktop app&quot; client at console.cloud.google.com (enable the Google Calendar API),
            paste its Client ID and Secret below, then click Connect. Stored locally on this device.
          </div>
          <input
            type="password"
            className="ou-settings-input"
            value={gcalClientId}
            onChange={(e) => setGcalClientId(e.target.value)}
            onBlur={saveGcalClientId}
            placeholder="Client ID (…apps.googleusercontent.com)"
            aria-label="Google OAuth client ID"
            autoComplete="off"
            spellCheck={false}
          />
          <input
            type="password"
            className="ou-settings-input"
            value={gcalClientSecret}
            onChange={(e) => setGcalClientSecret(e.target.value)}
            onBlur={saveGcalClientSecret}
            placeholder="Client Secret"
            aria-label="Google OAuth client secret"
            autoComplete="off"
            spellCheck={false}
          />
          <div className="ou-settings-btnrow">
            <button
              type="button"
              className="ou-settings-btn"
              onClick={() => void connectGoogleCalendar()}
              disabled={gcalConnecting || !gcalClientId.trim() || !gcalClientSecret.trim()}
            >
              {gcalConnecting ? 'Connecting…' : gcalConnected ? 'Reconnect' : 'Connect'}
            </button>
            {gcalMessage && <span className="ou-settings-msg">{gcalMessage}</span>}
          </div>
        </div>

        {/* Local calendar automation (Calendar.app / Outlook COM). Default OFF:
            delete/reschedule on these backends is new and has only ever been
            unit-tested, never run against a real calendar app — a mistake there
            cancels or moves a real meeting. Google Calendar above is unaffected
            and needs no toggle. */}
        <div className="ou-settings-row ou-settings-section">
          <div className="ou-settings-grow">
            <div className="ou-settings-label">Local calendar automation</div>
            <div className="ou-settings-desc">
              Lets OpenUI create, cancel and reschedule events directly in Calendar.app (macOS) or
              Outlook (Windows) instead of Google Calendar. <strong style={{ color: 'var(--ou-text)' }}>Off by
              default</strong> — cancelling/rescheduling on these backends is new and has not yet been
              verified against a real calendar app, and a mistake could cancel or move the wrong
              meeting. Google Calendar above works either way and is unaffected by this toggle.
            </div>
          </div>
          <Switch
            on={localCalendarEnabled}
            disabled={false}
            label="Local calendar automation"
            onClick={toggleLocalCalendar}
          />
        </div>

        {/* Integrations: Gmail (shares the Calendar OAuth client above, own refresh token) */}
        <div className="ou-settings-section">
          <div className="ou-settings-headrow">
            <div className="ou-settings-label">Gmail</div>
            <span className={`ou-settings-status${gmailConnected ? ' ok' : ''}`}>
              {gmailConnected ? 'Connected' : 'Not connected'}
            </span>
          </div>
          <div className="ou-settings-desc" style={{ marginBottom: 8 }}>
            Lets OpenUI send email and follow up on threads. Uses the same Google OAuth Client ID
            and Secret entered above for Google Calendar (enable the Gmail API on that same
            project), just click Connect.
          </div>
          <div className="ou-settings-btnrow" style={{ marginTop: 0 }}>
            <button
              type="button"
              className="ou-settings-btn"
              onClick={() => void connectGmail()}
              disabled={gmailConnecting || !gcalClientId.trim() || !gcalClientSecret.trim()}
            >
              {gmailConnecting ? 'Connecting…' : gmailConnected ? 'Reconnect' : 'Connect'}
            </button>
            {gmailMessage && <span className="ou-settings-msg">{gmailMessage}</span>}
          </div>
        </div>

        {/* Integrations: Google Drive (shares the Calendar OAuth client above, own refresh token) */}
        <div className="ou-settings-section">
          <div className="ou-settings-headrow">
            <div className="ou-settings-label">Google Drive</div>
            <span className={`ou-settings-status${driveConnected ? ' ok' : ''}`}>
              {driveConnected ? 'Connected' : 'Not connected'}
            </span>
          </div>
          <div className="ou-settings-desc" style={{ marginBottom: 8 }}>
            Lets OpenUI upload, download and share files in Drive. Uses the same Google OAuth Client
            ID and Secret entered above for Google Calendar (enable the Drive API on that same
            project). Requests only the narrow drive.file scope — access to files OpenUI creates or
            you open with it, never your whole Drive.
          </div>
          <div className="ou-settings-btnrow" style={{ marginTop: 0 }}>
            <button
              type="button"
              className="ou-settings-btn"
              onClick={() => void connectGoogleDrive()}
              disabled={driveConnecting || !gcalClientId.trim() || !gcalClientSecret.trim()}
            >
              {driveConnecting ? 'Connecting…' : driveConnected ? 'Reconnect' : 'Connect'}
            </button>
            {driveMessage && <span className="ou-settings-msg">{driveMessage}</span>}
          </div>
        </div>

        {/* App version & update check */}
        <div className="ou-settings-row ou-settings-section" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div className="ou-settings-label">App Version</div>
            <div className="ou-settings-desc" style={{ marginTop: 2 }}>
              OpenUI{appVersion ? ` v${appVersion}` : ''}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            {updateStatus === 'checking' ? (
              <span className="ou-settings-status">Checking…</span>
            ) : updateStatus === 'latest' ? (
              <span className="ou-settings-status ok">Up to date</span>
            ) : updateStatus === 'available' || updateStatus === 'downloaded' ? (
              <span className="ou-settings-status info">
                {updateStatus === 'downloaded' ? 'Ready to install' : 'Update available'}
              </span>
            ) : (
              <button
                type="button"
                className="ou-settings-link"
                onClick={onCheckForUpdates}
                disabled={!onCheckForUpdates}
              >
                Check for updates
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/** Minimal iOS-style switch (dark theme, token-driven). */
function Switch({
  on,
  disabled,
  label,
  onClick
}: {
  on: boolean
  disabled: boolean
  label: string
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`ou-switch${on ? ' on' : ''}`}
    >
      <span className="ou-switch-thumb" />
    </button>
  )
}
