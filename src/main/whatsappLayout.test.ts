import { describe, it, expect } from 'vitest'
import {
  findPaneSplit,
  findBadgeRows,
  parseChatList,
  conversationLines,
  searchableName,
  type RgbaFrame,
  type OcrBox
} from './whatsappLayout'

/** A frame filled with one colour, with helpers to paint rectangles. */
function frame(width: number, height: number, rgb: [number, number, number]): RgbaFrame & {
  fill: (x0: number, y0: number, x1: number, y1: number, c: [number, number, number]) => void
} {
  const data = new Uint8Array(width * height * 4)
  const f = {
    width,
    height,
    data,
    fill(x0: number, y0: number, x1: number, y1: number, c: [number, number, number]) {
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          const i = (y * width + x) * 4
          data[i] = c[0]
          data[i + 1] = c[1]
          data[i + 2] = c[2]
          data[i + 3] = 255
        }
    }
  }
  f.fill(0, 0, width, height, rgb)
  return f
}

const box = (text: string, y0: number, y1 = y0 + 20): OcrBox => ({ text, x0: 0, y0, x1: 300, y1 })

describe('findPaneSplit', () => {
  it('finds the divider between a lighter chat list and a darker conversation', () => {
    const f = frame(400, 300, [22, 23, 23])
    f.fill(0, 0, 168, 300, [29, 31, 31]) // chat list ends at 42%
    expect(findPaneSplit(f)).toBeCloseTo(0.42, 2)
  })

  it('is not fooled by text: an edge on a few rows is not a divider', () => {
    const f = frame(400, 300, [22, 23, 23])
    f.fill(0, 0, 168, 300, [29, 31, 31])
    f.fill(250, 100, 252, 120, [255, 255, 255]) // a glyph in the conversation
    expect(findPaneSplit(f)).toBeCloseTo(0.42, 2)
  })

  it('returns null when there is no divider at all', () => {
    expect(findPaneSplit(frame(400, 300, [22, 23, 23]))).toBeNull()
  })
})

describe('findBadgeRows', () => {
  it('finds a green badge on the right of the list and ignores a green avatar on the left', () => {
    const f = frame(300, 200, [29, 31, 31])
    f.fill(250, 50, 270, 70, [37, 211, 102]) // badge
    f.fill(10, 120, 50, 160, [37, 211, 102]) // avatar, left side
    expect(findBadgeRows(f)).toEqual([{ y0: 50, y1: 70 }])
  })

  it('skips the header (the green "All" chip) when told where it ends', () => {
    const f = frame(300, 200, [29, 31, 31])
    f.fill(220, 10, 290, 30, [37, 211, 102]) // a chip in the header
    f.fill(250, 90, 270, 110, [37, 211, 102])
    expect(findBadgeRows(f, 40)).toEqual([{ y0: 90, y1: 110 }])
  })

  it('treats a 1-2px green run as anti-aliasing, not a badge', () => {
    const f = frame(300, 200, [29, 31, 31])
    f.fill(250, 50, 270, 52, [37, 211, 102])
    expect(findBadgeRows(f)).toEqual([])
  })
})

describe('parseChatList', () => {
  const lines = [
    box('Chats', 0),
    box('All Unread 183', 40),
    box('> Colossal-a-pi... 19:11', 100),
    box('~Kartik Bh @ (2)', 125),
    box('Coding Club I... 18:48', 200),
    box('a ~coding club indi (125)', 225),
    box('Mom Yesterday', 300),
    box('see you tomorrow', 325),
    box('Ashu Tklu 1842', 400),
    box('?', 425)
  ]

  it('pairs each name with its preview and marks unread by badge colour', () => {
    const badges = [
      { y0: 120, y1: 140 },
      { y0: 222, y1: 242 }
    ]
    const chats = parseChatList(lines, badges, 70)
    expect(chats.map((c) => c.name)).toEqual(['Colossal-a-pi...', 'Coding Club I...', 'Mom', 'Ashu Tklu'])
    expect(chats.map((c) => c.unread)).toEqual([true, true, false, false])
    expect(chats[0].preview).toBe('~Kartik Bh')
    expect(chats[1].preview).toBe('~coding club indi')
    expect(chats[2].preview).toBe('see you tomorrow')
  })

  it('ignores the header lines above headerBottom', () => {
    expect(parseChatList(lines, [], 70).some((c) => /chats|unread/i.test(c.name))).toBe(false)
  })
})

describe('conversationLines', () => {
  it('keeps messages in reading order and drops WhatsApp labels and OCR debris', () => {
    const out = conversationLines([
      box('Type a message', 900),
      box('see you at 6', 300),
      box('2 unread messages', 100),
      box('~ Ayan Joshi +91 98714 60918', 200),
      box('= )', 400),
      box('click here for group info', 10)
    ])
    expect(out).toEqual(['~ Ayan Joshi +91 98714 60918', 'see you at 6'])
  })
})

describe('searchableName', () => {
  it('removes WhatsApp truncation so the name can be searched', () => {
    expect(searchableName('Colossal-a-pi...')).toBe('Colossal-a-pi')
    expect(searchableName('Coding Club I…')).toBe('Coding Club I')
    expect(searchableName('Mom')).toBe('Mom')
  })
})
