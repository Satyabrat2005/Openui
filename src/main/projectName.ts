/**
 * projectName.ts — derive a filesystem-safe project folder name from the user's
 * build request.
 *
 * Kept pure (no electron, no fs) so the slug rules can be unit-tested directly.
 * The output is used as a single path segment under the projects root, so it
 * must never contain a separator, a drive letter, or a `..` component — the
 * character whitelist below is the guarantee, and `isSafeProjectSlug` is the
 * assertion the sandbox re-checks before trusting a caller-supplied name.
 */

/**
 * Words stripped from the head and tail of the request. These are the framing
 * verbs and articles people wrap a request in ("build me a …"), never the
 * subject of the project itself.
 */
const NOISE_WORDS = new Set([
  'please',
  'can',
  'could',
  'you',
  'build',
  'create',
  'make',
  'generate',
  'scaffold',
  'write',
  'design',
  'develop',
  'code',
  'me',
  'us',
  'my',
  'a',
  'an',
  'the',
  'some',
  'new',
  'for',
  'with',
  'and',
  'of',
  'to'
])

/** Device names Windows refuses to use as a directory, whatever the extension. */
const WINDOWS_RESERVED = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9'
])

const MAX_WORDS = 5
const MAX_LENGTH = 48
const FALLBACK = 'project'

/** A slug safe to use as one path segment: lowercase alnum, inner hyphens only. */
export function isSafeProjectSlug(slug: string): boolean {
  return typeof slug === 'string' && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug) && slug.length <= MAX_LENGTH
}

function finaliseSlug(slug: string): string {
  const cleaned = slug.slice(0, MAX_LENGTH).replace(/^-+|-+$/g, '')
  if (!cleaned) return FALLBACK
  if (WINDOWS_RESERVED.has(cleaned)) return `${cleaned}-${FALLBACK}`
  return cleaned
}

function slugifyName(name: string): string {
  return finaliseSlug(
    String(name ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
  )
}

/**
 * Turn a free-text build request into a short folder name.
 *
 *   "Build me a 3D motion graphics website for food and groceries"
 *     → "3d-motion-graphics-website"
 *
 * Always returns a slug satisfying `isSafeProjectSlug`.
 */
export function deriveProjectSlug(message: string): string {
  const raw = String(message ?? '')
  const explicit =
    raw.match(/folder\s+(?:called|named)\s+["'`]?([\w .-]{1,40}?)["'`]?(?=[.,!?]|$|\s+(?:and|with|that|to|for)\b)/i) ||
    raw.match(/(?:call|name)\s+it\s+["'`]?([\w .-]{1,40}?)["'`]?(?=[.,!?]|$|\s+(?:and|with|that|to|for)\b)/i) ||
    raw.match(/(?:called|named)\s+["'`]?([\w .-]{1,40}?)["'`]?(?=[.,!?]|$|\s+(?:and|with|that|to|for)\b)/i)
  if (explicit) return slugifyName(explicit[1])

  const words = raw
    .toLowerCase()
    // Anything outside the whitelist becomes a separator, so punctuation,
    // quotes, slashes and dots can never survive into the path segment.
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean)

  let start = 0
  while (start < words.length && NOISE_WORDS.has(words[start])) start++

  const picked = words.slice(start, start + MAX_WORDS)
  while (picked.length > 0 && NOISE_WORDS.has(picked[picked.length - 1])) picked.pop()

  return finaliseSlug(picked.join('-'))
}
