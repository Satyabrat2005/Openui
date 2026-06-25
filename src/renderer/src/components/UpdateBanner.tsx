import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'

type Phase = 'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'downloaded' | 'error'

/**
 * Auto-update surface for the menu-bar popup.
 *
 * OpenUI has no traditional window toolbar, so update state lives at the foot
 * of the assistant card: a persistent version line with a manual "Check for
 * updates" trigger that expands into a banner as an update is found,
 * downloaded and made ready to install. Every transition is driven by the
 * main-process updater over IPC (see src/main/updater/updater.ts); in
 * development the events never fire because electron-updater is inert outside a
 * packaged build, so this quietly shows just the version line.
 */
export default function UpdateBanner(): JSX.Element {
  const [phase, setPhase] = useState<Phase>('idle')
  const [appVersion, setAppVersion] = useState('')
  const [newVersion, setNewVersion] = useState<string | null>(null)
  const [percent, setPercent] = useState(0)
  const [canAutoUpdate, setCanAutoUpdate] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // True while the user is waiting on a manual "Check for updates" result, so a
  // "no update" / error response gets acknowledged in the UI — background checks
  // that find nothing stay silent. Cleared by whichever result arrives first
  // (or the dev/no-op safety timeout in handleCheck).
  const pendingCheckRef = useRef(false)

  useEffect(() => {
    window.openui.getAppVersion().then(setAppVersion).catch(() => {})

    const offAvailable = window.openui.onUpdateAvailable((info) => {
      pendingCheckRef.current = false
      setNewVersion(info.version)
      setCanAutoUpdate(info.canAutoUpdate)
      setError(null)
      setPhase('available')
    })
    const offNotAvailable = window.openui.onUpdateNotAvailable(() => {
      // Acknowledge "up to date" only when the user asked — a silent background
      // check that finds nothing leaves the footer untouched.
      if (!pendingCheckRef.current) return
      pendingCheckRef.current = false
      setPhase('latest')
    })
    const offProgress = window.openui.onUpdateDownloadProgress((p) => {
      setPercent(Math.round(p.percent))
      setPhase('downloading')
    })
    const offDownloaded = window.openui.onUpdateDownloaded((info) => {
      setNewVersion(info.version)
      setPhase('downloaded')
    })
    const offError = window.openui.onUpdateError((e) => {
      setError(e.message)
      // Surface an error if the user is waiting on a check or is mid-download —
      // never for a background-check network blip.
      if (pendingCheckRef.current) {
        pendingCheckRef.current = false
        setPhase('error')
      } else {
        setPhase((p) => (p === 'available' || p === 'downloading' ? 'error' : p))
      }
    })

    return () => {
      offAvailable()
      offNotAvailable()
      offProgress()
      offDownloaded()
      offError()
    }
  }, [])

  // Auto-clear the transient "up to date" acknowledgement after a few seconds.
  useEffect(() => {
    if (phase !== 'latest') return
    const t = setTimeout(() => setPhase('idle'), 4000)
    return () => clearTimeout(t)
  }, [phase])

  const handleCheck = (): void => {
    setError(null)
    pendingCheckRef.current = true
    setPhase('checking')
    void window.openui.checkForUpdates()
    // Safety net: in development the updater is inert (no event ever fires), and
    // a real check could hang — don't leave the UI stuck on "Checking…".
    window.setTimeout(() => {
      if (!pendingCheckRef.current) return
      pendingCheckRef.current = false
      setPhase((p) => (p === 'checking' ? 'idle' : p))
    }, 6000)
  }

  const handleDownload = (): void => {
    if (canAutoUpdate) {
      setPercent(0)
      setPhase('downloading')
      void window.openui.downloadUpdate()
    } else {
      // Unsigned macOS: hand off to the browser instead of an in-app download.
      void window.openui.openReleasesPage()
    }
  }

  const handleRestart = (): void => {
    void window.openui.installUpdateAndRestart()
  }

  return (
    <div style={{ borderTop: '1px solid rgba(0,0,0,0.06)', paddingTop: 8, marginTop: 4 }}>
      {phase === 'available' && (
        <Banner>
          <span style={msgStyle}>Update available{newVersion ? ` — v${newVersion}` : ''}</span>
          <button style={primaryBtn} onClick={handleDownload}>
            {canAutoUpdate ? 'Download Update' : 'Open Download Page'}
          </button>
        </Banner>
      )}

      {phase === 'downloading' && (
        <Banner>
          <span style={msgStyle}>Downloading… {percent}%</span>
          <div style={progressTrack}>
            <div style={{ ...progressFill, width: `${percent}%` }} />
          </div>
        </Banner>
      )}

      {phase === 'downloaded' && (
        <Banner>
          <span style={msgStyle}>Update ready{newVersion ? ` — v${newVersion}` : ''}</span>
          <button style={primaryBtn} onClick={handleRestart}>
            Restart &amp; Install
          </button>
        </Banner>
      )}

      {phase === 'error' && (
        <Banner>
          <span style={{ ...msgStyle, color: '#ff3b30' }}>
            Update failed{error ? ` — ${error}` : ''}
          </span>
          <button style={linkBtn} onClick={handleCheck}>
            Retry
          </button>
        </Banner>
      )}

      {/* Persistent version + manual-check line. */}
      <div style={footerRow}>
        <span style={mutedStyle}>OpenUI{appVersion ? ` v${appVersion}` : ''}</span>
        {phase === 'checking' ? (
          <span style={mutedStyle}>Checking…</span>
        ) : phase === 'latest' ? (
          <span style={{ ...mutedStyle, color: '#34c759' }}>Up to date</span>
        ) : (
          <button style={linkBtn} onClick={handleCheck}>
            Check for updates
          </button>
        )}
      </div>
    </div>
  )
}

function Banner({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        padding: '4px 2px 8px'
      }}
    >
      {children}
    </div>
  )
}

const msgStyle: CSSProperties = { fontSize: 12, color: '#1c1c1e', fontWeight: 500 }
const mutedStyle: CSSProperties = { fontSize: 11, color: '#aeaeb2' }
const primaryBtn: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: '#fff',
  background: '#0a84ff',
  border: 'none',
  borderRadius: 7,
  padding: '5px 10px',
  cursor: 'pointer',
  flexShrink: 0
}
const linkBtn: CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  color: '#0a84ff',
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  padding: 0
}
const footerRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between'
}
const progressTrack: CSSProperties = {
  flex: 1,
  height: 4,
  background: 'rgba(0,0,0,0.08)',
  borderRadius: 2,
  overflow: 'hidden',
  marginLeft: 8
}
const progressFill: CSSProperties = {
  height: '100%',
  background: '#0a84ff',
  borderRadius: 2,
  transition: 'width 0.2s'
}
