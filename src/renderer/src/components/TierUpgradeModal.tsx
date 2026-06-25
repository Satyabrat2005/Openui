import type { TierUpgradePayload } from '../env'
import WaitlistLink from './WaitlistLink'

interface Props {
  payload: TierUpgradePayload
  onDismiss: () => void
}

const TIERS = [
  {
    id: 'free' as const,
    label: 'Free',
    color: '#636366',
    bg: '#f2f2f7',
    features: ['Local Ollama models', 'Tesseract.js OCR', 'All OS automation tools'],
    priceLabel: 'Always free'
  },
  {
    id: 'pro' as const,
    label: 'Pro',
    color: '#7c3aed',
    bg: '#ede9fe',
    features: ['Claude Sonnet (cloud)', 'Claude Vision for screen reading', 'Whisper API transcription', 'Everything in Free'],
    priceLabel: '$12 / month',
    priceId: import.meta.env.VITE_STRIPE_PRO_PRICE_ID as string | undefined
  },
  {
    id: 'enterprise' as const,
    label: 'Enterprise',
    color: '#b45309',
    bg: '#fef3c7',
    features: ['Claude Opus (most capable)', 'Private GPU endpoint', 'Priority support', 'Everything in Pro'],
    priceLabel: '$49 / month',
    priceId: import.meta.env.VITE_STRIPE_ENTERPRISE_PRICE_ID as string | undefined
  }
]

export default function TierUpgradeModal({ payload, onDismiss }: Props): JSX.Element {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.35)',
        backdropFilter: 'blur(4px)'
      }}
      onClick={onDismiss}
    >
      <div
        style={{
          background: 'rgba(255,255,255,0.97)',
          backdropFilter: 'blur(20px)',
          borderRadius: 20,
          padding: '28px 24px',
          width: 420,
          boxShadow: '0 24px 64px rgba(0,0,0,0.2)',
          fontFamily: '-apple-system, sans-serif'
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ marginBottom: 20 }}>
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 12,
              background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 12
            }}
          >
            <span style={{ fontSize: 22 }}>⚡</span>
          </div>
          <div style={{ fontSize: 18, fontWeight: 700, color: '#1c1c1e', letterSpacing: '-0.03em' }}>
            Upgrade your plan
          </div>
          <div style={{ fontSize: 13, color: '#8e8e93', marginTop: 4 }}>
            You're on the{' '}
            <strong style={{ color: payload.currentTier === 'free' ? '#636366' : '#7c3aed' }}>
              {payload.currentTier}
            </strong>{' '}
            plan. Upgrade to access{' '}
            <strong>{payload.requestedTier}</strong> features.
          </div>
        </div>

        {/* Tier cards */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 20 }}>
          {TIERS.filter((t) => t.id !== 'free').map((tier) => (
            <div
              key={tier.id}
              style={{
                borderRadius: 14,
                padding: '14px 16px',
                background: tier.id === payload.requestedTier ? tier.bg : '#f9f9fb',
                border: tier.id === payload.requestedTier ? `2px solid ${tier.color}33` : '2px solid transparent'
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: 700,
                    color: tier.color,
                    letterSpacing: '-0.02em'
                  }}
                >
                  {tier.label}
                </span>
                <span style={{ fontSize: 12, color: tier.color, fontWeight: 600 }}>
                  {tier.priceLabel}
                </span>
              </div>
              <ul style={{ margin: 0, padding: '0 0 0 16px', listStyle: 'disc' }}>
                {tier.features.map((f) => (
                  <li key={f} style={{ fontSize: 11, color: '#636366', marginBottom: 2 }}>
                    {f}
                  </li>
                ))}
              </ul>
              {tier.priceId && (
                <button
                  onClick={() => {
                    void window.openui.checkout(tier.priceId!)
                    onDismiss()
                  }}
                  style={{
                    marginTop: 12,
                    width: '100%',
                    padding: '8px 0',
                    borderRadius: 8,
                    border: 'none',
                    background: tier.color,
                    color: '#fff',
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: 'pointer',
                    letterSpacing: '-0.01em',
                    fontFamily: '-apple-system, sans-serif'
                  }}
                >
                  Upgrade to {tier.label}
                </button>
              )}
            </div>
          ))}
        </div>

        {/* Soft alternative to upgrading — capture interest for the Pro launch. */}
        <WaitlistLink />

        <button
          onClick={onDismiss}
          style={{
            width: '100%',
            padding: '9px 0',
            borderRadius: 10,
            border: '1.5px solid #e5e5ea',
            background: 'none',
            fontSize: 13,
            color: '#8e8e93',
            cursor: 'pointer',
            fontFamily: '-apple-system, sans-serif'
          }}
        >
          Continue on Free
        </button>
      </div>
    </div>
  )
}
