import { useState, type FormEvent } from 'react'
import type { AuthOutcome } from '../env'

/**
 * The logged-out surface: create an account, or sign in to an existing one.
 *
 * This is the WHOLE app when there is no session — App.tsx renders this instead
 * of the console, so no chat, no run ledger and no model control mounts behind
 * it. That is deliberate: a degraded-but-usable app would make the gate
 * decorative.
 *
 * The password is held in local component state for exactly as long as the form
 * is open, handed to the main process over IPC, and never written anywhere else
 * — no localStorage, no token in the renderer.
 */

const TERMS_URL = 'https://openui.app/terms'
const PRIVACY_URL = 'https://openui.app/privacy'
const MIN_PASSWORD_LENGTH = 8

type Mode = 'signin' | 'register'

/** What Splen is, beside the form: three plain promises, numbered like a spec. */
const POINTS: Array<[string, string]> = [
  ['Reads what you missed', 'WhatsApp, Gmail and Telegram, summarised in one place.'],
  ['Runs on this computer', 'Splen’s model lives on your machine. Your messages never leave it.'],
  ['Never sends on its own', 'Every reply waits for your OK before it goes out.']
]

/** The editorial half of the screen — the same on every auth state. */
function AuthAside(): JSX.Element {
  return (
    <aside className="ou-auth-aside">
      <div className="ou-auth-brand">
        <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true">
          <path
            d="M11 3.5c-1.6 3.4-3.2 8.6-3 13.4.2 5.2 3.4 9.6 8.6 9.6 4.8 0 8.2-3.5 8.2-7.8 0-4.1-3-7-6.8-7-3 0-5.4 1.8-6.4 4.4M11 3.5l3.4 2.6"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span>Splen</span>
      </div>
      <h2 className="ou-auth-headline">
        Your messages,
        <br />
        <em>read for you.</em>
      </h2>
      <ol className="ou-auth-points">
        {POINTS.map(([title, body], i) => (
          <li key={title}>
            <span className="ou-auth-num">{String(i + 1).padStart(2, '0')}</span>
            <span>
              <strong>{title}</strong>
              {body}
            </span>
          </li>
        ))}
      </ol>
    </aside>
  )
}

export default function AuthScreen(): JSX.Element {
  const [mode, setMode] = useState<Mode>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Set when registration succeeded but the project requires email confirmation
  // — the account exists and there is nothing more to do here yet.
  const [confirmSent, setConfirmSent] = useState(false)

  const registering = mode === 'register'

  const switchMode = (next: Mode): void => {
    setMode(next)
    setError(null)
    setConfirmSent(false)
  }

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (busy) return
    setError(null)
    setConfirmSent(false)
    setBusy(true)
    try {
      const result: AuthOutcome = registering
        ? await window.openui.registerWithEmail(email, password)
        : await window.openui.signInWithEmail(email, password)

      if (!result.ok) {
        setError(result.message)
        // A "this email already exists" on the register tab is really a nudge to
        // sign in, so put the user on the tab that can actually succeed.
        if (result.code === 'email_taken') setMode('signin')
        return
      }
      if (result.needsEmailConfirmation) {
        setConfirmSent(true)
        setPassword('')
        return
      }
      // On success the main process emits auth-success; AuthContext flips the
      // gate and this screen unmounts. Nothing to do here.
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  const openExternal = (url: string): void => {
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  if (confirmSent) {
    return (
      <div className="ou-auth" data-testid="auth-screen">
        <AuthAside />
        <div className="ou-auth-card">
          <h1 className="ou-auth-title">Check your email</h1>
          <p className="ou-auth-sub">
            We sent a confirmation link to <strong>{email}</strong>. Open it to finish creating your
            account, then come back and sign in.
          </p>
          <button type="button" className="ou-auth-primary" onClick={() => switchMode('signin')}>
            Back to sign in
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="ou-auth" data-testid="auth-screen">
      <AuthAside />
      <form className="ou-auth-card" onSubmit={(e) => void submit(e)}>
        <h1 className="ou-auth-title">{registering ? 'Create your account' : 'Welcome back'}</h1>
        <p className="ou-auth-sub">
          {registering
            ? 'Your account unlocks Splen and its model. Everything still runs on this computer.'
            : 'Sign in to pick up where you left off — your chats are right where you left them.'}
        </p>

        <div className="ou-auth-tabs" role="tablist" aria-label="Account">
          <button
            type="button"
            role="tab"
            aria-selected={!registering}
            className={`ou-auth-tab${!registering ? ' active' : ''}`}
            onClick={() => switchMode('signin')}
          >
            Sign in
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={registering}
            className={`ou-auth-tab${registering ? ' active' : ''}`}
            onClick={() => switchMode('register')}
          >
            Register
          </button>
        </div>

        <label className="ou-auth-field">
          <span className="ou-auth-label">Email</span>
          <input
            className="ou-auth-input"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            disabled={busy}
          />
        </label>

        <label className="ou-auth-field">
          <span className="ou-auth-label">Password</span>
          <input
            className="ou-auth-input"
            type="password"
            autoComplete={registering ? 'new-password' : 'current-password'}
            required
            minLength={registering ? MIN_PASSWORD_LENGTH : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={registering ? `At least ${MIN_PASSWORD_LENGTH} characters` : '••••••••'}
            disabled={busy}
          />
        </label>

        {error && (
          <p className="ou-auth-error" role="alert">
            {error}
          </p>
        )}

        <button type="submit" className="ou-auth-primary" disabled={busy}>
          {busy ? (registering ? 'Creating your account…' : 'Signing in…') : registering ? 'Create account' : 'Sign in'}
        </button>

        <p className="ou-auth-legal">
          By continuing, you agree to our{' '}
          <button type="button" className="ou-auth-link" onClick={() => openExternal(TERMS_URL)}>
            Terms
          </button>{' '}
          and{' '}
          <button type="button" className="ou-auth-link" onClick={() => openExternal(PRIVACY_URL)}>
            Privacy Policy
          </button>
          .
        </p>
      </form>
    </div>
  )
}
