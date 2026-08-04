// Safety gate — the web port of the desktop STATE_CHANGING_TOOLS /
// DESTRUCTIVE_TOOLS architecture. A gated tool's first /api/tool call returns
// needsConfirmation and does NOT execute; it runs only on a second request with
// a single-use, args-bound token. This is the property the Run Console's inline
// Approve/Deny callout is wired to (it never mutates until confirmed).

import { createHash, randomBytes } from 'node:crypto'

export const STATE_CHANGING_TOOLS = new Set<string>([
  'write_spreadsheet', 'create_repo', 'update_readme', 'push_files', 'open_pull_request', 'merge_pr'
])
export const DESTRUCTIVE_TOOLS = new Set<string>([
  'create_repo', 'push_files', 'open_pull_request', 'merge_pr'
])
export function requiresConfirmation(name: string): boolean {
  return STATE_CHANGING_TOOLS.has(name) || DESTRUCTIVE_TOOLS.has(name)
}
export function isDestructive(name: string): boolean {
  return DESTRUCTIVE_TOOLS.has(name)
}
export function hashArgs(args: unknown): string {
  return createHash('sha256').update(JSON.stringify(args ?? null)).digest('hex')
}

interface Pending { userId: string; toolName: string; argsHash: string; expiresAt: number }
const TTL_MS = 5 * 60 * 1000

export class ConfirmationStore {
  private pending = new Map<string, Pending>()
  issue(userId: string, toolName: string, args: unknown): string {
    const token = randomBytes(24).toString('hex')
    this.pending.set(token, { userId, toolName, argsHash: hashArgs(args), expiresAt: Date.now() + TTL_MS })
    return token
  }
  consume(token: string, userId: string, toolName: string, args: unknown): boolean {
    const e = this.pending.get(token)
    if (!e) return false
    this.pending.delete(token) // single-use even on mismatch
    return e.expiresAt >= Date.now() && e.userId === userId && e.toolName === toolName && e.argsHash === hashArgs(args)
  }
  sweep(now = Date.now()): void {
    for (const [k, v] of this.pending) if (v.expiresAt < now) this.pending.delete(k)
  }
}
