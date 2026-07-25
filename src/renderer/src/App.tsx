import { useCallback, useEffect, useRef, useState } from 'react'
import RunConsole from './components/RunConsole'
import ErrorBoundary from './components/ErrorBoundary'
import PermissionModal from './components/PermissionModal'
import HitlModal from './components/HitlModal'
import PlanApprovalModal from './components/PlanApprovalModal'
import OnboardingWizard from './components/onboarding/OnboardingWizard'
import ConsentModal from './components/ConsentModal'
import WhatsAppAutoReplyBanner from './components/WhatsAppAutoReplyBanner'
import { useAssistantAnimations } from './hooks/useAssistantAnimations'
import { useOnboarding } from './hooks/useOnboarding'
import { applyTheme, coerceThemePref, watchSystemTheme } from './lib/theme'
import { AuthProvider } from './context/AuthContext'
import { TaskActivityProvider, useTaskActivity } from './context/TaskActivityContext'
import type { PermissionTarget, HitlRequestPayload, PlanRequestPayload } from './env'

/** Brief splash shown while the persisted onboarding flag is read. */
function LoadingScreen(): JSX.Element {
  return (
    <div className="openui-loading">
      <div className="openui-loading-orb">
        <div className="openui-loading-dot" />
      </div>
    </div>
  )
}

const isMac = window.openui.platform === 'darwin'

/**
 * Custom window title bar for the frameless window. The empty flex area is a
 * drag region (-webkit-app-region: drag via .ou-titlebar-drag) so the window can
 * be moved; double-clicking it toggles maximize like a native title bar. The
 * minimize / maximize / close buttons are opted OUT of the drag region so they
 * stay clickable. Close hides to the tray (see main process).
 *
 * On macOS the window uses `titleBarStyle: 'hiddenInset'`, so the OS already
 * draws native traffic-light buttons over the top-left of this bar — we skip
 * rendering our own controls there and just reserve space via CSS
 * (.ou-titlebar-mac) so the brand label doesn't sit underneath them.
 */
/** 9px chevron used in the workspace switcher. */
function Chevron(): JSX.Element {
  return (
    <svg className="ou-tb-switcher-chevron" width="9" height="9" viewBox="0 0 9 9" aria-hidden="true">
      <path d="M2 3.4L4.5 5.9L7 3.4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/**
 * The 38px window chrome (handoff § A). Two left-side variants:
 *   • `setup`   — accent mark + "OpenUI" wordmark + mono "SETUP" (First Run).
 *   • `console` — workspace switcher + a live mono counter of running / waiting
 *     runs (sourced from TaskActivityContext, never hardcoded) + a ⌘K search
 *     affordance. The right-side window controls are shared.
 *
 * The minimize / maximize / close IPC and the isMac / hiddenInset handling are
 * unchanged — only the visual chrome differs.
 */
function TitleBar({ variant, onWorkspaceClick }: { variant: 'setup' | 'console'; onWorkspaceClick?: () => void }): JSX.Element {
  const [maximized, setMaximized] = useState(false)
  const { runningCount, waitingCount } = useTaskActivity()

  useEffect(() => {
    window.openui.isMaximized().then(setMaximized).catch(() => {})
    return window.openui.onMaximizeChange(setMaximized)
  }, [])

  return (
    <div className={isMac ? 'ou-titlebar ou-titlebar-mac' : 'ou-titlebar'}>
      {variant === 'setup' ? (
        <div className="ou-tb-setup">
          <div className="ou-tb-mark" aria-hidden="true" />
          <span className="ou-tb-wordmark">OpenUI</span>
          <span className="ou-tb-setup-tag">SETUP</span>
        </div>
      ) : (
        <div className="ou-tb-console">
          {/* Workspace switcher — opens the conversation/workspace history drawer
              (runs + conversations coexist: the ledger shows runs, this browses
              full chat threads by day and resumes them). */}
          <button type="button" className="ou-tb-switcher" aria-label="Switch workspace" title="Workspace & history" onClick={onWorkspaceClick}>
            <div className="ou-tb-mark" aria-hidden="true" />
            <span className="ou-tb-switcher-name">Work</span>
            <Chevron />
          </button>
          <div className="ou-tb-divider" aria-hidden="true" />
          {/* Live run counters — real, from TaskActivityContext. */}
          <div className="ou-tb-counters" aria-live="polite">
            <span className="ou-tb-count-running">{runningCount} running</span>
            {waitingCount > 0 && (
              <>
                <span className="ou-tb-count-sep">/</span>
                <span className="ou-tb-count-waiting">
                  {waitingCount} waiting on you
                </span>
              </>
            )}
          </div>
        </div>
      )}
      <div
        className="ou-titlebar-drag"
        onDoubleClick={isMac ? undefined : () => window.openui.toggleMaximizeWindow()}
      />
      {variant === 'console' && (
        // ⌘K search affordance — a real control, intentionally a no-op for now.
        // TODO: wire to a command palette / run search once that surface exists.
        <button
          type="button"
          className="ou-tb-search"
          aria-label="Search (Cmd K)"
          title="Search"
          onClick={() => {
            /* no-op: search surface not built yet */
          }}
        >
          <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
            <circle cx="4.6" cy="4.6" r="3.1" fill="none" stroke="currentColor" strokeWidth="1.3" />
            <path d="M6.9 6.9L9.4 9.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
          <span className="ou-tb-search-kbd">{isMac ? '⌘K' : 'Ctrl K'}</span>
        </button>
      )}
      {!isMac && (
        <div className="ou-winctl">
          <button
            type="button"
            className="ou-winbtn"
            aria-label="Minimize"
            title="Minimize"
            onClick={() => window.openui.minimizeWindow()}
          >
            <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
              <rect x="1.5" y="5" width="8" height="1.2" fill="currentColor" />
            </svg>
          </button>
          <button
            type="button"
            className="ou-winbtn"
            aria-label={maximized ? 'Restore' : 'Maximize'}
            title={maximized ? 'Restore' : 'Maximize'}
            onClick={() => window.openui.toggleMaximizeWindow()}
          >
            {maximized ? (
              <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
                <rect x="2" y="3.2" width="6" height="6" fill="none" stroke="currentColor" strokeWidth="1.1" />
                <path d="M4 3.2V1.5h5.5V7H7.8" fill="none" stroke="currentColor" strokeWidth="1.1" />
              </svg>
            ) : (
              <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
                <rect x="1.8" y="1.8" width="7.4" height="7.4" fill="none" stroke="currentColor" strokeWidth="1.1" />
              </svg>
            )}
          </button>
          <button
            type="button"
            className="ou-winbtn ou-winbtn-close"
            aria-label="Close"
            title="Close"
            onClick={() => window.openui.closeWindow()}
          >
            <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
              <path d="M2 2l7 7M9 2l-7 7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      )}
    </div>
  )
}

function AppShell(): JSX.Element {
  const overlayRef = useRef<HTMLDivElement>(null)
  const recordingRef = useRef<boolean>(false)
  const captionLockedRef = useRef<boolean>(false)

  const [permissionNeeded, setPermissionNeeded] = useState<PermissionTarget | null>(null)
  const [consentNeeded, setConsentNeeded] = useState(false)
  const [hitlRequest, setHitlRequest] = useState<HitlRequestPayload | null>(null)
  const [planRequest, setPlanRequest] = useState<PlanRequestPayload | null>(null)
  // True while the Run Console is showing the approval INLINE on a visible run
  // row — the blocking modal is then suppressed so there's one approval surface,
  // not two. Falls back to the modal whenever the run isn't visible/focused.
  const [inlineApproval, setInlineApproval] = useState(false)
  // Workspace / conversation-history drawer — opened from the title-bar switcher
  // OR the console's account row (runs + conversations coexist, see RunConsole).
  const [historyOpen, setHistoryOpen] = useState(false)

  const { taskViewActive } = useTaskActivity()
  const { isComplete, isLoading, currentStep, setCurrentStep, completeOnboarding } = useOnboarding()
  // The first message typed in onboarding, replayed once the chat mounts.
  const [initialMessage, setInitialMessage] = useState<string | null>(null)

  const showChat = !isLoading && isComplete
  // Only run the popup entrance choreography once the chat UI is mounted.
  useAssistantAnimations(overlayRef, recordingRef, captionLockedRef, showChat)

  // Apply the persisted theme preference at startup and keep it live with the
  // OS scheme while the preference is 'system'. Dark is the default.
  useEffect(() => {
    const stop = watchSystemTheme()
    window.openui
      .getSetting('theme')
      .then((value) => applyTheme(coerceThemePref(value)))
      .catch(() => {})
    return stop
  }, [])

  useEffect(() => {
    return window.openui.onPermissionDenied((permission) => {
      setPermissionNeeded(permission as PermissionTarget)
    })
  }, [])

  useEffect(() => {
    return window.openui.onHitlRequest((payload) => {
      setHitlRequest(payload)
    })
  }, [])

  // The main process auto-denies unanswered HITL requests (backstop timeout);
  // dismiss the now-stale modal so the demo never shows a dead confirmation.
  useEffect(() => {
    return window.openui.onHitlTimeout(({ id }) => {
      setHitlRequest((current) => (current?.id === id ? null : current))
    })
  }, [])

  useEffect(() => {
    return window.openui.onPlanRequest((payload) => {
      setPlanRequest(payload)
    })
  }, [])

  // First-launch privacy consent: show the prompt only while status is UNKNOWN.
  // "Skip" persists a permanent DENIED, so this never reappears on later launches.
  useEffect(() => {
    let cancelled = false
    window.openui
      .getConsentStatus()
      .then((status) => {
        if (!cancelled && status === 'unknown') setConsentNeeded(true)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  // Escape only dismisses the permission modal now — a real window must not
  // vanish out from under the user the way the old overlay did.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && permissionNeeded) setPermissionNeeded(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [permissionNeeded])

  const handleOnboardingComplete = useCallback(
    (firstMessage: string | null): void => {
      setInitialMessage(firstMessage)
      void completeOnboarding()
    },
    [completeOnboarding]
  )

  // Shared HITL/plan responders — used by BOTH the inline callout and the modal
  // fallback, so approve/deny run the exact same IPC either way (one pipeline).
  const respondHitl = useCallback(
    (approved: boolean): void => {
      if (!hitlRequest) return
      window.openui.respondHitl(hitlRequest.id, approved)
      setHitlRequest(null)
    },
    [hitlRequest]
  )
  const respondPlan = useCallback(
    (approved: boolean): void => {
      if (!planRequest) return
      window.openui.respondPlan(planRequest.id, approved)
      setPlanRequest(null)
    },
    [planRequest]
  )
  // A choice-style HITL (candidate picker) needs the modal's picker UI, so it is
  // never surfaced inline — only plain allow/deny requests are.
  const inlineHitl = hitlRequest && !(hitlRequest.choices && hitlRequest.choices.length > 0) ? hitlRequest : null

  return (
    <div ref={overlayRef} className="openui-overlay">
      {/* Setup chrome during onboarding/loading; console chrome once the app is
          in the working surface (drives the workspace switcher + live counters). */}
      <TitleBar
        variant={showChat ? 'console' : 'setup'}
        onWorkspaceClick={showChat ? () => setHistoryOpen(true) : undefined}
      />
      {/* Always-on WhatsApp auto-reply indicator + kill switch + draft review.
          Self-hides unless the watcher is active or a draft is waiting. */}
      <ErrorBoundary label="WhatsApp auto-reply" compact>
        <WhatsAppAutoReplyBanner />
      </ErrorBoundary>
      <div className={`ou-content${taskViewActive ? ' ou-taskview' : ''}`}>
      {isLoading ? (
        <LoadingScreen />
      ) : !isComplete ? (
        <OnboardingWizard
          onComplete={handleOnboardingComplete}
          initialStep={currentStep}
          onStepChange={setCurrentStep}
        />
      ) : (
        <>
          {/* The three-column Run Console replaces the AssistantPopup + ActivityPanel
              + ConnectedRail layout. It reuses the SAME chat pipeline (beginTask +
              window.openui.chat) and the TaskActivityContext queue/touched model. */}
          <ErrorBoundary label="Run console">
            <RunConsole
              initialMessage={initialMessage}
              hitlRequest={inlineHitl}
              planRequest={planRequest}
              onRespondHitl={respondHitl}
              onRespondPlan={respondPlan}
              onApprovalInline={setInlineApproval}
              historyOpen={historyOpen}
              onHistoryChange={setHistoryOpen}
            />
          </ErrorBoundary>
          {permissionNeeded && (
            <PermissionModal
              permission={permissionNeeded}
              onDismiss={() => setPermissionNeeded(null)}
            />
          )}
        </>
      )}
      {consentNeeded && <ConsentModal onClose={() => setConsentNeeded(false)} />}
      {/* Modal fallback — only when the approval isn't already shown inline on a
          visible run row (so a request is never silently missed, never doubled). */}
      {hitlRequest && !inlineApproval && (
        <ErrorBoundary label="Confirmation dialog" compact>
          <HitlModal
            request={hitlRequest}
            onAllow={() => {
              window.openui.respondHitl(hitlRequest.id, true)
              setHitlRequest(null)
            }}
            onDeny={() => {
              if (hitlRequest.choices && hitlRequest.choices.length > 0) {
                window.openui.respondHitlChoice(hitlRequest.id, null)
              } else {
                window.openui.respondHitl(hitlRequest.id, false)
              }
              setHitlRequest(null)
            }}
            onSelect={(choice) => {
              window.openui.respondHitlChoice(hitlRequest.id, choice)
              setHitlRequest(null)
            }}
          />
        </ErrorBoundary>
      )}
      {planRequest && !inlineApproval && (
        <ErrorBoundary label="Plan approval" compact>
          <PlanApprovalModal
            request={planRequest}
            onApprove={() => {
              window.openui.respondPlan(planRequest.id, true)
              setPlanRequest(null)
            }}
            onCancel={() => {
              window.openui.respondPlan(planRequest.id, false)
              setPlanRequest(null)
            }}
          />
        </ErrorBoundary>
      )}
      </div>
    </div>
  )
}

export default function App(): JSX.Element {
  return (
    <ErrorBoundary label="OpenUI">
      <AuthProvider>
        <TaskActivityProvider>
          <AppShell />
        </TaskActivityProvider>
      </AuthProvider>
    </ErrorBoundary>
  )
}
