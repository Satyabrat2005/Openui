import { useEffect, useState } from 'react'
import type { ConversationSummary } from '../env'
import { useAuth } from '../context/AuthContext'

interface Props {
  onSelect: (id: string) => void
  selectedId?: string
}

function formatDate(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()
  if (isToday) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
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
    return (
      <div style={{ padding: '12px 16px', fontSize: 11, color: '#aeaeb2', fontFamily: '-apple-system, sans-serif' }}>
        Loading…
      </div>
    )
  }

  if (!conversations.length) {
    return (
      <div style={{ padding: '12px 16px', fontSize: 11, color: '#aeaeb2', fontFamily: '-apple-system, sans-serif' }}>
        No conversations yet.
      </div>
    )
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 0,
        maxHeight: 400,
        overflowY: 'auto',
      }}
    >
      {conversations.map((conv) => {
        const isSelected = conv.id === selectedId
        return (
          <button
            key={conv.id}
            onClick={() => onSelect(conv.id)}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              background: isSelected ? 'rgba(167,139,250,0.15)' : 'none',
              border: 'none',
              borderLeft: isSelected ? '2px solid #a78bfa' : '2px solid transparent',
              borderRadius: 0,
              textAlign: 'left',
              padding: '8px 14px 8px 12px',
              cursor: 'pointer',
              transition: 'background 0.12s',
              width: '100%',
            }}
            onMouseEnter={(e) => {
              if (!isSelected) {
                ;(e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.05)'
              }
            }}
            onMouseLeave={(e) => {
              ;(e.currentTarget as HTMLButtonElement).style.background = isSelected
                ? 'rgba(167,139,250,0.15)'
                : 'none'
            }}
          >
            <span
              style={{
                fontSize: 12,
                color: '#e5e5e7',
                fontFamily: '-apple-system, sans-serif',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                maxWidth: 170,
              }}
            >
              {conv.title.slice(0, 40)}
            </span>
            <span
              style={{
                fontSize: 10,
                color: '#aeaeb2',
                flexShrink: 0,
                marginLeft: 8,
                fontFamily: '-apple-system, sans-serif',
              }}
            >
              {formatDate(conv.created_at)}
            </span>
          </button>
        )
      })}
    </div>
  )
}
