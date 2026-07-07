import { useEffect, useRef, useState } from 'react'

/**
 * PlusMenu (#1) — the "+" affordance next to the composer. Opens a small menu
 * with three actions:
 *   • Attach a file — reads a local file in the renderer and hands its name +
 *     (for text-like files) contents back to the composer as message context.
 *     There is no agent file-upload channel, so images attach by name only.
 *   • Connect an app — opens the Connect-apps (MCP) panel (#2).
 *   • Assign a task — routes the request straight to the task board (#4) instead
 *     of the chat thread. Execution still goes through the agent (there is one
 *     execution path); "assign" just changes where the UI focuses.
 */
export interface AttachedFile {
  name: string
  /** Text contents for text-like files, or null for binary/images. */
  text: string | null
}

const TEXT_EXT = /\.(txt|md|markdown|json|ya?ml|csv|log|js|jsx|ts|tsx|py|rb|go|rs|java|c|h|cpp|css|html?|xml|sh|toml|ini)$/i
const MAX_TEXT_CHARS = 20000

export default function PlusMenu({
  onAttach,
  onConnect,
  onAssign,
  disabled
}: {
  onAttach: (file: AttachedFile) => void
  onConnect: () => void
  onAssign: () => void
  disabled?: boolean
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-selecting the same file
    if (!file) return
    const isText = TEXT_EXT.test(file.name) || file.type.startsWith('text/')
    let text: string | null = null
    if (isText) {
      try {
        text = (await file.text()).slice(0, MAX_TEXT_CHARS)
      } catch {
        text = null
      }
    }
    onAttach({ name: file.name, text })
  }

  return (
    <div className="ou-plus" ref={rootRef}>
      <button
        type="button"
        className={`ou-plus-btn ${open ? 'open' : ''}`}
        aria-label="Add"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Attach, connect an app, or assign a task"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
          <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>

      {open && (
        <div className="ou-plus-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            className="ou-plus-item"
            onClick={() => {
              setOpen(false)
              fileRef.current?.click()
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12.5 12.5 21a5 5 0 0 1-7-7l8-8a3.5 3.5 0 0 1 5 5l-8 8a2 2 0 0 1-3-3l7.5-7.5" />
            </svg>
            <div className="ou-plus-item-text">
              <span className="ou-plus-item-title">Attach a file</span>
              <span className="ou-plus-item-sub">README, docs, images</span>
            </div>
          </button>

          <button
            type="button"
            role="menuitem"
            className="ou-plus-item"
            onClick={() => {
              setOpen(false)
              onConnect()
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 12a3 3 0 0 0 3 3l2-2a3 3 0 0 0-4-4M15 12a3 3 0 0 0-3-3l-2 2a3 3 0 0 0 4 4" />
            </svg>
            <div className="ou-plus-item-text">
              <span className="ou-plus-item-title">Connect an app</span>
              <span className="ou-plus-item-sub">Browser, WhatsApp, more</span>
            </div>
          </button>

          <button
            type="button"
            role="menuitem"
            className="ou-plus-item"
            onClick={() => {
              setOpen(false)
              onAssign()
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 11l3 3 8-8M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9" />
            </svg>
            <div className="ou-plus-item-text">
              <span className="ou-plus-item-title">Assign a task</span>
              <span className="ou-plus-item-sub">Send straight to the task board</span>
            </div>
          </button>
        </div>
      )}

      <input
        ref={fileRef}
        type="file"
        className="ou-plus-fileinput"
        onChange={(e) => void handleFile(e)}
        aria-hidden="true"
        tabIndex={-1}
      />
    </div>
  )
}
