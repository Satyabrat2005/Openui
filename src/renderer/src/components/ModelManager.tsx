import { useCallback, useEffect, useState } from 'react'
import type { ModelDownloadResult, ModelPullProgress, ModelStatus } from '../env'

/**
 * The in-app way to get a local model — the whole point of which is that there
 * is no other way a user is ever told about.
 *
 * Three things this has to get right, because each was a real failure mode:
 *
 *  1. REAL PROGRESS. The bar tracks the byte counts Ollama streams
 *     (`openui:model:pull`), including the phases that carry no byte counts at
 *     all ("pulling manifest", "verifying") — those show the phase text rather
 *     than a 0% bar that looks frozen for minutes.
 *  2. SPECIFIC FAILURES. Each failure code from main/modelDownload.ts gets its
 *     own message. "Download failed" is not an answer a person can act on.
 *  3. NO TERMINAL. Nothing here — button, hint, or error — names a shell
 *     command. When the engine is missing we offer the installer page; we do not
 *     install it silently and we do not fall back to "run this command".
 */

/** Human-readable byte size, mirroring main/ollamaPull.ts's formatBytes. */
function formatBytes(n: number | null): string {
  if (n === null) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let v = n
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  return `${v >= 10 || u === 0 ? Math.round(v) : v.toFixed(1)} ${units[u]}`
}

interface FailState {
  message: string
  installUrl?: string
}

export default function ModelManager(): JSX.Element {
  const [models, setModels] = useState<ModelStatus[] | null>(null)
  const [progress, setProgress] = useState<Record<string, ModelPullProgress>>({})
  const [failures, setFailures] = useState<Record<string, FailState>>({})
  /** Models this component has a download in flight for. */
  const [pending, setPending] = useState<Record<string, boolean>>({})

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setModels(await window.openui.listLocalModels())
    } catch {
      setModels([])
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Progress arrives on a broadcast channel, so a download started anywhere
  // (including automatically by a chat turn) shows up here too.
  useEffect(() => {
    return window.openui.onModelPull((p) => {
      setProgress((prev) => ({ ...prev, [p.model]: p }))
      if (p.done) void refresh()
    })
  }, [refresh])

  const download = async (model: string): Promise<void> => {
    setFailures((prev) => {
      const next = { ...prev }
      delete next[model]
      return next
    })
    setPending((prev) => ({ ...prev, [model]: true }))
    try {
      const result: ModelDownloadResult = await window.openui.downloadModel(model)
      if (!result.ok) {
        setFailures((prev) => ({
          ...prev,
          [model]: { message: result.message, installUrl: result.installUrl }
        }))
      }
    } catch {
      setFailures((prev) => ({
        ...prev,
        [model]: { message: 'The download could not be started. Please try again.' }
      }))
    } finally {
      setPending((prev) => ({ ...prev, [model]: false }))
      void refresh()
    }
  }

  if (models === null) {
    return (
      <div className="ou-models" data-testid="model-manager">
        <div className="ou-settings-label">Local model</div>
        <div className="ou-settings-desc">Checking which models are installed…</div>
      </div>
    )
  }

  return (
    <div className="ou-models" data-testid="model-manager">
      <div className="ou-settings-label">Local model</div>
      <div className="ou-settings-desc" style={{ marginBottom: 10 }}>
        OpenUI runs its models on your machine. Download them here — this is the only step, and it
        only has to happen once per model.
      </div>

      {models.map((m) => {
        const p = progress[m.id]
        const fail = failures[m.id]
        const active = (pending[m.id] || m.downloading) && !p?.done
        return (
          <div key={m.id} className="ou-model-row" data-testid={`model-row-${m.id}`}>
            <div className="ou-model-head">
              <div className="ou-model-grow">
                <div className="ou-model-name">{m.label}</div>
                <div className="ou-model-purpose">{m.purpose}</div>
              </div>
              {m.installed ? (
                <span className="ou-model-ready" data-testid={`model-ready-${m.id}`}>
                  Installed
                </span>
              ) : (
                <button
                  type="button"
                  className="ou-model-btn"
                  disabled={active}
                  onClick={() => void download(m.id)}
                >
                  {active ? 'Downloading…' : `Download · ${m.approxSize}`}
                </button>
              )}
            </div>

            {active && (
              <div className="ou-model-progress" role="status" aria-live="polite">
                <div className="ou-model-bar">
                  {/* A phase with no byte counts gets an indeterminate bar, not a
                      0% one — a stuck-looking bar is how a working download got
                      reported as a hang. */}
                  <div
                    className={p?.percent === null || p === undefined ? 'ou-model-fill indeterminate' : 'ou-model-fill'}
                    style={p?.percent != null ? { width: `${p.percent}%` } : undefined}
                  />
                </div>
                <div className="ou-model-phase">
                  {p?.percent != null
                    ? `${p.percent}% · ${formatBytes(p.completed)} of ${formatBytes(p.total)}${
                        p.layer ? ` · layer ${p.layer}` : ''
                      }`
                    : p?.status || 'starting download'}
                </div>
              </div>
            )}

            {fail && (
              <div className="ou-model-error" role="alert" data-testid={`model-error-${m.id}`}>
                <span>{fail.message}</span>
                {fail.installUrl && (
                  <button
                    type="button"
                    className="ou-auth-link"
                    onClick={() => window.open(fail.installUrl, '_blank', 'noopener,noreferrer')}
                  >
                    Get the local AI engine
                  </button>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
