// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'

// THE GATE. Access to the model is gated on a registered account, and the whole
// value of that claim rests on one property: with no session, the AI surface is
// not merely disabled — it is never mounted. A disabled-but-present UI would be
// a decorative gate.
//
// These tests assert absence, which is the easiest kind of test to write
// vacuously (a component that fails to render for an unrelated reason passes
// too). The final describe block is the control: it renders the SAME tree with a
// session and proves the gated UI really does appear, so "absent" means gated,
// not broken.

// App.tsx reads window.openui.platform at MODULE scope (to pick the macOS
// title-bar variant), so the bridge has to exist before the import — hence
// vi.hoisted, which runs ahead of it. Each test replaces the object wholesale.
vi.hoisted(() => {
  ;(globalThis as unknown as { window: { openui: unknown } }).window.openui = { platform: 'win32' }
})

// The console itself is heavy and irrelevant here — what matters is whether the
// gate mounts it at all, so it is replaced by a marker.
vi.mock('./components/RunConsole', () => ({
  default: () => <div data-testid="run-console">RUN CONSOLE</div>
}))
vi.mock('./components/onboarding/OnboardingWizard', () => ({
  default: () => <div data-testid="onboarding">ONBOARDING</div>
}))
vi.mock('./components/WhatsAppAutoReplyBanner', () => ({ default: () => null }))
vi.mock('./components/ConsentModal', () => ({ default: () => null }))
vi.mock('./components/ModelManager', () => ({
  default: () => <div data-testid="model-manager">MODEL MANAGER</div>
}))
vi.mock('./hooks/useAssistantAnimations', () => ({ useAssistantAnimations: () => {} }))
vi.mock('./context/TaskActivityContext', async () => {
  const React = await import('react')
  return {
    TaskActivityProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useTaskActivity: () => ({
      tasks: [],
      focusedId: null,
      runningCount: 0,
      waitingCount: 0,
      taskViewActive: false,
      beginTask: vi.fn(),
      focusTask: vi.fn()
    })
  }
})

import App from './App'

vi.mock('./hooks/useOnboarding', () => ({
  useOnboarding: () => ({
    isComplete: true,
    isLoading: false,
    currentStep: 1,
    setCurrentStep: vi.fn(),
    completeOnboarding: vi.fn()
  })
}))

type Openui = Record<string, unknown>

/** Build the window.openui surface App + AuthProvider touch on mount. */
function stubOpenui(over: Partial<Openui> = {}): void {
  ;(window as unknown as { openui: Openui }).openui = {
    platform: 'win32',
    // Auth surface.
    hasAccountSession: vi.fn(() => Promise.resolve(false)),
    getUser: vi.fn(() => Promise.resolve(null)),
    logout: vi.fn(() => Promise.resolve()),
    registerWithEmail: vi.fn(),
    signInWithEmail: vi.fn(),
    onAuthSuccess: vi.fn(() => vi.fn()),
    onAuthLogout: vi.fn(() => vi.fn()),
    onTierChanged: vi.fn(() => vi.fn()),
    onTierUpgradeNeeded: vi.fn(() => vi.fn()),
    // Window chrome.
    isMaximized: vi.fn(() => Promise.resolve(false)),
    onMaximizeChange: vi.fn(() => vi.fn()),
    minimizeWindow: vi.fn(),
    toggleMaximizeWindow: vi.fn(),
    closeWindow: vi.fn(),
    // AppShell subscriptions.
    getSetting: vi.fn(() => Promise.resolve(undefined)),
    getConsentStatus: vi.fn(() => Promise.resolve('granted')),
    onPermissionDenied: vi.fn(() => vi.fn()),
    onHitlRequest: vi.fn(() => vi.fn()),
    onHitlTimeout: vi.fn(() => vi.fn()),
    onPlanRequest: vi.fn(() => vi.fn()),
    respondHitl: vi.fn(),
    respondHitlChoice: vi.fn(),
    respondPlan: vi.fn(),
    ...over
  }
}

beforeEach(() => {
  stubOpenui()
  // AppShell watches the OS colour scheme on mount; jsdom has no matchMedia.
  // (Only the AUTHENTICATED tree reaches this — that it is needed at all is one
  // more sign the gated shell really does not mount when signed out.)
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {}
    })
  })
})
afterEach(cleanup)

describe('no session → no model UI', () => {
  it('renders the sign-in screen and mounts NOTHING that talks to a model', async () => {
    stubOpenui({ hasAccountSession: vi.fn(() => Promise.resolve(false)) })
    render(<App />)

    expect(await screen.findByTestId('auth-screen')).toBeTruthy()
    // The three ways into a model: the console, onboarding (which owns the chat
    // hand-off), and the download control. None may exist in the DOM.
    expect(screen.queryByTestId('run-console')).toBeNull()
    expect(screen.queryByTestId('onboarding')).toBeNull()
    expect(screen.queryByTestId('model-manager')).toBeNull()
  })

  it('fails CLOSED when the session check itself errors', async () => {
    stubOpenui({ hasAccountSession: vi.fn(() => Promise.reject(new Error('ipc down'))) })
    render(<App />)

    expect(await screen.findByTestId('auth-screen')).toBeTruthy()
    expect(screen.queryByTestId('run-console')).toBeNull()
  })

  it('shows the splash, not the sign-in screen, while the check is in flight', async () => {
    // A signed-in user must never see a flash of the sign-in screen at launch.
    stubOpenui({ hasAccountSession: vi.fn(() => new Promise(() => {})) })
    render(<App />)

    await waitFor(() => expect(document.querySelector('.openui-loading')).toBeTruthy())
    expect(screen.queryByTestId('auth-screen')).toBeNull()
    expect(screen.queryByTestId('run-console')).toBeNull()
  })

  it('an expired session that logs out mid-run drops back to the sign-in screen', async () => {
    // The token-refresh loop calls logout() when the refresh token is dead,
    // which emits auth-logout. The app must not stay on a stale authenticated
    // surface.
    let fireLogout: () => void = () => {}
    stubOpenui({
      hasAccountSession: vi.fn(() => Promise.resolve(true)),
      onAuthLogout: vi.fn((cb: () => void) => {
        fireLogout = cb
        return vi.fn()
      })
    })
    render(<App />)
    expect(await screen.findByTestId('run-console')).toBeTruthy()

    fireLogout()

    expect(await screen.findByTestId('auth-screen')).toBeTruthy()
    expect(screen.queryByTestId('run-console')).toBeNull()
  })

  it('an anonymous (email-less) auth-success does NOT open the gate', async () => {
    // ensureGuestSession mints exactly this shape. If it opened the gate, the
    // gate would be satisfiable without anyone registering.
    let fireSuccess: (u: unknown) => void = () => {}
    stubOpenui({
      hasAccountSession: vi.fn(() => Promise.resolve(false)),
      onAuthSuccess: vi.fn((cb: (u: unknown) => void) => {
        fireSuccess = cb
        return vi.fn()
      })
    })
    render(<App />)
    expect(await screen.findByTestId('auth-screen')).toBeTruthy()

    fireSuccess({ id: 'guest-1', email: null, display_name: null, avatar_url: null, tier: 'free' })

    await waitFor(() => expect(screen.queryByTestId('run-console')).toBeNull())
    expect(screen.queryByTestId('auth-screen')).toBeTruthy()
  })
})

describe('control — the same tree WITH a session', () => {
  // Without this, every assertion above would also pass against a component that
  // renders nothing at all. This is the revert-and-confirm-red check, pinned as
  // a permanent test rather than a one-off manual step.
  it('mounts the model UI once a registered account is signed in', async () => {
    stubOpenui({ hasAccountSession: vi.fn(() => Promise.resolve(true)) })
    render(<App />)

    expect(await screen.findByTestId('run-console')).toBeTruthy()
    expect(screen.queryByTestId('auth-screen')).toBeNull()
  })

  it('an email-bearing auth-success opens the gate', async () => {
    let fireSuccess: (u: unknown) => void = () => {}
    stubOpenui({
      hasAccountSession: vi.fn(() => Promise.resolve(false)),
      onAuthSuccess: vi.fn((cb: (u: unknown) => void) => {
        fireSuccess = cb
        return vi.fn()
      })
    })
    render(<App />)
    expect(await screen.findByTestId('auth-screen')).toBeTruthy()

    fireSuccess({ id: 'u1', email: 'rin@example.com', display_name: 'Rin', avatar_url: null, tier: 'free' })

    expect(await screen.findByTestId('run-console')).toBeTruthy()
  })
})
