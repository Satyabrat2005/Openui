import { useState } from 'react'
import type { ConnectionState, McpConnectConfig } from '../env'
import type { AppKind } from '../lib/appKind'
import AppIcon from './AppIcon'

/**
 * ConnectAppsModal (#2) — the settings panel that wires the renderer to the
 * (already validated) `openui:mcp:connect` handler via `window.openui.mcpConnect`.
 *
 * Each row is a connectable *source* backed by an MCP server config. The command
 * is prefilled but editable; browser/profile and message-app tokens are captured
 * through per-source fields. We validate on the way in (mirroring main's stdio
 * allowlist + sse scheme) for instant feedback, then main re-validates — nothing
 * here is trusted by the backend.
 */

// Mirrors ALLOWED_MCP_STDIO_COMMANDS in src/main/index.ts. Kept in sync manually;
// main remains the source of truth and rejects anything not on its own list.
const ALLOWED_STDIO = new Set(['npx', 'node', 'python', 'python3', 'uv', 'uvx', 'deno', 'bun', 'pnpm'])
const SSE_SCHEME = /^https?:\/\//i

function commandBasename(command: string): string {
  const base = command.split(/[\\/]/).pop() ?? command
  return base.replace(/\.(exe|cmd|bat)$/i, '').toLowerCase()
}

/** Client-side pre-check; returns an error string or null when the config is OK. */
function validate(config: McpConnectConfig): string | null {
  if (!config.name.trim()) return 'A connection name is required.'
  if (config.type === 'stdio') {
    if (!config.command || !config.command.trim()) return 'A launch command is required.'
    if (!ALLOWED_STDIO.has(commandBasename(config.command.trim())))
      return `Command must be one of: ${[...ALLOWED_STDIO].join(', ')}.`
    if (config.args && !config.args.every((a) => typeof a === 'string' && a.length > 0))
      return 'Arguments must be non-empty.'
  } else {
    if (!config.url || !SSE_SCHEME.test(config.url.trim())) return 'A valid http(s):// URL is required.'
  }
  return null
}

interface SourceDef {
  id: string
  name: string
  kind: AppKind
  blurb: string
  transport: 'stdio' | 'sse'
  command?: string
  args?: string[]
  url?: string
  /** A tag field, e.g. browser choice or profile, appended to args as `flag value`. */
  tag?: { label: string; flag: string; placeholder: string; default?: string }
  /** A secret captured into env (e.g. bot token). */
  secret?: { label: string; envKey: string; placeholder: string }
}

const CATALOG: SourceDef[] = [
  {
    id: 'browser',
    name: 'Browser',
    kind: 'browser',
    blurb: 'Drive a real Chrome/Edge/Firefox session via Playwright MCP.',
    transport: 'stdio',
    command: 'npx',
    args: ['@playwright/mcp@latest'],
    tag: { label: 'Browser / profile', flag: '--browser', placeholder: 'chrome, msedge, firefox', default: 'chrome' }
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp',
    kind: 'whatsapp',
    blurb: 'Read and send WhatsApp messages through a local WhatsApp MCP bridge.',
    transport: 'stdio',
    command: 'npx',
    args: ['whatsapp-mcp-server']
  },
  {
    id: 'slack',
    name: 'Slack',
    kind: 'messaging',
    blurb: 'Post and read Slack messages. Needs a bot token.',
    transport: 'stdio',
    command: 'npx',
    args: ['@modelcontextprotocol/server-slack'],
    secret: { label: 'Bot token', envKey: 'SLACK_BOT_TOKEN', placeholder: 'xoxb-…' }
  },
  {
    id: 'telegram',
    name: 'Telegram',
    kind: 'messaging',
    blurb: 'Connect a Telegram MCP bridge to read and send chats.',
    transport: 'stdio',
    command: 'npx',
    args: ['telegram-mcp'],
    secret: { label: 'Bot token', envKey: 'TELEGRAM_BOT_TOKEN', placeholder: '123456:ABC…' }
  },
  {
    id: 'custom-sse',
    name: 'Custom (SSE)',
    kind: 'app',
    blurb: 'Connect any remote MCP server over an http(s) SSE endpoint.',
    transport: 'sse',
    url: 'https://'
  }
]

/** Module-level status store so re-opening the modal reflects live connections. */
const statusStore = new Map<string, { state: ConnectionState; message?: string }>()

// ── Shared connection state (read by the left rail) ──────────────────────────
export interface ConnectableApp {
  id: string
  name: string
  kind: AppKind
  state: ConnectionState
  message?: string
}

const connListeners = new Set<() => void>()

/** Subscribe to connection-status changes; returns an unsubscribe fn. */
export function subscribeConnections(fn: () => void): () => void {
  connListeners.add(fn)
  return () => connListeners.delete(fn)
}

/** Snapshot every connectable source with its current live state. */
export function getConnections(): ConnectableApp[] {
  return CATALOG.map((s) => {
    const st = statusStore.get(s.id) ?? { state: 'disconnected' as ConnectionState }
    return { id: s.id, name: s.name, kind: s.kind, state: st.state, message: st.message }
  })
}

/** Update a source's status and notify the rail + any open modal rows. */
function setConnStatus(id: string, next: { state: ConnectionState; message?: string }): void {
  statusStore.set(id, next)
  for (const l of connListeners) l()
}

function buildConfig(src: SourceDef, tagValue: string, secretValue: string, urlValue: string): McpConnectConfig {
  if (src.transport === 'sse') {
    return { name: src.id, type: 'sse', url: urlValue.trim() }
  }
  const args = [...(src.args ?? [])]
  if (src.tag && tagValue.trim()) args.push(src.tag.flag, tagValue.trim())
  const env = src.secret && secretValue.trim() ? { [src.secret.envKey]: secretValue.trim() } : undefined
  return { name: src.id, type: 'stdio', command: src.command, args, ...(env ? { env } : {}) }
}

function StatusDot({ state }: { state: ConnectionState }): JSX.Element {
  return <span className={`ou-conn-dot ${state}`} aria-hidden="true" />
}

function statusLabel(state: ConnectionState, message?: string): string {
  switch (state) {
    case 'connecting':
      return 'Connecting…'
    case 'connected':
      return message ?? 'Connected'
    case 'error':
      return message ?? 'Failed to connect'
    default:
      return 'Not connected'
  }
}

function SourceRow({ src }: { src: SourceDef }): JSX.Element {
  const [tagValue, setTagValue] = useState(src.tag?.default ?? '')
  const [secretValue, setSecretValue] = useState('')
  const [urlValue, setUrlValue] = useState(src.url ?? '')
  const [status, setStatus] = useState(statusStore.get(src.id) ?? { state: 'disconnected' as ConnectionState })

  const connect = async (): Promise<void> => {
    const config = buildConfig(src, tagValue, secretValue, urlValue)
    const err = validate(config)
    if (err) {
      const next = { state: 'error' as ConnectionState, message: err }
      setConnStatus(src.id, next)
      setStatus(next)
      return
    }
    const connecting = { state: 'connecting' as ConnectionState }
    setConnStatus(src.id, connecting)
    setStatus(connecting)
    try {
      const res = await window.openui.mcpConnect(config)
      const next: { state: ConnectionState; message?: string } = res.ok
        ? { state: 'connected', message: `Connected · ${res.toolCount ?? 0} tool${res.toolCount === 1 ? '' : 's'}` }
        : { state: 'error', message: res.error ?? 'Failed to connect' }
      setConnStatus(src.id, next)
      setStatus(next)
    } catch (e) {
      const next = { state: 'error' as ConnectionState, message: e instanceof Error ? e.message : 'Failed to connect' }
      setConnStatus(src.id, next)
      setStatus(next)
    }
  }

  const busy = status.state === 'connecting'

  return (
    <div className="ou-conn-row">
      <div className={`ou-conn-icon ${src.kind}`}>
        <AppIcon kind={src.kind} size={18} />
      </div>
      <div className="ou-conn-main">
        <div className="ou-conn-titlerow">
          <span className="ou-conn-name">{src.name}</span>
          <span className={`ou-conn-status ${status.state}`}>
            <StatusDot state={status.state} />
            {statusLabel(status.state, status.message)}
          </span>
        </div>
        <p className="ou-conn-blurb">{src.blurb}</p>

        <div className="ou-conn-fields">
          {src.transport === 'sse' && (
            <input
              className="ou-conn-input"
              type="url"
              value={urlValue}
              onChange={(e) => setUrlValue(e.target.value)}
              placeholder="https://host/sse"
              aria-label={`${src.name} SSE URL`}
              spellCheck={false}
            />
          )}
          {src.tag && (
            <input
              className="ou-conn-input"
              type="text"
              value={tagValue}
              onChange={(e) => setTagValue(e.target.value)}
              placeholder={src.tag.placeholder}
              aria-label={`${src.name} ${src.tag.label}`}
              spellCheck={false}
            />
          )}
          {src.secret && (
            <input
              className="ou-conn-input"
              type="password"
              value={secretValue}
              onChange={(e) => setSecretValue(e.target.value)}
              placeholder={src.secret.placeholder}
              aria-label={`${src.name} ${src.secret.label}`}
              autoComplete="off"
              spellCheck={false}
            />
          )}
          <button
            type="button"
            className="ou-conn-btn"
            onClick={() => void connect()}
            disabled={busy}
          >
            {status.state === 'connected' ? 'Reconnect' : busy ? 'Connecting…' : 'Connect'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function ConnectAppsModal({ onClose }: { onClose: () => void }): JSX.Element {
  return (
    <div
      className="ou-modal-scrim"
      onMouseDown={(e) => {
        e.stopPropagation()
        onClose()
      }}
    >
      <div className="ou-conn-panel" onMouseDown={(e) => e.stopPropagation()}>
        <div className="ou-conn-header">
          <div>
            <h3 className="ou-conn-h3">Connect apps</h3>
            <p className="ou-conn-sub">
              Link OpenUI to your browser and messaging apps over MCP. Connections run for this session.
            </p>
          </div>
          <button type="button" className="ou-conn-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="ou-conn-list">
          {CATALOG.map((src) => (
            <SourceRow key={src.id} src={src} />
          ))}
        </div>
      </div>
    </div>
  )
}
