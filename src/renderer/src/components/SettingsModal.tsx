import { useEffect, useState } from 'react'
import type { AutonomyLevel, ConsentStatus } from '../env'
import type { UpdateStatus } from '../hooks/useUpdater'

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

  return (
    <div
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
            Paste a personal access token to let OpenUI review your Figma designs. Create one at
            figma.com → Settings → Security → Personal access tokens. Stored locally on this device.
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
