import OpenAI, { toFile } from 'openai'
import * as https from 'node:https'
import { BrowserWindow, ipcMain } from 'electron'
import { coerceTier, handleChat } from './agent'

function emit(win: BrowserWindow, channel: string, ...args: unknown[]): void {
  if (!win.isDestroyed()) win.webContents.send(channel, ...args)
}

// Whisper rejects files larger than 25 MB; reject oversized buffers up front so
// a hostile/forged IPC message can't force a huge allocation or upload.
const MAX_AUDIO_BYTES = 25 * 1024 * 1024
const ALLOWED_AUDIO_MIME = /^audio\/(webm|ogg|mp4|mpeg|wav|x-m4a)(;.*)?$/

export async function transcribeWithWhisper(audioBuffer: Buffer, mimeType: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    throw new Error(
      'OPENAI_API_KEY is not set — Whisper transcription requires an OpenAI API key.'
    )
  }

  const client = new OpenAI({ apiKey })
  const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp4') ? 'mp4' : 'webm'

  const result = await client.audio.transcriptions.create({
    file: await toFile(audioBuffer, `recording.${ext}`, { type: mimeType }),
    model: 'whisper-1'
  })

  return result.text.trim()
}

// ── Text-to-Speech ──────────────────────────────────────────────────────────

function httpsPost(url: string, body: string, headers: Record<string, string>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const bodyBytes = Buffer.from(body, 'utf8')
    const req = https.request(
      {
        method: 'POST',
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        headers: { ...headers, 'Content-Length': bodyBytes.byteLength }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const buf = Buffer.concat(chunks)
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${buf.toString('utf8').slice(0, 200)}`))
          } else {
            resolve(buf)
          }
        })
      }
    )
    req.on('error', reject)
    req.write(bodyBytes)
    req.end()
  })
}

// ElevenLabs voice ID — overridable via ELEVENLABS_VOICE_ID env var.
// Default: "Rachel" (21m00Tcm4TlvDq8ikWAM) — neutral, professional female voice.
const DEFAULT_ELEVENLABS_VOICE = '21m00Tcm4TlvDq8ikWAM'

async function synthesizeWithElevenLabs(text: string, apiKey: string): Promise<Buffer> {
  const voiceId = process.env.ELEVENLABS_VOICE_ID ?? DEFAULT_ELEVENLABS_VOICE
  return httpsPost(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
    JSON.stringify({
      text,
      model_id: 'eleven_monolingual_v1',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 }
    }),
    {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg'
    }
  )
}

/**
 * Synthesize speech from text. Uses ElevenLabs when ELEVENLABS_API_KEY is set
 * (richer voices); falls back to OpenAI TTS (tts-1 / nova).
 * Returns a Buffer containing MP3 audio.
 */
export async function synthesizeSpeech(text: string): Promise<Buffer> {
  const elevenLabsKey = process.env.ELEVENLABS_API_KEY
  if (elevenLabsKey) return synthesizeWithElevenLabs(text, elevenLabsKey)

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY or ELEVENLABS_API_KEY is required for text-to-speech.')
  }
  const client = new OpenAI({ apiKey })
  const response = await client.audio.speech.create({
    model: 'tts-1',
    voice: 'nova',
    input: text,
    response_format: 'mp3'
  })
  return Buffer.from(await response.arrayBuffer())
}

export function registerVoiceIPC(win: BrowserWindow): void {
  ipcMain.handle('openui:voice', async (_event, payload: unknown) => {
    if (typeof payload !== 'object' || payload === null) return
    const { audio, mimeType, tier } = payload as Record<string, unknown>

    // Validate the audio payload: must be a byte view (Uint8Array over IPC),
    // non-empty and within Whisper's size limit.
    if (!ArrayBuffer.isView(audio)) {
      emit(win, 'openui:chat:error', 'Invalid voice request: audio payload missing.')
      return
    }
    if (audio.byteLength === 0 || audio.byteLength > MAX_AUDIO_BYTES) {
      emit(win, 'openui:chat:error', 'Invalid voice request: audio is empty or too large.')
      return
    }
    const safeMime = typeof mimeType === 'string' && ALLOWED_AUDIO_MIME.test(mimeType) ? mimeType : 'audio/webm'
    const safeTier = coerceTier(tier)
    const audioBuffer = Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength)

    let transcript: string
    try {
      transcript = await transcribeWithWhisper(audioBuffer, safeMime)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      emit(win, 'openui:chat:error', message)
      return
    }

    if (!transcript) {
      emit(win, 'openui:chat:error', 'No speech detected in the recording.')
      return
    }

    // Push transcript to renderer so it can show it in #transcript-bubble
    // before the agent response starts streaming.
    emit(win, 'openui:voice:transcript', transcript)

    // Feed the transcribed text directly into the agent router.
    await handleChat(win, transcript, safeTier)
  })
}
