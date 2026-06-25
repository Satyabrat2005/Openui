import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { PermissionTarget } from '../env'
import { useAuth } from '../context/AuthContext'
import AuthButton from './AuthButton'
import SubscriptionStatus from './SubscriptionStatus'
import SignInBanner from './SignInBanner'
import UsageCounter from './UsageCounter'
import UpdateBanner from './UpdateBanner'
import SettingsModal from './SettingsModal'
import OllamaSuggestion from './OllamaSuggestion'
import LocalAIStatus from './LocalAIStatus'

type VoiceState = 'idle' | 'recording' | 'transcribing' | 'processing' | 'done'

interface Props {
  recordingRef: MutableRefObject<boolean>
  captionLockedRef: MutableRefObject<boolean>
  /** Called when an OS permission is missing; triggers the PermissionModal in App. */
  onPermissionNeeded?: (permission: PermissionTarget) => void
  /**
   * First message handed over from onboarding. Sent once on mount so its
   * streamed reply lands here, making the wizard-to-chat hand-off seamless.
   */
  initialMessage?: string | null
}

/** Prefer opus/webm; fall back to whatever the browser supports. */
function pickMimeType(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg']
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) ?? ''
}

export default function AssistantPopup({
  recordingRef,
  captionLockedRef,
  onPermissionNeeded,
  initialMessage
}: Props): JSX.Element {
  const { tier } = useAuth()
  const [voiceState, setVoiceState] = useState<VoiceState>('idle')
  const [transcript, setTranscript] = useState<string | null>(null)
  const [inputText, setInputText] = useState('')
  const initialSentRef = useRef(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showLocalAIToast, setShowLocalAIToast] = useState(false)

  // Imperative refs — caption and bars are managed outside React state so
  // GSAP and rAF writes don't conflict with React's reconciler.
  const captionRef = useRef<HTMLDivElement>(null)
  const soundBarsRef = useRef<HTMLDivElement>(null)

  // Recording infrastructure
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const analyserRef = useRef<AnalyserNode | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const animFrameRef = useRef<number | null>(null)

  // Write to #caption-text imperatively so GSAP doesn't fight React.
  const setCaption = useCallback((text: string): void => {
    if (captionRef.current) captionRef.current.textContent = text
  }, [])

  // ── IPC event listeners (mounted once) ────────────────────────────────
  useEffect(() => {
    const offChunk = window.openui.onChunk((delta) => {
      // Append streaming tokens directly to the DOM — no state update needed.
      if (captionRef.current) captionRef.current.textContent += delta
    })

    const offDone = window.openui.onDone(() => {
      setVoiceState('done')
    })

    const offError = window.openui.onError((msg) => {
      setCaption(`Error: ${msg}`)
      setVoiceState('idle')
      captionLockedRef.current = false
    })

    // Fired by main process after Whisper returns, before the agent streams.
    const offTranscript = window.openui.onTranscript((text) => {
      setTranscript(text)
      setVoiceState('processing')
      setCaption('') // clear so onChunk can stream into a blank caption
    })

    // Fired by the 60-second Ollama polling loop when local AI comes online.
    const offLocalAI = window.openui.onLocalAIAvailable(() => {
      setShowLocalAIToast(true)
      setTimeout(() => setShowLocalAIToast(false), 4000)
    })

    return () => {
      offChunk()
      offDone()
      offError()
      offTranscript()
      offLocalAI()
    }
  }, [setCaption, captionLockedRef])

  // ── Caption text for each voice state ─────────────────────────────────
  useEffect(() => {
    switch (voiceState) {
      case 'recording':
        captionLockedRef.current = true
        setCaption('Recording…')
        break
      case 'transcribing':
        setCaption('Transcribing…')
        break
      case 'processing':
        // Caption is cleared when onTranscript fires; onChunk fills it.
        break
      case 'done':
        // Caption holds the streaming response; leave it as-is.
        break
      case 'idle':
        // Release the lock so the GSAP demo typewriter can restart on next
        // mount (or just stays at its last value between interactions).
        break
    }
  }, [voiceState, setCaption, captionLockedRef])

  // ── Cleanup on unmount ─────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (animFrameRef.current !== null) cancelAnimationFrame(animFrameRef.current)
      mediaRecorderRef.current?.stop()
      streamRef.current?.getTracks().forEach((t) => t.stop())
      audioCtxRef.current?.close().catch(() => {})
    }
  }, [])

  // ── Mic button ─────────────────────────────────────────────────────────
  const handleMicClick = useCallback(async (): Promise<void> => {
    if (voiceState === 'recording') {
      // Stop recording — onstop callback takes it from here.
      if (animFrameRef.current !== null) {
        cancelAnimationFrame(animFrameRef.current)
        animFrameRef.current = null
      }
      recordingRef.current = false
      mediaRecorderRef.current?.stop()
      streamRef.current?.getTracks().forEach((t) => t.stop())
      audioCtxRef.current?.close().catch(() => {})
      audioCtxRef.current = null
      analyserRef.current = null
      setVoiceState('transcribing')
      return
    }

    // Allow starting a new recording from idle or after a completed turn.
    if (voiceState !== 'idle' && voiceState !== 'done') return

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      // Permission denied or hardware unavailable — show the guidance modal.
      onPermissionNeeded?.('microphone')
      setCaption('Microphone access denied.')
      return
    }

    streamRef.current = stream

    // Wire up AnalyserNode for real-time level visualisation.
    const audioCtx = new AudioContext()
    audioCtxRef.current = audioCtx
    const source = audioCtx.createMediaStreamSource(stream)
    const analyser = audioCtx.createAnalyser()
    analyser.fftSize = 128
    source.connect(analyser)
    analyserRef.current = analyser

    // Signal the GSAP bar loop to yield and start the rAF visualiser.
    recordingRef.current = true

    const animateBars = (): void => {
      if (!analyserRef.current || !recordingRef.current) return
      const data = new Uint8Array(analyserRef.current.frequencyBinCount)
      analyserRef.current.getByteFrequencyData(data)
      const bars = soundBarsRef.current?.querySelectorAll<HTMLElement>('.sbar')
      if (bars) {
        const step = Math.max(1, Math.floor(data.length / bars.length))
        bars.forEach((bar, i) => {
          const v = data[i * step] / 255
          bar.style.height = `${Math.floor(3 + v * 17)}px`
        })
      }
      animFrameRef.current = requestAnimationFrame(animateBars)
    }
    animateBars()

    const mimeType = pickMimeType()
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
    audioChunksRef.current = []

    recorder.ondataavailable = (e): void => {
      if (e.data.size > 0) audioChunksRef.current.push(e.data)
    }

    recorder.onstop = async (): Promise<void> => {
      try {
        const effectiveMime = recorder.mimeType || 'audio/webm'
        const blob = new Blob(audioChunksRef.current, { type: effectiveMime })
        const arrayBuffer = await blob.arrayBuffer()

        setTranscript(null)

        // Blocks until Whisper + the full agent turn complete.
        // onTranscript / onChunk / onDone / onError update the UI as they fire.
        await window.openui.transcribeAndChat(arrayBuffer, effectiveMime, tier)
      } catch {
        setVoiceState('idle')
        captionLockedRef.current = false
      }
    }

    recorder.start(200)
    mediaRecorderRef.current = recorder
    setVoiceState('recording')
  }, [voiceState, recordingRef, captionLockedRef, setCaption])

  // ── Text input send ────────────────────────────────────────────────────
  const handleSend = useCallback(
    async (text: string): Promise<void> => {
      const trimmed = text.trim()
      if (!trimmed) return
      if (voiceState === 'recording' || voiceState === 'processing' || voiceState === 'transcribing')
        return

      setTranscript(trimmed)
      setInputText('')
      captionLockedRef.current = true
      setVoiceState('processing')
      setCaption('')

      try {
        await window.openui.chat(trimmed, tier)
      } catch {
        setVoiceState('idle')
        captionLockedRef.current = false
      }
    },
    [voiceState, captionLockedRef, setCaption]
  )

  // Fire the message handed over from onboarding exactly once, after the IPC
  // listeners above are wired so the streamed reply is captured here.
  useEffect(() => {
    if (initialMessage && !initialSentRef.current) {
      initialSentRef.current = true
      void handleSend(initialMessage)
    }
  }, [initialMessage, handleSend])

  const isRecording = voiceState === 'recording'
  const isBusy = voiceState === 'transcribing' || voiceState === 'processing'

  return (
    <div id="openui-popup">
      {/* Header */}
      <div className="popup-header">
        <div className="popup-logo-row">
          <div className="popup-orb">
            <div className="popup-orb-dot" />
          </div>
          <span style={{ fontSize: 14, fontWeight: 600, color: '#1c1c1e', letterSpacing: '-.02em' }}>
            OpenUI
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <UsageCounter />
          <SubscriptionStatus />
          <button
            type="button"
            aria-label="Settings"
            title="Settings"
            onClick={() => setShowSettings(true)}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 26,
              height: 26,
              borderRadius: 7,
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              color: '#8e8e93',
              padding: 0
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6" />
              <path
                d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <AuthButton />
        </div>
      </div>

      {/* Returning-but-signed-out prompt (hidden while signed in) */}
      <SignInBanner />

      {/* Mic stage */}
      <div className="mic-stage">
        <div id="ring-1" className="mic-ring" />
        <div id="ring-2" className="mic-ring" />
        <div id="ring-3" className="mic-ring" />

        {/* Mic orb — click to toggle recording */}
        <div
          className="mic-orb"
          onClick={isBusy ? undefined : handleMicClick}
          style={{
            cursor: isBusy ? 'not-allowed' : 'pointer',
            background: isRecording
              ? 'linear-gradient(145deg, #ff6b6b 0%, #ff3b30 50%, #cc0000 100%)'
              : undefined,
            boxShadow: isRecording
              ? '0 6px 22px rgba(255, 59, 48, 0.45), 0 2px 7px rgba(255, 59, 48, 0.2)'
              : undefined,
            transition: 'background 0.25s, box-shadow 0.25s'
          }}
        >
          {isRecording ? (
            /* Stop icon shown while recording */
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
              <rect x="6" y="6" width="12" height="12" rx="2.5" fill="white" />
            </svg>
          ) : (
            /* Mic icon shown at rest */
            <svg width="31" height="31" viewBox="0 0 24 24" fill="none">
              <rect x="9" y="2" width="6" height="12" rx="3" fill="white" />
              <path
                d="M5 10c0 3.866 3.134 7 7 7s7-3.134 7-7"
                stroke="white"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
              <line x1="12" y1="19" x2="12" y2="22" stroke="white" strokeWidth="1.8" strokeLinecap="round" />
              <line x1="8.5" y1="22" x2="15.5" y2="22" stroke="white" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          )}
        </div>

        {/* Caption — imperatively managed; GSAP typewriter owns it at idle */}
        <div className="caption-area">
          <div id="caption-text" ref={captionRef} />
          <div id="sound-bars" ref={soundBarsRef}>
            <div className="sbar" style={{ height: 8 }} id="sb1" />
            <div className="sbar" style={{ height: 14 }} id="sb2" />
            <div className="sbar" style={{ height: 6 }} id="sb3" />
            <div className="sbar" style={{ height: 18 }} id="sb4" />
            <div className="sbar" style={{ height: 10 }} id="sb5" />
            <div className="sbar" style={{ height: 16 }} id="sb6" />
            <div className="sbar" style={{ height: 7 }} id="sb7" />
            <div className="sbar" style={{ height: 12 }} id="sb8" />
          </div>
        </div>
      </div>

      {/* Transcript bubble — shows what the user said while the agent replies */}
      <div
        id="transcript-bubble"
        style={{ display: transcript !== null ? '' : 'none' }}
      >
        <p id="transcript-text">{transcript ?? ''}</p>
      </div>

      {/* Ollama suggestion card — shown 2 min after mount if Ollama is absent */}
      <OllamaSuggestion />

      {/* Input strip */}
      <div className="input-strip">
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          style={{ color: '#aeaeb2', flexShrink: 0 }}
        >
          <circle cx="11" cy="11" r="8" stroke="currentColor" strokeWidth="2" />
          <path d="m21 21-4.35-4.35" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <input
          type="text"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSend(inputText)
          }}
          placeholder="Ask OpenUI anything…"
          disabled={isBusy || isRecording}
          style={{
            fontSize: 13,
            color: '#1c1c1e',
            flex: 1,
            fontFamily: '-apple-system, sans-serif',
            background: 'none',
            border: 'none',
            outline: 'none',
            opacity: isBusy || isRecording ? 0.4 : 1
          }}
        />
        <kbd style={{ fontSize: 11, color: '#c7c7cc', fontFamily: '-apple-system, sans-serif' }}>
          ⌘K
        </kbd>
      </div>

      {/* Suggestion chips */}
      <div className="chips-row">
        <div className="chip" onClick={() => handleSend('Check my emails')}>
          📧 Check email
        </div>
        <div className="chip" onClick={() => handleSend('Schedule an event')}>
          📅 Schedule event
        </div>
        <div className="chip" onClick={() => handleSend('Find a file')}>
          📁 Find file
        </div>
      </div>

      {/* App version + auto-update status / actions (electron-updater). */}
      <UpdateBanner />

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}

      {/* Local AI status footer */}
      <LocalAIStatus />

      {/* Toast: shown briefly when Ollama is detected running for the first time */}
      {showLocalAIToast && (
        <div
          style={{
            position: 'absolute',
            bottom: 60,
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'rgba(28,28,30,0.88)',
            color: '#fff',
            fontSize: 12,
            fontWeight: 500,
            fontFamily: '-apple-system, sans-serif',
            borderRadius: 20,
            padding: '6px 14px',
            whiteSpace: 'nowrap',
            pointerEvents: 'none'
          }}
        >
          Local AI detected! Switching to unlimited local mode.
        </div>
      )}
    </div>
  )
}
