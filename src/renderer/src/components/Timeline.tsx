/**
 * Timeline (#1, #2) — the center tool-call timeline, rendered inline in the chat
 * transcript for the active turn. Every tool call the agent makes becomes its own
 * row with an icon keyed to the action. When the agent fans out with
 * spawn_subagents, the concurrent sub-agents render under a collapsible
 * "Running N in parallel" header, each sub-row showing its own live status and
 * the REAL model handling it (from the backend, never a fabricated tag).
 *
 * This is deliberately a pure view over TaskActivityContext data: the parallel
 * group only appears because real concurrent sub-agents actually ran.
 */
import { useState } from 'react'
import type { TaskCard, TaskStatus, ParallelGroup, SubagentRow, StepStatus } from '../env'
import { useTaskActivity } from '../context/TaskActivityContext'
import AppIcon from './AppIcon'

function StepCheck({ status }: { status: TaskStatus | StepStatus }): JSX.Element {
  if (status === 'done') {
    return (
      <div className="ou-tl-check done">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M20 6L9 17l-5-5" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
    )
  }
  if (status === 'working') return <div className="ou-tl-check working"><div className="ou-tl-spinner" /></div>
  if (status === 'error') {
    return (
      <div className="ou-tl-check error">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
        </svg>
      </div>
    )
  }
  return <div className="ou-tl-check pending" />
}

/** Honest per-agent model chip — shows exactly the model the backend ran. */
function ModelTag({ label }: { label: string }): JSX.Element {
  return (
    <span className="ou-model-tag" title={`Handled by ${label}`}>
      <span className="ou-model-tag-dot" />
      {label}
    </span>
  )
}

function SubRow({ sub }: { sub: SubagentRow }): JSX.Element {
  return (
    <div className={`ou-tl-sub ${sub.status}`}>
      <span className="ou-tl-sub-branch" aria-hidden="true" />
      <StepCheck status={sub.status} />
      <span className={`ou-tl-sub-icon ${sub.app ?? 'app'}`}>
        <AppIcon kind={sub.app ?? 'app'} size={13} />
      </span>
      <div className="ou-tl-sub-body">
        <span className="ou-tl-sub-title">{sub.title}</span>
        {sub.summary && sub.status !== 'working' && <span className="ou-tl-sub-summary">{sub.summary}</span>}
      </div>
      <ModelTag label={sub.modelLabel} />
    </div>
  )
}

function ParallelBlock({ group }: { group: ParallelGroup }): JSX.Element {
  const [open, setOpen] = useState(true)
  const n = group.subs.length
  const running = group.subs.filter((s) => s.status === 'working').length
  return (
    <div className={`ou-tl-parallel ${group.status}`}>
      <button type="button" className="ou-tl-parallel-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <svg className="ou-tl-parallel-glyph" width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M4 7h8M4 7l3-3M4 7l3 3M20 17h-8M20 17l-3-3M20 17l-3 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="ou-tl-parallel-label">
          {running > 0 ? `Running ${n} sub-agents in parallel` : `Ran ${n} sub-agents in parallel`}
        </span>
        <svg className={`ou-tl-chevron ${open ? 'open' : ''}`} width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="ou-tl-parallel-subs">
          {group.subs.map((s) => (
            <SubRow key={s.subId} sub={s} />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Render one card's timeline: interleaved tool-call step rows and parallel
 * groups, in the order they were produced (groups anchor after the steps that
 * preceded them; a simple stable ordering that reads top-to-bottom).
 */
export function CardTimeline({ card }: { card: TaskCard }): JSX.Element | null {
  if (card.steps.length === 0 && card.groups.length === 0) return null
  return (
    <div className="ou-timeline">
      {card.steps.map((step) => {
        const kind = card.currentApp ?? 'thinking'
        return (
          <div key={step.id} className={`ou-tl-row ${step.status}`}>
            <StepCheck status={step.status} />
            <span className={`ou-tl-icon ${kind}`}>
              <AppIcon kind={kind} size={14} />
            </span>
            <div className="ou-tl-body">
              <span className="ou-tl-label">{step.label}</span>
              {step.detail && (step.status === 'working' || step.status === 'error') && (
                <span className={`ou-tl-detail ${step.status === 'error' ? 'error' : ''}`}>{step.detail}</span>
              )}
            </div>
          </div>
        )
      })}
      {card.groups.map((g) => (
        <ParallelBlock key={g.groupId} group={g} />
      ))}
    </div>
  )
}

/**
 * Inline timeline for the CURRENT turn — the star of the center zone. Shows the
 * in-progress card (or, if the user clicked a card in the rail, that focused one).
 */
export default function Timeline(): JSX.Element | null {
  const { tasks, focusedId } = useTaskActivity()
  const focused = focusedId ? tasks.find((c) => c.id === focusedId) : undefined
  const active = tasks.find((c) => c.status === 'in_progress')
  const card = focused ?? active
  if (!card) return null
  return <CardTimeline card={card} />
}
