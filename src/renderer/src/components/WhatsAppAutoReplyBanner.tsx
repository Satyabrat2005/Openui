import { useEffect, useState } from 'react'
import type { WhatsAppDraftReply } from '../env'

/**
 * The always-reachable visibility + kill switch for WhatsApp auto-reply (spec
 * item #4), plus the draft-review surface that makes the feature compose-and-
 * click. Mounted once at the app root so it is unmissable whenever the watcher
 * is active and whenever a draft is waiting.
 *
 * SAFETY: a drafted reply is never sent until the user clicks "Review & send"
 * on the specific card — that click IS the approval for that exact text. The
 * banner's "Turn off" is the one-click kill switch (main persists enabled:false
 * and stops the loop immediately).
 */
export default function WhatsAppAutoReplyBanner(): JSX.Element | null {
  const [active, setActive] = useState(false)
  const [drafts, setDrafts] = useState<WhatsAppDraftReply[]>([])
  const [sending, setSending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    // Initial state (the watcher may already be running from a prior session).
    window.openui
      .whatsAppAutoReplyStatus()
      .then((s) => {
        if (!cancelled) setActive(s.active)
      })
      .catch(() => {})

    const offActive = window.openui.onWhatsAppAutoReplyActive((a) => setActive(a))
    const offDraft = window.openui.onWhatsAppAutoReplyDraft((d) =>
      // Newest first; de-dupe by contact+timestamp so a re-emit can't stack.
      setDrafts((prev) => [d, ...prev.filter((p) => !(p.contact === d.contact && p.at === d.at))])
    )
    return () => {
      cancelled = true
      offActive()
      offDraft()
    }
  }, [])

  const dismiss = (draft: WhatsAppDraftReply): void => {
    setDrafts((prev) => prev.filter((d) => d !== draft))
  }

  const killSwitch = (): void => {
    void window.openui.killWhatsAppAutoReply().catch(() => {})
    setActive(false)
  }

  const reviewAndSend = (draft: WhatsAppDraftReply): void => {
    setError(null)
    setSending(draft.at + draft.contact)
    void window.openui
      .sendWhatsAppAutoReplyDraft(draft.contact, draft.draftText)
      .then((res) => {
        if (res.ok) dismiss(draft)
        else setError(res.error ?? 'Could not send the reply.')
      })
      .catch(() => setError('Could not send the reply.'))
      .finally(() => setSending(null))
  }

  if (!active && drafts.length === 0) return null

  return (
    <div
      style={{
        position: 'fixed',
        right: 16,
        bottom: 16,
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        maxWidth: 340,
        pointerEvents: 'none'
      }}
    >
      {active && (
        <div
          style={{
            pointerEvents: 'auto',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            background: '#111',
            color: '#fff',
            borderRadius: 10,
            padding: '9px 12px',
            boxShadow: '0 4px 16px rgba(0,0,0,0.25)'
          }}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
            <span
              style={{ width: 8, height: 8, borderRadius: 999, background: '#34c759', flexShrink: 0 }}
              aria-hidden
            />
            WhatsApp auto-reply is watching
          </span>
          <button
            onClick={killSwitch}
            style={{
              border: '1px solid rgba(255,255,255,0.3)',
              background: 'transparent',
              color: '#fff',
              borderRadius: 7,
              padding: '4px 10px',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              flexShrink: 0
            }}
          >
            Turn off
          </button>
        </div>
      )}

      {drafts.map((draft) => {
        const key = draft.at + draft.contact
        const isSending = sending === key
        return (
          <div
            key={key}
            style={{
              pointerEvents: 'auto',
              background: '#fff',
              border: '1px solid rgba(0,0,0,0.1)',
              borderRadius: 10,
              padding: 12,
              boxShadow: '0 4px 16px rgba(0,0,0,0.18)'
            }}
          >
            <div style={{ fontSize: 12.5, fontWeight: 600, color: '#1c1c1e', marginBottom: 2 }}>
              Suggested reply to {draft.contact}
            </div>
            {draft.incomingPreview && (
              <div style={{ fontSize: 11.5, color: '#8e8e93', lineHeight: 1.4, marginBottom: 6 }}>
                They said: {draft.incomingPreview}
              </div>
            )}
            <div
              style={{
                fontSize: 12.5,
                color: '#1c1c1e',
                lineHeight: 1.45,
                background: '#f2f2f7',
                borderRadius: 8,
                padding: '8px 10px',
                marginBottom: 8,
                whiteSpace: 'pre-wrap'
              }}
            >
              {draft.draftText}
            </div>
            {error && sending === null && (
              <div style={{ fontSize: 11.5, color: '#ff3b30', marginBottom: 6 }}>{error}</div>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => reviewAndSend(draft)}
                disabled={isSending}
                style={{
                  border: 'none',
                  background: '#34c759',
                  color: '#fff',
                  borderRadius: 7,
                  padding: '6px 12px',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: isSending ? 'default' : 'pointer',
                  opacity: isSending ? 0.7 : 1
                }}
              >
                {isSending ? 'Sending…' : 'Review & send'}
              </button>
              <button
                onClick={() => dismiss(draft)}
                disabled={isSending}
                style={{
                  border: '1px solid rgba(0,0,0,0.12)',
                  background: '#fff',
                  color: '#1c1c1e',
                  borderRadius: 7,
                  padding: '6px 12px',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: 'pointer'
                }}
              >
                Dismiss
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
