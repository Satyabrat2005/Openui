// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import HitlModal from './HitlModal'

// The recipient checks come from src/main/sendGuards.ts. A warning the card
// does not show protects nobody, so the rendering is pinned here.
describe('HitlModal — recipient warnings', () => {
  afterEach(cleanup)

  const base = {
    id: 'hitl1',
    tool: 'send_summary_email',
    args: { recipient: 'karan.reports@proton.example' },
    label: 'Email a summary to karan.reports@proton.example'
  }
  const noop = (): void => {}

  it('shows each warning above the action', () => {
    const warning = "You didn't type “karan.reports@proton.example” — it was taken from a message you received. Make sure it's who you mean."
    render(<HitlModal request={{ ...base, warnings: [warning] }} onAllow={noop} onDeny={noop} />)
    const box = screen.getByTestId('hitl-recipient-warnings')
    expect(box.getAttribute('role')).toBe('alert')
    expect(box.textContent).toContain('Check the recipient')
    expect(box.textContent).toContain(warning)
  })

  it('shows no warning box when there is nothing to check', () => {
    render(<HitlModal request={base} onAllow={noop} onDeny={noop} />)
    expect(screen.queryByTestId('hitl-recipient-warnings')).toBeNull()
  })
})
