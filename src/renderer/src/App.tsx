import { useCallback, useEffect, useRef, useState } from 'react'
import AssistantPopup from './components/AssistantPopup'
import TaskListPopup from './components/TaskListPopup'
import PermissionModal from './components/PermissionModal'
import HitlModal from './components/HitlModal'
import OnboardingWizard from './components/onboarding/OnboardingWizard'
import ConsentModal from './components/ConsentModal'
import WorkflowsUI from './components/WorkflowsUI'
import { useAssistantAnimations } from './hooks/useAssistantAnimations'
import { useOnboarding } from './hooks/useOnboarding'
import { AuthProvider } from './context/AuthContext'
import type { PermissionTarget, HitlRequestPayload } from './env'

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

/**
 * Custom window title bar for the frameless window. The empty flex area is a
 * drag region (-webkit-app-region: drag via .ou-titlebar-drag) so the window can
 * be moved; double-clicking it toggles maximize like a native title bar. The
 * minimize / maximize / close buttons are opted OUT of the drag region so they
 * stay clickable. Close hides to the tray (see main process).
 */
function TitleBar(): JSX.Element {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    window.openui.isMaximized().then(setMaximized).catch(() => {})
    return window.openui.onMaximizeChange(setMaximized)
  }, [])

  return (
    <div className="ou-titlebar">
      <div className="ou-titlebar-brand">
        <div className="ou-titlebar-orb" />
        <span className="ou-titlebar-name">OpenUI</span>
      </div>
      <div
        className="ou-titlebar-drag"
        onDoubleClick={() => window.openui.toggleMaximizeWindow()}
      />
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
    </div>
  )
}

function AppShell(): JSX.Element {
  const overlayRef = useRef<HTMLDivElement>(null)
  const recordingRef = useRef<boolean>(false)
  const captionLockedRef = useRef<boolean>(false)

  const [permissionNeeded, setPermissionNeeded] = useState<PermissionTarget | null>(null)
  const [consentNeeded, setConsentNeeded] = useState(false)
  const [showWorkflows, setShowWorkflows] = useState(false)
  const [hitlRequest, setHitlRequest] = useState<HitlRequestPayload | null>(null)

  const { isComplete, isLoading, completeOnboarding } = useOnboarding()
  // The first message typed in onboarding, replayed once the chat mounts.
  const [initialMessage, setInitialMessage] = useState<string | null>(null)

  const showChat = !isLoading && isComplete
  // Only run the popup entrance choreography once the chat UI is mounted.
  useAssistantAnimations(overlayRef, recordingRef, captionLockedRef, showChat)

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

  const handleRunWorkflow = useCallback((workflowName: string): void => {
    window.openui
      .getTier()
      .then((tier) => window.openui.chat(`Run workflow: ${workflowName}`, tier as 'free' | 'pro' | 'enterprise'))
      .catch(() => {})
  }, [])

  return (
    <div ref={overlayRef} className="openui-overlay">
      <TitleBar />
      <div className="ou-content">
      {isLoading ? (
        <LoadingScreen />
      ) : !isComplete ? (
        <OnboardingWizard onComplete={handleOnboardingComplete} />
      ) : (
        <>
          <AssistantPopup
            recordingRef={recordingRef}
            captionLockedRef={captionLockedRef}
            onPermissionNeeded={setPermissionNeeded}
            initialMessage={initialMessage}
          />
          <TaskListPopup />
          {/* Workflows toggle button — bottom-left corner */}
          <button
            onClick={() => setShowWorkflows(true)}
            title="Team Workflows"
            style={{
              position: 'fixed',
              bottom: 24,
              left: 24,
              zIndex: 9000,
              background: 'rgba(18,18,22,0.85)',
              border: '1px solid rgba(167,139,250,0.3)',
              borderRadius: 10,
              color: '#a78bfa',
              cursor: 'pointer',
              fontSize: 11,
              fontWeight: 600,
              padding: '6px 11px',
              backdropFilter: 'blur(8px)',
              letterSpacing: '0.03em'
            }}
          >
            Workflows
          </button>
          {showWorkflows && (
            <WorkflowsUI
              onClose={() => setShowWorkflows(false)}
              onRunWorkflow={handleRunWorkflow}
            />
          )}
          {permissionNeeded && (
            <PermissionModal
              permission={permissionNeeded}
              onDismiss={() => setPermissionNeeded(null)}
            />
          )}
        </>
      )}
      {consentNeeded && <ConsentModal onClose={() => setConsentNeeded(false)} />}
      {hitlRequest && (
        <HitlModal
          request={hitlRequest}
          onAllow={() => {
            window.openui.respondHitl(hitlRequest.id, true)
            setHitlRequest(null)
          }}
          onDeny={() => {
            window.openui.respondHitl(hitlRequest.id, false)
            setHitlRequest(null)
          }}
        />
      )}
      </div>
    </div>
  )
}

export default function App(): JSX.Element {
  return (
    <AuthProvider>
      <AppShell />
    </AuthProvider>
  )
}
