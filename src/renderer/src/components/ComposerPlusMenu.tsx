import { useEffect, useRef } from 'react'

/**
 * ComposerPlusMenu — the popover opened by the composer "+" button. Three
 * actions: attach a local file, connect an app (MCP), or assign a task directly.
 * Closes on outside-click or Escape.
 */
interface Props {
  onAttachFile: () => void
  onConnectApp: () => void
  onAssignTask: () => void
  onClose: () => void
}

function Item({
  onClick,
  icon,
  title,
  subtitle
}: {
  onClick: () => void
  icon: JSX.Element
  title: string
  subtitle: string
}): JSX.Element {
  return (
    <button type="button" className="ou-plus-item" onClick={onClick}>
      <span className="ou-plus-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="ou-plus-text">
        <span className="ou-plus-title">{title}</span>
        <span className="ou-plus-sub">{subtitle}</span>
      </span>
    </button>
  )
}

export default function ComposerPlusMenu({
  onAttachFile,
  onConnectApp,
  onAssignTask,
  onClose
}: Props): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return (
    <div className="ou-plus-menu" ref={ref} role="menu">
      <Item
        onClick={onAttachFile}
        title="Attach a file"
        subtitle="Add a local file to the chat"
        icon={
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path
              d="M18 8.5 9.4 17a3 3 0 0 1-4.2-4.2l8.5-8.6a2 2 0 0 1 2.8 2.8L8.7 15.1"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        }
      />
      <Item
        onClick={onConnectApp}
        title="Connect an app"
        subtitle="Add tools via an MCP server"
        icon={
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <rect x="3" y="3" width="7" height="7" rx="1.6" stroke="currentColor" strokeWidth="1.6" />
            <rect x="14" y="3" width="7" height="7" rx="1.6" stroke="currentColor" strokeWidth="1.6" />
            <rect x="3" y="14" width="7" height="7" rx="1.6" stroke="currentColor" strokeWidth="1.6" />
            <path d="M17.5 14v7M14 17.5h7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        }
      />
      <Item
        onClick={onAssignTask}
        title="Assign a task"
        subtitle="Have OpenUI plan and run it"
        icon={
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <rect x="4" y="4" width="16" height="16" rx="2.4" stroke="currentColor" strokeWidth="1.6" />
            <path d="m8 12 2.5 2.5L16 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        }
      />
    </div>
  )
}
