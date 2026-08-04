// Web port of AuthContext. Same useAuth() surface ({ user, tier, isAnonymous })
// RunConsole consumes; source is GET /api/me (Supabase getUser server-side)
// instead of the window.openui.getUser IPC.
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Tier, User } from '../types'
import { getMe } from '../api'

interface AuthContextValue {
  user: User | null
  tier: Tier
  isAnonymous: boolean
  refresh: () => void
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  tier: 'free',
  isAnonymous: true,
  refresh: () => {}
})

export function WebAuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [user, setUser] = useState<User | null>(null)

  const refresh = (): void => {
    getMe()
      .then((m) => setUser(m.user))
      .catch(() => setUser(null))
  }
  useEffect(refresh, [])

  const tier: Tier = user?.tier ?? 'free'
  const isAnonymous = !user || !user.email
  return <AuthContext.Provider value={{ user, tier, isAnonymous, refresh }}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  return useContext(AuthContext)
}
