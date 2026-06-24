import Anthropic from '@anthropic-ai/sdk'
import { BrowserWindow, ipcMain } from 'electron'
import { transcribeWithWhisper, synthesizeSpeech } from './voice'
import { coerceTier } from './agent'
import type { Tier } from './tools'

// ── Types ───────────────────────────────────────────────────────────────────

export type InterviewState = 'idle' | 'asking' | 'listening' | 'evaluating' | 'complete'

export interface InterviewStatusPayload {
  state: InterviewState
  detail?: string
}

export interface InterviewQuestionPayload {
  text: string
  audioBase64: string
  questionNumber: number
}

export interface InterviewTranscriptPayload {
  speaker: 'interviewer' | 'candidate'
  text: string
}

interface InterviewTurn {
  question: string
  answer?: string
}

interface InterviewSession {
  resume: string
  jobDescription: string
  tier: Tier
  turns: InterviewTurn[]
  state: InterviewState
}

// ── Constants ───────────────────────────────────────────────────────────────

const MAX_QUESTIONS = 10
const MAX_RESUME_CHARS = 8_000
const MAX_JD_CHARS = 4_000
const MAX_AUDIO_BYTES = 25 * 1024 * 1024
const ALLOWED_AUDIO_MIME = /^audio\/(webm|ogg|mp4|mpeg|wav|x-m4a)(;.*)?$/

const INTERVIEWER_SYSTEM_PROMPT = `You are an expert technical interviewer conducting a professional candidate screening interview. You have been provided with the candidate's resume and the job description.

Your personality:
- Warm, professional, and completely natural — you put the candidate at ease.
- You actively listen and reference specific details from the candidate's previous answers and resume.
- You use short conversational filler phrases to acknowledge responses before asking your next question. Examples: "I see", "That's interesting", "Got it, thanks", "That makes sense", "Great, I appreciate you sharing that", "Hmm, that's a solid example", "I like that approach", "Thanks for walking me through that".
- Keep each question concise — 2 to 3 sentences maximum.
- Ask exactly ONE question at a time. Never list multiple questions.

Interview structure (follow this progression naturally):
1. Warm greeting and one easy opener about their background or current role (turn 1).
2. Explore the candidate's most relevant experience and technical skills (turns 2–4).
3. A situational or problem-solving question specific to the role (turns 5–6).
4. A behavioral question using the STAR format — teamwork, conflict, or leadership (turns 7–8).
5. Role-fit and motivation questions (turns 9–10).
6. Closing: thank the candidate and ask if they have any questions for you (after turn 10).

Rules:
- Output ONLY what the interviewer says out loud. No stage directions, no JSON, no markdown, no preamble — just natural spoken words.
- Keep your response to 2–4 sentences.
- Never repeat a question already asked.
- Reference the candidate's resume and prior answers to personalise every follow-up.`

// ── Module-level session state ───────────────────────────────────────────────

let activeSession: InterviewSession | null = null

// ── Helpers ─────────────────────────────────────────────────────────────────

function emit(win: BrowserWindow, channel: string, ...args: unknown[]): void {
  if (!win.isDestroyed()) win.webContents.send(channel, ...args)
}

/**
 * Build the Anthropic messages array from the current session.
 *
 * Structure:
 *   user:      [SETUP] job description + resume + "begin now"
 *   assistant: turn[0].question
 *   user:      [Candidate]: turn[0].answer   ← only present when answered
 *   assistant: turn[1].question
 *   ...
 *
 * When closingHint is provided it is appended to the final user (candidate)
 * message so that Claude wraps up without adding a second consecutive user turn.
 */
function buildMessages(
  session: InterviewSession,
  closingHint?: string
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const setup = [
    '[INTERVIEW SETUP]',
    `JOB DESCRIPTION:\n${session.jobDescription}`,
    `CANDIDATE RESUME:\n${session.resume}`,
    'Begin the interview now.'
  ].join('\n\n')

  const msgs: Array<{ role: 'user' | 'assistant'; content: string }> = [
    { role: 'user', content: setup }
  ]

  const { turns } = session
  for (let i = 0; i < turns.length; i++) {
    msgs.push({ role: 'assistant', content: turns[i].question })
    if (turns[i].answer !== undefined) {
      const isLast = i === turns.length - 1
      const answerContent =
        isLast && closingHint
          ? `[Candidate]: ${turns[i].answer}\n\n${closingHint}`
          : `[Candidate]: ${turns[i].answer}`
      msgs.push({ role: 'user', content: answerContent })
    }
  }

  return msgs
}

/** Call Claude to produce the interviewer's next question / closing remark. */
async function generateQuestion(session: InterviewSession, isClosing = false): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required for the AI interviewer.')

  const closingHint = isClosing
    ? '[SYSTEM: This is the final turn. Please close the interview warmly, thank the candidate for their time, and invite them to ask any questions they may have for you.]'
    : undefined

  const messages = buildMessages(session, closingHint)
  const client = new Anthropic({ apiKey })

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 300,
    system: INTERVIEWER_SYSTEM_PROMPT,
    messages
  })

  const block = response.content[0]
  if (block.type !== 'text') throw new Error('Unexpected response type from interviewer model.')
  return block.text.trim()
}

// ── Core flow ────────────────────────────────────────────────────────────────

async function startInterview(
  win: BrowserWindow,
  resume: string,
  jobDescription: string,
  tier: Tier
): Promise<void> {
  activeSession = { resume, jobDescription, tier, turns: [], state: 'asking' }

  emit(win, 'openui:interview:status', {
    state: 'asking',
    detail: 'Generating opening question…'
  } satisfies InterviewStatusPayload)

  const question = await generateQuestion(activeSession)
  activeSession.turns.push({ question })

  emit(win, 'openui:interview:transcript', {
    speaker: 'interviewer',
    text: question
  } satisfies InterviewTranscriptPayload)

  const audioBuffer = await synthesizeSpeech(question)

  emit(win, 'openui:interview:question', {
    text: question,
    audioBase64: audioBuffer.toString('base64'),
    questionNumber: activeSession.turns.length
  } satisfies InterviewQuestionPayload)

  activeSession.state = 'listening'
  emit(win, 'openui:interview:status', {
    state: 'listening',
    detail: 'Your turn — press the mic to answer'
  } satisfies InterviewStatusPayload)
}

async function processAnswer(
  win: BrowserWindow,
  audioBuffer: Buffer,
  mimeType: string
): Promise<void> {
  if (!activeSession || activeSession.state !== 'listening') return

  activeSession.state = 'evaluating'
  emit(win, 'openui:interview:status', {
    state: 'evaluating',
    detail: 'Processing your answer…'
  } satisfies InterviewStatusPayload)

  // Transcribe the candidate's audio response.
  const candidateText = await transcribeWithWhisper(audioBuffer, mimeType)
  activeSession.turns[activeSession.turns.length - 1].answer = candidateText

  emit(win, 'openui:interview:transcript', {
    speaker: 'candidate',
    text: candidateText
  } satisfies InterviewTranscriptPayload)

  const isLastQuestion = activeSession.turns.length >= MAX_QUESTIONS

  activeSession.state = 'asking'
  emit(win, 'openui:interview:status', {
    state: 'asking',
    detail: isLastQuestion ? 'Wrapping up…' : 'Generating follow-up question…'
  } satisfies InterviewStatusPayload)

  const question = await generateQuestion(activeSession, isLastQuestion)
  activeSession.turns.push({ question })

  emit(win, 'openui:interview:transcript', {
    speaker: 'interviewer',
    text: question
  } satisfies InterviewTranscriptPayload)

  const ttsBuf = await synthesizeSpeech(question)
  emit(win, 'openui:interview:question', {
    text: question,
    audioBase64: ttsBuf.toString('base64'),
    questionNumber: activeSession.turns.length
  } satisfies InterviewQuestionPayload)

  if (isLastQuestion) {
    activeSession.state = 'complete'
    emit(win, 'openui:interview:status', {
      state: 'complete',
      detail: 'Interview complete'
    } satisfies InterviewStatusPayload)
  } else {
    activeSession.state = 'listening'
    emit(win, 'openui:interview:status', {
      state: 'listening',
      detail: 'Your turn — press the mic to answer'
    } satisfies InterviewStatusPayload)
  }
}

// ── IPC registration ─────────────────────────────────────────────────────────

export function registerInterviewerIPC(win: BrowserWindow): void {
  ipcMain.handle('openui:interview:start', async (_event, payload: unknown) => {
    if (typeof payload !== 'object' || payload === null) {
      emit(win, 'openui:interview:error', 'Invalid start payload.')
      return
    }
    const { resume, jobDescription, tier } = payload as Record<string, unknown>

    if (typeof resume !== 'string' || !resume.trim()) {
      emit(win, 'openui:interview:error', 'Resume is required.')
      return
    }
    if (typeof jobDescription !== 'string' || !jobDescription.trim()) {
      emit(win, 'openui:interview:error', 'Job description is required.')
      return
    }

    const safeResume = resume.trim().slice(0, MAX_RESUME_CHARS)
    const safeJD = jobDescription.trim().slice(0, MAX_JD_CHARS)
    const safeTier = coerceTier(tier)

    try {
      await startInterview(win, safeResume, safeJD, safeTier)
    } catch (err) {
      activeSession = null
      const msg = err instanceof Error ? err.message : String(err)
      emit(win, 'openui:interview:error', `Failed to start interview: ${msg}`)
    }
  })

  ipcMain.handle('openui:interview:answer', async (_event, payload: unknown) => {
    if (!activeSession) {
      emit(win, 'openui:interview:error', 'No active interview session.')
      return
    }
    if (typeof payload !== 'object' || payload === null) {
      emit(win, 'openui:interview:error', 'Invalid answer payload.')
      return
    }
    const { audio, mimeType } = payload as Record<string, unknown>

    if (!ArrayBuffer.isView(audio) || audio.byteLength === 0 || audio.byteLength > MAX_AUDIO_BYTES) {
      emit(win, 'openui:interview:error', 'Invalid audio: empty or too large.')
      return
    }
    const safeMime =
      typeof mimeType === 'string' && ALLOWED_AUDIO_MIME.test(mimeType) ? mimeType : 'audio/webm'
    const audioBuf = Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength)

    try {
      await processAnswer(win, audioBuf, safeMime)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      emit(win, 'openui:interview:error', `Error processing answer: ${msg}`)
      if (activeSession) {
        activeSession.state = 'listening'
        emit(win, 'openui:interview:status', {
          state: 'listening',
          detail: 'Something went wrong — please try again'
        } satisfies InterviewStatusPayload)
      }
    }
  })

  ipcMain.on('openui:interview:stop', () => {
    activeSession = null
    emit(win, 'openui:interview:status', {
      state: 'idle',
      detail: undefined
    } satisfies InterviewStatusPayload)
  })
}
