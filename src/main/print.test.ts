import { describe, it, expect, vi, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Mock Electron: shell.openPath succeeds; BrowserWindow renders + prints ok.
const opened: string[] = []
vi.mock('electron', () => ({
  shell: { openPath: vi.fn(async (p: string) => (opened.push(p), '')) },
  BrowserWindow: class {
    webContents = {
      print: (_opts: unknown, cb: (ok: boolean, reason: string) => void) => cb(true, '')
    }
    async loadFile(): Promise<void> {}
    isDestroyed(): boolean {
      return false
    }
    destroy(): void {}
  }
}))

import { printRegistry, printToolSchemas, classifyPrintTarget } from './print'

const dir = mkdtempSync(join(homedir(), '.openui-print-test-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('classifyPrintTarget (pure)', () => {
  it('routes web content to render, everything else to open', () => {
    expect(classifyPrintTarget('a.html')).toBe('render')
    expect(classifyPrintTarget('a.HTM')).toBe('render')
    expect(classifyPrintTarget('notes.txt')).toBe('render')
    expect(classifyPrintTarget('doc.pdf')).toBe('open')
    expect(classifyPrintTarget('photo.png')).toBe('open')
    expect(classifyPrintTarget('sheet.xlsx')).toBe('open')
  })
})

describe('print_file', () => {
  it('prints an HTML file via the render path', async () => {
    const html = join(dir, 'page.html')
    writeFileSync(html, '<h1>hi</h1>')
    const r = await printRegistry.print_file({ path: html })
    expect(r.ok).toBe(true)
    expect(r.output).toMatch(/printer/i)
  })

  it('opens a PDF in the default app to print', async () => {
    const pdf = join(dir, 'doc.pdf')
    writeFileSync(pdf, '%PDF-1.4 test')
    const r = await printRegistry.print_file({ path: pdf })
    expect(r.ok).toBe(true)
    expect(r.output).toMatch(/default app|Ctrl\/Cmd\+P/i)
    expect(opened).toContain(pdf)
  })

  it('rejects a missing file', async () => {
    const r = await printRegistry.print_file({ path: join(dir, 'ghost.html') })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/not found/i)
  })

  it('exposes exactly the print_file schema', () => {
    expect(printToolSchemas.map((s) => s.name)).toEqual(['print_file'])
  })
})
