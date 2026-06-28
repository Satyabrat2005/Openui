import { useState } from 'react'
import { track } from '../../lib/telemetry'

interface Props {
  /**
   * Hand the wizard the user's first message (or `null` if they chose to jump
   * straight into the app via the mic). The wizard persists completion and the
   * chat interface sends the message so its streamed reply lands in the chat.
   */
  onSubmit: (message: string | null) => void
}

interface Suggestion {
  text: string
  /** Reported via telemetry so we can see which prompts convert. */
  type: string
}

const SUGGESTIONS: ReadonlyArray<Suggestion> = [
  { text: 'Open my calendar', type: 'calendar' },
  { text: 'Find my latest resume', type: 'resume' },
  { text: 'What can you do?', type: 'capabilities' }
]

/**
 * Step 4 — the "aha". The input mirrors the real chat input so the hand-off to
 * the main interface is seamless. Tapping a suggestion fills the box and sends;
 * typing + Enter sends too. Either way the message is handed up and the wizard
 * dissolves into the live chat.
 */
export default function FirstChatStep({ onSubmit }: Props): JSX.Element {
  const [inputText, setInputText] = useState('')

  const send = (text: string, source: 'suggestion' | 'typed', suggestionType?: string): void => {
    const trimmed = text.trim()
    if (!trimmed) return
    track('first_message_sent', { source, suggestion_type: suggestionType })
    onSubmit(trimmed)
  }

  const handleSuggestion = (s: Suggestion): void => {
    setInputText(s.text) // fill the box so the hand-off shows the chosen prompt
    send(s.text, 'suggestion', s.type)
  }

  return (
    <div className="ob-firstchat">
      <h1 className="ob-title" style={{ textAlign: 'center' }}>
        Try it out!
      </h1>
      <p className="ob-subtitle" style={{ marginTop: 8, textAlign: 'center' }}>
        Pick a prompt to start, or type your own:
      </p>

      <div className="ob-suggest" style={{ marginTop: 22 }}>
        {SUGGESTIONS.map((s) => (
          <button key={s.type} className="ob-suggest-row" onClick={() => handleSuggestion(s)}>
            <span>{s.text}</span>
          </button>
        ))}
      </div>

      {/* Same visual language as the main chat input strip. */}
      <div className="input-strip" style={{ marginTop: 18 }}>
        <input
          type="text"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') send(inputText, 'typed')
          }}
          placeholder="Type a message…"
          autoFocus
          style={{
            fontSize: 13,
            color: '#1c1c1e',
            flex: 1,
            fontFamily: '-apple-system, sans-serif',
            background: 'none',
            border: 'none',
            outline: 'none'
          }}
        />
        {/* The mic hands off to the live chat, where the real recorder lives, so
            we don't duplicate the MediaRecorder pipeline inside onboarding. */}
        <button
          className="ob-mic-btn"
          title="Continue with voice"
          onClick={() => onSubmit(null)}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect x="9" y="2" width="6" height="12" rx="3" fill="#007aff" />
            <path
              d="M5 10c0 3.866 3.134 7 7 7s7-3.134 7-7"
              stroke="#007aff"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
            <line x1="12" y1="19" x2="12" y2="22" stroke="#007aff" strokeWidth="1.8" strokeLinecap="round" />
            <line x1="8.5" y1="22" x2="15.5" y2="22" stroke="#007aff" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  )
}
