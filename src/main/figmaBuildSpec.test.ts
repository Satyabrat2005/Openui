import { describe, it, expect } from 'vitest'
import {
  describeBuildSpec,
  validateBuildSpec,
  BuildSpecError,
  MAX_BUILD_NODES,
  MAX_BUILD_DEPTH
} from './figmaBuildSpec'

// These specs cross a trust boundary: the agent writes them, they travel over a
// socket, and a plugin executes them against the user's real Figma document. So
// the tests care as much about what is REJECTED as about what round-trips.

/** Smallest spec that validates. */
const minimal = (): Record<string, unknown> => ({
  name: 'Test',
  frames: [{ type: 'FRAME', name: 'Root' }]
})

describe('validateBuildSpec — shape', () => {
  it('accepts a minimal spec', () => {
    const v = validateBuildSpec(minimal())
    expect(v.spec.name).toBe('Test')
    expect(v.spec.frames).toHaveLength(1)
    expect(v.nodeCount).toBe(1)
  })

  it('requires a name', () => {
    expect(() => validateBuildSpec({ frames: [{ type: 'FRAME' }] })).toThrow(/spec\.name/)
  })

  it('requires a non-empty frames array', () => {
    expect(() => validateBuildSpec({ name: 'x', frames: [] })).toThrow(/spec\.frames/)
    expect(() => validateBuildSpec({ name: 'x' })).toThrow(/spec\.frames/)
  })

  it('rejects a non-object spec', () => {
    expect(() => validateBuildSpec(null)).toThrow(BuildSpecError)
    expect(() => validateBuildSpec('a string')).toThrow(BuildSpecError)
    expect(() => validateBuildSpec([])).toThrow(BuildSpecError)
  })

  it('requires top-level entries to be frames', () => {
    // A bare TEXT at the top level has nowhere to live on the canvas.
    expect(() =>
      validateBuildSpec({ name: 'x', frames: [{ type: 'TEXT', text: 'hi' }] })
    ).toThrow(/must be FRAME/)
  })

  it('rejects an unknown node type', () => {
    expect(() =>
      validateBuildSpec({ name: 'x', frames: [{ type: 'COMPONENT_SET' }] })
    ).toThrow(/spec\.frames\[0\]\.type/)
  })

  it('names the offending field in the error path', () => {
    expect(() =>
      validateBuildSpec({
        name: 'x',
        frames: [{ type: 'FRAME', children: [{ type: 'FRAME', children: [{ type: 'FRAME', fill: 'blue' }] }] }]
      })
    ).toThrow(/frames\[0\]\.children\[0\]\.children\[0\]\.fill/)
  })
})

describe('validateBuildSpec — unknown fields', () => {
  it('drops fields the interpreter does not implement', () => {
    // Nothing unrecognised may reach the plugin: the spec is the whole contract.
    const v = validateBuildSpec({
      name: 'x',
      frames: [{ type: 'FRAME', name: 'Root', evilProperty: 'rm -rf', __proto__: { polluted: true } }]
    })
    expect(v.spec.frames[0]).toEqual({ type: 'FRAME', name: 'Root' })
    expect('evilProperty' in v.spec.frames[0]).toBe(false)
  })
})

describe('validateBuildSpec — colours', () => {
  it('accepts 3, 6 and 8 digit hex and normalises case', () => {
    const v = validateBuildSpec({
      name: 'x',
      frames: [
        { type: 'FRAME', fill: '#abc' },
        { type: 'FRAME', fill: '#1a1a2e' },
        { type: 'FRAME', fill: '#1a1a2eff' }
      ]
    })
    expect(v.spec.frames.map((f) => f.fill)).toEqual(['#ABC', '#1A1A2E', '#1A1A2EFF'])
  })

  it('rejects a CSS colour name or rgb() — the plugin only parses hex', () => {
    expect(() => validateBuildSpec({ name: 'x', frames: [{ type: 'FRAME', fill: 'red' }] })).toThrow(
      /hex colour/
    )
    expect(() =>
      validateBuildSpec({ name: 'x', frames: [{ type: 'FRAME', fill: 'rgb(1,2,3)' }] })
    ).toThrow(/hex colour/)
  })
})

describe('validateBuildSpec — numeric bounds', () => {
  it('rejects a coordinate far off canvas', () => {
    expect(() =>
      validateBuildSpec({ name: 'x', frames: [{ type: 'FRAME', x: 1e9 }] })
    ).toThrow(/outside the allowed range/)
  })

  it('rejects NaN and Infinity', () => {
    expect(() => validateBuildSpec({ name: 'x', frames: [{ type: 'FRAME', width: NaN }] })).toThrow(
      /finite number/
    )
    expect(() =>
      validateBuildSpec({ name: 'x', frames: [{ type: 'FRAME', width: Infinity }] })
    ).toThrow(/finite number/)
  })

  it('rejects a negative width', () => {
    expect(() =>
      validateBuildSpec({ name: 'x', frames: [{ type: 'FRAME', width: -10 }] })
    ).toThrow(/outside the allowed range/)
  })

  it('rejects an opacity outside 0..1', () => {
    expect(() =>
      validateBuildSpec({ name: 'x', frames: [{ type: 'FRAME', opacity: 255 }] })
    ).toThrow(/outside the allowed range/)
  })
})

describe('validateBuildSpec — text', () => {
  it('requires non-empty text on a TEXT node', () => {
    // An empty TEXT node is invisible in Figma and reads as a dropped layer.
    expect(() =>
      validateBuildSpec({ name: 'x', frames: [{ type: 'FRAME', children: [{ type: 'TEXT' }] }] })
    ).toThrow(/requires non-empty "text"/)
    expect(() =>
      validateBuildSpec({ name: 'x', frames: [{ type: 'FRAME', children: [{ type: 'TEXT', text: '' }] }] })
    ).toThrow(/requires non-empty "text"/)
  })

  it('rejects text on a non-TEXT node', () => {
    expect(() =>
      validateBuildSpec({
        name: 'x',
        frames: [{ type: 'FRAME', children: [{ type: 'RECTANGLE', text: 'oops' }] }]
      })
    ).toThrow(/only TEXT nodes carry text/)
  })

  it('collects every font used, deduped', () => {
    const v = validateBuildSpec({
      name: 'x',
      frames: [
        {
          type: 'FRAME',
          children: [
            { type: 'TEXT', text: 'a', font: { family: 'Inter', style: 'Bold' } },
            { type: 'TEXT', text: 'b', font: { family: 'Inter', style: 'Bold' } },
            { type: 'TEXT', text: 'c', font: { family: 'Roboto', style: 'Regular' } }
          ]
        }
      ]
    })
    expect(v.fonts).toEqual([
      { family: 'Inter', style: 'Bold' },
      { family: 'Roboto', style: 'Regular' }
    ])
  })

  it('defaults an unstyled text node to Inter Regular in the font list', () => {
    // Figma throws if .characters is set before the font is loaded, so the
    // preload list must cover implicit defaults too.
    const v = validateBuildSpec({
      name: 'x',
      frames: [{ type: 'FRAME', children: [{ type: 'TEXT', text: 'hi' }] }]
    })
    expect(v.fonts).toEqual([{ family: 'Inter', style: 'Regular' }])
  })
})

describe('validateBuildSpec — structure', () => {
  it('rejects children on a non-FRAME node', () => {
    expect(() =>
      validateBuildSpec({
        name: 'x',
        frames: [{ type: 'FRAME', children: [{ type: 'RECTANGLE', children: [{ type: 'TEXT', text: 'a' }] }] }]
      })
    ).toThrow(/only FRAME nodes can have children/)
  })

  it('enforces the node budget', () => {
    const children = Array.from({ length: MAX_BUILD_NODES + 5 }, () => ({ type: 'RECTANGLE' }))
    expect(() => validateBuildSpec({ name: 'x', frames: [{ type: 'FRAME', children }] })).toThrow(
      /node limit/
    )
  })

  it('enforces the depth limit', () => {
    let node: Record<string, unknown> = { type: 'FRAME', name: 'leaf' }
    for (let i = 0; i < MAX_BUILD_DEPTH + 3; i += 1) {
      node = { type: 'FRAME', children: [node] }
    }
    expect(() => validateBuildSpec({ name: 'x', frames: [node] })).toThrow(/nested deeper/)
  })
})

describe('validateBuildSpec — auto-layout', () => {
  it('round-trips a full auto-layout config', () => {
    const v = validateBuildSpec({
      name: 'x',
      frames: [
        {
          type: 'FRAME',
          layout: {
            mode: 'HORIZONTAL',
            gap: 16,
            padding: [24, 32, 24, 32],
            primaryAxis: 'SPACE_BETWEEN',
            counterAxis: 'CENTER',
            wrap: true,
            rowGap: 12
          }
        }
      ]
    })
    expect(v.spec.frames[0].layout).toEqual({
      mode: 'HORIZONTAL',
      gap: 16,
      padding: [24, 32, 24, 32],
      primaryAxis: 'SPACE_BETWEEN',
      counterAxis: 'CENTER',
      wrap: true,
      rowGap: 12
    })
  })

  it('requires a layout mode', () => {
    expect(() =>
      validateBuildSpec({ name: 'x', frames: [{ type: 'FRAME', layout: { gap: 8 } }] })
    ).toThrow(/layout\.mode/)
  })

  it('rejects a padding array that is not four numbers', () => {
    expect(() =>
      validateBuildSpec({
        name: 'x',
        frames: [{ type: 'FRAME', layout: { mode: 'VERTICAL', padding: [8, 8] } }]
      })
    ).toThrow(/top, right, bottom, left/)
  })

  it('rejects an invalid alignment value', () => {
    expect(() =>
      validateBuildSpec({
        name: 'x',
        frames: [{ type: 'FRAME', layout: { mode: 'VERTICAL', primaryAxis: 'MIDDLE' } }]
      })
    ).toThrow(/expected one of/)
  })

  it('keeps ABSOLUTE positioning and grow', () => {
    const v = validateBuildSpec({
      name: 'x',
      frames: [
        {
          type: 'FRAME',
          layout: { mode: 'VERTICAL' },
          children: [{ type: 'ELLIPSE', positioning: 'ABSOLUTE' }, { type: 'FRAME', grow: 1 }]
        }
      ]
    })
    expect(v.spec.frames[0].children?.[0].positioning).toBe('ABSOLUTE')
    expect(v.spec.frames[0].children?.[1].grow).toBe(1)
  })
})

describe('describeBuildSpec', () => {
  it('outlines what will be created before anything touches the document', () => {
    const v = validateBuildSpec({
      name: 'Landing',
      page: 'Marketing',
      frames: [
        {
          type: 'FRAME',
          name: 'Hero',
          width: 1440,
          height: 600,
          fill: '#1A1A2E',
          layout: { mode: 'VERTICAL', gap: 24 },
          children: [{ type: 'TEXT', text: 'Ship faster', font: { size: 48 } }]
        }
      ]
    })
    const out = describeBuildSpec(v)
    expect(out).toContain('Build "Landing"')
    expect(out).toContain('2 nodes')
    expect(out).toContain('on page "Marketing"')
    expect(out).toContain('FRAME  "Hero"  1440×600')
    expect(out).toContain('autolayout:column')
    expect(out).toContain('fill:#1A1A2E')
    expect(out).toContain('"Ship faster"')
  })
})
