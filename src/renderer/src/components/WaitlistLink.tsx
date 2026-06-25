import { useState } from 'react'
import { useAuth } from '../context/AuthContext'

/**
 * A compact "Join the waitlist" control for the desktop app. Clicking the link
 * reveals an email field (pre-filled from the signed-in user) and posts to the
 * waitlist Edge Function via `window.openui.joinWaitlist`. Mirrors the website's
 * states: loading, success, already-subscribed, error.
 */
export default function WaitlistLink(): JSX.Element {
  const { user } = useAuth()
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState(user?.email ?? '')
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'info' | 'error'>('idle')
  const [message, setMessage] = useState('')

  const joined = status === 'success'

  async function submit(): Promise<void> {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setStatus('error')
      setMessage('Please enter a valid email address.')
      return
    }
    setStatus('loading')
    setMessage('')
    const result = await window.openui.joinWaitlist(email)
    if (result.ok && result.alreadySubscribed) {
      setStatus('info')
      setMessage("You're already on the waitlist!")
    } else if (result.ok) {
      setStatus('success')
      setMessage("You're on the list! We'll notify you when Pro launches.")
    } else {
      setStatus('error')
      setMessage('Something went wrong. Please try again.')
    }
  }

  const msgColor =
    status === 'success' ? '#1f9d4d' : status === 'error' ? '#e0352b' : '#8e8e93'

  if (!open) {
    return (
      <div style={{ textAlign: 'center', marginBottom: 12 }}>
        <button
          onClick={() => setOpen(true)}
          style={{
            background: 'none',
            border: 'none',
            padding: 0,
            fontSize: 12,
            color: '#7c3aed',
            cursor: 'pointer',
            fontFamily: '-apple-system, sans-serif',
            textDecoration: 'underline'
          }}
        >
          Not ready to upgrade? Join the waitlist →
        </button>
      </div>
    )
  }

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={joined || status === 'loading'}
          placeholder="you@example.com"
          aria-label="Email address"
          style={{
            flex: 1,
            minWidth: 0,
            height: 34,
            padding: '0 10px',
            fontSize: 12.5,
            border: '1.5px solid #e5e5ea',
            borderRadius: 8,
            outline: 'none',
            fontFamily: '-apple-system, sans-serif'
          }}
        />
        <button
          onClick={() => void submit()}
          disabled={joined || status === 'loading'}
          style={{
            flexShrink: 0,
            height: 34,
            padding: '0 14px',
            borderRadius: 8,
            border: 'none',
            background: joined ? '#34c759' : '#7c3aed',
            color: '#fff',
            fontSize: 12,
            fontWeight: 600,
            cursor: joined || status === 'loading' ? 'default' : 'pointer',
            opacity: status === 'loading' ? 0.6 : 1,
            fontFamily: '-apple-system, sans-serif',
            whiteSpace: 'nowrap'
          }}
        >
          {joined ? 'Joined!' : status === 'loading' ? 'Joining…' : 'Notify Me'}
        </button>
      </div>
      {message && (
        <div style={{ fontSize: 11, color: msgColor, marginTop: 6, textAlign: 'center' }}>
          {message}
        </div>
      )}
    </div>
  )
}
