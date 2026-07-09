import { useEffect, useState } from 'react'
import { useTaskActivity } from '../context/TaskActivityContext'
import { appMetaForTool } from '../lib/appKind'

/**
 * ThinkingStatus (#3) — the dynamic status line shown above the streaming reply
 * while a turn runs. When the agent is between tool calls it rotates through
 * generic stages ("Thinking…", "Rendering…"); the moment a tool starts it snaps
 * to a stage-appropriate phrase derived from the tool ("Reading the screen…",
 * "Browsing the web…"). Driven by real IPC events via TaskActivityContext.
 */
const GENERIC = ['Thinking…', 'Reading the request…', 'Planning the steps…', 'Working on it…', 'Rendering…']

export default function ThinkingStatus({ active }: { active: boolean }): JSX.Element | null {
  const { activeTool } = useTaskActivity()
  const [genericIdx, setGenericIdx] = useState(0)

  // Rotate the generic phrases only while active and no tool is running.
  useEffect(() => {
    if (!active || activeTool) return
    const t = window.setInterval(() => setGenericIdx((i) => (i + 1) % GENERIC.length), 1800)
    return () => window.clearInterval(t)
  }, [active, activeTool])

  if (!active) return null
  const label = activeTool ? appMetaForTool(activeTool).phrase : GENERIC[genericIdx]

  return (
    <div className="ou-thinking" role="status" aria-live="polite">
      <span className="ou-thinking-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span className="ou-thinking-text" key={label}>
        {label}
      </span>
    </div>
  )
}
