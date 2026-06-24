import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { PermissionTarget, InterviewEntry, InterviewState } from '../env'

// ── Shared voice-state type used by both modes ───────────────────────────────
type VoiceState = 'idle' | 'recording' | 'transcribing' | 'processing' | 'done'

// ── Top-level app mode ────────────────────────────────────────────────────────
type AppMode = 'assistant' | 'interview'

interface Props {
  recordingRef: MutableRefObject<boolean>
  captionLockedRef: MutableRefObject<boolean>
  onPermissionNeeded?: (permission: PermissionTarget) => void
}

const DEFAULT_TIER = 'pro' as const

function pickMimeType(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg']
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) ?? ''
}

let _entrySeq = 0

// ── Interview Setup Panel ─────────────────────────────────────────────────────

interface SetupPanelProps {
  onStart: (resume: string, jd: string) => void
  onCancel: () => void
}

function SetupPanel({ onStart, onCancel }: SetupPanelProps): JSX.Element {
  const [resume, setResume] = useState('')
  const [jd, setJd] = useState('')
  const canSubmit = resume.trim().length > 20 && jd.trim().length > 20

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '0 2px' }}>
      <p style={{ margin: 0, fontSize: 12, color: '#636366', lineHeight: 1.5 }}>
        Paste the candidate&apos;s resume and the job description. The AI interviewer
        will ask natural follow-up questions based on both.
      </p>
      <label style={{ fontSize: 11, fontWeight: 600, color: '#48484a' }}>
        Resume
        <textarea
          value={resume}
          onChange={(e) => setResume(e.target.value)}
          placeholder="Paste resume text here…"
          rows={5}
          style={{
            display: 'block',
            marginTop: 4,
            width: '100%',
            boxSizing: 'border-box',
            fontSize: 11,
            fontFamily: '-apple-system, sans-serif',
            color: '#1c1c1e',
            background: '#f2f2f7',
            border: '1px solid #e5e5ea',
            borderRadius: 8,
            padding: '6px 8px',
            resize: 'vertical',
            outline: 'none'
          }}
        />
      </label>
      <label style={{ fontSize: 11, fontWeight: 600, color: '#48484a' }}>
        Job Description
        <textarea
          value={jd}
          onChange={(e) => setJd(e.target.value)}
          placeholder="Paste job description here…"
          rows={4}
          style={{
            display: 'block',
            marginTop: 4,
            width: '100%',
            boxSizing: 'border-box',
            fontSize: 11,
            fontFamily: '-apple-system, sans-serif',
            color: '#1c1c1e',
            background: '#f2f2f7',
            border: '1px solid #e5e5ea',
            borderRadius: 8,
            padding: '6px 8px',
            resize: 'vertical',
            outline: 'none'
          }}
        />
      </label>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={() => canSubmit && onStart(resume.trim(), jd.trim())}
          disabled={!canSubmit}
          style={{
            flex: 1,
            padding: '7px 0',
            borderRadius: 8,
            border: 'none',
            background: canSubmit ? 'linear-gradient(135deg,#6e8efb,#a777e3)' : '#e5e5ea',
            color: canSubmit ? '#fff' : '#aeaeb2',
            fontSize: 12,
            fontWeight: 600,
            cursor: canSubmit ? 'pointer' : 'not-allowed',
            transition: 'background 0.2s'
          }}
        >
          Start Interview
        </button>
        <button
          onClick={onCancel}
          style={{
            padding: '7px 14px',
            borderRadius: 8,
            border: '1px solid #e5e5ea',
            background: 'transparent',
            color: '#636366',
            fontSize: 12,
            cursor: 'pointer'
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

// ── Interview Live Panel ──────────────────────────────────────────────────────

interface LivePanelProps {
  entries: InterviewEntry[]
  interviewState: InterviewState
  stateDetail: string
  isRecording: boolean
  isBusy: boolean
  onMicClick: () => void
  onStop: () => void
}

function LivePanel({
  entries,
  interviewState,
  stateDetail,
  isRecording,
  isBusy,
  onMicClick,
  onStop
}: LivePanelProps): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to the bottom whenever a new entry is added.
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
  }, [entries.length])

  const statusColor: Record<InterviewState, string> = {
    idle: '#8e8e93',
    asking: '#007aff',
    listening: '#34c759',
    evaluating: '#ff9500',
    complete: '#636366'
  }

  const canAnswer = interviewState === 'listening'
  const isComplete = interviewState === 'complete'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* Status bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '5px 10px',
          background: '#f2f2f7',
          borderRadius: 8
        }}
      >
        <div
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: statusColor[interviewState],
            flexShrink: 0,
            animation: interviewState === 'asking' || interviewState === 'evaluating'
              ? 'pulse 1.2s ease-in-out infinite'
              : 'none'
          }}
        />
        <span style={{ fontSize: 11, color: '#48484a', flex: 1 }}>{stateDetail}</span>
        {isRecording && (
          <span style={{ fontSize: 10, color: '#ff3b30', fontWeight: 600 }}>REC</span>
        )}
      </div>

      {/* Transcript scroll area */}
      <div
        ref={listRef}
        style={{
          maxHeight: 260,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          padding: '2px 0'
        }}
      >
        {entries.length === 0 && (
          <p style={{ margin: 0, fontSize: 12, color: '#aeaeb2', textAlign: 'center', padding: '20px 0' }}>
            Interview starting…
          </p>
        )}
        {entries.map((entry) => {
          const isInterviewer = entry.speaker === 'interviewer'
          return (
            <div
              key={entry.id}
              style={{
                display: 'flex',
                justifyContent: isInterviewer ? 'flex-start' : 'flex-end'
              }}
            >
              <div
                style={{
                  maxWidth: '85%',
                  padding: '7px 10px',
                  borderRadius: isInterviewer ? '4px 12px 12px 12px' : '12px 4px 12px 12px',
                  background: isInterviewer
                    ? 'linear-gradient(135deg,#e8eaf6,#f3e5f5)'
                    : 'linear-gradient(135deg,#e8f5e9,#f1f8e9)',
                  fontSize: 12,
                  lineHeight: 1.5,
                  color: '#1c1c1e'
                }}
              >
                <div
                  style={{
                    fontSize: 9,
                    fontWeight: 700,
                    letterSpacing: '0.06em',
                    color: isInterviewer ? '#7c4dff' : '#2e7d32',
                    marginBottom: 3,
                    textTransform: 'uppercase'
                  }}
                >
                  {isInterviewer ? 'Interviewer' : 'Candidate'}
                </div>
                {entry.text}
              </div>
            </div>
          )
        })}
      </div>

      {/* Controls */}
      {isComplete ? (
        <div
          style={{
            padding: '8px 12px',
            background: '#f2f2f7',
            borderRadius: 10,
            fontSize: 12,
            color: '#636366',
            textAlign: 'center'
          }}
        >
          Interview complete — thank you!
          <button
            onClick={onStop}
            style={{
              display: 'block',
              margin: '6px auto 0',
              padding: '4px 16px',
              borderRadius: 8,
              border: '1px solid #e5e5ea',
              background: 'transparent',
              fontSize: 11,
              color: '#636366',
              cursor: 'pointer'
            }}
          >
            Close
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* Mic button — only active when state is 'listening' */}
          <div
            onClick={canAnswer || isRecording ? onMicClick : undefined}
            style={{
              width: 42,
              height: 42,
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              cursor: canAnswer || isRecording ? 'pointer' : 'not-allowed',
              background: isRecording
                ? 'linear-gradient(145deg,#ff6b6b,#ff3b30,#cc0000)'
                : canAnswer
                  ? 'linear-gradient(145deg,#6e8efb,#a777e3)'
                  : '#e5e5ea',
              boxShadow: isRecording
                ? '0 4px 14px rgba(255,59,48,0.4)'
                : canAnswer
                  ? '0 4px 14px rgba(110,142,251,0.35)'
                  : 'none',
              transition: 'background 0.25s, box-shadow 0.25s',
              opacity: isBusy && !isRecording ? 0.4 : 1
            }}
          >
            {isRecording ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <rect x="6" y="6" width="12" height="12" rx="2" fill="white" />
              </svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                <rect x="9" y="2" width="6" height="12" rx="3" fill="white" />
                <path d="M5 10c0 3.866 3.134 7 7 7s7-3.134 7-7" stroke="white" strokeWidth="1.8" strokeLinecap="round" />
                <line x1="12" y1="19" x2="12" y2="22" stroke="white" strokeWidth="1.8" strokeLinecap="round" />
                <line x1="8.5" y1="22" x2="15.5" y2="22" stroke="white" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            )}
          </div>
          <span style={{ fontSize: 11, color: '#8e8e93', flex: 1 }}>
            {isRecording
              ? 'Recording… tap to stop'
              : canAnswer
                ? 'Tap mic to answer'
                : 'Wait for the question to finish…'}
          </span>
          <button
            onClick={onStop}
            style={{
              padding: '4px 10px',
              borderRadius: 8,
              border: '1px solid #e5e5ea',
              background: 'transparent',
              fontSize: 10,
              color: '#aeaeb2',
              cursor: 'pointer'
            }}
          >
            End
          </button>
        </div>
      )}
    </div>
  )
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function AssistantPopup({ recordingRef, captionLockedRef, onPermissionNeeded }: Props): JSX.Element {
  // ── Assistant mode state ────────────────────────────────────────────────
  const [voiceState, setVoiceState] = useState<VoiceState>('idle')
  const [transcript, setTranscript] = useState<string | null>(null)
  const [inputText, setInputText] = useState('')

  const captionRef = useRef<HTMLDivElement>(null)
  const soundBarsRef = useRef<HTMLDivElement>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const analyserRef = useRef<AnalyserNode | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const animFrameRef = useRef<number | null>(null)

  // ── Interview mode state ────────────────────────────────────────────────
  const [appMode, setAppMode] = useState<AppMode>('assistant')
  const [interviewPhase, setInterviewPhase] = useState<'setup' | 'live'>('setup')
  const [interviewState, setInterviewState] = useState<InterviewState>('idle')
  const [stateDetail, setStateDetail] = useState<string>('Ready')
  const [interviewEntries, setInterviewEntries] = useState<InterviewEntry[]>([])
  const [ivRecording, setIvRecording] = useState(false)

  // Recording infrastructure reused for interview answers.
  const ivMediaRecorderRef = useRef<MediaRecorder | null>(null)
  const ivAudioChunksRef = useRef<Blob[]>([])
  const ivStreamRef = useRef<MediaStream | null>(null)
  const ivAudioRef = useRef<HTMLAudioElement | null>(null)

  // ── Caption helper ──────────────────────────────────────────────────────
  const setCaption = useCallback((text: string): void => {
    if (captionRef.current) captionRef.current.textContent = text
  }, [])

  // ── Assistant IPC listeners ─────────────────────────────────────────────
  useEffect(() => {
    const offChunk = window.openui.onChunk((delta) => {
      if (captionRef.current) captionRef.current.textContent += delta
    })
    const offDone = window.openui.onDone(() => setVoiceState('done'))
    const offError = window.openui.onError((msg) => {
      setCaption(`Error: ${msg}`)
      setVoiceState('idle')
      captionLockedRef.current = false
    })
    const offTranscript = window.openui.onTranscript((text) => {
      setTranscript(text)
      setVoiceState('processing')
      setCaption('')
    })
    return () => { offChunk(); offDone(); offError(); offTranscript() }
  }, [setCaption, captionLockedRef])

  // ── Interview IPC listeners ─────────────────────────────────────────────
  useEffect(() => {
    const offQuestion = window.openui.onInterviewQuestion((data) => {
      // Play TTS audio for the question.
      try {
        const bytes = Uint8Array.from(atob(data.audioBase64), (c) => c.charCodeAt(0))
        const blob = new Blob([bytes], { type: 'audio/mpeg' })
        const url = URL.createObjectURL(blob)
        if (ivAudioRef.current) {
          ivAudioRef.current.pause()
          URL.revokeObjectURL(ivAudioRef.current.src)
        }
        const audio = new Audio(url)
        ivAudioRef.current = audio
        audio.play().catch(() => {})
        audio.onended = (): void => URL.revokeObjectURL(url)
      } catch {
        // TTS playback is non-critical — transcript still shows the text.
      }
    })

    const offTranscript = window.openui.onInterviewTranscript((data) => {
      setInterviewEntries((prev) => [
        ...prev,
        { speaker: data.speaker, text: data.text, id: ++_entrySeq }
      ])
    })

    const offStatus = window.openui.onInterviewStatus((data) => {
      setInterviewState(data.state as InterviewState)
      setStateDetail(data.detail ?? '')
    })

    const offError = window.openui.onInterviewError((msg) => {
      setStateDetail(`Error: ${msg}`)
      setInterviewState('listening')
    })

    return () => { offQuestion(); offTranscript(); offStatus(); offError() }
  }, [])

  // ── Caption for each voice state (assistant mode) ───────────────────────
  useEffect(() => {
    if (appMode !== 'assistant') return
    if (voiceState === 'recording') {
      captionLockedRef.current = true
      setCaption('Recording…')
    } else if (voiceState === 'transcribing') {
      setCaption('Transcribing…')
    }
  }, [voiceState, setCaption, captionLockedRef, appMode])

  // ── Cleanup on unmount ──────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (animFrameRef.current !== null) cancelAnimationFrame(animFrameRef.current)
      mediaRecorderRef.current?.stop()
      streamRef.current?.getTracks().forEach((t) => t.stop())
      audioCtxRef.current?.close().catch(() => {})
      ivMediaRecorderRef.current?.stop()
      ivStreamRef.current?.getTracks().forEach((t) => t.stop())
      if (ivAudioRef.current) {
        ivAudioRef.current.pause()
        try { URL.revokeObjectURL(ivAudioRef.current.src) } catch { /* no-op */ }
      }
    }
  }, [])

  // ── Assistant mic button ────────────────────────────────────────────────
  const handleMicClick = useCallback(async (): Promise<void> => {
    if (voiceState === 'recording') {
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
    if (voiceState !== 'idle' && voiceState !== 'done') return

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      onPermissionNeeded?.('microphone')
      setCaption('Microphone access denied.')
      return
    }

    streamRef.current = stream
    const audioCtx = new AudioContext()
    audioCtxRef.current = audioCtx
    const source = audioCtx.createMediaStreamSource(stream)
    const analyser = audioCtx.createAnalyser()
    analyser.fftSize = 128
    source.connect(analyser)
    analyserRef.current = analyser
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
        await window.openui.transcribeAndChat(arrayBuffer, effectiveMime, DEFAULT_TIER)
      } catch {
        setVoiceState('idle')
        captionLockedRef.current = false
      }
    }

    recorder.start(200)
    mediaRecorderRef.current = recorder
    setVoiceState('recording')
  }, [voiceState, recordingRef, captionLockedRef, setCaption, onPermissionNeeded])

  // ── Interview mic button ────────────────────────────────────────────────
  const handleInterviewMicClick = useCallback(async (): Promise<void> => {
    if (ivRecording) {
      // Stop recording — onstop will send audio to main.
      ivMediaRecorderRef.current?.stop()
      ivStreamRef.current?.getTracks().forEach((t) => t.stop())
      ivStreamRef.current = null
      setIvRecording(false)
      return
    }
    if (interviewState !== 'listening') return

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      onPermissionNeeded?.('microphone')
      return
    }

    ivStreamRef.current = stream
    const mimeType = pickMimeType()
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
    ivAudioChunksRef.current = []

    recorder.ondataavailable = (e): void => {
      if (e.data.size > 0) ivAudioChunksRef.current.push(e.data)
    }

    recorder.onstop = async (): Promise<void> => {
      try {
        const effectiveMime = recorder.mimeType || 'audio/webm'
        const blob = new Blob(ivAudioChunksRef.current, { type: effectiveMime })
        const arrayBuffer = await blob.arrayBuffer()
        await window.openui.sendInterviewAnswer(arrayBuffer, effectiveMime)
      } catch {
        setStateDetail('Failed to send answer — please try again.')
      }
    }

    recorder.start(200)
    ivMediaRecorderRef.current = recorder
    setIvRecording(true)
  }, [ivRecording, interviewState, onPermissionNeeded])

  // ── Text input send (assistant mode) ───────────────────────────────────
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
        await window.openui.chat(trimmed, DEFAULT_TIER)
      } catch {
        setVoiceState('idle')
        captionLockedRef.current = false
      }
    },
    [voiceState, captionLockedRef, setCaption]
  )

  // ── Interview start / stop ──────────────────────────────────────────────
  const handleInterviewStart = useCallback(async (resume: string, jd: string): Promise<void> => {
    setInterviewEntries([])
    setInterviewState('asking')
    setStateDetail('Starting interview…')
    setInterviewPhase('live')
    try {
      await window.openui.startInterview(resume, jd, DEFAULT_TIER)
    } catch {
      setStateDetail('Failed to start interview.')
      setInterviewPhase('setup')
    }
  }, [])

  const handleInterviewStop = useCallback((): void => {
    window.openui.stopInterview()
    ivMediaRecorderRef.current?.stop()
    ivStreamRef.current?.getTracks().forEach((t) => t.stop())
    ivStreamRef.current = null
    setIvRecording(false)
    setInterviewPhase('setup')
    setInterviewEntries([])
    setInterviewState('idle')
    setStateDetail('Ready')
  }, [])

  // ── Mode toggle ─────────────────────────────────────────────────────────
  const toggleMode = useCallback((): void => {
    if (appMode === 'interview') {
      handleInterviewStop()
    }
    setAppMode((m) => (m === 'assistant' ? 'interview' : 'assistant'))
  }, [appMode, handleInterviewStop])

  const isRecording = voiceState === 'recording'
  const isBusy = voiceState === 'transcribing' || voiceState === 'processing'

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div id="openui-popup" style={appMode === 'interview' ? { maxHeight: 'none' } : undefined}>
      {/* Header — always shown */}
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
          {/* Mode toggle chip */}
          <button
            onClick={toggleMode}
            style={{
              padding: '3px 10px',
              borderRadius: 20,
              border: 'none',
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: '0.03em',
              cursor: 'pointer',
              background: appMode === 'interview'
                ? 'linear-gradient(135deg,#6e8efb,#a777e3)'
                : '#f2f2f7',
              color: appMode === 'interview' ? '#fff' : '#636366',
              transition: 'background 0.2s'
            }}
          >
            {appMode === 'interview' ? '✕ Exit Interview' : '🎙 Interview Mode'}
          </button>
          <div className="popup-status">
            <div className="status-dot" />
            <span style={{ fontSize: 11, color: '#8e8e93', fontWeight: 500 }}>Local · Private</span>
          </div>
        </div>
      </div>

      {appMode === 'assistant' ? (
        /* ─── Assistant Mode ──────────────────────────────────────────────── */
        <>
          {/* Mic stage */}
          <div className="mic-stage">
            <div id="ring-1" className="mic-ring" />
            <div id="ring-2" className="mic-ring" />
            <div id="ring-3" className="mic-ring" />
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
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
                  <rect x="6" y="6" width="12" height="12" rx="2.5" fill="white" />
                </svg>
              ) : (
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

          <div
            id="transcript-bubble"
            style={{ display: transcript !== null ? '' : 'none' }}
          >
            <p id="transcript-text">{transcript ?? ''}</p>
          </div>

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
              onKeyDown={(e) => { if (e.key === 'Enter') handleSend(inputText) }}
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
        </>
      ) : (
        /* ─── Interview Mode ──────────────────────────────────────────────── */
        <div style={{ padding: '4px 2px 2px' }}>
          {interviewPhase === 'setup' ? (
            <SetupPanel
              onStart={handleInterviewStart}
              onCancel={() => {
                setAppMode('assistant')
              }}
            />
          ) : (
            <LivePanel
              entries={interviewEntries}
              interviewState={interviewState}
              stateDetail={stateDetail}
              isRecording={ivRecording}
              isBusy={interviewState === 'asking' || interviewState === 'evaluating'}
              onMicClick={handleInterviewMicClick}
              onStop={handleInterviewStop}
            />
          )}
        </div>
      )}
    </div>
  )
}
