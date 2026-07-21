import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mailMergeRegistry, mailMergeToolSchemas } from './mailmerge'
import { worddocRegistry } from './worddoc'
import { spreadsheetRegistry } from './spreadsheet'
import { pdfRegistry } from './pdf'

// resolveSafePath confines mutating writes to the home tree and rejects
// sensitive dirs (AppData, .ssh, …), so the scratch dir must live directly
// under $HOME with a non-sensitive name.
const dir = mkdtempSync(join(homedir(), '.openui-merge-test-'))
const template = join(dir, 'offer.docx')
const data = join(dir, 'people.xlsx')

// A merge writes several real documents per test (and the PDF variant renders
// and re-parses them), so these need more than vitest's 5s default once test
// files are running in parallel. Scoped to this file — see pdf.test.ts.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

/**
 * Generated documents each carry a dot-prefixed ".<name>.openui.json" sidecar
 * (so a merged letter stays editable by the worddoc tools), so tests count and
 * address the real deliverables rather than everything in the folder.
 */
function outputs(folder: string, ext = '.docx'): string[] {
  return readdirSync(folder)
    .filter((f) => !f.startsWith('.') && f.toLowerCase().endsWith(ext))
    .sort()
}

beforeAll(async () => {
  // A template is just a normal generated document with {{tokens}} in it.
  await worddocRegistry.create_document({ path: template, title: 'Offer for {{Name}}' })
  await worddocRegistry.add_heading({ path: template, text: 'Role: {{Role}}', level: 2 })
  await worddocRegistry.add_paragraph({
    path: template,
    text: 'Dear {{Name}}, we are delighted to offer you the {{Role}} position at {{Salary}}.'
  })
  await worddocRegistry.add_doc_table({
    path: template,
    rows: [
      ['Field', 'Value'],
      ['Start date', '{{Start}}']
    ]
  })

  await spreadsheetRegistry.write_spreadsheet({
    path: data,
    data: {
      rows: [
        ['Name', 'Role', 'Salary', 'Start'],
        ['Ada Lovelace', 'Engineer', '$120k', '2026-08-01'],
        ['Grace Hopper', 'Architect', '$150k', '2026-09-15']
      ]
    }
  })
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('mail_merge — validation', () => {
  it('rejects a non-.docx template', async () => {
    const r = await mailMergeRegistry.mail_merge({
      template_path: data,
      rows: [{ Name: 'x' }],
      output_dir: join(dir, 'out-bad')
    })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('.docx')
  })

  it('refuses a Word-authored template it cannot read', async () => {
    const foreign = join(dir, 'from-word.docx')
    writeFileSync(foreign, 'PK not really a document')
    const r = await mailMergeRegistry.mail_merge({
      template_path: foreign,
      rows: [{ Name: 'x' }],
      output_dir: join(dir, 'out-bad')
    })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('create_document')
  })

  it('refuses a template with no {{tokens}} — every output would be identical', async () => {
    const plain = join(dir, 'plain.docx')
    await worddocRegistry.create_document({ path: plain, title: 'Static Notice' })
    const r = await mailMergeRegistry.mail_merge({
      template_path: plain,
      rows: [{ Name: 'x' }],
      output_dir: join(dir, 'out-bad')
    })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('no {{tokens}}')
  })

  it('rejects an output_dir outside the home tree', async () => {
    const r = await mailMergeRegistry.mail_merge({
      template_path: template,
      rows: [{ Name: 'x' }],
      output_dir: join(homedir(), '..', 'openui-should-not-write')
    })
    expect(r.ok).toBe(false)
  })

  it('rejects empty, malformed and oversized row data', async () => {
    const outDir = join(dir, 'out-bad')
    expect((await mailMergeRegistry.mail_merge({ template_path: template, rows: [], output_dir: outDir })).ok).toBe(false)
    expect(
      (await mailMergeRegistry.mail_merge({ template_path: template, rows: ['nope'], output_dir: outDir })).ok
    ).toBe(false)

    const tooMany = await mailMergeRegistry.mail_merge({
      template_path: template,
      rows: Array.from({ length: 600 }, (_, i) => ({ Name: `p${i}` })),
      output_dir: outDir
    })
    expect(tooMany.ok).toBe(false)
    expect(tooMany.error).toContain('too many rows')
  })

  it('rejects a bad format and a non-spreadsheet data_path', async () => {
    const badFormat = await mailMergeRegistry.mail_merge({
      template_path: template,
      rows: [{ Name: 'x' }],
      output_dir: join(dir, 'out-bad'),
      format: 'rtf'
    })
    expect(badFormat.ok).toBe(false)
    expect(badFormat.error).toContain('format')

    const badData = await mailMergeRegistry.mail_merge({
      template_path: template,
      data_path: template,
      output_dir: join(dir, 'out-bad')
    })
    expect(badData.ok).toBe(false)
    expect(badData.error).toContain('.xlsx')
  })

  it('exposes exactly the one mail-merge schema', () => {
    expect(mailMergeToolSchemas.map((s) => s.name)).toEqual(['mail_merge'])
  })
})

describe('mail_merge — round-trip', () => {
  it('generates one .docx per spreadsheet row with fields substituted', async () => {
    const out = join(dir, 'out-docx')
    const r = await mailMergeRegistry.mail_merge({
      template_path: template,
      data_path: data,
      output_dir: out,
      filename_template: 'offer-{{Name}}'
    })
    expect(r.ok).toBe(true)
    expect(r.output).toContain('2 DOCX file(s)')

    const files = outputs(out)
    expect(files).toEqual(['offer-Ada Lovelace.docx', 'offer-Grace Hopper.docx'])

    // Re-read one output through the document tools and confirm substitution.
    const structure = await worddocRegistry.list_document_structure({ path: join(out, files[0]) })
    expect(structure.ok).toBe(true)
    expect(structure.output).toContain('Offer for Ada Lovelace')
    expect(structure.output).toContain('Role: Engineer')
    expect(structure.output).not.toContain('{{')
  })

  it('generates PDFs directly when format is pdf, with per-row content', async () => {
    const out = join(dir, 'out-pdf')
    const r = await mailMergeRegistry.mail_merge({
      template_path: template,
      data_path: data,
      output_dir: out,
      filename_template: '{{Name}}-offer',
      format: 'pdf'
    })
    expect(r.ok).toBe(true)
    expect(r.output).toContain('2 PDF file(s)')

    const grace = join(out, 'Grace Hopper-offer.pdf')
    expect(existsSync(grace)).toBe(true)

    const text = await pdfRegistry.read_pdf({ path: grace })
    expect(text.output).toContain('Grace Hopper')
    expect(text.output).toContain('Architect')
    expect(text.output).toContain('$150k')
    expect(text.output).toContain('2026-09-15') // from the table cell
    // Ada's row must not have leaked into Grace's document.
    expect(text.output).not.toContain('Ada Lovelace')
  })

  it('accepts inline object rows and array-of-arrays with a header row', async () => {
    const objOut = join(dir, 'out-obj')
    const objects = await mailMergeRegistry.mail_merge({
      template_path: template,
      rows: [{ Name: 'Alan', Role: 'Researcher', Salary: '$90k', Start: '2026-01-01' }],
      output_dir: objOut
    })
    expect(objects.ok).toBe(true)
    expect(outputs(objOut)).toHaveLength(1)

    const arrOut = join(dir, 'out-arr')
    const arrays = await mailMergeRegistry.mail_merge({
      template_path: template,
      rows: [
        ['Name', 'Role', 'Salary', 'Start'],
        ['Katherine', 'Analyst', '$95k', '2026-02-01']
      ],
      output_dir: arrOut
    })
    expect(arrays.ok).toBe(true)
    const structure = await worddocRegistry.list_document_structure({
      path: join(arrOut, outputs(arrOut)[0])
    })
    expect(structure.output).toContain('Offer for Katherine')
  })

  it('matches tokens case-insensitively', async () => {
    const tpl = join(dir, 'lower.docx')
    await worddocRegistry.create_document({ path: tpl, title: 'Hello {{name}}' })
    const out = join(dir, 'out-case')
    const r = await mailMergeRegistry.mail_merge({
      template_path: tpl,
      rows: [{ Name: 'Ada' }],
      output_dir: out
    })
    expect(r.ok).toBe(true)
    const structure = await worddocRegistry.list_document_structure({
      path: join(out, outputs(out)[0])
    })
    expect(structure.output).toContain('Hello Ada')
  })

  it('warns about template tokens the data has no column for, and leaves them visible', async () => {
    const out = join(dir, 'out-missing')
    const r = await mailMergeRegistry.mail_merge({
      template_path: template,
      rows: [{ Name: 'Solo' }], // no Role/Salary/Start columns
      output_dir: out
    })
    expect(r.ok).toBe(true)
    expect(r.error).toBeUndefined()
    expect(r.output).toContain('WARNING')
    expect(r.output).toContain('Role')

    const structure = await worddocRegistry.list_document_structure({
      path: join(out, outputs(out)[0])
    })
    expect(structure.output).toContain('Offer for Solo')
    expect(structure.output).toContain('{{Role}}') // unresolved, but visible
  })

  it('sanitises filenames so a hostile data row cannot escape the output folder', async () => {
    const out = join(dir, 'out-escape')
    const r = await mailMergeRegistry.mail_merge({
      template_path: template,
      rows: [{ Name: '../../../etc/passwd' }, { Name: 'con' }],
      output_dir: out,
      filename_template: '{{Name}}'
    })
    expect(r.ok).toBe(true)

    const files = outputs(out)
    expect(files).toHaveLength(2)
    // No separators survived, so nothing was written outside `out`.
    for (const f of files) {
      expect(f).not.toContain('/')
      expect(f).not.toContain('\\')
      expect(f).not.toMatch(/^\.\./)
    }
    // The Windows reserved device name was defused rather than used verbatim.
    expect(files.some((f) => f.toLowerCase() === 'con.docx')).toBe(false)
    expect(existsSync(join(dir, 'passwd.docx'))).toBe(false)
  })

  it('does not overwrite when two rows produce the same filename', async () => {
    const out = join(dir, 'out-dupes')
    const r = await mailMergeRegistry.mail_merge({
      template_path: template,
      rows: [{ Name: 'Alex' }, { Name: 'Alex' }],
      output_dir: out,
      filename_template: '{{Name}}'
    })
    expect(r.ok).toBe(true)
    expect(outputs(out)).toHaveLength(2)
  })

  it('leaves the template itself untouched', async () => {
    const structure = await worddocRegistry.list_document_structure({ path: template })
    expect(structure.output).toContain('Offer for {{Name}}')
  })
})
