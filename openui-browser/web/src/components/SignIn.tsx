// Sign-in — NEW design surface (the desktop README lists sign-in under "Not yet
// designed", and RunConsole.tsx has no equivalent). Deliberately built ONLY from
// the existing Run Console tokens (--ou-accent, --ou-bg-*, --ou-font-*, radii)
// so it reads as the same product, not a different visual language. Nothing here
// is lifted from a verified desktop screen — it is new, and flagged as such.
import { useState } from 'react'
import { setToken } from '../api'

export default function SignIn({ onSignedIn }: { onSignedIn: () => void }): JSX.Element {
  const [value, setValue] = useState('dev:me')
  const submit = (): void => {
    setToken(value.trim() || 'dev:me')
    onSignedIn()
  }
  return (
    <div className="ou-signin">
      <div className="ou-signin-card">
        <div className="ou-signin-brand">
          <span className="ou-signin-mark" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 14 14"><path d="M2 6.2l2.6 2.6L10 3" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </span>
          <span className="ou-signin-name">OpenUI</span>
        </div>
        <h1 className="ou-signin-title">Sign in to run</h1>
        <p className="ou-signin-sub">Use your OpenUI account — the same login as the desktop app. In dev mode, enter <code>dev:me</code>.</p>
        <label className="ou-signin-label">Access token</label>
        <input
          className="ou-signin-input"
          value={value}
          placeholder="Supabase access token or dev:me"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
          autoFocus
        />
        <button type="button" className="ou-signin-btn" onClick={submit}>Continue</button>
        <p className="ou-signin-foot">Runs in your browser · no install</p>
      </div>
    </div>
  )
}
