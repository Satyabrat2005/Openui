import { useEffect, useRef } from 'react'
import { useOnboardingAnimations } from '../../hooks/useOnboardingAnimations'

interface Props {
  onNext: () => void
}

const FEATURES: ReadonlyArray<{ label: string }> = [
  { label: 'Runs on your device' },
  { label: 'Your data stays local' },
  { label: 'Works instantly' }
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
            <span className="ob-feature-icon" style={{width:14,height:14,borderRadius:'50%',background:'#a78bfa',display:'inline-block',flexShrink:0}} />
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
