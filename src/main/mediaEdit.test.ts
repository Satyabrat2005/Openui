import { describe, it, expect, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import ffmpegStatic from 'ffmpeg-static'
import {
  parseTimeToSeconds,
  parseMediaInfo,
  mediaEditToolSchemas,
  mediaEditRegistry,
  CONVERT_FORMATS
} from './mediaEdit'

const execFileAsync = promisify(execFile)

// resolveSafePath confines mutating writes to the home tree, so the scratch dir
// must live directly under $HOME (same convention as spreadsheet.test.ts).
const dir = mkdtempSync(join(homedir(), '.openui-media-test-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('parseTimeToSeconds', () => {
  it('accepts plain seconds (number or string)', () => {
    expect(parseTimeToSeconds(12)).toBe(12)
    expect(parseTimeToSeconds('12.5')).toBe(12.5)
  })
  it('accepts MM:SS and HH:MM:SS clock strings', () => {
    expect(parseTimeToSeconds('01:30')).toBe(90)
    expect(parseTimeToSeconds('00:01:30')).toBe(90)
    expect(parseTimeToSeconds('1:02:03.5')).toBe(3723.5)
  })
  it('rejects negatives and garbage', () => {
    expect(parseTimeToSeconds(-1)).toBeNull()
    expect(parseTimeToSeconds('soon')).toBeNull()
    expect(parseTimeToSeconds('1:99')).toBeNull()
    expect(parseTimeToSeconds(null)).toBeNull()
  })
})

describe('parseMediaInfo', () => {
  const banner = [
    "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'x.mp4':",
    '  Duration: 00:00:01.50, start: 0.000000, bitrate: 245 kb/s',
    '  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 320x240 [SAR 1:1 DAR 4:3], 200 kb/s, 15 fps, 15 tbr, 15360 tbn',
    '  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, mono, fltp, 69 kb/s'
  ].join('\n')

  it('extracts duration, bitrate, and both streams from an ffmpeg banner', () => {
    const info = parseMediaInfo(banner)
    expect(info.durationSec).toBe(1.5)
    expect(info.overallBitrateKbps).toBe(245)
    expect(info.video).toEqual({ codec: 'h264', width: 320, height: 240, fps: 15 })
    expect(info.audio).toEqual({ codec: 'aac', sampleRateHz: 44100 })
  })

  it('returns nulls for an unrecognised banner', () => {
    const info = parseMediaInfo('not media')
    expect(info.durationSec).toBeNull()
    expect(info.video).toBeNull()
    expect(info.audio).toBeNull()
  })
})

describe('validation gates (no ffmpeg job spawned)', () => {
  const out = join(dir, 'out.mp4')

  it('trim_video rejects a non-increasing range', async () => {
    const r = await mediaEditRegistry.trim_video({ path: join(dir, 'in.mp4'), start: '5', end: '5', output_path: out })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/greater than/)
  })
  it('convert_media rejects an unsupported format', async () => {
    const r = await mediaEditRegistry.convert_media({ path: join(dir, 'in.mp4'), format: 'flv', output_path: out })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/format/)
  })
  it('extract_audio rejects a non-audio output extension', async () => {
    const r = await mediaEditRegistry.extract_audio({ video_path: join(dir, 'in.mp4'), output_path: join(dir, 'a.mp4') })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/audio file/)
  })
  it('merge_media requires at least two inputs', async () => {
    const r = await mediaEditRegistry.merge_media({ paths: [join(dir, 'a.mp4')], output_path: out })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/at least two/)
  })
  it('refuses an output path outside the home tree', async () => {
    const r = await mediaEditRegistry.convert_media({
      path: join(dir, 'in.mp4'),
      format: 'wav',
      output_path: join(homedir(), '..', 'escape.wav')
    })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/home folder/)
  })
})

describe('tool surface', () => {
  it('exposes exactly the five media schemas', () => {
    const names = mediaEditToolSchemas.map((s) => s.name).sort()
    expect(names).toEqual(
      ['convert_media', 'extract_audio', 'get_media_info', 'merge_media', 'trim_video'].sort()
    )
  })
  it('registry has an executor for every schema', () => {
    for (const s of mediaEditToolSchemas) expect(typeof mediaEditRegistry[s.name]).toBe('function')
  })
  it('advertises the documented convert formats', () => {
    expect([...CONVERT_FORMATS]).toEqual(['mp4', 'webm', 'mov', 'mp3', 'wav', 'm4a'])
  })
})

// Real ffmpeg round-trip — generates a tiny clip with the bundled binary, then
// probes/trims/extracts/merges it. Skips cleanly if the binary is unavailable.
const hasFfmpeg = !!ffmpegStatic
;(hasFfmpeg ? describe : describe.skip)('ffmpeg round-trip', () => {
  const source = join(dir, 'source.mp4')

  it(
    'generates a source, then reads info + trims + extracts + merges it',
    async () => {
      // 1-second 320x240 test pattern with a 440 Hz tone → a real A/V mp4.
      await execFileAsync(
        ffmpegStatic as string,
        [
          '-y',
          '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=15',
          '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
          '-shortest', '-pix_fmt', 'yuv420p', source
        ],
        { timeout: 60_000, windowsHide: true }
      )
      expect(existsSync(source)).toBe(true)

      // get_media_info reads the real streams back.
      const info = await mediaEditRegistry.get_media_info({ path: source })
      expect(info.ok).toBe(true)
      expect(info.output).toMatch(/video:/)
      expect(info.output).toMatch(/320x240/)
      expect(info.output).toMatch(/audio:/)

      // trim to the first half-second.
      const trimmed = join(dir, 'trimmed.mp4')
      const t = await mediaEditRegistry.trim_video({ path: source, start: '0', end: '0.5', output_path: trimmed })
      expect(t.ok).toBe(true)
      expect(statSync(trimmed).size).toBeGreaterThan(0)

      // extract the audio track to a WAV.
      const wav = join(dir, 'track.wav')
      const a = await mediaEditRegistry.extract_audio({ video_path: source, output_path: wav })
      expect(a.ok).toBe(true)
      expect(statSync(wav).size).toBeGreaterThan(0)

      // concatenate two copies of the clip.
      const merged = join(dir, 'merged.mp4')
      const m = await mediaEditRegistry.merge_media({ paths: [source, source], output_path: merged })
      expect(m.ok).toBe(true)
      expect(statSync(merged).size).toBeGreaterThan(0)
    },
    120_000
  )
})
