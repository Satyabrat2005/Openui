import { useEffect, useRef, useState } from 'react'
import AssistantPopup from './components/AssistantPopup'
import TaskListPopup from './components/TaskListPopup'
import PermissionModal from './components/PermissionModal'
import { useAssistantAnimations } from './hooks/useAssistantAnimations'
import type { PermissionTarget } from './env'

export default function App(): JSX.Element {
  const overlayRef = useRef<HTMLDivElement>(null)

  // Shared refs passed to both the animations hook and AssistantPopup so they
  // can coordinate without triggering re-renders.
  const recordingRef = useRef<boolean>(false)
  const captionLockedRef = useRef<boolean>(false)

  // null = no modal; otherwise shows the permission guidance modal.
  const [permissionNeeded, setPermissionNeeded] = useState<PermissionTarget | null>(null)

  useAssistantAnimations(overlayRef, recordingRef, captionLockedRef)

  // Subscribe to permission-denied events pushed by the main process when a
  // tool detects missing OS permissions (e.g. Accessibility for nut.js).
  useEffect(() => {
    return window.openui.onPermissionDenied((permission) => {
      setPermissionNeeded(permission as PermissionTarget)
    })
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

  return (
    <div ref={overlayRef} className="openui-overlay" onMouseDown={handleBackdrop}>
      <AssistantPopup
        recordingRef={recordingRef}
        captionLockedRef={captionLockedRef}
        onPermissionNeeded={setPermissionNeeded}
      />
      <TaskListPopup />
      {permissionNeeded && (
        <PermissionModal
          permission={permissionNeeded}
          onDismiss={() => setPermissionNeeded(null)}
        />
      )}
    </div>
  )
}
