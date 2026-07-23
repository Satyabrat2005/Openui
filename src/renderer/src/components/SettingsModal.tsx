import { useEffect, useState } from 'react'
import type { AutonomyLevel, ConsentStatus } from '../env'
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
  // GitHub personal access token — read by the main-process GitHub tools when
  // the GITHUB_TOKEN env var is absent (the normal case for end users).
  const [githubToken, setGithubToken] = useState('')
  const [githubSaved, setGithubSaved] = useState(false)
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
            Paste a personal access token to let OpenUI review your Figma designs. Create one at
            figma.com → Settings → Security → Personal access tokens. Stored locally on this device.
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
