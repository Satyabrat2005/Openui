import { useEffect, useRef } from 'react'
import { useOnboardingAnimations } from '../../hooks/useOnboardingAnimations'

interface Props {
  onNext: () => void
}

function MonitorIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1" y="2" width="14" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5 13h6M8 11v2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function CloudIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M11.5 10.5H4.5a2.5 2.5 0 010-5h.1A3.5 3.5 0 0111 4.5a2 2 0 01.5 6z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function BoltIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M9 2L4 9h4.5L7 14l7-8H9.5L11 2z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}

const FEATURES: ReadonlyArray<{ icon: () => JSX.Element; label: string }> = [
  { icon: MonitorIcon, label: 'Runs on your device' },
  { icon: CloudIcon, label: 'Cloud AI, no setup needed' },
  { icon: BoltIcon, label: 'Works instantly' }
]

/**
 * Step 1 — the hero. Logo pops in (scale + fade), then the three key selling
 * points stagger up. A single call to action; no other links or distractions.
 */
export default function WelcomeStep({ onNext }: Props): JSX.Element {
  const { animateLogo, animateStagger } = useOnboardingAnimations()
  const logoRef = useRef<HTMLDivElement>(null)
  const featuresRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    animateLogo(logoRef.current)
    animateStagger(featuresRef.current?.querySelectorAll<HTMLElement>('.ob-feature-row'))
  }, [animateLogo, animateStagger])

  return (
    <div className="ob-welcome">
      <div ref={logoRef} className="ob-logo">
        <div className="ob-logo-dot" />
      </div>

      <h1 className="ob-title" style={{ marginTop: 22 }}>
        Welcome to OpenUI
      </h1>
      <p className="ob-subtitle" style={{ marginTop: 8, maxWidth: 260 }}>
        Your AI assistant that lives on your computer.
      </p>

      <div ref={featuresRef} className="ob-feature-card" style={{ marginTop: 26 }}>
        {FEATURES.map((f) => (
          <div key={f.label} className="ob-feature-row">
            <span className="ob-feature-icon"><f.icon /></span>
            <span>{f.label}</span>
          </div>
        ))}
      </div>

      <button className="ob-btn-primary" style={{ marginTop: 28 }} onClick={onNext}>
        Get Started&nbsp;&rarr;
      </button>
    </div>
  )
}
