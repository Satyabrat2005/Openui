import { useCallback, useEffect, useState } from 'react'
import type { Workflow } from '../env'

interface Props {
  onClose: () => void
  onRunWorkflow?: (workflowName: string) => void
}

export default function WorkflowsUI({ onClose, onRunWorkflow }: Props): JSX.Element {
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)

  const refresh = useCallback((): void => {
    window.openui
      .listWorkflows()
      .then(setWorkflows)
      .catch(() => setWorkflows([]))
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const handleImport = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setStatus(null)
    try {
      const result = await window.openui.importWorkflow()
      if (result.ok && result.workflow) {
        setStatus(`Imported "${result.workflow.name}"`)
        refresh()
      } else if (result.error && result.error !== 'Cancelled') {
        setStatus(`Import failed: ${result.error}`)
      }
    } catch (err) {
      setStatus(`Import error: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const handleExport = async (workflow: Workflow): Promise<void> => {
    if (busy) return
    setBusy(true)
    setStatus(null)
    try {
      const result = await window.openui.exportWorkflow(workflow)
      if (result.ok) {
        setStatus(`Exported "${workflow.name}"`)
      } else if (result.error && result.error !== 'Cancelled') {
        setStatus(`Export failed: ${result.error}`)
      }
    } catch (err) {
      setStatus(`Export error: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async (name: string): Promise<void> => {
    if (busy) return
    setBusy(true)
    setStatus(null)
    try {
      const result = await window.openui.deleteWorkflow(name)
      if (result.ok) {
        setStatus(`Deleted "${name}"`)
        refresh()
      } else {
        setStatus(`Delete failed: ${result.error ?? 'Unknown error'}`)
      }
    } catch (err) {
      setStatus(`Delete error: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const handleRun = (workflow: Workflow): void => {
    onRunWorkflow?.(workflow.name)
    onClose()
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        background: 'rgba(0,0,0,0.55)',
        backdropFilter: 'blur(6px)'
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        style={{
          background: 'rgba(18,18,22,0.97)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 16,
          padding: '24px 24px 20px',
          width: 480,
          maxHeight: '80vh',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          boxShadow: '0 24px 64px rgba(0,0,0,0.7)',
          color: '#fff',
          fontFamily: 'inherit'
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600, letterSpacing: '-0.3px' }}>
              Team Workflows
            </h2>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: 'rgba(255,255,255,0.45)' }}>
              Saved automation sequences your team can share and run
            </p>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              color: 'rgba(255,255,255,0.45)',
              cursor: 'pointer',
              fontSize: 20,
              lineHeight: 1,
              padding: 4
            }}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* Status message */}
        {status && (
          <div
            style={{
              fontSize: 12,
              padding: '8px 12px',
              borderRadius: 8,
              background: status.includes('failed') || status.includes('error')
                ? 'rgba(239,68,68,0.15)'
                : 'rgba(34,197,94,0.15)',
              color: status.includes('failed') || status.includes('error')
                ? '#f87171'
                : '#4ade80',
              border: `1px solid ${
                status.includes('failed') || status.includes('error')
                  ? 'rgba(239,68,68,0.25)'
                  : 'rgba(34,197,94,0.25)'
              }`
            }}
          >
            {status}
          </div>
        )}

        {/* Workflow list */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            minHeight: 0
          }}
        >
          {workflows.length === 0 ? (
            <div
              style={{
                textAlign: 'center',
                padding: '40px 0',
                color: 'rgba(255,255,255,0.3)',
                fontSize: 13
              }}
            >
              No workflows saved yet.
              <br />
              Import a .workflow.json file to get started.
            </div>
          ) : (
            workflows.map((wf) => (
              <div
                key={wf.name}
                style={{
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.07)',
                  borderRadius: 10,
                  overflow: 'hidden'
                }}
              >
                {/* Row */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '10px 12px'
                  }}
                >
                  <button
                    onClick={() => setExpanded(expanded === wf.name ? null : wf.name)}
                    style={{
                      flex: 1,
                      background: 'none',
                      border: 'none',
                      color: '#fff',
                      cursor: 'pointer',
                      textAlign: 'left',
                      padding: 0
                    }}
                  >
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{wf.name}</div>
                    <div
                      style={{
                        fontSize: 11,
                        color: 'rgba(255,255,255,0.4)',
                        marginTop: 2,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap'
                      }}
                    >
                      {wf.description || 'No description'} · {wf.steps.length} step
                      {wf.steps.length !== 1 ? 's' : ''}
                    </div>
                  </button>

                  {/* Action buttons */}
                  <button
                    onClick={() => handleRun(wf)}
                    disabled={busy}
                    title="Run workflow"
                    style={iconBtn('var(--ou-violet)')}
                    aria-label={`Run ${wf.name}`}
                  >
                    ▶
                  </button>
                  <button
                    onClick={() => handleExport(wf)}
                    disabled={busy}
                    title="Export workflow"
                    style={iconBtn('rgba(255,255,255,0.4)')}
                    aria-label={`Export ${wf.name}`}
                  >
                    ↑
                  </button>
                  <button
                    onClick={() => handleDelete(wf.name)}
                    disabled={busy}
                    title="Delete workflow"
                    style={iconBtn('#f87171')}
                    aria-label={`Delete ${wf.name}`}
                  >
                    ✕
                  </button>
                </div>

                {/* Expanded step list */}
                {expanded === wf.name && (
                  <div
                    style={{
                      borderTop: '1px solid rgba(255,255,255,0.06)',
                      padding: '10px 12px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 6
                    }}
                  >
                    <div
                      style={{
                        fontSize: 10,
                        color: 'rgba(255,255,255,0.35)',
                        textTransform: 'uppercase',
                        letterSpacing: '0.06em',
                        marginBottom: 2
                      }}
                    >
                      Trigger: {wf.trigger || '—'}
                    </div>
                    {wf.steps.map((step, i) => (
                      <div
                        key={i}
                        style={{
                          display: 'flex',
                          gap: 8,
                          fontSize: 11,
                          color: 'rgba(255,255,255,0.6)'
                        }}
                      >
                        <span style={{ color: 'rgba(255,255,255,0.25)', minWidth: 20 }}>
                          {i + 1}.
                        </span>
                        <span>
                          <span
                            style={{
                              fontFamily: 'monospace',
                              color: 'var(--ou-violet)',
                              background: 'var(--ou-violet-soft)',
                              padding: '1px 5px',
                              borderRadius: 4
                            }}
                          >
                            {step.tool}
                          </span>
                          {' '}
                          <span style={{ color: 'rgba(255,255,255,0.35)' }}>
                            {JSON.stringify(step.args)}
                          </span>
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        {/* Footer actions */}
        <div style={{ display: 'flex', gap: 8, paddingTop: 4, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          <button
            onClick={handleImport}
            disabled={busy}
            style={{
              flex: 1,
              padding: '9px 0',
              borderRadius: 8,
              border: '1px solid var(--ou-violet-border)',
              background: 'var(--ou-violet-soft)',
              color: 'var(--ou-violet)',
              fontSize: 13,
              fontWeight: 500,
              cursor: busy ? 'not-allowed' : 'pointer',
              opacity: busy ? 0.5 : 1
            }}
          >
            Import Workflow…
          </button>
          <button
            onClick={onClose}
            style={{
              padding: '9px 18px',
              borderRadius: 8,
              border: '1px solid rgba(255,255,255,0.1)',
              background: 'rgba(255,255,255,0.05)',
              color: 'rgba(255,255,255,0.6)',
              fontSize: 13,
              cursor: 'pointer'
            }}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

function iconBtn(color: string): React.CSSProperties {
  return {
    background: 'none',
    border: 'none',
    color,
    cursor: 'pointer',
    fontSize: 13,
    padding: '3px 6px',
    borderRadius: 5,
    lineHeight: 1
  }
}
