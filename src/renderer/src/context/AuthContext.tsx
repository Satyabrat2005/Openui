import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { User, Tier, TierUpgradePayload } from '../env'
import TierUpgradeModal from '../components/TierUpgradeModal'

/**
 * Whether the app has a REGISTERED account signed in.
 *
 * `loading` is a distinct state on purpose: the answer comes from the main
 * process over IPC, and rendering "signed out" for one frame while that call is
 * in flight would flash the sign-in screen at an already-signed-in user on every
 * launch.
 */
export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated'

interface AuthContextValue {
  user: User | null
  tier: Tier
  isAnonymous: boolean
  /** Drives the gate in App.tsx — see AuthGate. */
  status: AuthStatus
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  tier: 'free',
  isAnonymous: true,
  status: 'loading',
  signOut: async () => {}
})

// ── Payments temporarily disabled for the demo ────────────────────────────────
// Pro-tier billing is paused while we run demo testing (revisiting in a few
// months). The Stripe checkout flow (src/main/stripe/checkout.ts) and the
// TierUpgradeModal component are kept intact but not surfaced: we ignore the
// "tier-upgrade-needed" nudge so the payment/upgrade UI never appears. Flip this
// back to `true` to restore the upgrade modal when we resume pro-tier work.
const PAYMENTS_ENABLED: boolean = false

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [user, setUser] = useState<User | null>(null)
  const [status, setStatus] = useState<AuthStatus>('loading')
  const [upgradePayload, setUpgradePayload] = useState<TierUpgradePayload | null>(null)

  useEffect(() => {
    // Resolve the gate from the main process, which is the only place a session
    // lives. `hasAccountSession` is authoritative: it is false for an anonymous
    // session and false for one whose token has expired beyond refresh.
    let cancelled = false
    window.openui
      .hasAccountSession()
      .then((has) => {
        if (!cancelled) setStatus(has ? 'authenticated' : 'unauthenticated')
      })
      // A failed status check must fail CLOSED — the sign-in screen is the safe
      // thing to show when we can't prove there is a session.
      .catch(() => {
        if (!cancelled) setStatus('unauthenticated')
      })

    // getUser returns AuthUser (display_name); map to our User shape.
    window.openui.getUser().then((u) => {
      if (cancelled || !u) return
      setUser({ id: u.id, email: u.email, name: u.display_name, avatar_url: u.avatar_url, tier: (u.tier as Tier) ?? 'free' })
    })

    const unsubs = [
      window.openui.onAuthSuccess((u) => {
        setUser({ id: u.id, email: u.email, name: u.display_name, avatar_url: u.avatar_url, tier: (u.tier as Tier) ?? 'free' })
        // Only a session with a real email is a registered account; an
        // email-less profile is a guest and must not open the gate.
        setStatus(u.email ? 'authenticated' : 'unauthenticated')
      }),
      window.openui.onAuthLogout(() => {
        setUser(null)
        setStatus('unauthenticated')
      }),
      window.openui.onTierChanged((tier) => {
        setUser((prev) => (prev ? { ...prev, tier } : prev))
      }),
      // Only surface the upgrade modal while payments are enabled (see above).
      ...(PAYMENTS_ENABLED
        ? [window.openui.onTierUpgradeNeeded((payload) => setUpgradePayload(payload))]
        : [])
    ]

    return () => {
      cancelled = true
      unsubs.forEach((fn) => fn())
    }
  }, [])

  const tier: Tier = user?.tier ?? 'free'
  // A session without an email is an anonymous/guest session, not an account.
  const isAnonymous = !user || user.id === 'anonymous' || !user.email

  const signOut = async (): Promise<void> => {
    // Clear locally first so the UI drops to the sign-in screen even if the
    // network sign-out is slow; main emits auth-logout as well.
    setUser(null)
    setStatus('unauthenticated')
    try {
      await window.openui.logout()
    } catch {
      /* local state is already signed out */
    }
  }

  return (
    <AuthContext.Provider value={{ user, tier, isAnonymous, status, signOut }}>
      {children}
      {PAYMENTS_ENABLED && upgradePayload && (
        <TierUpgradeModal
          payload={upgradePayload}
          onDismiss={() => setUpgradePayload(null)}
        />
      )}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  return useContext(AuthContext)
}
