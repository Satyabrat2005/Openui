import { useEffect, useState } from 'react'
import type { McpConnectConfig, McpServerStatus } from '../env'

/**
 * ConnectAppsPanel — the real UI for the (previously unreachable)
 * openui:mcp:connect handler. It builds an McpConnectConfig from a small form and
 * calls window.openui.connectMcp(), which the MAIN process fully validates before
 * it reaches connectMcpServer() (name/type checks + a stdio-command allowlist +
 * http(s)-only SSE urls). The light validation here is UX-only — the main-process
 * gate remains the security boundary. Per-app connection status
 * (connected/disconnected/error) is shown live.
 */

// Mirrors the main-process allowlist so we can warn early; the main gate is
// authoritative regardless of what we let through here.
const ALLOWED_STDIO = ['npx', 'node', 'python', 'python3', 'uv', 'uvx', 'deno', 'bun', 'pnpm']

interface Props {
  onClose: () => void
}

function StatusChip({ status }: { status: McpServerStatus['status'] }): JSX.Element {
  const label = status === 'connected' ? 'Connected' : status === 'error' ? 'Error' : 'Disconnected'
  return <span className={`ou-mcp-chip ${status}`}>{label}</span>
}

export default function ConnectAppsPanel({ onClose }: Props): JSX.Element {
  const [servers, setServers] = useState<McpServerStatus[]>([])
  const [name, setName] = useState('')
  const [type, setType] = useState<'stdio' | 'sse'>('stdio')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.openui.getMcpStatus().then(setServers).catch(() => {})
    return window.openui.onMcpStatus(setServers)
  }, [])

  const commandBase = command.trim().split(/[\\/]/).pop()?.replace(/\.(exe|cmd|bat)$/i, '').toLowerCase() ?? ''
  const localValidationError = ((): string | null => {
    if (!name.trim()) return 'Give this app a name.'
    if (type === 'stdio') {
      if (!command.trim()) return 'A command is required for a local (stdio) server.'
      if (!ALLOWED_STDIO.includes(commandBase)) {
        return `Command must be one of: ${ALLOWED_STDIO.join(', ')}.`
      }
    } else {
      if (!/^https?:\/\//i.test(url.trim())) return 'URL must start with http:// or https://.'
    }
    return null
  })()

  const connect = async (): Promise<void> => {
    if (localValidationError) {
      setError(localValidationError)
      return
    }
    setBusy(true)
    setError(null)
    const config: McpConnectConfig =
      type === 'stdio'
        ? {
            name: name.trim(),
            type: 'stdio',
            command: command.trim(),
            args: args.trim() ? args.trim().split(/\s+/) : undefined
          }
        : { name: name.trim(), type: 'sse', url: url.trim() }
    try {
      const result = await window.openui.connectMcp(config)
      if (!result.ok) setError(result.error ?? 'Connection failed.')
      else {
        // Clear the form on success; the status list updates via onMcpStatus.
        setName('')
        setCommand('')
        setArgs('')
        setUrl('')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ou-modal-scrim" onMouseDown={onClose}>
      <div className="ou-modal ou-mcp" onMouseDown={(e) => e.stopPropagation()}>
        <div className="ou-modal-head">
          <h3>Connect an app</h3>
          <button type="button" aria-label="Close" className="ou-modal-close" onClick={onClose}>
            ×
          </button>
        </div>
        <p className="ou-modal-sub">
          Connect a Model Context Protocol server to give OpenUI new tools. Local commands are
          limited to a safe allowlist.
        </p>

        {/* Connected apps + status */}
        {servers.length > 0 && (
          <div className="ou-mcp-list">
            {servers.map((s) => (
              <div className="ou-mcp-row" key={s.name}>
                <div className="ou-mcp-row-main">
                  <span className="ou-mcp-name">{s.name}</span>
                  <span className="ou-mcp-meta">
                    {s.type}
                    {s.status === 'connected' ? ` · ${s.toolCount} tool${s.toolCount === 1 ? '' : 's'}` : ''}
                    {s.status === 'error' && s.error ? ` · ${s.error}` : ''}
                  </span>
                </div>
                <div className="ou-mcp-row-actions">
                  <StatusChip status={s.status} />
                  {s.status === 'connected' && (
                    <button
                      type="button"
                      className="ou-mcp-disconnect"
                      onClick={() => void window.openui.disconnectMcp(s.name)}
                    >
                      Disconnect
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Add-a-server form */}
        <div className="ou-mcp-form">
          <label className="ou-field">
            <span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. filesystem" />
          </label>
          <div className="ou-mcp-type">
            <button
              type="button"
              className={type === 'stdio' ? 'active' : ''}
              onClick={() => setType('stdio')}
            >
              Local (stdio)
            </button>
            <button
              type="button"
              className={type === 'sse' ? 'active' : ''}
              onClick={() => setType('sse')}
            >
              Remote (SSE)
            </button>
          </div>

          {type === 'stdio' ? (
            <>
              <label className="ou-field">
                <span>Command</span>
                <input
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="npx"
                  spellCheck={false}
                />
              </label>
              <label className="ou-field">
                <span>Arguments</span>
                <input
                  value={args}
                  onChange={(e) => setArgs(e.target.value)}
                  placeholder="-y @modelcontextprotocol/server-filesystem ~/Documents"
                  spellCheck={false}
                />
              </label>
            </>
          ) : (
            <label className="ou-field">
              <span>Server URL</span>
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/sse"
                spellCheck={false}
              />
            </label>
          )}

          {(error || localValidationError) && (
            <div className="ou-mcp-error">{error ?? localValidationError}</div>
          )}

          <button
            type="button"
            className="ou-mcp-connect"
            onClick={() => void connect()}
            disabled={busy || localValidationError !== null}
          >
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        </div>
      </div>
    </div>
  )
}
