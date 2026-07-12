import { useCallback, useEffect, useState } from 'react'

/**
 * First-run onboarding state, backed by the `onboarding_complete` row in the
 * SQLite `settings` table (persisted in the main process, read/written over
 * IPC). A fresh install — or a re-install, which wipes the local DB — starts
 * with no row, so the wizard shows again. That is the intended behaviour.
 */

const ONBOARDING_KEY = 'onboarding_complete'
const ONBOARDING_STEP_KEY = 'onboarding_step'

export interface UseOnboarding {
  /** True once the user has finished (or previously finished) onboarding. */
  isComplete: boolean
  /** True while the persisted flag is still being read on first mount. */
  isLoading: boolean
  currentStep: number
  setCurrentStep: (step: number) => void
  completeOnboarding: () => Promise<void>
  resetOnboarding: () => Promise<void>
}

export function useOnboarding(): UseOnboarding {
  const [isComplete, setIsComplete] = useState(false)
  const [currentStep, setCurrentStepState] = useState(0)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    window.openui
      .getSetting(ONBOARDING_KEY)
      .then((value) => {
        if (cancelled) return
        const complete = value === true
        setIsComplete(complete)
        if (complete) {
          setIsLoading(false)
          return
        }
        // Only resume a saved step if onboarding hasn't already been finished.
        window.openui
          .getSetting(ONBOARDING_STEP_KEY)
          .then((step) => {
            if (cancelled) return
            if (typeof step === 'number') setCurrentStepState(step)
            setIsLoading(false)
          })
          .catch(() => {
            if (cancelled) return
            setIsLoading(false)
          })
      })
      .catch(() => {
        // If the read fails, fail open into onboarding rather than trapping the
        // user behind a blank loading screen.
        if (cancelled) return
        setIsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const setCurrentStep = useCallback((step: number): void => {
    setCurrentStepState(step)
    void window.openui.setSetting(ONBOARDING_STEP_KEY, step)
  }, [])

  const completeOnboarding = useCallback(async (): Promise<void> => {
    await window.openui.setSetting(ONBOARDING_KEY, true)
    await window.openui.setSetting(ONBOARDING_STEP_KEY, 0)
    setIsComplete(true)
    setCurrentStepState(0)
  }, [])

  const resetOnboarding = useCallback(async (): Promise<void> => {
    await window.openui.setSetting(ONBOARDING_KEY, false)
    await window.openui.setSetting(ONBOARDING_STEP_KEY, 0)
    setIsComplete(false)
    setCurrentStepState(0)
  }, [])

  return { isComplete, isLoading, currentStep, setCurrentStep, completeOnboarding, resetOnboarding }
}
