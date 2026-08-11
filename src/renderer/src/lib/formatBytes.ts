/**
 * formatBytes.ts — byte counts as short human-readable sizes.
 *
 * Used by the model-download progress bar. Mirrors the main-process helper in
 * ollamaPull.ts; kept separate because the renderer must not import from
 * src/main (different build target, and main pulls in Electron).
 */
export function formatBytes(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let v = n
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  return `${v >= 10 || u === 0 ? Math.round(v) : v.toFixed(1)} ${units[u]}`
}
