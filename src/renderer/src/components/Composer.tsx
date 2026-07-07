import { useEffect, useRef, useState } from 'react'
import ComposerPlusMenu from './ComposerPlusMenu'

/**
 * Composer — the chat input surface. On an empty session it renders centered and
 * large (the Claude/ChatGPT/Gemini "home" layout); inside a live thread it renders
 * as a compact bottom strip. A "+" button opens the actions menu (attach a file,
 * connect an app, assign a task). The textarea auto-grows with its content.
 */
interface Props {
  value: string
  onChange: (v: string) => void
  onSend: () => void
  disabled?: boolean
  isRecording?: boolean
  onMic?: () => void
  /** true = large centered hero composer; false = compact in-thread strip. */
  centered?: boolean
  placeholder?: string
  onAttachFile: () => void
  onConnectApp: () => void
  onAssignTask: () => void
}

export default function Composer({
  value,
  onChange,
  onSend,
  disabled = false,
  isRecording = false,
  onMic,
  centered = false,
  placeholder = 'Ask OpenUI anything…',
  onAttachFile,
  onConnectApp,
  onAssignTask
}: Props): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const taRef = useRef<HTMLTextAreaElement>(null)

  // Auto-grow the textarea to fit its content (bounded), resetting when cleared.
  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, centered ? 200 : 120)}px`
  }, [value, centered])

  const closeMenuThen = (fn: () => void) => (): void => {
    setMenuOpen(false)
    fn()
  }

  return (
    <div className={`ou-composer${centered ? ' centered' : ''}`}>
      <div className="ou-composer-box">
        <div className="ou-composer-plus-wrap">
          <button
            type="button"
            className="ou-composer-plus"
            aria-label="Add"
            title="Attach, connect, or assign"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
          {menuOpen && (
            <ComposerPlusMenu
              onAttachFile={closeMenuThen(onAttachFile)}
              onConnectApp={closeMenuThen(onConnectApp)}
              onAssignTask={closeMenuThen(onAssignTask)}
              onClose={() => setMenuOpen(false)}
            />
          )}
        </div>

        <textarea
          ref={taRef}
          className="ou-composer-input"
          value={value}
          rows={1}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              onSend()
            }
          }}
        />

        {onMic && (
          <button
            type="button"
            aria-label={isRecording ? 'Stop recording' : 'Start voice input'}
            title={isRecording ? 'Stop recording' : 'Voice input'}
            className={`ou-composer-mic${isRecording ? ' recording' : ''}`}
            onClick={disabled ? undefined : onMic}
            disabled={disabled}
          >
            {isRecording ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <rect x="9" y="2" width="6" height="12" rx="3" fill="currentColor" />
                <path
                  d="M5 10c0 3.866 3.134 7 7 7s7-3.134 7-7"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
                <line x1="12" y1="19" x2="12" y2="22" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            )}
          </button>
        )}

        <button
          type="button"
          className="ou-composer-send"
          aria-label="Send"
          title="Send"
          onClick={onSend}
          disabled={disabled || value.trim().length === 0}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path d="M12 20V5M6 11l6-6 6 6" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
    </div>
  )
}
