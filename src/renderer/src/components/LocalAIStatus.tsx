import { useAuth } from '../context/AuthContext'
import type { Tier } from '../env'

const CLOUD_LIMIT: Record<Tier, string> = {
  free: '5 messages/day free',
  pro: '500 messages/day cloud',
  enterprise: 'Unlimited cloud messages'
}

export default function LocalAIStatus(): JSX.Element {
  const { tier } = useAuth()

  return (
    <div style={rowStyle}>
      <span style={{ ...dotStyle, background: '#34c759' }} />
      <span style={labelStyle}>Cloud AI · {CLOUD_LIMIT[tier]}</span>
    </div>
  )
}

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '6px 16px',
  borderTop: '1px solid rgba(0,0,0,0.06)',
  fontFamily: '-apple-system, sans-serif'
}

const dotStyle: React.CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: '50%',
  flexShrink: 0
}

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  color: '#8e8e93',
  fontWeight: 500,
  flex: 1
}
