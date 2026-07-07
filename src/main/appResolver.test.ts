import { describe, it, expect } from 'vitest'
import { normalizeAppName, scoreAppName, resolveApp, type InstalledApp } from './appResolver'

const apps: InstalledApp[] = [
  { name: 'Visual Studio Code', appId: 'code.appid', source: 'startapps' },
  { name: 'Visual Studio 2022', appId: 'vs2022.appid', source: 'startapps' },
  { name: 'Google Chrome', appId: 'chrome.appid', source: 'startapps' },
  { name: 'Microsoft Edge', appId: 'edge.appid', source: 'startapps' },
  { name: 'Microsoft PowerPoint', appId: 'ppt.appid', source: 'startapps' },
  { name: 'Microsoft Word', appId: 'word.appid', source: 'startapps' },
  { name: 'WhatsApp', appId: 'whatsapp.appid', source: 'startapps' },
  { name: 'Spotify', appId: 'spotify.appid', source: 'startapps' },
  { name: 'Notepad', path: 'C:/Windows/notepad.exe', source: 'shortcut' },
  { name: 'VLC media player', path: 'C:/vlc/vlc.lnk', source: 'shortcut' }
]

describe('normalizeAppName', () => {
  it('lowercases, drops .exe, and strips punctuation', () => {
    expect(normalizeAppName('Visual Studio Code')).toBe('visual studio code')
    expect(normalizeAppName('notepad.exe')).toBe('notepad')
    expect(normalizeAppName('Node.js')).toBe('node js')
    expect(normalizeAppName('  Google   Chrome  ')).toBe('google chrome')
  })
})

describe('scoreAppName', () => {
  it('scores exact matches highest and unrelated names zero', () => {
    expect(scoreAppName('notepad', 'notepad')).toBe(100)
    expect(scoreAppName('notepad', 'google chrome')).toBe(0)
  })
  it('ranks whole-word prefix above bare-character prefix', () => {
    const wholeWord = scoreAppName('visual studio', 'visual studio code')
    const charPrefix = scoreAppName('power', 'powerpoint')
    expect(wholeWord).toBeGreaterThan(charPrefix)
  })
})

describe('resolveApp', () => {
  it('resolves the exact registered name', () => {
    expect(resolveApp('Visual Studio Code', apps)?.name).toBe('Visual Studio Code')
    expect(resolveApp('WhatsApp', apps)?.name).toBe('WhatsApp')
  })

  it('resolves colloquial aliases to the canonical app', () => {
    expect(resolveApp('VS Code', apps)?.name).toBe('Visual Studio Code')
    expect(resolveApp('vscode', apps)?.name).toBe('Visual Studio Code')
    expect(resolveApp('chrome', apps)?.name).toBe('Google Chrome')
    expect(resolveApp('ppt', apps)?.name).toBe('Microsoft PowerPoint')
    expect(resolveApp('word', apps)?.name).toBe('Microsoft Word')
  })

  it('matches case-insensitively and ignoring punctuation', () => {
    expect(resolveApp('spotify', apps)?.name).toBe('Spotify')
    expect(resolveApp('vlc', apps)?.name).toBe('VLC media player')
  })

  it('returns null when nothing clears the confidence threshold', () => {
    expect(resolveApp('some app that is not installed', apps)).toBeNull()
    expect(resolveApp('xyzzy', apps)).toBeNull()
  })

  it('does not launch the wrong app on a single shared generic word', () => {
    // "microsoft" alone overlaps Word/PowerPoint/Edge but must not resolve to any
    // one of them — a lone generic token stays below threshold.
    expect(resolveApp('microsoft', apps)).toBeNull()
  })

  it('prefers the startapps source when scores tie', () => {
    const dup: InstalledApp[] = [
      { name: 'Slack', path: 'C:/slack.lnk', source: 'shortcut' },
      { name: 'Slack', appId: 'slack.appid', source: 'startapps' }
    ]
    expect(resolveApp('slack', dup)?.source).toBe('startapps')
  })

  it('resolves macOS .app-bundle entries the same way as Windows entries', () => {
    const macApps: InstalledApp[] = [
      { name: 'Visual Studio Code', path: '/Applications/Visual Studio Code.app', source: 'app-bundle' },
      { name: 'Google Chrome', path: '/Applications/Google Chrome.app', source: 'app-bundle' },
      { name: 'Notes', path: '/System/Applications/Notes.app', source: 'app-bundle' }
    ]
    expect(resolveApp('vscode', macApps)?.name).toBe('Visual Studio Code')
    expect(resolveApp('chrome', macApps)?.name).toBe('Google Chrome')
    expect(resolveApp('notes', macApps)?.path).toBe('/System/Applications/Notes.app')
    expect(resolveApp('xyzzy', macApps)).toBeNull()
  })
})
