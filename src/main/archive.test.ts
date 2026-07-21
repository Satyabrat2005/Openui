import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import { archiveRegistry, archiveToolSchemas, coercePathList, isInsideDir } from './archive'

// resolveSafePath confines mutating writes to the home tree, so the scratch dir
// must live directly under $HOME with a non-sensitive name.
const dir = mkdtempSync(join(homedir(), '.openui-archive-test-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('archive pure helpers', () => {
  it('coercePathList accepts arrays and comma/newline strings, de-duplicates', () => {
    expect(coercePathList(['a', 'b', 'a'])).toEqual(['a', 'b'])
    expect(coercePathList('a, b\nc')).toEqual(['a', 'b', 'c'])
    expect(coercePathList('')).toEqual([])
    expect(coercePathList(42)).toEqual([])
  })

  it('isInsideDir accepts children and rejects escapes', () => {
    const base = join(dir, 'dest')
    expect(isInsideDir(base, join(base, 'a', 'b.txt'))).toBe(true)
    expect(isInsideDir(base, base)).toBe(true)
    expect(isInsideDir(base, join(base, '..', 'evil.txt'))).toBe(false)
  })
})

describe('archive tools', () => {
  it('creates, lists and extracts a zip round-trip', async () => {
    const fileA = join(dir, 'a.txt')
    writeFileSync(fileA, 'hello alpha')
    const zipPath = join(dir, 'bundle.zip')

    const c = await archiveRegistry.create_zip({ paths: [fileA], output_path: zipPath })
    expect(c.ok).toBe(true)
    expect(existsSync(zipPath)).toBe(true)

    const l = await archiveRegistry.list_zip_contents({ zip_path: zipPath })
    expect(l.ok).toBe(true)
    expect(l.output).toContain('a.txt')

    const dest = join(dir, 'out')
    const e = await archiveRegistry.extract_zip({ zip_path: zipPath, dest_dir: dest })
    expect(e.ok).toBe(true)
    expect(readFileSync(join(dest, 'a.txt'), 'utf8')).toBe('hello alpha')
  })

  it('never lets a path-traversal entry escape the destination', async () => {
    // adm-zip sanitises "../" from entry names on read/write, and our extract
    // loop additionally verifies every target with isInsideDir (defence in
    // depth). The security PROPERTY we assert here is the outcome that matters:
    // extracting a hostile archive writes nothing outside dest.
    const evilZip = join(dir, 'evil.zip')
    const zip = new AdmZip()
    zip.addFile('../escaped.txt', Buffer.from('pwned'))
    zip.writeZip(evilZip)

    const dest = join(dir, 'safe-out')
    const e = await archiveRegistry.extract_zip({ zip_path: evilZip, dest_dir: dest })
    expect(e.ok).toBe(true)
    // The traversal was neutralised: the file is INSIDE dest, never in its parent.
    expect(existsSync(join(dir, 'escaped.txt'))).toBe(false)
    expect(existsSync(join(dest, 'escaped.txt'))).toBe(true)
  })

  it('rejects a non-.zip output path and a write outside home', async () => {
    const bad = await archiveRegistry.create_zip({ paths: ['x'], output_path: join(dir, 'nope.tar') })
    expect(bad.ok).toBe(false)
    const outside = await archiveRegistry.create_zip({
      paths: [join(dir, 'a.txt')],
      output_path: join(homedir(), '..', 'openui-should-not-write.zip')
    })
    expect(outside.ok).toBe(false)
  })

  it('errors clearly on a missing input path', async () => {
    const r = await archiveRegistry.create_zip({ paths: [join(dir, 'ghost.txt')], output_path: join(dir, 'g.zip') })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/not found/i)
  })

  it('exposes exactly the three archive schemas', () => {
    const names = archiveToolSchemas.map((s) => s.name).sort()
    expect(names).toEqual(['create_zip', 'extract_zip', 'list_zip_contents'])
  })
})
