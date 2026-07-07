import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { PermissionTarget } from '../env'
import { useAuth } from '../context/AuthContext'
import AuthButton from './AuthButton'
import SubscriptionStatus from './SubscriptionStatus'
import SignInBanner from './SignInBanner'
import UsageCounter from './UsageCounter'
import UpdateBanner from './UpdateBanner'
import UpdateProgress from './UpdateProgress'
import UpdateReady from './UpdateReady'
import SettingsModal from './SettingsModal'
import { useUpdater } from '../hooks/useUpdater'
import LocalAIStatus from './LocalAIStatus'
import ConversationList from './ConversationList'
import PlusMenu, { type AttachedFile } from './PlusMenu'
import ConnectAppsModal from './ConnectAppsModal'
import ThinkingStatus from './ThinkingStatus'
import Timeline from './Timeline'
import { useTaskActivity } from '../context/TaskActivityContext'

type HistoryMsg = { role: string; content: string | null; created_at: number }

/** A single turn rendered in the live conversation thread. */
type ChatMsg = { role: 'user' | 'assistant'; content: string }

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

/**
 * Defence-in-depth display sanitiser. The StreamGate in the main process already
 * withholds tool-call JSON from the UI, but if anything slips through (a model
 * mis-classification, a wrapped call) we never want raw JSON or the internal
 * "TOOL RESULT" prefix to reach the user. Returns the user-facing text, or '' if
 * the whole message was machine plumbing.
 */
function cleanAssistantText(text: string): string {
  let t = text
  // Drop a parroted internal result prefix the model sometimes echoes back.
  t = t.replace(/^\s*TOOL RESULT\b[^\n]*\n?/i, '')
  const trimmed = t.trim()
  // Hide a message that is (or is becoming) a raw tool-call JSON object.
  if (trimmed.startsWith('{') && /"(tool|tool_name|name)"\s*:/.test(trimmed)) return ''
  if (trimmed.startsWith('```') && /"(tool|tool_name|name)"\s*:/.test(trimmed)) return ''
  return t
}

export default function AssistantPopup({
  recordingRef,
  captionLockedRef,
  onPermissionNeeded,
  initialMessage
}: Props): JSX.Element {
  const { tier } = useAuth()
  const { beginTask } = useTaskActivity()
  const [voiceState, setVoiceState] = useState<VoiceState>('idle')
  const [inputText, setInputText] = useState('')
  const initialSentRef = useRef(false)
  const [showSettings, setShowSettings] = useState(false)
  // Connect-apps (MCP) panel, opened from the "+" menu.
  const [showConnect, setShowConnect] = useState(false)
  // Files attached via the "+" menu, folded into the next message as context.
  const [attachments, setAttachments] = useState<AttachedFile[]>([])
  // Inline "assign a task" composer, opened from the "+" menu.
  const [assignOpen, setAssignOpen] = useState(false)
  const [assignText, setAssignText] = useState('')
  const [showHistory, setShowHistory] = useState(false)
  const [activeConvId, setActiveConvId] = useState<string | null>(null)
  // On a wide/maximized window the session sidebar is pinned permanently open
  // (the ChatGPT/Claude layout); on a narrow window it collapses into a slide-in
  // panel toggled from the header. Tracks the live window width so resizing,
  // maximizing, or entering full screen flips the layout automatically.
  const [wide, setWide] = useState(() => window.innerWidth >= 900)
  useEffect(() => {
    const onResize = (): void => setWide(window.innerWidth >= 900)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  // The live conversation thread for the current session — every user and
  // assistant turn, accumulated so the UI is a real chat, not a single caption.
  const [messages, setMessages] = useState<ChatMsg[]>([])
  // True while the assistant is streaming into the last message of `messages`.
  const streamingRef = useRef(false)
  // 👍/👎 on the last response (self-improvement loop). Null until the user
  // rates; reset to null whenever a new turn starts.
  const [feedbackGiven, setFeedbackGiven] = useState<null | 'up' | 'down'>(null)

  const { updateState, appVersion, checkForUpdates, downloadUpdate, installAndRestart, openDownloadPage, dismiss } =
    useUpdater()

  // Suppress update banners during onboarding (flag set by the onboarding wizard).
  const onboardingComplete = localStorage.getItem('openui:onboarding-complete') !== 'false'
  const isMac = window.openui.platform === 'darwin'

  // Imperative refs — caption and bars are managed outside React state so
  // GSAP and rAF writes don't conflict with React's reconciler.
  const captionRef = useRef<HTMLDivElement>(null)
  const soundBarsRef = useRef<HTMLDivElement>(null)
  const threadEndRef = useRef<HTMLDivElement>(null)

  // Recording infrastructure
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const analyserRef = useRef<AnalyserNode | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const animFrameRef = useRef<number | null>(null)

  // Write to #caption-text imperatively so GSAP doesn't fight React (hero only).
  const setCaption = useCallback((text: string): void => {
    if (captionRef.current) captionRef.current.textContent = text
  }, [])

  /** Append a streamed delta to the last (assistant) message in the thread. */
  const appendToLastAssistant = useCallback((delta: string): void => {
    setMessages((prev) => {
      if (prev.length === 0) return prev
      const next = prev.slice()
      const last = next[next.length - 1]
      if (last.role !== 'assistant') return prev
      next[next.length - 1] = { ...last, content: last.content + delta }
      return next
    })
  }, [])

  /** Open a fresh user→assistant turn in the thread, ready to stream into. */
  const beginTurn = useCallback((userText: string): void => {
    setMessages((prev) => [...prev, { role: 'user', content: userText }, { role: 'assistant', content: '' }])
    streamingRef.current = true
    setFeedbackGiven(null)
    setVoiceState('processing')
  }, [])

  // Keep the thread scrolled to the newest message.
  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ block: 'end' })
  }, [messages])

  // ── IPC event listeners (mounted once) ────────────────────────────────
  useEffect(() => {
    const offChunk = window.openui.onChunk((delta) => {
      if (streamingRef.current) {
        appendToLastAssistant(delta)
      } else if (captionRef.current) {
        // Hero/demo fallback — stream into the caption when no thread turn is open.
        captionRef.current.textContent += delta
      }
    })

    const offDone = window.openui.onDone((result) => {
      streamingRef.current = false
      // Reconcile: the streamed bubble may hold transient tool-call JSON or
      // intermediate turns. Replace it with the authoritative clean final text
      // the agent settled on so no streaming artifacts (or leaked JSON) survive.
      const finalText = result?.text ?? ''
      if (finalText.trim()) {
        setMessages((prev) => {
          if (prev.length === 0) return prev
          const next = prev.slice()
          const last = next[next.length - 1]
          if (last.role === 'assistant') next[next.length - 1] = { ...last, content: finalText }
          return next
        })
      }
      setVoiceState('done')
    })

    const offError = window.openui.onError((msg) => {
      streamingRef.current = false
      setMessages((prev) => {
        if (prev.length === 0) return prev
        const next = prev.slice()
        const last = next[next.length - 1]
        if (last.role === 'assistant' && last.content === '') {
          next[next.length - 1] = { ...last, content: `⚠️ ${msg}` }
          return next
        }
        return prev
      })
      setCaption(`Error: ${msg}`)
      setVoiceState('idle')
      captionLockedRef.current = false
    })

    // Fired by main process after Whisper returns, before the agent streams.
    const offTranscript = window.openui.onTranscript((text) => {
      beginTask(text, 'chat')
      beginTurn(text)
      captionLockedRef.current = true
      setCaption('')
    })

    return () => {
      offChunk()
      offDone()
      offError()
      offTranscript()
    }
  }, [setCaption, captionLockedRef, appendToLastAssistant, beginTurn, beginTask])

  // ── Caption text for each voice state (hero state only) ────────────────
  useEffect(() => {
    switch (voiceState) {
      case 'recording':
        captionLockedRef.current = true
        if (messages.length === 0) setCaption('Recording…')
        break
      case 'transcribing':
        if (messages.length === 0) setCaption('Transcribing…')
        break
      default:
        break
    }
  }, [voiceState, setCaption, captionLockedRef, messages.length])

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

        // Blocks until Whisper + the full agent turn complete.
        // onTranscript / onChunk / onDone / onError update the UI as they fire.
        await window.openui.transcribeAndChat(arrayBuffer, effectiveMime, tier)
      } catch {
        streamingRef.current = false
        setVoiceState('idle')
        captionLockedRef.current = false
      }
    }

    recorder.start(200)
    mediaRecorderRef.current = recorder
    setVoiceState('recording')
  }, [voiceState, recordingRef, captionLockedRef, setCaption, tier, onPermissionNeeded])

  // ── History sidebar handlers ──────────────────────────────────────────
  const handleNewChat = useCallback(() => {
    window.openui.clearHistory()
    streamingRef.current = false
    setMessages([])
    setActiveConvId(null)
    setShowHistory(false)
    setVoiceState('idle')
    setInputText('')
    setFeedbackGiven(null)
    setCaption('')
    captionLockedRef.current = false
  }, [setCaption, captionLockedRef])

  const handleConvSelect = useCallback(
    async (id: string): Promise<void> => {
      setActiveConvId(id)
      setShowHistory(false)
      try {
        const msgs = await window.openui.resumeConversation(id)
        const thread: ChatMsg[] = (msgs as HistoryMsg[])
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content ?? '' }))
        streamingRef.current = false
        setMessages(thread)
        captionLockedRef.current = true
        setVoiceState('idle')
      } catch {
        setMessages([])
      }
    },
    [captionLockedRef]
  )

  // ── Text input send ────────────────────────────────────────────────────
  const handleSend = useCallback(
    async (text: string, opts?: { kind?: 'chat' | 'assigned' }): Promise<void> => {
      const trimmed = text.trim()
      if (!trimmed) return
      if (voiceState === 'recording' || voiceState === 'processing' || voiceState === 'transcribing')
        return

      // Fold any attached files into the message the agent sees, while the
      // thread bubble shows only what the user typed.
      const attached = attachments
      const contextBlock = attached
        .map((f) =>
          f.text !== null
            ? `[Attached file: ${f.name}]\n${f.text}`
            : `[Attached file: ${f.name} — binary/image, not readable as text]`
        )
        .join('\n\n')
      const agentMessage = contextBlock ? `${contextBlock}\n\n${trimmed}` : trimmed

      captionLockedRef.current = true
      setInputText('')
      setAttachments([])
      // Open a task card for the board/activity panel before the agent emits its
      // reset/step events, so the card carries the user's request as its title.
      beginTask(trimmed, opts?.kind ?? 'chat')
      beginTurn(trimmed)

      try {
        await window.openui.chat(agentMessage, tier)
      } catch {
        streamingRef.current = false
        setVoiceState('idle')
        captionLockedRef.current = false
      }
    },
    [voiceState, captionLockedRef, beginTurn, beginTask, attachments, tier]
  )

  // Assign a task straight to the board (from the "+" menu). Same agent path as
  // chat; "assigned" just tags the card so the board surfaces it immediately.
  const handleAssign = useCallback((): void => {
    const text = assignText.trim()
    if (!text) return
    setAssignOpen(false)
    setAssignText('')
    void handleSend(text, { kind: 'assigned' })
  }, [assignText, handleSend])

  // ── Rate the last response (self-improvement loop) ──────────────────────
  const rate = useCallback((kind: 'up' | 'down'): void => {
    setFeedbackGiven(kind) // optimistic — the rating is best-effort and local
    void window.openui.rateLast(kind === 'up' ? 5 : 1).catch(() => {})
  }, [])

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
  // The hero (big mic orb) shows only on a blank, idle session; once a chat is
  // under way we switch to the scrolling conversation thread.
  const showHero = messages.length === 0
  // Pin the sidebar when the window is wide enough; otherwise it slides in.
  const sidebarPinned = wide

  // The composer (input + "+" menu + mic). Rendered centered inside the hero on
  // a blank session, and docked at the bottom of the thread once a chat starts.
  const renderComposer = (variant: 'hero' | 'docked'): JSX.Element => (
    <div className={`ou-composer ${variant}`}>
      {attachments.length > 0 && (
        <div className="ou-attachments">
          {attachments.map((f, i) => (
            <span className="ou-attach-chip" key={`${f.name}-${i}`}>
              <span className="ou-attach-name">{f.name}</span>
              <button
                type="button"
                className="ou-attach-x"
                aria-label={`Remove ${f.name}`}
                onClick={() => setAttachments((a) => a.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="input-strip">
        <PlusMenu
          onAttach={(f) => setAttachments((a) => [...a, f])}
          onConnect={() => setShowConnect(true)}
          onAssign={() => setAssignOpen(true)}
          disabled={isBusy || isRecording}
        />
        <input
          type="text"
          className="ou-composer-input"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSend(inputText)
          }}
          placeholder="Ask OpenUI anything…"
          disabled={isBusy || isRecording}
        />
        {inputText.trim() !== '' && !isBusy && !isRecording && (
          <button
            type="button"
            className="ou-send-btn"
            aria-label="Send"
            title="Send"
            onClick={() => handleSend(inputText)}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
              <path d="M12 20V5M5 12l7-7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
        <button
          type="button"
          aria-label={isRecording ? 'Stop recording' : 'Start voice input'}
          title={isRecording ? 'Stop recording' : 'Voice input'}
          onClick={isBusy ? undefined : handleMicClick}
          disabled={isBusy}
          className={`ou-input-mic${isRecording ? ' recording' : ''}`}
        >
          {isRecording ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" />
            </svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
              <rect x="9" y="2" width="6" height="12" rx="3" fill="currentColor" />
              <path d="M5 10c0 3.866 3.134 7 7 7s7-3.134 7-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              <line x1="12" y1="19" x2="12" y2="22" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          )}
        </button>
      </div>
    </div>
  )

  return (
    <div id="openui-popup">
      <div className="ou-workspace">
      {/* Session sidebar — pinned open on wide windows, slide-in on narrow ones */}
      <div
        className="ou-sidebar"
        style={{
          ...(sidebarPinned
            ? { position: 'relative', width: 260, flexShrink: 0, transform: 'none' }
            : {
                position: 'absolute',
                top: 0,
                left: 0,
                bottom: 0,
                width: 280,
                zIndex: 100,
                transform: showHistory ? 'translateX(0)' : 'translateX(-100%)',
              }),
          transition: 'transform 0.24s cubic-bezier(0.4,0,0.2,1)',
          background: 'rgba(10,10,12,0.98)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          borderRight: '1px solid rgba(255,255,255,0.08)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* New Chat button */}
        <button
          type="button"
          onClick={handleNewChat}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            margin: '12px 10px 4px',
            padding: '7px 12px',
            background: 'rgba(255,255,255,0.07)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 8,
            cursor: 'pointer',
            color: '#e5e5e7',
            fontSize: 12,
            fontFamily: '-apple-system, sans-serif',
            fontWeight: 500,
            transition: 'background 0.12s',
          }}
          onMouseEnter={(e) => {
            ;(e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.12)'
          }}
          onMouseLeave={(e) => {
            ;(e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.07)'
          }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
            <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          New chat
        </button>

        {/* Section label */}
        <div
          style={{
            padding: '10px 14px 4px',
            fontSize: 10,
            fontWeight: 600,
            color: '#636366',
            fontFamily: '-apple-system, sans-serif',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
          }}
        >
          Recent
        </div>

        {/* Conversation list */}
        <ConversationList onSelect={handleConvSelect} selectedId={activeConvId ?? undefined} />
      </div>

      {/* Dim scrim behind the slide-in sidebar (narrow layout only) */}
      {!sidebarPinned && showHistory && (
        <div className="ou-sidebar-scrim" onClick={() => setShowHistory(false)} />
      )}

      {/* Chat column */}
      <div className="ou-chatcol">
      {/* Header */}
      <div className="popup-header">
        <div className="popup-logo-row">
          <div className="popup-orb">
            <div className="popup-orb-dot" />
          </div>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--ou-text)', letterSpacing: '-.02em' }}>
            OpenUI
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <UsageCounter />
          <SubscriptionStatus />
          {/* New chat — quick reset without opening the sidebar */}
          <button
            type="button"
            aria-label="New chat"
            title="New chat"
            onClick={handleNewChat}
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
              padding: 0,
              transition: 'background 0.15s, color 0.15s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--ou-surface-2)'
              e.currentTarget.style.color = 'var(--ou-text)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent'
              e.currentTarget.style.color = '#8e8e93'
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path
                d="M12 5v14M5 12h14"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
          </button>
          {/* History toggle — only needed when the sidebar isn't pinned open */}
          {!sidebarPinned && (
          <button
            type="button"
            aria-label="History"
            title="Conversation history"
            onClick={() => setShowHistory((v) => !v)}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 26,
              height: 26,
              borderRadius: 7,
              border: 'none',
              background: showHistory ? 'rgba(167,139,250,0.15)' : 'transparent',
              cursor: 'pointer',
              color: showHistory ? '#a78bfa' : '#8e8e93',
              padding: 0,
              transition: 'background 0.15s, color 0.15s',
            }}
          >
            {/* Clock / history icon */}
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.7" />
              <path d="M12 7v5l3 3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          )}
          <button
            type="button"
            aria-label="Settings"
            title="Settings"
            onClick={() => setShowSettings(true)}
            style={{
              position: 'relative',
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
            {/* Green dot when a downloaded update is waiting to be installed */}
            {updateState.status === 'downloaded' && (
              <span
                style={{
                  position: 'absolute',
                  top: 2,
                  right: 2,
                  width: 5,
                  height: 5,
                  borderRadius: '50%',
                  background: '#34c759',
                  border: '1px solid rgba(0,0,0,0.6)',
                }}
              />
            )}
          </button>
          <AuthButton />
        </div>
      </div>

      {/* Returning-but-signed-out prompt (hidden while signed in) */}
      <SignInBanner />

      {/* Update banners — shown above the main content when relevant */}
      {onboardingComplete && updateState.status === 'available' && (
        <UpdateBanner
          version={updateState.version ?? ''}
          isMac={isMac}
          onDownload={updateState.canAutoUpdate ? downloadUpdate : openDownloadPage}
          onDismiss={dismiss}
        />
      )}
      {updateState.status === 'downloading' && updateState.downloadProgress && (
        <UpdateProgress {...updateState.downloadProgress} />
      )}
      {onboardingComplete && updateState.status === 'downloaded' && (
        <UpdateReady
          version={updateState.version ?? ''}
          onRestart={installAndRestart}
          onDismiss={dismiss}
        />
      )}

      {/* Scrollable middle region: either the live thread or the centered hero */}
      <div className={`ou-chatbody${showHero ? ' hero' : ''}`}>
      {/* Live conversation thread — the real, working chat view */}
      {!showHero && (
        <div className="ou-thread">
          {messages.map((msg, i) => {
            const isLast = i === messages.length - 1
            const isStreaming = isLast && msg.role === 'assistant' && voiceState === 'processing'
            if (msg.role === 'user') {
              return (
                <div className="ou-msg" key={i}>
                  <span className="ou-msg-role" style={{ alignSelf: 'flex-end' }}>
                    You
                  </span>
                  <div className="ou-bubble user">{msg.content}</div>
                </div>
              )
            }
            const display = cleanAssistantText(msg.content)
            // While the turn is executing, show the dynamic status line above the
            // reply until the first tokens arrive; then the bubble takes over.
            const showThinking = isStreaming && !display.trim()
            return (
              <div className="ou-msg" key={i}>
                <span className="ou-msg-role">OpenUI</span>
                {showThinking && <ThinkingStatus active />}
                {(display.trim() || !isStreaming) && (
                  <div className={`ou-bubble ai${isStreaming ? ' ou-caret' : ''}`}>{display}</div>
                )}
              </div>
            )
          })}

          {/* Center tool-call timeline (#1/#2) — every tool call + any real
              parallel sub-agent group for the current turn, inline in the thread. */}
          <Timeline />

          {/* Was-this-helpful rating — feeds the local self-improvement loop. */}
          {voiceState === 'done' && <FeedbackButtons given={feedbackGiven} onRate={rate} />}

          <div ref={threadEndRef} />
        </div>
      )}

      {/* Hero greeting — the centered headline above the composer */}
      {showHero && <h1 className="ou-hero-greeting">What can I help you with?</h1>}

      {/* Mic stage — kept mounted so GSAP's rings/bars keep running; hidden off-hero */}
      <div className="mic-stage" style={{ display: showHero ? undefined : 'none' }}>
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

      {/* Hero composer + suggestion chips — centered, only on a blank session */}
      {showHero && renderComposer('hero')}
      {showHero && (
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
      )}
      </div>
      {/* /ou-chatbody */}

      {/* Docked composer — pinned to the bottom of the thread mid-conversation */}
      {!showHero && renderComposer('docked')}
      </div>
      {/* /ou-chatcol */}
      </div>
      {/* /ou-workspace */}

      {showSettings && (
        <SettingsModal
          onClose={() => setShowSettings(false)}
          appVersion={appVersion}
          updateStatus={updateState.status}
          onCheckForUpdates={checkForUpdates}
        />
      )}

      {/* Connect-apps (MCP) panel — opened from the "+" menu */}
      {showConnect && <ConnectAppsModal onClose={() => setShowConnect(false)} />}

      {/* Assign-a-task composer — opened from the "+" menu */}
      {assignOpen && (
        <div
          className="ou-modal-scrim"
          onMouseDown={(e) => {
            e.stopPropagation()
            setAssignOpen(false)
          }}
        >
          <div className="ou-assign-panel" onMouseDown={(e) => e.stopPropagation()}>
            <div className="ou-assign-header">
              <h3 className="ou-assign-title">Assign a task</h3>
              <button type="button" className="ou-conn-close" aria-label="Close" onClick={() => setAssignOpen(false)}>
                ×
              </button>
            </div>
            <p className="ou-assign-sub">Describe the job. OpenUI runs it and tracks progress in the task board.</p>
            <textarea
              className="ou-assign-input"
              value={assignText}
              onChange={(e) => setAssignText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleAssign()
              }}
              placeholder="e.g. Open my browser, find the latest OpenUI release, and summarise the changelog."
              rows={4}
              autoFocus
            />
            <div className="ou-assign-actions">
              <button type="button" className="ou-assign-cancel" onClick={() => setAssignOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="ou-assign-go"
                onClick={handleAssign}
                disabled={assignText.trim() === ''}
              >
                Assign task
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Local AI status footer */}
      <LocalAIStatus />
    </div>
  )
}

/**
 * Compact "Was this helpful?" rating shown under a completed response. Sends a
 * 👍 (rating 5) or 👎 (rating 1) to the local self-improvement loop, then shows a
 * brief thank-you. Purely additive — ignoring it has no effect on the chat.
 */
function FeedbackButtons({
  given,
  onRate
}: {
  given: null | 'up' | 'down'
  onRate: (kind: 'up' | 'down') => void
}): JSX.Element {
  if (given) {
    return (
      <div
        style={{
          textAlign: 'center',
          marginTop: 8,
          fontSize: 11,
          color: 'rgba(255,255,255,0.55)',
          fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif'
        }}
      >
        Thanks — OpenUI learns from your feedback.
      </div>
    )
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        marginTop: 8
      }}
    >
      <span
        style={{
          fontSize: 11,
          color: 'rgba(255,255,255,0.5)',
          fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif'
        }}
      >
        Was this helpful?
      </span>
      <RatingButton label="Good response" emoji="👍" onClick={() => onRate('up')} />
      <RatingButton label="Not right" emoji="👎" onClick={() => onRate('down')} />
    </div>
  )
}

function RatingButton({
  label,
  emoji,
  onClick
}: {
  label: string
  emoji: string
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      style={{
        border: 'none',
        background: 'rgba(255,255,255,0.10)',
        borderRadius: 14,
        width: 28,
        height: 24,
        fontSize: 13,
        lineHeight: 1,
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        transition: 'background 0.15s ease'
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.22)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.10)')}
    >
      {emoji}
    </button>
  )
}
