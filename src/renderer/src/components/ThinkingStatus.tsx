import { useEffect, useState } from 'react'
import type { AgentStage } from '../env'
import { useTaskActivity } from '../context/TaskActivityContext'

/**
 * ThinkingStatus — a live, stage-appropriate activity line shown while the agent
 * works. Unlike a static spinner, the text tracks the REAL stage the agent loop
 * reports (thinking / reading the screen / running a tool / rendering) and gently
 * rotates through stage-specific phrasings so it feels alive. The model tag next
 * to it is the real routed model from the stage payload — never decorative.
 */
const STAGE_PHRASES: Record<Exclude<AgentStage, 'idle'>, string[]> = {
  thinking: ['Thinking…', 'Working it out…', 'Planning the next step…'],
  reading: ['Reading the screen…', 'Looking at what’s on screen…'],
  running: ['Running the tool…', 'On it…', 'Doing the work…'],
  rendering: ['Rendering…', 'Putting it together…']
}

export default function ThinkingStatus(): JSX.Element | null {
  const { stage } = useTaskActivity()
  const [phraseIdx, setPhraseIdx] = useState(0)

  const active = stage !== null && stage.stage !== 'idle'
  const key = active ? (stage.stage as Exclude<AgentStage, 'idle'>) : null

  // Reset the rotation whenever the stage changes so we start from its first phrase.
  useEffect(() => {
    setPhraseIdx(0)
  }, [key])

  // Rotate through the current stage's phrasings.
  useEffect(() => {
    if (!key) return
    const phrases = STAGE_PHRASES[key]
    if (phrases.length <= 1) return
    const id = window.setInterval(() => {
      setPhraseIdx((i) => (i + 1) % phrases.length)
    }, 1800)
    return () => window.clearInterval(id)
  }, [key])

  if (!active || !key) return null

  // For a running tool, prefer the concrete tool label the agent supplied.
  const phrases = STAGE_PHRASES[key]
  const base = key === 'running' && stage.detail ? stage.detail : phrases[phraseIdx % phrases.length]

  return (
    <div className="ou-thinking" role="status" aria-live="polite">
      <span className="ou-thinking-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span className="ou-thinking-text">{base}</span>
      {stage.model && <span className="ou-thinking-model">{stage.model}</span>}
    </div>
  )
}
