import { useEffect, useState } from 'react'

type CardState = 'hidden' | 'visible' | 'permanent-dismiss-prompt' | 'success'

// How long after mount before we check and potentially show the card (ms).
const SHOW_DELAY_MS = 2 * 60 * 1000

export default function OllamaSuggestion(): JSX.Element | null {
  const [cardState, setCardState] = useState<CardState>('hidden')
  const [dismissCount, setDismissCount] = useState(0)

  // After SHOW_DELAY_MS, check whether Ollama is installed. Show the card only
  // if it isn't — and only if the user hasn't permanently dismissed the prompt.
  useEffect(() => {
    const timer = setTimeout(async () => {
      try {
        const { installed } = await window.openui.checkOllama()
        if (!installed) {
          setCardState('visible')
          console.log('[Telemetry] ollama_prompt_shown')
        }
      } catch {
        // IPC not ready yet — silently skip.
      }
    }, SHOW_DELAY_MS)
    return () => clearTimeout(timer)
  }, [])

  // When the polling loop detects Ollama came online, switch to success.
  useEffect(() => {
    const off = window.openui.onLocalAIAvailable(() => {
      setCardState('success')
    })
    return off
  }, [])

  const handleSetUp = async (): Promise<void> => {
    console.log('[Telemetry] ollama_prompt_clicked')
    await window.openui.installOllama()
  }

  const handleNotNow = async (): Promise<void> => {
    const next = dismissCount + 1
    setDismissCount(next)
    if (next >= 3) {
      setCardState('permanent-dismiss-prompt')
    } else {
      setCardState('hidden')
      await window.openui.dismissOllamaPrompt(false)
    }
  }

  const handlePermanentDismiss = async (permanently: boolean): Promise<void> => {
    setCardState('hidden')
    await window.openui.dismissOllamaPrompt(permanently)
  }

  if (cardState === 'hidden') return null

  // ── Success state ──────────────────────────────────────────────────────────
  if (cardState === 'success') {
    return (
      <div style={cardStyle}>
        <span style={{color:'#34d399',fontSize:13}}>✓</span>
        <div style={{ flex: 1 }}>
          <div style={titleStyle}>Local AI is active!</div>
          <div style={bodyStyle}>You now have unlimited free messages.</div>
        </div>
      </div>
    )
  }

  // ── Permanent-dismiss prompt (after 3 "Not now" clicks) ───────────────────
  if (cardState === 'permanent-dismiss-prompt') {
    return (
      <div style={cardStyle}>
        <div style={{ flex: 1 }}>
          <div style={titleStyle}>Don't show again?</div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button style={btnPrimaryStyle} onClick={() => handlePermanentDismiss(true)}>
              Yes, don't show again
            </button>
            <button style={btnGhostStyle} onClick={() => handlePermanentDismiss(false)}>
              Maybe later
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── Default suggestion card ────────────────────────────────────────────────
  return (
    <div style={cardStyle}>
      <span style={{color:'#a78bfa',fontSize:13}}>→</span>
      <div style={{ flex: 1 }}>
        <div style={titleStyle}>Want unlimited free messages?</div>
        <div style={bodyStyle}>Install local AI for unlimited offline use — no cloud needed.</div>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button style={btnPrimaryStyle} onClick={handleSetUp}>
            Set up local AI
          </button>
          <button style={btnGhostStyle} onClick={handleNotNow}>
            Not now
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────

const cardStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 10,
  margin: '8px 16px',
  padding: '10px 12px',
  background: 'rgba(0, 122, 255, 0.06)',
  border: '1px solid rgba(0, 122, 255, 0.18)',
  borderRadius: 10,
  fontSize: 12,
  fontFamily: '-apple-system, sans-serif'
}

const titleStyle: React.CSSProperties = {
  fontWeight: 600,
  color: '#1c1c1e',
  fontSize: 12,
  marginBottom: 2
}

const bodyStyle: React.CSSProperties = {
  color: '#636366',
  fontSize: 11,
  lineHeight: 1.4
}

const btnPrimaryStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: '#fff',
  background: '#007aff',
  border: 'none',
  borderRadius: 6,
  padding: '4px 10px',
  cursor: 'pointer',
  fontFamily: '-apple-system, sans-serif'
}

const btnGhostStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  color: '#636366',
  background: 'transparent',
  border: '1px solid #d1d1d6',
  borderRadius: 6,
  padding: '4px 10px',
  cursor: 'pointer',
  fontFamily: '-apple-system, sans-serif'
}
