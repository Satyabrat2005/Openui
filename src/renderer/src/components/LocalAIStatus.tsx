import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import type { Tier } from '../env'

const CLOUD_LIMIT: Record<Tier, string> = {
  free: '20 messages/day free',
  pro: '500 messages/day cloud',
  enterprise: 'Unlimited cloud messages'
}

export default function LocalAIStatus(): JSX.Element {
  const { tier } = useAuth()
  const [running, setRunning] = useState(false)

  // Check on mount.
  useEffect(() => {
    window.openui.checkOllama().then(({ running: r }) => setRunning(r)).catch(() => {})
  }, [])

  // React to polling events from main.
  useEffect(() => {
    const off = window.openui.onLocalAIAvailable(() => setRunning(true))
    return off
  }, [])

  const handleSetUp = (): void => {
    window.openui.installOllama().catch(() => {})
  }

  if (running) {
    return (
      <div style={rowStyle}>
        <span style={{ ...dotStyle, background: '#34c759' }} />
        <span style={labelStyle}>Local AI · Unlimited offline messages</span>
      </div>
    )
  }

  return (
    <div style={rowStyle}>
      <span style={{ ...dotStyle, background: '#c7c7cc' }} />
      <span style={labelStyle}>Cloud · {CLOUD_LIMIT[tier]}</span>
      <button style={linkBtnStyle} onClick={handleSetUp}>
        Set up local AI
      </button>
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

const linkBtnStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  color: '#007aff',
  background: 'none',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
  fontFamily: '-apple-system, sans-serif'
}
