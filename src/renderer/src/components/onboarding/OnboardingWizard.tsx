import { useCallback, useEffect, useRef, useState } from 'react'
import { useOnboardingAnimations } from '../../hooks/useOnboardingAnimations'
import { track } from '../../lib/telemetry'
import WelcomeStep from './WelcomeStep'
import SignInStep from './SignInStep'
import TourStep from './TourStep'
import FirstChatStep from './FirstChatStep'

interface Props {
  /**
   * Called when onboarding finishes, with the user's first message (or `null`
   * if they opted into voice). The parent persists completion and mounts the
   * chat interface, which sends the message so the reply streams into the chat.
   */
  onComplete: (firstMessage: string | null) => void
  /** Step to resume at (e.g. after quitting partway through onboarding last time). */
  initialStep?: number
  /** Called whenever the current step changes, so the parent can persist it. */
  onStepChange?: (step: number) => void
}

const STEP_NAMES = ['welcome', 'signin', 'tour', 'first_chat'] as const
const TOTAL_STEPS = STEP_NAMES.length
const FIRST_CHAT_STEP = TOTAL_STEPS - 1

/**
 * Full-popup first-run wizard that replaces the chat interface until the user
 * is set up. Steps share a single content container so transitions are a clean
 * slide-down-out / slide-up-in; the final step dissolves the whole wizard
 * before the chat interface takes over. Auth (step 2) cannot be skipped.
 */
export default function OnboardingWizard({ onComplete, initialStep, onStepChange }: Props): JSX.Element {
  const { animateStepIn, animateStepOut, animateWizardOut } = useOnboardingAnimations()
  const clampedInitialStep =
    initialStep !== undefined ? Math.min(Math.max(initialStep, 0), FIRST_CHAT_STEP) : 0
  const [step, setStep] = useState(clampedInitialStep)
  const wizardRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const startTimeRef = useRef(Date.now())
  const startedRef = useRef(false)

  // onboarding_started — fired exactly once when the wizard first renders.
  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    track('onboarding_started')
  }, [])

  // Animate the freshly-mounted step in and report which step was reached.
  useEffect(() => {
    animateStepIn(contentRef.current)
    track('onboarding_step_reached', { step_number: step, step_name: STEP_NAMES[step] })
    onStepChange?.(step)
  }, [step, animateStepIn, onStepChange])

  const goToStep = useCallback(
    (next: number): void => {
      animateStepOut(contentRef.current, () => setStep(next))
    },
    [animateStepOut]
  )

  const skipFrom = useCallback(
    (from: number): void => {
      track('onboarding_skipped', { step_skipped_from: STEP_NAMES[from] })
      goToStep(FIRST_CHAT_STEP)
    },
    [goToStep]
  )

  const finish = useCallback(
    (message: string | null): void => {
      track('onboarding_completed', { duration_ms: Date.now() - startTimeRef.current })
      animateWizardOut(wizardRef.current, () => onComplete(message))
    },
    [animateWizardOut, onComplete]
  )

  const handleWelcomeNext = useCallback(() => goToStep(1), [goToStep])
  const handleAuthed = useCallback(() => goToStep(2), [goToStep])
  const handleTourNext = useCallback(() => goToStep(FIRST_CHAT_STEP), [goToStep])
  const handleTourSkip = useCallback(() => skipFrom(2), [skipFrom])

  return (
    <div ref={wizardRef} id="onboarding-popup">
      <div className="ob-progress">
        {STEP_NAMES.map((name, i) => (
          <span key={name} className={`ob-dot${i === step ? ' active' : ''}`} />
        ))}
      </div>

      <div ref={contentRef} className="ob-content">
        {step === 0 && <WelcomeStep onNext={handleWelcomeNext} />}
        {step === 1 && <SignInStep onAuthed={handleAuthed} />}
        {step === 2 && <TourStep onNext={handleTourNext} onSkip={handleTourSkip} />}
        {step === FIRST_CHAT_STEP && <FirstChatStep onSubmit={finish} />}
      </div>
    </div>
  )
}
