import { useEffect, type CSSProperties } from 'react'

export interface UpdateBannerProps {
  version: string
  isMac: boolean
  onDownload: () => void
  onDismiss: () => void
}

/** Slim top-of-popup banner shown when a new version is available. */
export default function UpdateBanner({ version, isMac, onDownload, onDismiss }: UpdateBannerProps): JSX.Element {
  // Auto-dismiss after 30 s if the user doesn't interact.
  useEffect(() => {
    const t = setTimeout(onDismiss, 30_000)
    return () => clearTimeout(t)
  }, [onDismiss])

  return (
    <div style={bannerStyle} className="update-banner-slide-in">
      <span style={textStyle}>Splen v{version} is available</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        <button style={downloadBtn} onClick={onDownload}>
          {isMac ? 'Open Download Page' : 'Download'}
        </button>
        <button style={dismissBtn} aria-label="Dismiss update notification" onClick={onDismiss}>
          <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
            <path d="M1 1L8 8M8 1L1 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  )
}

const bannerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  padding: '7px 10px 7px 12px',
  background: 'linear-gradient(135deg, rgba(10,132,255,0.10) 0%, rgba(94,92,230,0.08) 100%)',
  border: '1px solid rgba(10,132,255,0.18)',
  borderRadius: 10,
  marginBottom: 10,
}
const textStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  color: '#1c1c1e',
  flex: 1,
  minWidth: 0,
}
const downloadBtn: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: '#fff',
  background: '#0a84ff',
  border: 'none',
  borderRadius: 6,
  padding: '4px 9px',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}
const dismissBtn: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 18,
  height: 18,
  borderRadius: '50%',
  border: 'none',
  background: 'rgba(0,0,0,0.07)',
  cursor: 'pointer',
  color: '#636366',
  padding: 0,
  flexShrink: 0,
}
