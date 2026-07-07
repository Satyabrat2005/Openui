import { useEffect, useState } from 'react'
import type { ConversationSummary } from '../env'
import { useAuth } from '../context/AuthContext'

interface Props {
  onSelect: (id: string) => void
  selectedId?: string
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()
  if (isToday) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/** Bucket a timestamp into a Claude-style day group. */
function dayGroup(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const dayMs = 86_400_000
  if (ts >= startOfToday) return 'Today'
  if (ts >= startOfToday - dayMs) return 'Yesterday'
  if (ts >= startOfToday - 7 * dayMs) return 'Previous 7 Days'
  return 'Older'
}

const GROUP_ORDER = ['Today', 'Yesterday', 'Previous 7 Days', 'Older']

/** A tiny type glyph inferred from the conversation title (code / image / text). */
function typeIcon(title: string): JSX.Element {
  const t = title.toLowerCase()
  if (/code|bug|function|refactor|script|api|deploy/.test(t)) {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M8 9l-3 3 3 3M16 9l3 3-3 3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  if (/image|photo|picture|design|figma|screenshot|logo/.test(t)) {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="3" y="4" width="18" height="16" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
        <circle cx="8.5" cy="9.5" r="1.6" stroke="currentColor" strokeWidth="1.4" />
        <path d="M4 17l5-4 4 3 3-2 4 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 4h9l4 4v12H6z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M14 4v5h5M9 13h6M9 16h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

export default function ConversationList({ onSelect, selectedId }: Props): JSX.Element {
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [loading, setLoading] = useState(true)
  const { user } = useAuth()

  useEffect(() => {
    if (!user) {
      setConversations([])
      setLoading(false)
      return
    }
    window.openui
      .getConversations()
      .then((list) => setConversations(list))
      .catch(() => setConversations([]))
      .finally(() => setLoading(false))
  }, [user])

  if (loading) {
    // Shimmer skeleton rows while history loads.
    return (
      <div className="ou-conv-scroll" style={{ padding: '8px 0' }}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="ou-conv-skeleton" style={{ animationDelay: `${i * 0.08}s` }} />
        ))}
      </div>
    )
  }

  if (!conversations.length) {
    return (
      <div style={{ padding: '12px 16px', fontSize: 12, color: 'var(--ou-text-faint)' }}>
        No conversations yet.
      </div>
    )
  }

  // Group by day, preserving the incoming (newest-first) order within each group.
  const groups = new Map<string, ConversationSummary[]>()
  for (const conv of conversations) {
    const g = dayGroup(conv.created_at)
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g)!.push(conv)
  }

  return (
    <div className="ou-conv-scroll" style={{ display: 'flex', flexDirection: 'column', overflowY: 'auto', minHeight: 0, flex: '1 1 auto' }}>
      {GROUP_ORDER.filter((g) => groups.has(g)).map((g) => (
        <div key={g}>
          <div className="ou-conv-group-label">{g}</div>
          {groups.get(g)!.map((conv) => {
            const isSelected = conv.id === selectedId
            return (
              <button
                key={conv.id}
                type="button"
                className={`ou-conv-row${isSelected ? ' active' : ''}`}
                onClick={() => onSelect(conv.id)}
                title={conv.title}
              >
                <span className="ou-conv-icon">{typeIcon(conv.title)}</span>
                <span className="ou-conv-title">{conv.title}</span>
                <span className="ou-conv-time">{formatTime(conv.created_at)}</span>
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}
