import { useEffect, useState } from 'react'
import { labelForModel } from '../lib/modelLabel'

export default function LocalAIStatus(): JSX.Element {
  // Set when a screen read used local OCR to describe the screen.
  const [ocrHint, setOcrHint] = useState(false)
  // The REAL model id the backend reported for the most recent turn, or null
  // before any turn has run. We only ever show a model the backend told us it is
  // using — never a hardcoded name — and we make no claim about liveness or
  // cloud-call counts we cannot verify from here.
  const [model, setModel] = useState<string | null>(null)

  useEffect(() => {
    const off = window.openui.onScreenOcrFallback(() => setOcrHint(true))
    return off
  }, [])

  useEffect(() => {
    const off = window.openui.onChatModel(({ model }) => setModel(model))
    return off
  }, [])

  // Auto-dismiss the hint after a few seconds so it never lingers permanently.
  useEffect(() => {
    if (!ocrHint) return
    const id = window.setTimeout(() => setOcrHint(false), 8000)
    return () => window.clearTimeout(id)
  }, [ocrHint])

  return (
    <>
      {ocrHint && (
        <div style={hintStyle} role="status">
          <span style={{ flex: 1 }}>
            Screen read used local OCR to describe the screen — running fully on your machine.
          </span>
          <button
            type="button"
            onClick={() => setOcrHint(false)}
            aria-label="Dismiss"
            style={dismissStyle}
          >
            ✕
          </button>
        </div>
      )}
      <div style={rowStyle}>
        <span style={{ ...dotStyle, background: model ? '#34c759' : '#c7c7cc' }} />
        <span style={labelStyle}>
          {model ? `Local AI · ${labelForModel(model)}` : 'Local AI · Ollama'}
        </span>
      </div>
    </>
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

const hintStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 8,
  padding: '8px 16px',
  borderTop: '1px solid rgba(0,0,0,0.06)',
  background: 'rgba(255,159,10,0.12)',
  color: '#b25e00',
  fontSize: 11,
  lineHeight: 1.4,
  fontFamily: '-apple-system, sans-serif'
}

const dismissStyle: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: '#b25e00',
  cursor: 'pointer',
  fontSize: 11,
  lineHeight: 1,
  padding: 0,
  flexShrink: 0
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
