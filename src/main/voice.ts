import OpenAI, { toFile } from 'openai'
import { BrowserWindow, ipcMain } from 'electron'
import { coerceTier, handleChat } from './agent'

function emit(win: BrowserWindow, channel: string, ...args: unknown[]): void {
  if (!win.isDestroyed()) win.webContents.send(channel, ...args)
}

// Whisper rejects files larger than 25 MB; reject oversized buffers up front so
// a hostile/forged IPC message can't force a huge allocation or upload.
const MAX_AUDIO_BYTES = 25 * 1024 * 1024
const ALLOWED_AUDIO_MIME = /^audio\/(webm|ogg|mp4|mpeg|wav|x-m4a)(;.*)?$/

async function transcribeWithWhisper(audioBuffer: Buffer, mimeType: string): Promise<string> {
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
