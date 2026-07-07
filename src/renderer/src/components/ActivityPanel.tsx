/**
 * ActivityPanel (#3/#5) — the right-side column of floating live-preview cards.
 *
 * Top card: a REAL live thumbnail of the primary display, polled from main's
 * read-only `captureScreenThumbnail` (the same desktopCapturer path read_screen
 * uses), shown only while a screen/app tool is actually running. This is the
 * genuine "see what the agent is touching" preview, not a fabricated tile.
 *
 * When real sub-agents are running in parallel, each gets its own preview card
 * below (app icon + title + its real model tag). We capture the whole primary
 * display, not individual windows, so the per-sub-agent cards are icon previews;
 * true per-window capture is a clean follow-up. Below everything: a most-recent
 * history of completed tasks. All data comes from TaskActivityContext.
 */
import { useEffect, useRef, useState } from 'react'
import type { TaskCard, SubagentRow } from '../env'
import { useTaskActivity } from '../context/TaskActivityContext'
import { metaForKind } from '../lib/appKind'
import AppIcon from './AppIcon'

function durationLabel(card: TaskCard): string {
  if (!card.endedAt) return ''
  const ms = card.endedAt - card.startedAt
  if (ms < 1000) return '<1s'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

/** Poll a live screen thumbnail while `active`; returns the latest data URL. */
function useScreenThumbnail(active: boolean): string | null {
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const busy = useRef(false)
  useEffect(() => {
    if (!active) {
      setDataUrl(null)
      return
    }
    let live = true
    const tick = async (): Promise<void> => {
      if (busy.current) return
      busy.current = true
      try {
        const res = await window.openui.captureScreenThumbnail()
        if (live && res.ok && res.dataUrl) setDataUrl(res.dataUrl)
      } catch {
        /* transient capture failure — keep the last frame */
      } finally {
        busy.current = false
      }
    }
    void tick()
    const id = window.setInterval(() => void tick(), 1300)
    return () => {
      live = false
      window.clearInterval(id)
    }
  }, [active])
  return dataUrl
}

function SubPreview({ sub }: { sub: SubagentRow }): JSX.Element {
  const meta = metaForKind(sub.app ?? 'app')
  return (
    <div className={`ou-preview-card sub ${sub.status}`}>
      <div className="ou-preview-bar">
        <span className={`ou-preview-appicon ${meta.kind}`}>
          <AppIcon kind={meta.kind} size={13} />
        </span>
        <span className="ou-preview-name">{sub.title}</span>
        <span className="ou-model-tag sm" title={`Handled by ${sub.modelLabel}`}>
          {sub.modelLabel}
        </span>
      </div>
      <div className={`ou-preview-body ${meta.kind}`}>
        <div className="ou-activity-scanline" />
        <div className={`ou-activity-glyph ${meta.kind}`}>
          <AppIcon kind={meta.kind} size={34} />
        </div>
      </div>
    </div>
  )
}

function HistoryRow({ card }: { card: TaskCard }): JSX.Element {
  const meta = metaForKind(card.currentApp ?? 'thinking')
  return (
    <div className={`ou-hist-row ${card.status}`}>
      <span className={`ou-hist-icon ${meta.kind}`}>
        <AppIcon kind={meta.kind} size={14} />
      </span>
      <div className="ou-hist-body">
        <span className="ou-hist-title">{card.title}</span>
        <span className="ou-hist-sub">
          {card.status === 'failed' ? 'Failed' : 'Completed'}
          {card.steps.length > 0 ? ` · ${card.steps.length} step${card.steps.length === 1 ? '' : 's'}` : ''}
          {durationLabel(card) ? ` · ${durationLabel(card)}` : ''}
        </span>
      </div>
      <span className={`ou-hist-dot ${card.status}`} aria-hidden="true" />
    </div>
  )
}

export default function ActivityPanel(): JSX.Element | null {
  const { tasks, activeApp, activeModel } = useTaskActivity()

  const running = tasks.find((c) => c.status === 'in_progress')
  const runningSubs = (running?.groups ?? []).flatMap((g) => g.subs).filter((s) => s.status === 'working')
  const history = tasks
    .filter((c) => c.status !== 'in_progress' && (c.steps.length > 0 || c.groups.length > 0 || c.kind === 'assigned'))
    .slice()
    .reverse()

  const thumb = useScreenThumbnail(!!activeApp)

  // Nothing to show — stay out of the way on an idle window.
  if (!activeApp && history.length === 0) return null

  const meta = activeApp ? metaForKind(activeApp) : null

  return (
    <aside className="ou-activity" aria-label="Live activity">
      <div className="ou-activity-header">Live preview</div>

      {meta ? (
        <div className={`ou-preview-card main ${meta.kind}`}>
          <div className="ou-preview-bar">
            <span className={`ou-preview-appicon ${meta.kind}`}>
              <AppIcon kind={meta.kind} size={13} />
            </span>
            <span className="ou-preview-name">{running?.title ?? `Controlling ${meta.label}`}</span>
            <span className="ou-preview-live">
              <span className="ou-activity-live-dot" />
              Live
            </span>
          </div>
          <div className={`ou-preview-body ${meta.kind}`}>
            {thumb ? (
              <img className="ou-preview-shot" src={thumb} alt="Live screen preview" />
            ) : (
              <>
                <div className="ou-activity-scanline" />
                <div className={`ou-activity-glyph ${meta.kind}`}>
                  <AppIcon kind={meta.kind} size={40} />
                </div>
              </>
            )}
          </div>
          {activeModel && <div className="ou-preview-foot">{meta.phrase}</div>}
        </div>
      ) : (
        <div className="ou-activity-idle">
          <span className="ou-activity-idle-dot" />
          Idle — no app being controlled
        </div>
      )}

      {runningSubs.map((sub) => (
        <SubPreview key={sub.subId} sub={sub} />
      ))}

      <div className="ou-activity-history-label">Recent tasks</div>
      <div className="ou-activity-history">
        {history.length === 0 ? (
          <div className="ou-activity-history-empty">Completed tasks will appear here.</div>
        ) : (
          history.map((card) => <HistoryRow key={card.id} card={card} />)
        )}
      </div>
    </aside>
  )
}
