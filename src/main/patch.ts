/**
 * patch.ts — apply unified-diff hunks to a file's text (Task §6).
 *
 * `edit_file` already gives the coding agent a scoped, token-cheap edit: it
 * swaps ONE literal substring. That is perfect for a single site, but a change
 * that touches several places in a large file becomes several round-trips —
 * each re-reading the file, each another turn off the budget. A unified diff
 * expresses all of those hunks in one call, and its `@@` line anchors make the
 * edit reviewable and let us reject a patch that no longer fits the file rather
 * than clobbering it.
 *
 * Deliberately pure: string in, string out. No fs, no Electron — the sandbox
 * wiring (path resolution, snapshotting, byte cap) lives in
 * sandbox.ts:applyPatchToSandboxFile. Every branch below has a fixture in
 * patch.test.ts.
 *
 * Safety: like editSandboxFile, this never guesses. A hunk applies only where
 * its full context+removed block matches the file byte-for-byte; line numbers
 * are allowed to drift (the file may have grown/shrunk since the diff was
 * generated) but the surrounding text must still match, within a bounded fuzz
 * window. A hunk that matches nowhere throws — the model must re-read and
 * regenerate rather than corrupt the file.
 */

/** One line of a hunk: a leading marker plus the text after it. */
export interface HunkLine {
  /** ' ' = context (unchanged), '+' = added, '-' = removed. */
  type: ' ' | '+' | '-'
  /** The line content with the marker stripped (no trailing newline). */
  text: string
}

/** One `@@ -oldStart,oldLines +newStart,newLines @@` block. */
export interface Hunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: HunkLine[]
}

/** How far from a hunk's stated line number we search for its context. */
const FUZZ = 200

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/** Context+removed line count a hunk has collected so far (its "old" side). */
function oldCount(h: Hunk): number {
  let n = 0
  for (const l of h.lines) if (l.type !== '+') n++
  return n
}

/** Added+context line count a hunk has collected so far (its "new" side). */
function newCount(h: Hunk): number {
  let n = 0
  for (const l of h.lines) if (l.type !== '-') n++
  return n
}

/** A hunk is full once it has as many old- and new-side lines as its header declared. */
function hunkComplete(h: Hunk): boolean {
  return oldCount(h) >= h.oldLines && newCount(h) >= h.newLines
}

/**
 * Parse a unified diff into hunks. Header noise before the first `@@`
 * (`--- a/x`, `+++ b/x`, `diff --git`, `index …`) is ignored — the target file
 * is supplied out-of-band by the caller, so only the hunks matter. Throws on a
 * patch with no hunks.
 */
export function parseUnifiedDiff(diff: string): Hunk[] {
  if (typeof diff !== 'string' || !diff.trim()) {
    throw new Error('patch is empty — provide a unified diff with at least one @@ hunk')
  }
  const hunks: Hunk[] = []
  let current: Hunk | null = null

  for (const raw of diff.split(/\r?\n/)) {
    const header = raw.match(HUNK_HEADER)
    if (header) {
      current = {
        oldStart: +header[1],
        oldLines: header[2] === undefined ? 1 : +header[2],
        newStart: +header[3],
        newLines: header[4] === undefined ? 1 : +header[4],
        lines: []
      }
      hunks.push(current)
      continue
    }
    if (!current) continue // preamble before the first hunk
    if (raw.startsWith('\\')) continue // "\ No newline at end of file" — metadata

    const marker = raw[0]
    if (marker === ' ' || marker === '+' || marker === '-') {
      current.lines.push({ type: marker, text: raw.slice(1) })
      if (hunkComplete(current)) current = null
      continue
    }
    // Some emitters drop the leading space on an empty context line. Treat a
    // bare empty line as empty context while the hunk still needs lines; once
    // the hunk is full, an empty line is just the gap before the next one.
    if (raw === '' && !hunkComplete(current)) {
      current.lines.push({ type: ' ', text: '' })
      if (hunkComplete(current)) current = null
      continue
    }
    // Anything else (trailing prose, a new file's header) ends this hunk.
    current = null
  }

  if (!hunks.length) throw new Error('no @@ hunks found in patch')
  return hunks
}

/** The old-side (context + removed) text block a hunk expects to find in the file. */
function oldSide(h: Hunk): string[] {
  return h.lines.filter((l) => l.type !== '+').map((l) => l.text)
}

/** True when `block` matches `src` exactly, starting at `pos`. */
function matchesAt(src: string[], pos: number, block: string[]): boolean {
  if (pos < 0 || pos + block.length > src.length) return false
  for (let i = 0; i < block.length; i++) if (src[pos + i] !== block[i]) return false
  return true
}

/**
 * Find where a hunk's old-side block sits in `src`, at or after `from`. Prefers
 * the header's stated line, then searches outward within FUZZ so a diff whose
 * line numbers have drifted still applies as long as the surrounding text is
 * intact. A pure insertion (no context, no removals) applies at its stated line.
 */
function locateHunk(src: string[], h: Hunk, from: number): number {
  const block = oldSide(h)
  if (block.length === 0) {
    return Math.max(from, Math.min(h.oldStart - 1, src.length))
  }
  const preferred = Math.max(from, h.oldStart - 1)
  if (matchesAt(src, preferred, block)) return preferred
  for (let d = 1; d <= FUZZ; d++) {
    const down = preferred + d
    if (down >= from && matchesAt(src, down, block)) return down
    const up = preferred - d
    if (up >= from && matchesAt(src, up, block)) return up
  }
  throw new Error(
    `patch does not apply: context near line ${h.oldStart} does not match the file. ` +
      'The file may have changed since the diff was generated — re-read it and regenerate the hunk.'
  )
}

/**
 * Apply parsed hunks to a file's text and return the new text. Hunks are applied
 * in order; each must land at or after the previous one (no overlap). The
 * original file's trailing-newline state is preserved.
 */
export function applyPatch(original: string, hunks: Hunk[]): string {
  const hadTrailingNewline = original.endsWith('\n')
  const src = original.length ? original.split('\n') : []
  if (hadTrailingNewline) src.pop() // drop the empty element the trailing \n produces

  const out: string[] = []
  let srcIdx = 0 // how many original lines have been consumed

  for (const h of hunks) {
    const loc = locateHunk(src, h, srcIdx)
    // Copy the untouched gap between the last hunk and this one.
    for (let i = srcIdx; i < loc; i++) out.push(src[i])
    srcIdx = loc
    // locateHunk has verified the whole old-side block matches at `loc`, so
    // consuming context/removed lines here cannot diverge from the file.
    for (const line of h.lines) {
      if (line.type === ' ') {
        out.push(src[srcIdx])
        srcIdx++
      } else if (line.type === '-') {
        srcIdx++
      } else {
        out.push(line.text)
      }
    }
  }
  for (let i = srcIdx; i < src.length; i++) out.push(src[i])

  let result = out.join('\n')
  if (hadTrailingNewline) result += '\n'
  return result
}
