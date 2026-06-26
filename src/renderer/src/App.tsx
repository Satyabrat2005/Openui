import { useCallback, useEffect, useRef, useState } from 'react'
import AssistantPopup from './components/AssistantPopup'
import TaskListPopup from './components/TaskListPopup'
import PermissionModal from './components/PermissionModal'
import HitlModal from './components/HitlModal'
import OnboardingWizard from './components/onboarding/OnboardingWizard'
import ConsentModal from './components/ConsentModal'
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

function AppShell(): JSX.Element {
  const overlayRef = useRef<HTMLDivElement>(null)
  const recordingRef = useRef<boolean>(false)
  const captionLockedRef = useRef<boolean>(false)

  const [permissionNeeded, setPermissionNeeded] = useState<PermissionTarget | null>(null)
  const [consentNeeded, setConsentNeeded] = useState(false)
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

  const handleBackdrop = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (e.target === e.currentTarget) window.openui?.hide()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        if (permissionNeeded) {
          setPermissionNeeded(null)
        } else {
          window.openui?.hide()
        }
      }
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

  return (
    <div ref={overlayRef} className="openui-overlay" onMouseDown={handleBackdrop}>
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
  )
}

export default function App(): JSX.Element {
  return (
    <AuthProvider>
      <AppShell />
    </AuthProvider>
  )
}
