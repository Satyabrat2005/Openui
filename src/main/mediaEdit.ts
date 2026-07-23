/**
 * mediaEdit.ts — audio/video automation for the OpenUI agent.
 *
 * Self-contained tool module (schemas + registry) mirroring spreadsheet.ts /
 * figma.ts. It drives ffmpeg for real transcode/trim/extract/merge work instead
 * of asking the user to run a command line — the codebase had no ffmpeg surface
 * at all before this.
 *
 * BINARY: the actual ffmpeg is bundled by ffmpeg-static (so users need nothing
 * preinstalled); fluent-ffmpeg is the thin JS wrapper. ffmpeg.setFfmpegPath()
 * points the wrapper at the bundled binary. NOTE (licensing/size — flagged to
 * the maintainer): the ffmpeg-static build is GPL-3.0-or-later and ~79 MB per
 * platform; swapping in an LGPL build only changes the binary the path points at,
 * not this module. get_media_info shells out to that same binary's `-i` probe
 * (ffmpeg-static does not bundle ffprobe).
 *
 * SECURITY / SAFETY:
 *   - Every path passes through resolveSafePath(): inputs read-only (blocked from
 *     sensitive dirs), outputs mutating (additionally confined to the home tree).
 *   - Input file size is capped so a hostile/accidental huge file is refused up
 *     front rather than filling the disk with a transcode.
 *   - Each ffmpeg job has a wall-clock timeout; on expiry the child is killed
 *     (same containment pattern sandbox.ts uses for its bounded child processes).
 *   - The four mutating tools (trim_video, convert_media, extract_audio,
 *     merge_media) are registered in STATE_CHANGING_TOOLS (tools.ts) for HITL
 *     gating; get_media_info is read-only and omitted.
 *   - The pure helpers (parseTimeToSeconds, parseMediaInfo) are exported for unit
 *     testing without spawning ffmpeg.
 */

import ffmpeg from 'fluent-ffmpeg'
import ffmpegStatic from 'ffmpeg-static'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { stat, readFile, writeFile, unlink } from 'node:fs/promises'
import { extname, basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { resolveSafePath } from './fs/pathSafety'
import { decodeAudioDurationSeconds } from './audioDuration'
import type { ExecutorContext, ToolResult, ToolSchema } from './tools'

const execFileAsync = promisify(execFile)

// Point fluent-ffmpeg at the bundled binary. Done once at module load; when the
// binary is missing (unsupported platform / failed download) ffmpegStatic is
// null and every tool returns a clear error via ensureFfmpeg().
if (ffmpegStatic) ffmpeg.setFfmpegPath(ffmpegStatic)

/** Largest input file we will hand to ffmpeg. Above this we refuse up front. */
const MAX_INPUT_BYTES = 2 * 1024 * 1024 * 1024 // 2 GiB
/** Wall-clock ceiling for a single transcode/merge job before the child is killed. */
const MEDIA_TIMEOUT_MS = 10 * 60_000 // 10 minutes
/** Timeout for the lightweight `ffmpeg -i` metadata probe. */
const PROBE_TIMEOUT_MS = 30_000
/** Only files up to this size are fully read to reuse audioDuration's header
 *  parser; larger inputs get their duration from the ffmpeg probe instead. */
const AUDIO_HEADER_READ_CAP = 64 * 1024 * 1024 // 64 MB
/** Cap on how many clips merge_media will concatenate in one call. */
const MAX_MERGE_INPUTS = 50

/** Container formats convert_media can target. */
export const CONVERT_FORMATS = ['mp4', 'webm', 'mov', 'mp3', 'wav', 'm4a'] as const
export type ConvertFormat = (typeof CONVERT_FORMATS)[number]
/** Extensions accepted as an audio-only output (extract_audio, and audio converts). */
const AUDIO_EXTS = new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'flac'])

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** True when the bundled ffmpeg binary is available; otherwise a friendly error. */
function ensureFfmpeg(tool: string): string | null {
  if (!ffmpegStatic) {
    return `${tool}: the bundled ffmpeg binary is unavailable on this platform. Media tools are disabled.`
  }
  return null
}

/** Extension of a path without the dot, lower-cased ("" when none). */
function ext(path: string): string {
  return extname(path).replace(/^\./, '').toLowerCase()
}

// ── pure helpers (exported for unit tests) ────────────────────────────────────

/**
 * Parse a time value into seconds. Accepts a number (seconds), a plain seconds
 * string ("12.5"), or a colon clock ("MM:SS" / "HH:MM:SS" with optional
 * fractional seconds). Returns null on anything unparseable or negative.
 */
export function parseTimeToSeconds(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw >= 0 ? raw : null
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (!s) return null
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s)
  const m = /^(\d+):([0-5]?\d)(?::([0-5]?\d(?:\.\d+)?))?$/.exec(s)
  if (!m) return null
  return m[3] !== undefined
    ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) // HH:MM:SS
    : Number(m[1]) * 60 + Number(m[2]) // MM:SS
}

export interface MediaInfo {
  durationSec: number | null
  overallBitrateKbps: number | null
  video: { codec: string; width: number; height: number; fps: number | null } | null
  audio: { codec: string; sampleRateHz: number | null } | null
}

/**
 * Parse the metadata ffmpeg prints to stderr when probing an input with `-i`.
 * Pure so it can be unit-tested against captured banners without ffmpeg.
 */
export function parseMediaInfo(stderr: string): MediaInfo {
  const info: MediaInfo = {
    durationSec: null,
    overallBitrateKbps: null,
    video: null,
    audio: null
  }

  const dur = /Duration:\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(stderr)
  if (dur) {
    info.durationSec = Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3])
  }
  const br = /bitrate:\s*(\d+)\s*kb\/s/.exec(stderr)
  if (br) info.overallBitrateKbps = Number(br[1])

  // The trailing [^\n]* keeps the whole stream line in match[0], so the fps/Hz
  // fields (which come AFTER the codec + resolution) are searchable within it.
  const video = /Stream #\d+:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?:\s*Video:\s*([A-Za-z0-9_]+)[^\n]*?(\d{2,5})x(\d{2,5})[^\n]*/.exec(
    stderr
  )
  if (video) {
    const fpsMatch = /(\d+(?:\.\d+)?)\s*fps/.exec(video[0])
    info.video = {
      codec: video[1],
      width: Number(video[2]),
      height: Number(video[3]),
      fps: fpsMatch ? Number(fpsMatch[1]) : null
    }
  }
  const audio = /Stream #\d+:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?:\s*Audio:\s*([A-Za-z0-9_]+)[^\n]*/.exec(stderr)
  if (audio) {
    const hz = /(\d+)\s*Hz/.exec(audio[0])
    info.audio = { codec: audio[1], sampleRateHz: hz ? Number(hz[1]) : null }
  }
  return info
}

// ── shared execution helpers ──────────────────────────────────────────────────

/** Validate that a resolved input path is a readable file within the size cap. */
async function checkInput(path: string, tool: string): Promise<string | null> {
  try {
    const info = await stat(path)
    if (!info.isFile()) return `${tool}: "${path}" is not a file.`
    if (info.size > MAX_INPUT_BYTES) {
      return `${tool}: "${path}" is ${(info.size / (1024 * 1024)).toFixed(0)} MB, over the ${MAX_INPUT_BYTES / (1024 * 1024 * 1024)} GB input limit.`
    }
    return null
  } catch (e) {
    return `${tool}: cannot read "${path}" — ${errText(e)}`
  }
}

type FfmpegCommand = ffmpeg.FfmpegCommand

/**
 * Run a built ffmpeg command to completion with a wall-clock bound. `start`
 * kicks off processing (e.g. `c => c.save(out)` or `c => c.mergeToFile(out,
 * tmp)`); on timeout the child is killed and the promise rejects. Resolves when
 * ffmpeg emits 'end', rejects on 'error'.
 */
function runFfmpeg(command: FfmpegCommand, start: (c: FfmpegCommand) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        command.kill('SIGKILL')
      } catch {
        /* already exited */
      }
      reject(new Error(`ffmpeg job exceeded the ${MEDIA_TIMEOUT_MS / 1000}s time limit and was stopped.`))
    }, MEDIA_TIMEOUT_MS)

    command
      .on('error', (err: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(err)
      })
      .on('end', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      })
    start(command)
  })
}

// ── trim_video ────────────────────────────────────────────────────────────────

async function trim_video(args: Record<string, unknown>): Promise<ToolResult> {
  const gate = ensureFfmpeg('trim_video')
  if (gate) return { ok: false, error: gate }

  let input: string
  let output: string
  try {
    input = resolveSafePath(args.path ?? args.input_path, { mutating: false })
    output = resolveSafePath(args.output_path, { mutating: true })
  } catch (e) {
    return { ok: false, error: `trim_video: ${errText(e)}` }
  }
  const start = parseTimeToSeconds(args.start)
  const end = parseTimeToSeconds(args.end)
  if (start === null) return { ok: false, error: 'trim_video: "start" must be seconds or HH:MM:SS.' }
  if (end === null) return { ok: false, error: 'trim_video: "end" must be seconds or HH:MM:SS.' }
  if (end <= start) return { ok: false, error: 'trim_video: "end" must be greater than "start".' }

  const bad = await checkInput(input, 'trim_video')
  if (bad) return { ok: false, error: bad }

  try {
    await runFfmpeg(ffmpeg(input).setStartTime(start).setDuration(end - start), (c) => c.save(output))
    return { ok: true, output: `Trimmed ${basename(input)} [${start}s–${end}s] → ${output}.` }
  } catch (e) {
    return { ok: false, error: `trim_video failed: ${errText(e)}` }
  }
}

// ── convert_media ─────────────────────────────────────────────────────────────

async function convert_media(args: Record<string, unknown>): Promise<ToolResult> {
  const gate = ensureFfmpeg('convert_media')
  if (gate) return { ok: false, error: gate }

  const format = typeof args.format === 'string' ? args.format.trim().toLowerCase() : ''
  if (!(CONVERT_FORMATS as readonly string[]).includes(format)) {
    return { ok: false, error: `convert_media: "format" must be one of ${CONVERT_FORMATS.join(', ')}.` }
  }
  let input: string
  let output: string
  try {
    input = resolveSafePath(args.path ?? args.input_path, { mutating: false })
    output = resolveSafePath(args.output_path, { mutating: true })
  } catch (e) {
    return { ok: false, error: `convert_media: ${errText(e)}` }
  }

  const bad = await checkInput(input, 'convert_media')
  if (bad) return { ok: false, error: bad }

  try {
    await runFfmpeg(ffmpeg(input).toFormat(format), (c) => c.save(output))
    return { ok: true, output: `Converted ${basename(input)} → ${format.toUpperCase()} at ${output}.` }
  } catch (e) {
    return { ok: false, error: `convert_media failed: ${errText(e)}` }
  }
}

// ── extract_audio ─────────────────────────────────────────────────────────────

async function extract_audio(args: Record<string, unknown>): Promise<ToolResult> {
  const gate = ensureFfmpeg('extract_audio')
  if (gate) return { ok: false, error: gate }

  let input: string
  let output: string
  try {
    input = resolveSafePath(args.video_path ?? args.path, { mutating: false })
    output = resolveSafePath(args.output_path, { mutating: true })
  } catch (e) {
    return { ok: false, error: `extract_audio: ${errText(e)}` }
  }
  if (!AUDIO_EXTS.has(ext(output))) {
    return {
      ok: false,
      error: `extract_audio: "output_path" must be an audio file (${[...AUDIO_EXTS].join(', ')}).`
    }
  }

  const bad = await checkInput(input, 'extract_audio')
  if (bad) return { ok: false, error: bad }

  try {
    await runFfmpeg(ffmpeg(input).noVideo(), (c) => c.save(output))
    return { ok: true, output: `Extracted audio from ${basename(input)} → ${output}.` }
  } catch (e) {
    return { ok: false, error: `extract_audio failed: ${errText(e)}` }
  }
}

// ── merge_media ───────────────────────────────────────────────────────────────

async function merge_media(args: Record<string, unknown>): Promise<ToolResult> {
  const gate = ensureFfmpeg('merge_media')
  if (gate) return { ok: false, error: gate }

  const rawPaths = Array.isArray(args.paths) ? args.paths : null
  if (!rawPaths || rawPaths.length < 2) {
    return { ok: false, error: 'merge_media: "paths" must be an array of at least two files.' }
  }
  if (rawPaths.length > MAX_MERGE_INPUTS) {
    return { ok: false, error: `merge_media: too many inputs (limit ${MAX_MERGE_INPUTS}).` }
  }

  const inputs: string[] = []
  let output: string
  try {
    for (const p of rawPaths) inputs.push(resolveSafePath(p, { mutating: false }))
    output = resolveSafePath(args.output_path, { mutating: true })
  } catch (e) {
    return { ok: false, error: `merge_media: ${errText(e)}` }
  }

  for (const p of inputs) {
    const bad = await checkInput(p, 'merge_media')
    if (bad) return { ok: false, error: bad }
  }

  // Use the concat DEMUXER (a list file + stream copy) rather than
  // fluent-ffmpeg's mergeToFile — the latter shells out to ffprobe, which
  // ffmpeg-static does not bundle. Stream copy is lossless and fast; it requires
  // the inputs to share codec/params (the usual "join clips from one source"
  // case), and ffmpeg surfaces a clear error otherwise.
  const listFile = join(tmpdir(), `openui-concat-${Date.now()}-${randomBytes(4).toString('hex')}.txt`)
  try {
    await writeFile(listFile, inputs.map((p) => `file '${escapeConcatPath(p)}'`).join('\n'), 'utf8')
    await runFfmpeg(
      ffmpeg(listFile).inputOptions(['-f', 'concat', '-safe', '0']).outputOptions(['-c', 'copy']),
      (c) => c.save(output)
    )
    return { ok: true, output: `Merged ${inputs.length} clips → ${output}.` }
  } catch (e) {
    return { ok: false, error: `merge_media failed: ${errText(e)}` }
  } finally {
    await unlink(listFile).catch(() => {})
  }
}

/** Escape a path for a concat-demuxer list line: forward slashes (Windows-safe
 *  for ffmpeg) and single quotes written as the '\'' sequence. */
function escapeConcatPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/'/g, "'\\''")
}

// ── get_media_info (read-only) ────────────────────────────────────────────────

/** Reuse audioDuration.ts's header parser for the audio-container overlap. */
async function headerDuration(path: string, size: number): Promise<number | null> {
  if (size > AUDIO_HEADER_READ_CAP) return null
  try {
    return decodeAudioDurationSeconds(await readFile(path))
  } catch {
    return null
  }
}

/** Probe an input with `ffmpeg -i`, returning its stderr banner (info + error). */
async function probeMedia(bin: string, path: string): Promise<string> {
  try {
    const { stderr } = await execFileAsync(bin, ['-hide_banner', '-i', path], {
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true
    })
    return stderr
  } catch (e) {
    // ffmpeg exits non-zero on "-i with no output" but still prints the banner.
    return (e as { stderr?: string }).stderr ?? ''
  }
}

function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  const pad = (n: number): string => String(Math.floor(n)).padStart(2, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)} (${sec.toFixed(2)}s)`
}

async function get_media_info(args: Record<string, unknown>): Promise<ToolResult> {
  const gate = ensureFfmpeg('get_media_info')
  if (gate) return { ok: false, error: gate }

  let input: string
  try {
    input = resolveSafePath(args.path, { mutating: false })
  } catch (e) {
    return { ok: false, error: `get_media_info: ${errText(e)}` }
  }
  let size = 0
  try {
    const info = await stat(input)
    if (!info.isFile()) return { ok: false, error: `get_media_info: "${input}" is not a file.` }
    size = info.size
  } catch (e) {
    return { ok: false, error: `get_media_info: cannot read "${input}" — ${errText(e)}` }
  }

  try {
    const stderr = await probeMedia(ffmpegStatic as string, input)
    const parsed = parseMediaInfo(stderr)
    // Prefer audioDuration's header read where it applies (WAV/Ogg/WebM), then
    // fall back to ffmpeg's parsed Duration for everything else (mp4/mov/…).
    const duration = (await headerDuration(input, size)) ?? parsed.durationSec

    const lines: string[] = [`Media info for ${basename(input)} (${(size / (1024 * 1024)).toFixed(1)} MB):`]
    lines.push(`- duration: ${duration !== null ? formatDuration(duration) : 'unknown'}`)
    if (parsed.overallBitrateKbps !== null) lines.push(`- bitrate: ${parsed.overallBitrateKbps} kb/s`)
    if (parsed.video) {
      lines.push(
        `- video: ${parsed.video.codec} ${parsed.video.width}x${parsed.video.height}` +
          `${parsed.video.fps !== null ? ` @ ${parsed.video.fps} fps` : ''}`
      )
    }
    if (parsed.audio) {
      lines.push(
        `- audio: ${parsed.audio.codec}${parsed.audio.sampleRateHz !== null ? ` ${parsed.audio.sampleRateHz} Hz` : ''}`
      )
    }
    if (!parsed.video && !parsed.audio) {
      lines.push('- no audio/video streams detected (is this a media file?).')
    }
    return { ok: true, output: lines.join('\n') }
  } catch (e) {
    return { ok: false, error: `get_media_info failed: ${errText(e)}` }
  }
}

// ── schemas (LLM-facing surface) ─────────────────────────────────────────────

export const mediaEditToolSchemas: ToolSchema[] = [
  {
    name: 'trim_video',
    description:
      'Trim a video or audio file to the segment between "start" and "end" and write it to output_path. ' +
      'Times are seconds ("12.5") or clock strings ("00:01:30"). Prefer this over computer_use for editing media.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the source media file.' },
        start: { type: 'string', description: 'Start time — seconds or HH:MM:SS.' },
        end: { type: 'string', description: 'End time — seconds or HH:MM:SS (must be after start).' },
        output_path: { type: 'string', description: 'Destination path inside your home folder.' }
      },
      required: ['path', 'start', 'end', 'output_path']
    }
  },
  {
    name: 'convert_media',
    description: 'Convert a media file to another container/format (mp4, webm, mov, mp3, wav, m4a).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the source media file.' },
        format: { type: 'string', description: 'Target format.', enum: [...CONVERT_FORMATS] },
        output_path: { type: 'string', description: 'Destination path inside your home folder.' }
      },
      required: ['path', 'format', 'output_path']
    }
  },
  {
    name: 'extract_audio',
    description: 'Extract the audio track from a video into an audio file (output extension picks the codec, e.g. .mp3/.wav/.m4a).',
    parameters: {
      type: 'object',
      properties: {
        video_path: { type: 'string', description: 'Path to the source video file.' },
        output_path: { type: 'string', description: 'Destination audio path (.mp3/.wav/.m4a/…) inside your home folder.' }
      },
      required: ['video_path', 'output_path']
    }
  },
  {
    name: 'merge_media',
    description: 'Concatenate several clips (or audio tracks) into one file, in the given order.',
    parameters: {
      type: 'object',
      properties: {
        paths: { type: 'array', description: 'Ordered array of source file paths (2 or more).', items: { type: 'string' } },
        output_path: { type: 'string', description: 'Destination path inside your home folder.' }
      },
      required: ['paths', 'output_path']
    }
  },
  {
    name: 'get_media_info',
    description:
      'Read a media file\'s duration, codecs, resolution and bitrate without modifying it. ' +
      'Use this to inspect media before trimming or converting.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the media file to inspect.' }
      },
      required: ['path']
    }
  }
]

export const mediaEditRegistry: Record<
  string,
  (args: Record<string, unknown>, context?: ExecutorContext) => Promise<ToolResult>
> = {
  trim_video,
  convert_media,
  extract_audio,
  merge_media,
  get_media_info
}
