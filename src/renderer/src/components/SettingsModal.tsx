import { isValidElement, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import {
  Brain,
  Check,
  ChevronDown,
  Copy,
  Cpu,
  Gauge,
  Hash,
  KeyRound,
  Mail,
  MessageCircle,
  MessagesSquare,
  Monitor,
  Moon,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  Wrench,
  X,
  type LucideIcon
} from 'lucide-react'
import type { AutonomyLevel, ChannelMemory, ConsentStatus, WhatsAppAutoReplyConfig } from '../env'
import type { UpdateStatus } from '../hooks/useUpdater'
import { applyTheme, coerceThemePref, type ThemePref } from '../lib/theme'
import ModelManager from './ModelManager'

const THEME_OPTIONS: { value: ThemePref; label: string; Icon: LucideIcon }[] = [
  { value: 'system', label: 'System', Icon: Monitor },
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon }
]

const AUTONOMY_OPTIONS: { value: AutonomyLevel; label: string; hint: string }[] = [
  { value: 'ask-each', label: 'Ask each', hint: 'Confirm every action before it runs.' },
  { value: 'approve-plan', label: 'Approve plan', hint: 'Review the plan once, then it runs on its own.' },
  { value: 'full-auto', label: 'Full auto', hint: 'Runs steps without asking. Sending a message, deleting or linking a contact still always asks.' }
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

// Display names for the four channels cross-channel memory covers. Keys match
// MemoryChannel in src/main/channelMemory.ts.
const MEMORY_CHANNELS: Record<string, string> = {
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  slack: 'Slack',
  gmail: 'Gmail'
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

// Sections that belong to the older all-purpose assistant (design tools, code
// hosting, calendar/Drive, screen OCR, AI improvement). The Splen build is a
// texting agent, so Settings shows only what it uses. Flip to bring them back.
const SHOW_EXTRA_SETTINGS = false

export type SettingsSection = 'general' | 'model' | 'channels' | 'keys' | 'memory' | 'usage' | 'privacy' | 'advanced'
export type SettingsChannel = 'whatsapp' | 'gmail' | 'telegram' | 'slack'

const SECTIONS: { id: SettingsSection; label: string; Icon: LucideIcon }[] = [
  { id: 'general', label: 'General', Icon: SlidersHorizontal },
  { id: 'model', label: 'Model', Icon: Cpu },
  { id: 'channels', label: 'Channels', Icon: MessagesSquare },
  { id: 'keys', label: 'Keys', Icon: KeyRound },
  { id: 'memory', label: 'Memory', Icon: Brain },
  { id: 'usage', label: 'Usage', Icon: Gauge },
  { id: 'privacy', label: 'Privacy & safety', Icon: ShieldCheck },
  ...(CLOUD_TIER_ENABLED || SHOW_EXTRA_SETTINGS
    ? [{ id: 'advanced' as const, label: 'Advanced', Icon: Wrench }]
    : [])
]

const SECTION_INTRO: Record<SettingsSection, { title: string; intro: string }> = {
  general: { title: 'General', intro: 'How Splen looks, and which version you’re on.' },
  model: { title: 'Model', intro: 'Splen runs on this computer. Download its model once, here.' },
  channels: { title: 'Channels', intro: 'Where your messages are. Open one to set it up.' },
  keys: { title: 'Keys', intro: 'Tokens you’ve given Splen. They’re encrypted and stay on this computer.' },
  memory: {
    title: 'Memory',
    intro: 'One-line notes Splen keeps after reading or sending a message, and uses as context later, even on a different channel. Stored only on this computer. Forget anything and it stops being used immediately.'
  },
  usage: { title: 'Usage', intro: 'How much you’ve used Splen. Counted on this computer.' },
  privacy: { title: 'Privacy & safety', intro: 'What Splen may do on its own, and what you share with us.' },
  advanced: { title: 'Advanced', intro: 'Options outside the texting agent.' }
}

interface UsageData {
  today: Awaited<ReturnType<typeof window.openui.getUsageToday>>
  summary: Awaited<ReturnType<typeof window.openui.getUsageSummary>>
}

interface Props {
  onClose: () => void
  appVersion?: string
  updateStatus?: UpdateStatus
  onCheckForUpdates?: () => void
  /** Which section to open on (default General). */
  initialSection?: SettingsSection
  /** A channel to open expanded, for "Set up WhatsApp" style entry points. */
  initialChannel?: SettingsChannel
}

/**
 * The Settings panel: a section list on the left, the section on the right.
 * Every control persists to the same setting it always did; only what the user
 * sees changed. The analytics toggle mirrors the first-launch consent choice and
 * stays in sync with changes made elsewhere via the onConsentUpdated event.
 */
export default function SettingsModal({
  onClose,
  appVersion,
  updateStatus,
  onCheckForUpdates,
  initialSection = 'general',
  initialChannel
}: Props): JSX.Element {
  const [active, setActive] = useState<SettingsSection>(initialSection)
  const [openChannel, setOpenChannel] = useState<SettingsChannel | null>(initialChannel ?? null)
  const toggleChannel = (id: SettingsChannel): void => setOpenChannel((cur) => (cur === id ? null : id))
  const panelRef = useRef<HTMLDivElement>(null)
  const navRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [enabled, setEnabled] = useState(false)
  const [busy, setBusy] = useState(false)
  // Appearance: light / dark / follow-OS. Default matches the app default (dark).
  const [theme, setTheme] = useState<ThemePref>('system')
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
  // What is actually saved, as opposed to what is typed in the box right now.
  const [telegramStored, setTelegramStored] = useState('')
  // The bot Telegram confirmed for the pasted token (verifyTelegramToken).
  const [telegramBot, setTelegramBot] = useState<string | null>(null)
  const [telegramBusy, setTelegramBusy] = useState(false)
  const [telegramMessage, setTelegramMessage] = useState('')
  // Slack bot/user token — read by the main-process Slack tools when the
  // SLACK_TOKEN env var is absent. Same per-user credential reasoning as Figma/GitHub.
  const [slackToken, setSlackToken] = useState('')
  const [slackStored, setSlackStored] = useState('')
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
  const [unifiedInboxEnabled, setUnifiedInboxEnabled] = useState(false)
  // Gmail — shares the Google Calendar OAuth client id/secret above (one
  // Google Cloud client, multiple scopes) but has its own refresh token and
  // Connect button, since it's a separate OAuth grant.
  const [gmailConnected, setGmailConnected] = useState(false)
  const [gmailConnecting, setGmailConnecting] = useState(false)
  const [gmailMessage, setGmailMessage] = useState('')
  // This build ships OpenUI's own Google client: Connect needs no Client ID.
  const [gmailBuiltIn, setGmailBuiltIn] = useState(false)
  const [gmailOwnClient, setGmailOwnClient] = useState(false)
  // Google Drive — same shared OAuth client as Calendar/Gmail, own refresh token
  // and Connect button (the narrow drive.file scope is its own OAuth grant).
  const [driveConnected, setDriveConnected] = useState(false)
  const [driveConnecting, setDriveConnecting] = useState(false)
  const [driveMessage, setDriveMessage] = useState('')
  // WhatsApp allowlisted auto-reply. The whole config lives in one object; the
  // watcher only ever COMPOSES a suggested reply for these contacts — sending
  // stays a human click. Default-off; empty allowlist means nothing runs.
  const [waConfig, setWaConfig] = useState<WhatsAppAutoReplyConfig | null>(null)
  const [waLoadFailed, setWaLoadFailed] = useState(false)
  const [waSaved, setWaSaved] = useState(false)
  const [waNewName, setWaNewName] = useState('')
  const [waNewInstruction, setWaNewInstruction] = useState('')
  // Cross-channel memory. Every stored line is listed here because the feature's
  // whole risk is invisibility: carrying something said on WhatsApp into a Slack
  // reply is only acceptable if the user can see exactly what is remembered and
  // delete any of it. Read-only from the renderer — the agent loop is the sole
  // writer (see channelMemory.ts).
  const [memories, setMemories] = useState<ChannelMemory[]>([])
  const [memoriesState, setMemoriesState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [memoryConfirmClear, setMemoryConfirmClear] = useState(false)
  const [usage, setUsage] = useState<UsageData | 'loading' | 'failed'>('loading')

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
        if (!cancelled && typeof value === 'string') {
          setTelegramToken(value)
          setTelegramStored(value)
        }
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
        if (!cancelled && typeof value === 'string') {
          setSlackToken(value)
          setSlackStored(value)
        }
      })
      .catch(() => {})

    window.openui
      .getWhatsAppAutoReply()
      .then((cfg) => {
        if (!cancelled) setWaConfig(cfg)
      })
      .catch(() => {
        if (!cancelled) setWaLoadFailed(true)
      })

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
      .getSetting('unified_inbox_enabled')
      .then((value) => {
        // Absent/null/undefined ⇒ ON. Mirrors isUnifiedInboxEnabled in
        // src/main/inboxSummary.ts — only an explicit `false` turns it off.
        if (!cancelled) setUnifiedInboxEnabled(value !== false)
      })
      .catch(() => {})

    window.openui
      .gmailStatus()
      .then((s) => {
        if (!cancelled) {
          setGmailConnected(Boolean(s?.connected))
          setGmailBuiltIn(Boolean(s?.builtInClient))
        }
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
        if (!cancelled) {
          setMemories(rows)
          setMemoriesState('ready')
        }
      })
      .catch(() => {
        if (!cancelled) setMemoriesState('failed')
      })

    Promise.all([window.openui.getUsageToday(), window.openui.getUsageSummary(30)])
      .then(([today, summary]) => {
        if (!cancelled) setUsage({ today, summary })
      })
      .catch(() => {
        if (!cancelled) setUsage('failed')
      })

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

  const connectTelegram = async (): Promise<void> => {
    if (telegramBusy || !telegramToken.trim()) return
    setTelegramBusy(true)
    setTelegramMessage('Checking with Telegram…')
    try {
      const result = await window.openui.telegramConnect(telegramToken.trim())
      if (result.ok) {
        setTelegramBot(result.username)
        setTelegramStored(telegramToken.trim())
        setTelegramMessage('')
      } else {
        setTelegramBot(null)
        setTelegramMessage(result.error)
      }
    } catch {
      setTelegramMessage('Could not check the token. Try again.')
    } finally {
      setTelegramBusy(false)
    }
  }

  const saveSlackToken = (): void => {
    void window.openui
      .setSetting('slack_token', slackToken.trim())
      .then(() => {
        setSlackStored(slackToken.trim())
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

  const toggleUnifiedInbox = (): void => {
    const next = !unifiedInboxEnabled
    setUnifiedInboxEnabled(next)
    void window.openui
      .setSetting('unified_inbox_enabled', next)
      .catch(() => setUnifiedInboxEnabled(!next))
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
      // With the built-in client there is nothing to save; otherwise persist the
      // user's own client first so the main-process flow can read it.
      if (!gmailBuiltIn || gmailOwnClient) {
        await window.openui.setSetting('google_oauth_client_id', gcalClientId.trim())
        await window.openui.setSetting('google_oauth_client_secret', gcalClientSecret.trim())
      }
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

  // Focus moves into the dialog on open, so Tab starts at the section list;
  // each section starts at the top.
  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true })
  }, [])
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0
  }, [active])

  /** Up/Down/Home/End move between sections, as in any vertical tab list. */
  const onNavKey = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const at = SECTIONS.findIndex((x) => x.id === active)
    const next =
      e.key === 'ArrowDown' ? (at + 1) % SECTIONS.length
      : e.key === 'ArrowUp' ? (at - 1 + SECTIONS.length) % SECTIONS.length
      : e.key === 'Home' ? 0
      : e.key === 'End' ? SECTIONS.length - 1
      : -1
    if (next < 0) return
    e.preventDefault()
    setActive(SECTIONS[next].id)
    navRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus()
  }

  /** Clear saved credentials, then the fields that show them. */
  const removeKeys = (settings: string[], clear: () => void): void => {
    void Promise.all(settings.map((key) => window.openui.setSetting(key, '')))
      .then(clear)
      .catch(() => {})
  }

  const savedKeys = [
    telegramStored.trim() && {
      id: 'telegram',
      label: 'Telegram bot token',
      hint: 'Removing it here stops Splen using the bot. To cancel the token itself, ask @BotFather.',
      value: telegramStored,
      remove: () =>
        removeKeys(['telegram_bot_token'], () => {
          setTelegramStored('')
          setTelegramToken('')
          setTelegramBot(null)
        })
    },
    slackStored.trim() && {
      id: 'slack',
      label: 'Slack token',
      hint: 'Removing it here stops Splen using Slack. To cancel the token itself, use api.slack.com/apps.',
      value: slackStored,
      remove: () =>
        removeKeys(['slack_token'], () => {
          setSlackStored('')
          setSlackToken('')
        })
    },
    gcalClientId.trim() && {
      id: 'google',
      label: 'Google OAuth client',
      hint: 'Your own Google Cloud client, used to sign in to Gmail. Removing it means connecting Gmail again.',
      value: gcalClientId,
      remove: () =>
        removeKeys(['google_oauth_client_id', 'google_oauth_client_secret'], () => {
          setGcalClientId('')
          setGcalClientSecret('')
        })
    }
  ].filter((k): k is Exclude<typeof k, '' | false> => Boolean(k))

  const panel = SECTION_INTRO[active]

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      className="ou-set-scrim"
      onMouseDown={(e) => {
        // Click outside the panel dismisses; clicks inside are stopped below.
        e.stopPropagation()
        onClose()
      }}
    >
      <div ref={panelRef} tabIndex={-1} className="ou-set" onMouseDown={(e) => e.stopPropagation()}>
        <aside className="ou-set-nav">
          <div className="ou-set-nav-title">Settings</div>
          <div
            ref={navRef}
            role="tablist"
            aria-orientation="vertical"
            aria-label="Settings sections"
            className="ou-set-nav-list"
            onKeyDown={onNavKey}
          >
            {SECTIONS.map(({ id, label, Icon }) => (
              <button
                key={id}
                id={`settings-tab-${id}`}
                type="button"
                role="tab"
                aria-selected={active === id}
                aria-controls="settings-panel"
                tabIndex={active === id ? 0 : -1}
                className={`ou-set-nav-item${active === id ? ' active' : ''}`}
                onClick={() => setActive(id)}
              >
                <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
                <span>{label}</span>
              </button>
            ))}
          </div>
          <div className="ou-set-nav-foot">Splen{appVersion ? ` v${appVersion}` : ''}</div>
        </aside>

        <div className="ou-set-main">
          <button type="button" aria-label="Close settings" className="ou-set-close" onClick={onClose}>
            <X size={18} strokeWidth={1.75} aria-hidden="true" />
          </button>

          <div
            ref={scrollRef}
            id="settings-panel"
            role="tabpanel"
            aria-labelledby={`settings-tab-${active}`}
            className="ou-set-scroll"
          >
            <div className="ou-set-pane" key={active}>
              <header className="ou-set-head">
                <h2 className="ou-set-title">{panel.title}</h2>
                <p className="ou-set-intro">{panel.intro}</p>
              </header>

              {active === 'general' && (
                <>
                  <Group title="Appearance">
                    <Row title="Theme" desc="Follow your computer, or pick one.">
                      <div className="ou-seg" role="radiogroup" aria-label="Appearance">
                        {THEME_OPTIONS.map(({ value, label, Icon }) => (
                          <button
                            key={value}
                            type="button"
                            role="radio"
                            aria-checked={theme === value}
                            onClick={() => chooseTheme(value)}
                            className={`ou-seg-btn${theme === value ? ' active' : ''}`}
                          >
                            <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
                            {label}
                          </button>
                        ))}
                      </div>
                    </Row>
                  </Group>

                  <Group title="About">
                    <Row title="App version" desc={`Splen${appVersion ? ` v${appVersion}` : ''}`}>
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
                          className="ou-set-ghost bordered"
                          onClick={onCheckForUpdates}
                          disabled={!onCheckForUpdates}
                        >
                          Check for updates
                        </button>
                      )}
                    </Row>
                  </Group>
                </>
              )}

              {active === 'model' && (
                /* The in-app download path. This is the ONLY place the app
                   documents how to get a model — there is no terminal instruction
                   anywhere in the product. */
                <Group title="On this computer">
                  <div className="ou-set-card">
                    <ModelManager showHeading={false} />
                  </div>
                </Group>
              )}

              {active === 'channels' && (
                <>
                  <Group title="Connections">
                    <div className="ou-set-card">
                      {/* WhatsApp needs no connection. The auto-reply below is
                          compose-and-click by design: the watcher only drafts
                          suggestions for these contacts; sending is always a
                          human click. Default-off; empty allowlist = nothing runs. */}
                      <ChannelRow
                        name="WhatsApp"
                        sub="Through WhatsApp Desktop on this computer"
                        Icon={MessageCircle}
                        status="Built in"
                        ok
                        open={openChannel === 'whatsapp'}
                        onToggle={() => toggleChannel('whatsapp')}
                      >
                        {waConfig ? (
                          <>
                            <div className="ou-set-subrow">
                              <div className="ou-settings-grow">
                                <div className="ou-set-row-title">
                                  Draft replies automatically
                                  {waSaved && <span className="ou-settings-saved"> Saved</span>}
                                </div>
                                <div className="ou-set-row-desc">
                                  Splen watches for new messages from the people listed here and{' '}
                                  <strong>drafts a reply</strong> for each. It never sends on its own, and
                                  nothing runs for anyone not on this list.
                                </div>
                              </div>
                              <Switch
                                on={waConfig.enabled}
                                disabled={false}
                                label="Draft WhatsApp replies automatically"
                                onClick={toggleWaEnabled}
                              />
                            </div>

                            {waConfig.allowlist.length > 0 && (
                              <ul className="ou-set-list">
                                {waConfig.allowlist.map((entry) => (
                                  <li key={entry.name}>
                                    <div className="ou-settings-grow">
                                      <div className="ou-set-row-title">{entry.name}</div>
                                      {entry.instruction && <div className="ou-set-row-desc">{entry.instruction}</div>}
                                    </div>
                                    <button
                                      type="button"
                                      className="ou-set-ghost"
                                      onClick={() => removeWaContact(entry.name)}
                                      aria-label={`Remove ${entry.name} from the auto-reply allowlist`}
                                    >
                                      Remove
                                    </button>
                                  </li>
                                ))}
                              </ul>
                            )}

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
                            <div className="ou-settings-btnrow">
                              <button type="button" className="ou-settings-btn" onClick={addWaContact} disabled={!waNewName.trim()}>
                                Add contact
                              </button>
                            </div>
                          </>
                        ) : waLoadFailed ? (
                          <div className="ou-set-error" role="alert">
                            Couldn’t load the auto-reply settings. Close Settings and open it again.
                          </div>
                        ) : (
                          <Lines count={3} />
                        )}
                      </ChannelRow>

                      {/* Gmail. With Splen's own Google client baked in (gmailBuiltIn)
                          this is one click: browser → choose account → Allow. Without
                          it, a guided own-client setup — the fields stay reachable. */}
                      <ChannelRow
                        name="Gmail"
                        sub="Read, summarise and reply to email"
                        Icon={Mail}
                        status={gmailConnected ? 'Connected' : 'Not connected'}
                        ok={gmailConnected}
                        open={openChannel === 'gmail'}
                        onToggle={() => toggleChannel('gmail')}
                      >
                        {gmailBuiltIn && !gmailOwnClient ? (
                          <p className="ou-set-row-desc">
                            Click Connect, choose your Google account in the browser, then click Allow.
                          </p>
                        ) : (
                          <>
                            <p className="ou-set-row-desc">One-time setup with your own Google project, about 5 minutes:</p>
                            <ol className="ou-settings-steps">
                              <li>
                                <button type="button" className="ou-settings-link" onClick={() => window.open('https://console.cloud.google.com/apis/library/gmail.googleapis.com', '_blank', 'noopener,noreferrer')}>
                                  Turn on the Gmail API
                                </button>{' '}
                                (create a project if asked).
                              </li>
                              <li>
                                <button type="button" className="ou-settings-link" onClick={() => window.open('https://console.cloud.google.com/apis/credentials/oauthclient', '_blank', 'noopener,noreferrer')}>
                                  Create an OAuth client
                                </button>{' '}
                                — application type <strong>Desktop app</strong>. If Google asks, set up the
                                consent screen and add your own email as a test user.
                              </li>
                              <li>Paste the Client ID and Client Secret below, then click Connect.</li>
                            </ol>
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
                          </>
                        )}
                        <div className="ou-settings-btnrow">
                          <button
                            type="button"
                            className="ou-settings-btn"
                            onClick={() => void connectGmail()}
                            disabled={
                              gmailConnecting ||
                              ((!gmailBuiltIn || gmailOwnClient) && (!gcalClientId.trim() || !gcalClientSecret.trim()))
                            }
                          >
                            {gmailConnecting ? 'Connecting…' : gmailConnected ? 'Reconnect' : 'Connect Gmail'}
                          </button>
                          {gmailMessage && <span className="ou-settings-msg">{gmailMessage}</span>}
                        </div>
                        {gmailBuiltIn && (
                          <button type="button" className="ou-settings-link" onClick={() => setGmailOwnClient((v) => !v)}>
                            {gmailOwnClient ? 'Use Splen’s Google sign-in instead' : 'Use my own Google Cloud client instead'}
                          </button>
                        )}
                      </ChannelRow>

                      {/* Telegram: a bot the user owns. Guided, and the token is
                          checked with Telegram before it is saved, so a typo fails
                          here and not mid-task. */}
                      <ChannelRow
                        name="Telegram"
                        sub="Through a bot you own"
                        Icon={Send}
                        status={telegramBot ? `Connected as @${telegramBot}` : telegramStored ? 'Token saved' : 'Not connected'}
                        ok={Boolean(telegramBot || telegramStored)}
                        open={openChannel === 'telegram'}
                        onToggle={() => toggleChannel('telegram')}
                      >
                        <ol className="ou-settings-steps">
                          <li>
                            Open{' '}
                            <button type="button" className="ou-settings-link" onClick={() => window.open('https://t.me/BotFather', '_blank', 'noopener,noreferrer')}>
                              @BotFather
                            </button>{' '}
                            in Telegram.
                          </li>
                          <li>
                            Send <code>/newbot</code>, choose a name, and copy the token it sends back.
                          </li>
                          <li>Paste the token here and click Connect.</li>
                        </ol>
                        <input
                          type="password"
                          className="ou-settings-input"
                          value={telegramToken}
                          onChange={(e) => {
                            setTelegramToken(e.target.value)
                            setTelegramBot(null)
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void connectTelegram()
                          }}
                          placeholder="123456789:AA…"
                          aria-label="Telegram bot token"
                          autoComplete="off"
                          spellCheck={false}
                        />
                        <div className="ou-settings-btnrow">
                          <button
                            type="button"
                            className="ou-settings-btn"
                            onClick={() => void connectTelegram()}
                            disabled={telegramBusy || !telegramToken.trim()}
                          >
                            {telegramBusy ? 'Checking…' : telegramBot ? 'Reconnect' : 'Connect'}
                          </button>
                          {telegramMessage && <span className="ou-settings-msg">{telegramMessage}</span>}
                        </div>
                        {telegramBot && (
                          <p className="ou-set-row-desc" data-testid="telegram-next">
                            Last step:{' '}
                            <button
                              type="button"
                              className="ou-settings-link"
                              onClick={() => window.open(`https://t.me/${telegramBot}`, '_blank', 'noopener,noreferrer')}
                            >
                              open @{telegramBot}
                            </button>{' '}
                            and press <strong>Start</strong>. Splen can read and answer messages sent to this
                            bot — not your personal Telegram chats.
                          </p>
                        )}
                      </ChannelRow>

                      <ChannelRow
                        name="Slack"
                        sub="Read, search and send messages"
                        Icon={Hash}
                        status={slackStored ? 'Token saved' : 'Not connected'}
                        ok={Boolean(slackStored)}
                        open={openChannel === 'slack'}
                        onToggle={() => toggleChannel('slack')}
                      >
                        <p className="ou-set-row-desc">
                          Create a token at api.slack.com/apps. A bot token (xoxb-) with chat:write,
                          channels:read and channels:history covers most tasks; search needs a user token
                          (xoxp-) with search:read.
                          {slackSaved && <span className="ou-settings-saved"> Saved</span>}
                        </p>
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
                      </ChannelRow>
                    </div>
                  </Group>

                  {/* Unified inbox — ON by default (see isUnifiedInboxEnabled). What
                      keeps it safe is not this switch: every channel reports its own
                      read status, a person-scoped read refuses an unresolved name
                      rather than widening, and every outbound action confirms with
                      the resolved recipients shown. */}
                  <Group title="Across channels">
                    <Row
                      title="Unified inbox"
                      desc="Read every channel in one pass for questions like “what’s my summary?”, and send one message to people across them. Anything outbound shows the exact recipients and asks first."
                    >
                      <Switch on={unifiedInboxEnabled} disabled={false} label="Unified inbox" onClick={toggleUnifiedInbox} />
                    </Row>
                  </Group>
                </>
              )}

              {active === 'keys' &&
                (savedKeys.length === 0 ? (
                  <Empty
                    Icon={KeyRound}
                    title="No keys saved"
                    body="Tokens you add under Channels show up here, so you can copy or remove them."
                    action={{ label: 'Go to Channels', onClick: () => setActive('channels') }}
                  />
                ) : (
                  <Group title="Saved on this computer">
                    <div className="ou-set-card">
                      {savedKeys.map((k) => (
                        <KeyRow key={k.id} label={k.label} hint={k.hint} value={k.value} onRemove={k.remove} />
                      ))}
                    </div>
                  </Group>
                ))}

              {/* Cross-channel memory. Listed in full and individually deletable by
                  design: the feature carries what happened on one channel into a
                  reply on another, and that is only acceptable if the user can see
                  every line of it. Nothing here writes memory — the agent loop is
                  the sole writer (channelMemory.ts). */}
              {active === 'memory' &&
                (memoriesState === 'loading' ? (
                  <Group title="Remembered">
                    <div className="ou-set-card ou-set-pad"><Lines count={4} /></div>
                  </Group>
                ) : memoriesState === 'failed' ? (
                  <div className="ou-set-error" role="alert">
                    Couldn’t read what Splen remembers. Close Settings and open it again.
                  </div>
                ) : memories.length === 0 ? (
                  <Empty
                    Icon={Brain}
                    title="Nothing remembered yet"
                    body="After Splen reads or sends a message, its one-line note appears here."
                  />
                ) : (
                  <>
                    <Group title={`Remembered · ${memories.length}`}>
                      <div className="ou-set-card">
                        {memories.map((m) => (
                          <div className="ou-mem" key={m.id}>
                            <div className="ou-settings-grow">
                              <div className="ou-mem-meta">
                                <span className="ou-mem-channel">{MEMORY_CHANNELS[m.channel] ?? m.channel}</span>
                                <span className="ou-mem-subject">{m.subject_label}</span>
                                <span className="ou-mem-age">{memoryAge(m.created_at)}</span>
                              </div>
                              <div className="ou-mem-text">{m.summary}</div>
                            </div>
                            <button
                              type="button"
                              className="ou-set-ghost"
                              onClick={() => forgetMemory(m.id)}
                              aria-label={`Forget: ${m.summary}`}
                              title="Forget this"
                            >
                              Forget
                            </button>
                          </div>
                        ))}
                      </div>
                    </Group>

                    <Group title="Forget in bulk">
                      <div className="ou-set-chips">
                        {/* Per-subject clear: "stop remembering this person" is a
                            more common intent than clearing the whole store. */}
                        {[...new Map(memories.map((m) => [m.subject_key, m.subject_label])).entries()]
                          .slice(0, 6)
                          .map(([key, label]) => (
                            <button
                              key={key}
                              type="button"
                              className="ou-set-ghost bordered"
                              onClick={() => forgetSubject(key)}
                              title={`Forget everything stored about ${label}`}
                            >
                              Forget all: {label}
                            </button>
                          ))}
                        <button
                          type="button"
                          className={`ou-set-ghost bordered${memoryConfirmClear ? ' danger' : ''}`}
                          onClick={forgetAllMemories}
                          onBlur={() => setMemoryConfirmClear(false)}
                        >
                          {memoryConfirmClear ? 'Click again to confirm' : 'Forget everything'}
                        </button>
                      </div>
                    </Group>
                  </>
                ))}

              {active === 'usage' &&
                (usage === 'loading' ? (
                  <Group title="Last 30 days">
                    <div className="ou-set-card ou-set-pad"><Lines count={3} /></div>
                  </Group>
                ) : usage === 'failed' ? (
                  <div className="ou-set-error" role="alert">
                    Couldn’t read usage on this computer. Close Settings and open it again.
                  </div>
                ) : (
                  <UsagePanel today={usage.today} summary={usage.summary} />
                ))}

              {active === 'privacy' && (
                <>
                  {/* How autonomous the agent is when carrying out tasks */}
                  <Group title="Approvals">
                    <div className="ou-set-card" role="radiogroup" aria-label="Approvals">
                      {AUTONOMY_OPTIONS.map((opt) => (
                        <button
                          key={opt.value}
                          type="button"
                          role="radio"
                          aria-checked={autonomy === opt.value}
                          className={`ou-set-option${autonomy === opt.value ? ' on' : ''}`}
                          onClick={() => chooseAutonomy(opt.value)}
                        >
                          <span className="ou-set-radio" aria-hidden="true" />
                          <span className="ou-settings-grow">
                            <span className="ou-set-row-title">{opt.label}</span>
                            <span className="ou-set-row-desc">{opt.hint}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                  </Group>

                  <Group title="Analytics">
                    <Row
                      title="Anonymous usage analytics"
                      desc="Help improve Splen by sharing anonymous usage counts. Your messages are never included."
                    >
                      <Switch on={enabled} disabled={busy} label="Anonymous usage analytics" onClick={() => void toggle()} />
                    </Row>
                  </Group>
                </>
              )}

              {active === 'advanced' && (
                <>
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

        {/* Not part of the Splen texting product; kept behind SHOW_EXTRA_SETTINGS. */}
        {SHOW_EXTRA_SETTINGS && (
          <>
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

        {/* Integrations: Google Calendar (dedicated OAuth for invites + Meet links) */}
        <div className="ou-settings-section">
          <div className="ou-settings-headrow">
            <div className="ou-settings-label">Google Calendar</div>
            <span className={`ou-settings-status${gcalConnected ? ' ok' : ''}`}>
              {gcalConnected ? 'Connected' : 'Not connected'}
            </span>
          </div>
          <div className="ou-settings-desc" style={{ marginBottom: 8 }}>
            Lets OpenUI email calendar invites and attach Google Meet links. Uses the same Google
            OAuth Client ID and Secret entered under Gmail (enable the Google Calendar API on that
            project), then click Connect.
          </div>
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
            ID and Secret entered under Gmail (enable the Drive API on that same
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
          </>
        )}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/** A titled block of settings. Bare children are wrapped in the bordered card. */
function Group({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="ou-set-group">
      <h3 className="ou-set-group-title">{title}</h3>
      {isValidElement(children) && children.type === Row ? <div className="ou-set-card">{children}</div> : children}
    </section>
  )
}

/** One setting: what it is on the left, its control on the right. */
function Row({ title, desc, children }: { title: string; desc: string; children: ReactNode }): JSX.Element {
  return (
    <div className="ou-set-row">
      <div className="ou-settings-grow">
        <div className="ou-set-row-title">{title}</div>
        <div className="ou-set-row-desc">{desc}</div>
      </div>
      {children}
    </div>
  )
}

/** Placeholder lines while something is loading. */
function Lines({ count }: { count: number }): JSX.Element {
  return (
    <div className="ou-sp-skeleton" aria-hidden="true" data-testid="settings-loading">
      {Array.from({ length: count }, (_, i) => (
        <span key={i} style={{ width: `${[88, 64, 76, 52][i % 4]}%` }} />
      ))}
    </div>
  )
}

function Empty({
  Icon,
  title,
  body,
  action
}: {
  Icon: LucideIcon
  title: string
  body: string
  action?: { label: string; onClick: () => void }
}): JSX.Element {
  return (
    <div className="ou-set-empty">
      <Icon size={20} strokeWidth={1.5} aria-hidden="true" />
      <div className="ou-set-empty-title">{title}</div>
      <p className="ou-set-empty-body">{body}</p>
      {action && (
        <button type="button" className="ou-set-ghost bordered" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  )
}

/** A channel: a row that opens to show how to set it up. */
function ChannelRow({
  name,
  sub,
  Icon,
  status,
  ok,
  open,
  onToggle,
  children
}: {
  name: string
  sub: string
  Icon: LucideIcon
  status: string
  ok?: boolean
  open: boolean
  onToggle: () => void
  children: ReactNode
}): JSX.Element {
  return (
    <div className={`ou-ch${open ? ' open' : ''}`}>
      <button type="button" className="ou-ch-head" aria-expanded={open} onClick={onToggle}>
        <Icon className="ou-ch-icon" size={17} strokeWidth={1.75} aria-hidden="true" />
        <span className="ou-settings-grow">
          <span className="ou-set-row-title">{name}</span>
          <span className="ou-set-row-desc">{sub}</span>
        </span>
        <span className={`ou-ch-status${ok ? ' ok' : ''}`}>
          <i aria-hidden="true" />
          {status}
        </span>
        <ChevronDown className="ou-ch-chevron" size={16} strokeWidth={1.75} aria-hidden="true" />
      </button>
      <div className="ou-ch-body">
        <div className="ou-ch-clip">
          <div className="ou-ch-inner">{children}</div>
        </div>
      </div>
    </div>
  )
}

/** The start of a key and a mask: enough to recognise it, not enough to use it. */
function maskKey(value: string): string {
  const v = value.trim()
  return `${v.slice(0, Math.min(5, Math.floor(v.length / 4)))}…••••`
}

/** A saved key: masked, copyable, removable in two clicks. */
function KeyRow({
  label,
  hint,
  value,
  onRemove
}: {
  label: string
  hint: string
  value: string
  onRemove: () => void
}): JSX.Element {
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [confirming, setConfirming] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])

  const copyKey = (): void => {
    const show = (state: 'copied' | 'failed'): void => {
      setCopy(state)
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setCopy('idle'), 1500)
    }
    navigator.clipboard.writeText(value.trim()).then(
      () => show('copied'),
      () => show('failed')
    )
  }

  return (
    <div className="ou-key">
      <div className="ou-settings-grow">
        <div className="ou-set-row-title">{label}</div>
        <code className="ou-key-value">{maskKey(value)}</code>
        <div className="ou-set-row-desc">{hint}</div>
      </div>
      <span className="ou-key-copy">
        <button type="button" className="ou-set-ghost bordered" onClick={copyKey} aria-label={`Copy ${label}`}>
          {copy === 'copied' ? <Check size={14} strokeWidth={2} aria-hidden="true" /> : <Copy size={14} strokeWidth={1.75} aria-hidden="true" />}
          Copy
        </button>
        {copy !== 'idle' && (
          <span className="ou-key-tip" role="status">
            {copy === 'copied' ? 'Copied' : 'Couldn’t copy'}
          </span>
        )}
      </span>
      <button
        type="button"
        className={`ou-set-ghost bordered${confirming ? ' danger' : ''}`}
        aria-label={confirming ? `Confirm removing ${label}` : `Remove ${label}`}
        onBlur={() => setConfirming(false)}
        onClick={() => {
          if (confirming) onRemove()
          else setConfirming(true)
        }}
      >
        {confirming ? 'Click to confirm' : 'Remove'}
      </button>
    </div>
  )
}

/**
 * How Splen has been used, from the local usage meter. There is no token budget
 * to show: while the app is free the only honest ratio is days used out of the
 * window. When plans are on, the bar becomes today's messages against the limit.
 */
function UsagePanel({ today, summary }: UsageData): JSX.Element {
  const limited = !today.unlimited && today.limit !== null
  const value = limited ? today.used : summary.activeDays
  const max = limited ? (today.limit as number) : summary.windowDays
  const percent = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0
  return (
    <>
      <Group title={limited ? 'Today' : `Last ${summary.windowDays} days`}>
        <div className="ou-set-card ou-set-pad">
          <div className="ou-usage-head">
            <span className="ou-usage-num">{value}</span>
            <span className="ou-usage-of">{limited ? `of ${max} messages today` : `of ${max} days active`}</span>
          </div>
          <div
            className="ou-usage-bar"
            role="progressbar"
            aria-label={limited ? 'Messages used today' : 'Days active'}
            aria-valuenow={value}
            aria-valuemin={0}
            aria-valuemax={max}
          >
            <div style={{ width: `${percent}%` }} />
          </div>
          {summary.totalMessages === 0 && (
            <p className="ou-set-row-desc">Nothing yet. Send Splen a message and it shows up here.</p>
          )}
        </div>
      </Group>

      <Group title="Activity">
        <dl className="ou-usage-stats">
          <div>
            <dt>Today</dt>
            <dd>{today.used}</dd>
          </div>
          <div>
            <dt>Last {summary.windowDays} days</dt>
            <dd>{summary.totalMessages}</dd>
          </div>
          <div>
            <dt>Day streak</dt>
            <dd>{summary.currentStreak}</dd>
          </div>
        </dl>
      </Group>

      {today.unlimited && (
        <Group title="Plan">
          <Row title="Unlimited messages" desc="Splen is free to use as much as you like during the beta.">
            <span className="ou-settings-status ok">Free</span>
          </Row>
        </Group>
      )}
    </>
  )
}

/** A mechanical toggle: the thumb slides, the track lights up gold. */
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
