import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { User, Tier, TierUpgradePayload } from '../env'
import TierUpgradeModal from '../components/TierUpgradeModal'

interface AuthContextValue {
  user: User | null
  tier: Tier
  isAnonymous: boolean
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  tier: 'free',
  isAnonymous: true
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
  const [upgradePayload, setUpgradePayload] = useState<TierUpgradePayload | null>(null)

  useEffect(() => {
    // Fetch the current user state from main on mount.
    // getUser returns AuthUser (display_name); map to our User shape.
    window.openui.getUser().then((u) => {
      if (u) setUser({ id: u.id, email: u.email, name: u.display_name, avatar_url: u.avatar_url, tier: (u.tier as Tier) ?? 'free' })
    })

    const unsubs = [
      window.openui.onAuthSuccess((u) => {
        setUser({ id: u.id, email: u.email, name: u.display_name, avatar_url: u.avatar_url, tier: (u.tier as Tier) ?? 'free' })
      }),
      window.openui.onAuthLogout(() => setUser(null)),
      window.openui.onTierChanged((tier) => {
        setUser((prev) => (prev ? { ...prev, tier } : prev))
      }),
      // Only surface the upgrade modal while payments are enabled (see above).
      ...(PAYMENTS_ENABLED
        ? [window.openui.onTierUpgradeNeeded((payload) => setUpgradePayload(payload))]
        : [])
    ]

    return () => unsubs.forEach((fn) => fn())
  }, [])

  const tier: Tier = user?.tier ?? 'free'
  // A guest (silent anonymous cloud session) has a real id but no email — treat
  // it as anonymous so we keep nudging an optional Google sign-in, even though
  // the app is already fully usable on the free tier.
  const isAnonymous = !user || user.id === 'anonymous' || !user.email

  return (
    <AuthContext.Provider value={{ user, tier, isAnonymous }}>
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
