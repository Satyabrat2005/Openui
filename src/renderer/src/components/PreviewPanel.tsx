import { useTaskActivity } from '../context/TaskActivityContext'

/**
 * PreviewPanel — a right-side column of live thumbnail cards fed by the SAME
 * desktopCapturer capture read_screen() already takes (piped over
 * openui:screen:preview). It is a real view of what the agent is looking at, not
 * a separate or simulated preview system. Renders nothing until the first
 * capture of a turn arrives.
 */
function relativeTime(ts: number): string {
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (secs < 2) return 'just now'
  if (secs < 60) return `${secs}s ago`
  return `${Math.round(secs / 60)}m ago`
}

export default function PreviewPanel(): JSX.Element | null {
  const { previews } = useTaskActivity()
  if (previews.length === 0) return null

  return (
    <aside className="ou-preview">
      <div className="ou-preview-head">
        <span className="ou-preview-title">Live preview</span>
        <span className="ou-preview-sub">What OpenUI sees</span>
      </div>
      <div className="ou-preview-cards">
        {previews.map((p) => (
          <figure className="ou-preview-card" key={p.timestamp}>
            <img src={p.image} alt="Screen capture" loading="lazy" />
            <figcaption>{relativeTime(p.timestamp)}</figcaption>
          </figure>
        ))}
      </div>
    </aside>
  )
}
