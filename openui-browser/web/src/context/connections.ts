// Web connection store — same synchronous getConnections()/subscribeConnections()
// surface the desktop ConnectAppsModal exported (so RunConsole's CONNECTED group
// and CAN TOUCH scope pills port unchanged), but the source is the REST endpoint
// instead of the Electron connection manager.
import type { AppKind } from '../types'
import { getConnectionsRemote } from '../api'

export type ConnectionState = 'connected' | 'disconnected' | 'connecting' | 'error'
export interface ConnectableApp {
  id: string
  name: string
  kind: AppKind
  state: ConnectionState
  message?: string
}

let cache: ConnectableApp[] = []
const listeners = new Set<() => void>()

function emit(): void {
  listeners.forEach((fn) => fn())
}

export function getConnections(): ConnectableApp[] {
  return cache
}

export function subscribeConnections(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Refresh from the backend; call once on app mount. */
export async function refreshConnections(): Promise<void> {
  const rows = await getConnectionsRemote()
  cache = rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind as AppKind,
    state: r.state as ConnectionState
  }))
  emit()
}

/** Optimistically mark a connection (used by the connect modal after a PAT is set). */
export function setLocalConnection(id: string, name: string, kind: AppKind, state: ConnectionState): void {
  const i = cache.findIndex((c) => c.id === id)
  const row = { id, name, kind, state }
  if (i === -1) cache = [...cache, row]
  else cache = cache.map((c) => (c.id === id ? row : c))
  emit()
}
