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
        <div className="ou-auth-card">
          <div className="ou-auth-mark" aria-hidden="true" />
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
      <form className="ou-auth-card" onSubmit={(e) => void submit(e)}>
        <div className="ou-auth-mark" aria-hidden="true" />
        <h1 className="ou-auth-title">{registering ? 'Create your account' : 'Sign in to OpenUI'}</h1>
        <p className="ou-auth-sub">
          {registering
            ? 'An account unlocks the assistant and its models. Everything still runs on your machine.'
            : 'Sign in to use the assistant. Everything still runs on your machine.'}
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
          {busy ? 'Working…' : registering ? 'Create account' : 'Sign in'}
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
