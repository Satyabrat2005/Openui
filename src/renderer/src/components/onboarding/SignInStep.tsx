import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../../context/AuthContext'

interface Props {
  /** Called once the user is authenticated; advances the wizard. */
  onAuthed: () => void
}

const TERMS_URL = 'https://openui.app/terms'
const PRIVACY_URL = 'https://openui.app/privacy'

/**
 * Step 2 — optional sign-in. A silent guest session already makes the app fully
 * usable on the free tier, so signing in is an upgrade (syncs plan + preferences
 * across devices), not a gate: "Continue without an account" advances the wizard.
 * The Google button fires the login IPC; we advance as soon as auth succeeds
 * (observed via AuthContext) and surface a friendly message on failure rather
 * than a raw error string.
 *
 * External links are opened with `window.open`, which the main process'
 * window-open handler routes to the OS browser.
 */
export default function SignInStep({ onAuthed }: Props): JSX.Element {
  const { isAnonymous } = useAuth()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const advancedRef = useRef(false)

  // Advance the moment a real user is present — covers both a fresh sign-in and
  // the edge case of arriving here already authenticated. Guarded so it fires
  // exactly once.
  useEffect(() => {
    if (!isAnonymous && !advancedRef.current) {
      advancedRef.current = true
      onAuthed()
    }
  }, [isAnonymous, onAuthed])

  useEffect(() => {
    return window.openui.onAuthError(() => {
      setError("We couldn't sign you in. Please try again.")
      setLoading(false)
    })
  }, [])

  const handleSignIn = async (): Promise<void> => {
    setError(null)
    setLoading(true)
    try {
      const opened = await window.openui.login()
      // `false` means sign-in isn't configured/available; auth-success never
      // arrives, so clear the spinner and tell the user.
      if (!opened) {
        setError('Sign-in is temporarily unavailable. Please try again later.')
        setLoading(false)
      }
      // On success we keep the spinner until auth-success flips isAnonymous and
      // the effect above advances the wizard.
    } catch {
      setError("We couldn't sign you in. Please try again.")
      setLoading(false)
    }
  }

  const openExternal = (url: string): void => {
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  return (
    <div className="ob-signin">
      <h1 className="ob-title" style={{ textAlign: 'center' }}>
        Sign in to get started
      </h1>
      <p className="ob-subtitle" style={{ marginTop: 10, textAlign: 'center', maxWidth: 280 }}>
        Your account syncs your plan and preferences across devices.
      </p>

      <button
        className="ob-btn-google"
        style={{ marginTop: 30 }}
        onClick={handleSignIn}
        disabled={loading}
      >
        {loading ? (
          <span className="ob-spinner" aria-label="Signing in" />
        ) : (
          <>
            <GoogleLogo />
            <span>Sign in with Google</span>
          </>
        )}
      </button>

      {error && <p className="ob-error">{error}</p>}

      <button
        className="ob-link"
        style={{ marginTop: 18, fontSize: 13, opacity: 0.7 }}
        onClick={onAuthed}
      >
        Continue without an account
      </button>

      <p className="ob-legal" style={{ marginTop: error ? 14 : 22 }}>
        By signing in, you agree to our{' '}
        <button className="ob-link" onClick={() => openExternal(TERMS_URL)}>
          Terms
        </button>{' '}
        and{' '}
        <button className="ob-link" onClick={() => openExternal(PRIVACY_URL)}>
          Privacy Policy
        </button>
        .
      </p>
    </div>
  )
}

function GoogleLogo(): JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.34A9 9 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.94H.96a9 9 0 0 0 0 8.12l3.01-2.34z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.94l3.01 2.34C4.68 5.16 6.66 3.58 9 3.58z"
      />
    </svg>
  )
}
