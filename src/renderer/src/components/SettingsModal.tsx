import { useEffect, useState } from 'react'
import type { AutonomyLevel, ConsentStatus, WhatsAppAutoReplyConfig } from '../env'
import type { UpdateStatus } from '../hooks/useUpdater'

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

  useEffect(() => {
    let cancelled = false
    window.openui
      .getConsentStatus()
      .then((status) => {
        if (!cancelled) setEnabled(status === 'granted')
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

    const off = window.openui.onConsentUpdated((status: ConsentStatus) => {
      setEnabled(status === 'granted')
    })
    return () => {
      cancelled = true
      off()
    }
  }, [])

  const chooseAutonomy = (value: AutonomyLevel): void => {
    const prev = autonomy
    setAutonomy(value) // optimistic; reverted on failure
    void window.openui.setSetting('autonomy_level', value).catch(() => setAutonomy(prev))
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
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9998,
        background: 'rgba(0, 0, 0, 0.35)'
      }}
      onMouseDown={(e) => {
        // Click outside the card dismisses; clicks inside are stopped below.
        e.stopPropagation()
        onClose()
      }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          background: 'rgba(255, 255, 255, 0.98)',
          backdropFilter: 'blur(20px)',
          borderRadius: 14,
          padding: '22px 24px',
          maxWidth: 380,
          width: '90%',
          maxHeight: '80vh',
          overflowY: 'auto',
          boxShadow: '0 12px 40px rgba(0, 0, 0, 0.22), 0 0 0 0.5px rgba(0,0,0,0.08)',
          fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif'
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 18
          }}
        >
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: '#1c1c1e' }}>Settings</h3>
          <button
            type="button"
            aria-label="Close settings"
            onClick={onClose}
            style={{
              border: 'none',
              background: 'transparent',
              fontSize: 18,
              lineHeight: 1,
              color: '#8e8e93',
              cursor: 'pointer',
              padding: 2
            }}
          >
            ×
          </button>
        </div>

        {/* Privacy: anonymous usage analytics */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: '#1c1c1e' }}>
              Anonymous Usage Analytics
            </div>
            <div style={{ fontSize: 12, color: '#8e8e93', lineHeight: 1.5, marginTop: 3 }}>
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
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 14,
            borderTop: '1px solid rgba(0,0,0,0.06)',
            paddingTop: 14,
            marginTop: 14
          }}
        >
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: '#1c1c1e' }}>AI Improvement</div>
            <div style={{ fontSize: 12, color: '#8e8e93', lineHeight: 1.5, marginTop: 3 }}>
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
        <div
          style={{
            borderTop: '1px solid rgba(0,0,0,0.06)',
            paddingTop: 14,
            marginTop: 14
          }}
        >
          <div style={{ fontSize: 13.5, fontWeight: 600, color: '#1c1c1e' }}>Automation</div>
          <div style={{ fontSize: 12, color: '#8e8e93', lineHeight: 1.5, marginTop: 3, marginBottom: 10 }}>
            How much OpenUI does on its own when running a multi-step task.
          </div>
          <div style={{ display: 'flex', gap: 6, background: '#f2f2f7', borderRadius: 9, padding: 3 }}>
            {AUTONOMY_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => chooseAutonomy(opt.value)}
                style={{
                  flex: 1,
                  border: 'none',
                  borderRadius: 7,
                  padding: '7px 4px',
                  fontSize: 12,
                  fontWeight: 600,
                  fontFamily: 'inherit',
                  cursor: 'pointer',
                  background: autonomy === opt.value ? '#ffffff' : 'transparent',
                  color: autonomy === opt.value ? '#0a84ff' : '#636366',
                  boxShadow: autonomy === opt.value ? '0 1px 3px rgba(0,0,0,0.12)' : 'none',
                  transition: 'background 0.15s ease, color 0.15s ease'
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <div style={{ fontSize: 11.5, color: '#8e8e93', lineHeight: 1.45, marginTop: 8 }}>
            {AUTONOMY_OPTIONS.find((o) => o.value === autonomy)?.hint}
          </div>
        </div>

        {/* Integrations: Figma personal access token */}
        <div
          style={{
            borderTop: '1px solid rgba(0,0,0,0.06)',
            paddingTop: 14,
            marginTop: 14
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: '#1c1c1e' }}>Figma</div>
            {figmaSaved && (
              <span style={{ fontSize: 11, color: '#34c759', fontWeight: 500 }}>Saved</span>
            )}
          </div>
          <div style={{ fontSize: 12, color: '#8e8e93', lineHeight: 1.5, marginTop: 3, marginBottom: 8 }}>
            Paste a personal access token to let OpenUI review your Figma designs, export their
            design tokens, and build frames as code. Create one at figma.com → Settings → Security →
            Personal access tokens. Read-only access is enough. Stored locally on this device.
          </div>
          <input
            type="password"
            value={figmaToken}
            onChange={(e) => setFigmaToken(e.target.value)}
            onBlur={saveFigmaToken}
            placeholder="figd_…"
            aria-label="Figma personal access token"
            autoComplete="off"
            spellCheck={false}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              border: '1px solid rgba(0,0,0,0.12)',
              borderRadius: 8,
              padding: '8px 10px',
              fontSize: 12.5,
              fontFamily: 'inherit',
              color: '#1c1c1e',
              background: '#fff',
              outline: 'none'
            }}
          />
        </div>

        {/* Screen OCR language (free-tier local OCR) */}
        <div
          style={{
            borderTop: '1px solid rgba(0,0,0,0.06)',
            paddingTop: 14,
            marginTop: 14
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: '#1c1c1e' }}>Screen OCR language</div>
            {ocrLangSaved && (
              <span style={{ fontSize: 11, color: '#34c759', fontWeight: 500 }}>Saved</span>
            )}
          </div>
          <div style={{ fontSize: 12, color: '#8e8e93', lineHeight: 1.5, marginTop: 3, marginBottom: 8 }}>
            Language used to read your screen with local OCR (free tier). Pick the language your
            apps are in so non-English text is read correctly; “Auto” follows your system language.
          </div>
          <select
            value={ocrLanguage}
            onChange={(e) => chooseOcrLanguage(e.target.value)}
            aria-label="Screen OCR language"
            style={{
              width: '100%',
              boxSizing: 'border-box',
              border: '1px solid rgba(0,0,0,0.12)',
              borderRadius: 8,
              padding: '8px 10px',
              fontSize: 12.5,
              fontFamily: 'inherit',
              color: '#1c1c1e',
              background: '#fff',
              outline: 'none'
            }}
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
          <div style={{ borderTop: '1px solid rgba(0,0,0,0.06)', paddingTop: 14, marginTop: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: '#1c1c1e' }}>WhatsApp auto-reply</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {waSaved && <span style={{ fontSize: 11, color: '#34c759', fontWeight: 500 }}>Saved</span>}
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: waConfig.enabled ? '#34c759' : '#8e8e93',
                    background: waConfig.enabled ? 'rgba(52,199,89,0.12)' : 'rgba(142,142,147,0.12)',
                    borderRadius: 999,
                    padding: '2px 8px'
                  }}
                >
                  {waConfig.enabled ? 'ON' : 'OFF'}
                </span>
              </div>
            </div>
            <div style={{ fontSize: 12, color: '#8e8e93', lineHeight: 1.5, marginTop: 3, marginBottom: 10 }}>
              When on, OpenUI watches for new WhatsApp messages from the contacts you list below and{' '}
              <strong style={{ color: '#1c1c1e' }}>drafts a suggested reply</strong> for each. It never sends on its
              own — you review every draft and click to send. Nothing runs for anyone not on this list.
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', marginBottom: 12 }}>
              <input type="checkbox" checked={waConfig.enabled} onChange={toggleWaEnabled} />
              <span style={{ fontSize: 12.5, color: '#1c1c1e' }}>
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
                      border: '1px solid rgba(0,0,0,0.08)',
                      borderRadius: 8,
                      padding: '7px 10px',
                      marginBottom: 6
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 600, color: '#1c1c1e' }}>{entry.name}</div>
                      {entry.instruction && (
                        <div style={{ fontSize: 11.5, color: '#8e8e93', lineHeight: 1.4, marginTop: 2 }}>
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
                        color: '#ff3b30',
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
                value={waNewName}
                onChange={(e) => setWaNewName(e.target.value)}
                placeholder="Contact or group name (exactly as in WhatsApp)"
                aria-label="Contact or group name to allow auto-reply drafts for"
                spellCheck={false}
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  border: '1px solid rgba(0,0,0,0.12)',
                  borderRadius: 8,
                  padding: '8px 10px',
                  fontSize: 12.5,
                  fontFamily: 'inherit',
                  color: '#1c1c1e',
                  background: '#fff',
                  outline: 'none'
                }}
              />
              <input
                type="text"
                value={waNewInstruction}
                onChange={(e) => setWaNewInstruction(e.target.value)}
                placeholder="Optional instruction, e.g. “reply as if I'm busy, keep it short”"
                aria-label="Optional per-contact reply instruction"
                spellCheck={false}
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  border: '1px solid rgba(0,0,0,0.12)',
                  borderRadius: 8,
                  padding: '8px 10px',
                  fontSize: 12.5,
                  fontFamily: 'inherit',
                  color: '#1c1c1e',
                  background: '#fff',
                  outline: 'none'
                }}
              />
              <button
                onClick={addWaContact}
                disabled={!waNewName.trim()}
                style={{
                  alignSelf: 'flex-start',
                  border: '1px solid rgba(0,0,0,0.12)',
                  borderRadius: 8,
                  padding: '7px 14px',
                  fontSize: 12.5,
                  fontWeight: 600,
                  color: waNewName.trim() ? '#1c1c1e' : '#c7c7cc',
                  background: '#fff',
                  cursor: waNewName.trim() ? 'pointer' : 'default'
                }}
              >
                Add to allowlist
              </button>
            </div>
          </div>
        )}

        {/* Cloud AI: bring-your-own-key frontier model (opt-in). Hidden for the
            Ollama-only launch; see CLOUD_TIER_ENABLED above. */}
        {CLOUD_TIER_ENABLED && (
        <div
          style={{
            borderTop: '1px solid rgba(0,0,0,0.06)',
            paddingTop: 14,
            marginTop: 14
          }}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: '#1c1c1e' }}>Cloud AI</div>
              <div style={{ fontSize: 12, color: '#8e8e93', lineHeight: 1.5, marginTop: 3 }}>
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
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 }}>
            <div style={{ fontSize: 12.5, fontWeight: 500, color: '#1c1c1e' }}>Anthropic API key</div>
            {anthropicSaved && (
              <span style={{ fontSize: 11, color: '#34c759', fontWeight: 500 }}>Saved</span>
            )}
          </div>
          <div style={{ fontSize: 12, color: '#8e8e93', lineHeight: 1.5, marginTop: 3, marginBottom: 8 }}>
            Get one at console.anthropic.com → API keys. Stored locally on this device; the toggle
            above stays off until a key is saved.
          </div>
          <input
            type="password"
            value={anthropicKey}
            onChange={(e) => setAnthropicKey(e.target.value)}
            onBlur={saveAnthropicKey}
            placeholder="sk-ant-…"
            aria-label="Anthropic API key"
            autoComplete="off"
            spellCheck={false}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              border: '1px solid rgba(0,0,0,0.12)',
              borderRadius: 8,
              padding: '8px 10px',
              fontSize: 12.5,
              fontFamily: 'inherit',
              color: '#1c1c1e',
              background: '#fff',
              outline: 'none'
            }}
          />
        </div>
        )}

        {/* Integrations: GitHub personal access token */}
        <div
          style={{
            borderTop: '1px solid rgba(0,0,0,0.06)',
            paddingTop: 14,
            marginTop: 14
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: '#1c1c1e' }}>GitHub</div>
            {githubSaved && (
              <span style={{ fontSize: 11, color: '#34c759', fontWeight: 500 }}>Saved</span>
            )}
          </div>
          <div style={{ fontSize: 12, color: '#8e8e93', lineHeight: 1.5, marginTop: 3, marginBottom: 8 }}>
            Paste a personal access token with &quot;repo&quot; scope to let OpenUI create repos,
            push code, and open pull requests for you. Create one at github.com → Settings →
            Developer settings → Personal access tokens. Stored locally on this device.
          </div>
          <input
            type="password"
            value={githubToken}
            onChange={(e) => setGithubToken(e.target.value)}
            onBlur={saveGithubToken}
            placeholder="ghp_…"
            aria-label="GitHub personal access token"
            autoComplete="off"
            spellCheck={false}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              border: '1px solid rgba(0,0,0,0.12)',
              borderRadius: 8,
              padding: '8px 10px',
              fontSize: 12.5,
              fontFamily: 'inherit',
              color: '#1c1c1e',
              background: '#fff',
              outline: 'none'
            }}
          />
        </div>

        {/* Integrations: Slack bot/user token */}
        <div
          style={{
            borderTop: '1px solid rgba(0,0,0,0.06)',
            paddingTop: 14,
            marginTop: 14
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: '#1c1c1e' }}>Slack</div>
            {slackSaved && (
              <span style={{ fontSize: 11, color: '#34c759', fontWeight: 500 }}>Saved</span>
            )}
          </div>
          <div style={{ fontSize: 12, color: '#8e8e93', lineHeight: 1.5, marginTop: 3, marginBottom: 8 }}>
            Paste a Slack token to let OpenUI send, read, and search Slack messages. A bot token
            (xoxb-) with chat:write, channels:read and channels:history covers most tasks; search
            needs a user token (xoxp-) with search:read. Create one at api.slack.com/apps. Stored
            locally on this device.
          </div>
          <input
            type="password"
            value={slackToken}
            onChange={(e) => setSlackToken(e.target.value)}
            onBlur={saveSlackToken}
            placeholder="xoxb-…"
            aria-label="Slack token"
            autoComplete="off"
            spellCheck={false}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              border: '1px solid rgba(0,0,0,0.12)',
              borderRadius: 8,
              padding: '8px 10px',
              fontSize: 12.5,
              fontFamily: 'inherit',
              color: '#1c1c1e',
              background: '#fff',
              outline: 'none'
            }}
          />
        </div>

        {/* Integrations: Google Calendar (dedicated OAuth for invites + Meet links) */}
        <div style={{ borderTop: '1px solid rgba(0,0,0,0.06)', paddingTop: 14, marginTop: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: '#1c1c1e' }}>Google Calendar</div>
            <span
              style={{
                fontSize: 11,
                color: gcalConnected ? '#34c759' : '#8e8e93',
                fontWeight: 500
              }}
            >
              {gcalConnected ? 'Connected' : 'Not connected'}
            </span>
          </div>
          <div style={{ fontSize: 12, color: '#8e8e93', lineHeight: 1.5, marginTop: 3, marginBottom: 8 }}>
            Lets OpenUI email calendar invites and attach Google Meet links. Create an OAuth
            &quot;Desktop app&quot; client at console.cloud.google.com (enable the Google Calendar API),
            paste its Client ID and Secret below, then click Connect. Stored locally on this device.
          </div>
          <input
            type="password"
            value={gcalClientId}
            onChange={(e) => setGcalClientId(e.target.value)}
            onBlur={saveGcalClientId}
            placeholder="Client ID (…apps.googleusercontent.com)"
            aria-label="Google OAuth client ID"
            autoComplete="off"
            spellCheck={false}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              border: '1px solid rgba(0,0,0,0.12)',
              borderRadius: 8,
              padding: '8px 10px',
              fontSize: 12.5,
              fontFamily: 'inherit',
              color: '#1c1c1e',
              background: '#fff',
              outline: 'none',
              marginBottom: 6
            }}
          />
          <input
            type="password"
            value={gcalClientSecret}
            onChange={(e) => setGcalClientSecret(e.target.value)}
            onBlur={saveGcalClientSecret}
            placeholder="Client Secret"
            aria-label="Google OAuth client secret"
            autoComplete="off"
            spellCheck={false}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              border: '1px solid rgba(0,0,0,0.12)',
              borderRadius: 8,
              padding: '8px 10px',
              fontSize: 12.5,
              fontFamily: 'inherit',
              color: '#1c1c1e',
              background: '#fff',
              outline: 'none'
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
            <button
              type="button"
              onClick={() => void connectGoogleCalendar()}
              disabled={gcalConnecting || !gcalClientId.trim() || !gcalClientSecret.trim()}
              style={{
                fontSize: 12.5,
                fontWeight: 500,
                color: '#fff',
                background: gcalConnecting ? '#8e8e93' : '#0a84ff',
                border: 'none',
                borderRadius: 8,
                padding: '7px 14px',
                cursor: gcalConnecting ? 'default' : 'pointer'
              }}
            >
              {gcalConnecting ? 'Connecting…' : gcalConnected ? 'Reconnect' : 'Connect'}
            </button>
            {gcalMessage && (
              <span style={{ fontSize: 11, color: '#8e8e93', lineHeight: 1.4 }}>{gcalMessage}</span>
            )}
          </div>
        </div>

        {/* Integrations: Gmail (shares the Calendar OAuth client above, own refresh token) */}
        <div style={{ borderTop: '1px solid rgba(0,0,0,0.06)', paddingTop: 14, marginTop: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: '#1c1c1e' }}>Gmail</div>
            <span
              style={{
                fontSize: 11,
                color: gmailConnected ? '#34c759' : '#8e8e93',
                fontWeight: 500
              }}
            >
              {gmailConnected ? 'Connected' : 'Not connected'}
            </span>
          </div>
          <div style={{ fontSize: 12, color: '#8e8e93', lineHeight: 1.5, marginTop: 3, marginBottom: 8 }}>
            Lets OpenUI send email and follow up on threads. Uses the same Google OAuth Client ID
            and Secret entered above for Google Calendar (enable the Gmail API on that same
            project), just click Connect.
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              type="button"
              onClick={() => void connectGmail()}
              disabled={gmailConnecting || !gcalClientId.trim() || !gcalClientSecret.trim()}
              style={{
                fontSize: 12.5,
                fontWeight: 500,
                color: '#fff',
                background: gmailConnecting ? '#8e8e93' : '#0a84ff',
                border: 'none',
                borderRadius: 8,
                padding: '7px 14px',
                cursor: gmailConnecting ? 'default' : 'pointer'
              }}
            >
              {gmailConnecting ? 'Connecting…' : gmailConnected ? 'Reconnect' : 'Connect'}
            </button>
            {gmailMessage && (
              <span style={{ fontSize: 11, color: '#8e8e93', lineHeight: 1.4 }}>{gmailMessage}</span>
            )}
          </div>
        </div>

        {/* Integrations: Google Drive (shares the Calendar OAuth client above, own refresh token) */}
        <div style={{ borderTop: '1px solid rgba(0,0,0,0.06)', paddingTop: 14, marginTop: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: '#1c1c1e' }}>Google Drive</div>
            <span
              style={{
                fontSize: 11,
                color: driveConnected ? '#34c759' : '#8e8e93',
                fontWeight: 500
              }}
            >
              {driveConnected ? 'Connected' : 'Not connected'}
            </span>
          </div>
          <div style={{ fontSize: 12, color: '#8e8e93', lineHeight: 1.5, marginTop: 3, marginBottom: 8 }}>
            Lets OpenUI upload, download and share files in Drive. Uses the same Google OAuth Client
            ID and Secret entered above for Google Calendar (enable the Drive API on that same
            project). Requests only the narrow drive.file scope — access to files OpenUI creates or
            you open with it, never your whole Drive.
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              type="button"
              onClick={() => void connectGoogleDrive()}
              disabled={driveConnecting || !gcalClientId.trim() || !gcalClientSecret.trim()}
              style={{
                fontSize: 12.5,
                fontWeight: 500,
                color: '#fff',
                background: driveConnecting ? '#8e8e93' : '#0a84ff',
                border: 'none',
                borderRadius: 8,
                padding: '7px 14px',
                cursor: driveConnecting ? 'default' : 'pointer'
              }}
            >
              {driveConnecting ? 'Connecting…' : driveConnected ? 'Reconnect' : 'Connect'}
            </button>
            {driveMessage && (
              <span style={{ fontSize: 11, color: '#8e8e93', lineHeight: 1.4 }}>{driveMessage}</span>
            )}
          </div>
        </div>

        {/* App version & update check */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderTop: '1px solid rgba(0,0,0,0.06)',
            paddingTop: 14,
            marginTop: 14,
          }}
        >
          <div>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: '#1c1c1e' }}>App Version</div>
            <div style={{ fontSize: 12, color: '#8e8e93', marginTop: 2 }}>
              OpenUI{appVersion ? ` v${appVersion}` : ''}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            {updateStatus === 'checking' ? (
              <span style={{ fontSize: 11, color: '#8e8e93' }}>Checking…</span>
            ) : updateStatus === 'latest' ? (
              <span style={{ fontSize: 11, color: '#34c759', fontWeight: 500 }}>Up to date</span>
            ) : updateStatus === 'available' || updateStatus === 'downloaded' ? (
              <span style={{ fontSize: 11, color: '#0a84ff', fontWeight: 500 }}>
                {updateStatus === 'downloaded' ? 'Ready to install' : 'Update available'}
              </span>
            ) : (
              <button
                style={{
                  fontSize: 11,
                  fontWeight: 500,
                  color: '#0a84ff',
                  background: 'none',
                  border: 'none',
                  cursor: onCheckForUpdates ? 'pointer' : 'default',
                  padding: 0,
                }}
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

/** Minimal iOS-style switch. */
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
      style={{
        flexShrink: 0,
        width: 44,
        height: 26,
        borderRadius: 13,
        border: 'none',
        padding: 0,
        position: 'relative',
        cursor: disabled ? 'default' : 'pointer',
        background: on ? '#34c759' : '#e5e5ea',
        transition: 'background 0.18s ease',
        marginTop: 2
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 2,
          left: on ? 20 : 2,
          width: 22,
          height: 22,
          borderRadius: '50%',
          background: 'white',
          boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
          transition: 'left 0.18s ease'
        }}
      />
    </button>
  )
}
