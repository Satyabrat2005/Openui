import { describe, it, expect, vi, beforeEach } from 'vitest'

// The meter reads and writes one table, so the database is the boundary that
// gets faked. Everything else here is pure date arithmetic and tier lookup,
// which is the part worth testing: the failure modes of a daily allowance are
// almost all calendar bugs, not counting bugs.

const H = vi.hoisted(() => ({
  days: new Map<string, { day: string; message_count: number; voice_count: number; first_at: number | null; last_at: number | null }>(),
  throwOnRead: false,
  throwOnWrite: false
}))

vi.mock('./database', () => ({
  database: {
    usage: {
      getDay: (day: string) => {
        if (H.throwOnRead) throw new Error('db is gone')
        return H.days.get(day)
      },
      increment: (day: string, kind: 'message' | 'voice', at: number) => {
        if (H.throwOnWrite) throw new Error('db is gone')
        const row = H.days.get(day) ?? { day, message_count: 0, voice_count: 0, first_at: at, last_at: at }
        if (kind === 'voice') row.voice_count += 1
        else row.message_count += 1
        row.last_at = at
        H.days.set(day, row)
      },
      recentDays: (n: number) =>
        [...H.days.values()].sort((a, b) => (a.day < b.day ? 1 : -1)).slice(0, n)
    }
  }
}))

import {
  checkAllowance,
  limitReachedMessage,
  localDay,
  nextResetAt,
  normaliseTier,
  recordTurn,
  summarise,
  usedOn
} from './usageMeter'

const seed = (day: string, messages: number): void => {
  H.days.set(day, { day, message_count: messages, voice_count: 0, first_at: 0, last_at: 0 })
}

beforeEach(() => {
  H.days.clear()
  H.throwOnRead = false
  H.throwOnWrite = false
})

describe('localDay', () => {
  it('uses the local calendar date, not the UTC one', () => {
    // 23:30 local on the 5th. A UTC-based day would already be the 6th for
    // anyone east of the meridian, ending their allowance before their evening
    // does — which reads to the user as the counter being broken.
    const late = new Date(2026, 8, 5, 23, 30, 0)
    expect(localDay(late)).toBe('2026-09-05')
  })

  it('zero-pads so the strings sort chronologically', () => {
    expect(localDay(new Date(2026, 0, 9))).toBe('2026-01-09')
    expect(localDay(new Date(2026, 0, 9)) < localDay(new Date(2026, 0, 10))).toBe(true)
    // The trap this format avoids: '2026-1-9' would sort AFTER '2026-1-10'.
    expect(localDay(new Date(2026, 9, 1)) > localDay(new Date(2026, 8, 30))).toBe(true)
  })
})

describe('nextResetAt', () => {
  it('is the coming local midnight', () => {
    const at = new Date(2026, 8, 5, 14, 0, 0)
    const reset = new Date(nextResetAt(at))
    expect(reset.getDate()).toBe(6)
    expect(reset.getHours()).toBe(0)
    expect(reset.getMinutes()).toBe(0)
  })

  it('rolls the month over correctly on the last day', () => {
    const reset = new Date(nextResetAt(new Date(2026, 8, 30, 23, 59, 0)))
    expect(localDay(reset)).toBe('2026-10-01')
  })
})

describe('checkAllowance', () => {
  it('allows a free user their first turn of the day', () => {
    const a = checkAllowance('free')
    expect(a.allowed).toBe(true)
    expect(a.limit).toBe(10)
    expect(a.used).toBe(0)
  })

  it('reports what will be left AFTER this turn, which is the number to show', () => {
    const now = new Date(2026, 8, 5, 10, 0, 0)
    seed(localDay(now), 3)
    const a = checkAllowance('free', now)
    expect(a.used).toBe(3)
    expect(a.remaining).toBe(6) // 10 - 3 used - this one
  })

  it('refuses the turn AFTER the limit is reached, not the one that reaches it', () => {
    const now = new Date(2026, 8, 5, 10, 0, 0)
    seed(localDay(now), 9)
    expect(checkAllowance('free', now).allowed).toBe(true) // the 10th is allowed
    seed(localDay(now), 10)
    const blocked = checkAllowance('free', now)
    expect(blocked.allowed).toBe(false)
    expect(blocked.remaining).toBe(0)
  })

  it('never reports negative remaining, even if the count somehow overshoots', () => {
    const now = new Date(2026, 8, 5, 10, 0, 0)
    seed(localDay(now), 99)
    expect(checkAllowance('free', now).remaining).toBe(0)
  })

  it('does not meter pro or enterprise', () => {
    const now = new Date(2026, 8, 5, 10, 0, 0)
    seed(localDay(now), 500)
    for (const tier of ['pro', 'enterprise'] as const) {
      const a = checkAllowance(tier, now)
      expect(a.allowed).toBe(true)
      expect(a.unlimited).toBe(true)
      expect(a.limit).toBeNull()
    }
  })

  it('yesterday does not count against today', () => {
    const yesterday = new Date(2026, 8, 4, 10, 0, 0)
    const today = new Date(2026, 8, 5, 10, 0, 0)
    seed(localDay(yesterday), 10)
    expect(checkAllowance('free', today).allowed).toBe(true)
    expect(checkAllowance('free', today).used).toBe(0)
  })

  // An unknown tier string reaching here means a corrupt or stale subscription
  // row. Resolving it generously would hand out an unlimited allowance on the
  // strength of bad data, so it resolves to free.
  it('treats an unrecognised tier as free rather than unlimited', () => {
    expect(normaliseTier('platinum')).toBe('free')
    expect(normaliseTier('')).toBe('free')
    const a = checkAllowance('platinum')
    expect(a.limit).toBe(10)
    expect(a.unlimited).toBe(false)
  })

  it('fails OPEN when the database cannot be read', () => {
    // A meter that cannot count must not lock someone out of a product running
    // entirely on their own hardware. One extra free turn is the cheaper error.
    H.throwOnRead = true
    const a = checkAllowance('free')
    expect(a.allowed).toBe(true)
    expect(usedOn()).toBe(0)
  })
})

describe('recordTurn', () => {
  it('counts one turn against today', () => {
    const now = new Date(2026, 8, 5, 10, 0, 0)
    recordTurn('message', now)
    recordTurn('message', now)
    expect(usedOn(localDay(now))).toBe(2)
  })

  it('keeps voice turns out of the message count', () => {
    const now = new Date(2026, 8, 5, 10, 0, 0)
    recordTurn('voice', now)
    expect(usedOn(localDay(now))).toBe(0)
  })

  it('never throws when the database is unwritable', () => {
    H.throwOnWrite = true
    expect(() => recordTurn('message')).not.toThrow()
  })
})

describe('summarise', () => {
  it('averages over ACTIVE days, not elapsed days', () => {
    // Someone who uses OpenUI hard on two days is an intense occasional user.
    // Dividing by 30 would report them as a light daily user — a different
    // person, and the wrong one to build for.
    seed('2026-09-01', 20)
    seed('2026-09-02', 20)
    const s = summarise(30, new Date(2026, 8, 5))
    expect(s.activeDays).toBe(2)
    expect(s.totalMessages).toBe(40)
    expect(s.messagesPerActiveDay).toBe(20)
  })

  it('finds the busiest day', () => {
    seed('2026-09-01', 3)
    seed('2026-09-02', 11)
    seed('2026-09-03', 7)
    expect(summarise(30, new Date(2026, 8, 5)).busiestDay).toEqual({ day: '2026-09-02', messages: 11 })
  })

  it('counts a streak ending today', () => {
    seed('2026-09-03', 1)
    seed('2026-09-04', 1)
    seed('2026-09-05', 1)
    expect(summarise(30, new Date(2026, 8, 5, 12, 0)).currentStreak).toBe(3)
  })

  it('does not break a streak just because today has not started yet', () => {
    // At 9am with nothing sent today, a streak of three should still read three
    // rather than collapsing to zero and re-appearing after the first message.
    seed('2026-09-02', 1)
    seed('2026-09-03', 1)
    seed('2026-09-04', 1)
    expect(summarise(30, new Date(2026, 8, 5, 9, 0)).currentStreak).toBe(3)
  })

  it('breaks the streak on a real gap', () => {
    seed('2026-09-01', 1)
    seed('2026-09-02', 1)
    // nothing on the 3rd or 4th
    seed('2026-09-05', 1)
    expect(summarise(30, new Date(2026, 8, 5, 12, 0)).currentStreak).toBe(1)
  })

  it('reports an empty history as zeroes rather than NaN', () => {
    const s = summarise(30, new Date(2026, 8, 5))
    expect(s.activeDays).toBe(0)
    expect(s.messagesPerActiveDay).toBe(0)
    expect(s.currentStreak).toBe(0)
    expect(s.busiestDay).toBeNull()
  })
})

describe('limitReachedMessage', () => {
  it('says the number, when it refills, and never mentions a terminal', () => {
    const now = new Date(2026, 8, 5, 22, 0, 0)
    seed(localDay(now), 10)
    const msg = limitReachedMessage(checkAllowance('free', now))
    expect(msg).toContain('10')
    expect(msg).toMatch(/refill/i)
    // The terminal boundary applies to every user-facing string in the app, not
    // just the model-download ones. See terminalBoundary.test.ts.
    expect(msg).not.toMatch(/terminal|command line|ollama run|npm |\$ /i)
  })
})
