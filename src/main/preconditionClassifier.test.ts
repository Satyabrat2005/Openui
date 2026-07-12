import { describe, it, expect } from 'vitest'
import { looksLikeMissingPrecondition } from './preconditionClassifier'

describe('looksLikeMissingPrecondition — true positives (real error strings in this codebase)', () => {
  const cases: string[] = [
    'Gmail is not connected. Open Settings → Gmail and click Connect.',
    'Google Calendar is not connected. Open Settings → Google Calendar and click Connect.',
    'Google OAuth client is not configured (Settings → Google Calendar).',
    'Gmail is not connected.',
    'Google Calendar is not connected.',
    'No browser session is connected. Call connect_browser first — the user must approve.',
    "Could not find an application named 'antigravity'. Try its exact name as shown in the Start menu.",
    '@octokit/rest is not installed. Run: npm install @octokit/rest',
    '"whatsapp" is not installed or not on PATH.',
    'Supabase is not configured — set SUPABASE_URL and SUPABASE_ANON_KEY in your .env.',
    'Monthly voice limit reached. Upgrade to Pro for more voice time.',
    'Daily voice limit reached. Upgrade to Enterprise for unlimited voice time.',
    'Voice transcription requires a Pro subscription for cloud accuracy.',
    'OCR requires a Pro subscription for higher accuracy.',
    'Screen reading is temporarily unavailable — the voice service is not configured on the server.'
  ]

  for (const error of cases) {
    it(`flags: ${error.slice(0, 60)}`, () => {
      expect(looksLikeMissingPrecondition(error)).toBe(true)
    })
  }
})

describe('looksLikeMissingPrecondition — true negatives (should not stop the loop)', () => {
  const cases: (string | null | undefined)[] = [
    'File not found: C:\\projects\\missing.ts',
    'Network request failed with status 500',
    'Invalid JSON in tool arguments',
    'Permission denied writing to read-only file',
    'Element not found on screen — try a different selector',
    'Timed out waiting for the page to load',
    'Unexpected token in tool call',
    '',
    null,
    undefined
  ]

  for (const error of cases) {
    it(`does not flag: ${String(error).slice(0, 60)}`, () => {
      expect(looksLikeMissingPrecondition(error)).toBe(false)
    })
  }
})
