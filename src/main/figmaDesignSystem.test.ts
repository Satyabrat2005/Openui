import { describe, it, expect } from 'vitest'
import {
  buildVariableIndex,
  contrastRatio,
  effectToCss,
  emitTokens,
  extractDesignSystem,
  figmaColorToHex,
  relativeLuminance,
  slugifyStyleName,
  summarizeDesignSystem
} from './figmaDesignSystem'
import type { FigmaFileResponse, FigmaNode, FigmaVariablesResponse } from './figmaTypes'

// Figma colours are 0..1 floats, so these helpers keep the fixtures readable.
const rgb = (r: number, g: number, b: number, a = 1): { r: number; g: number; b: number; a: number } => ({
  r: r / 255,
  g: g / 255,
  b: b / 255,
  a
})

const WHITE = rgb(255, 255, 255)
const BLACK = rgb(0, 0, 0)

/** Wrap nodes in the Document → Page → children shape the API returns. */
function fileWith(children: FigmaNode[], styles: FigmaFileResponse['styles'] = {}): FigmaFileResponse {
  return {
    name: 'Test File',
    styles,
    document: {
      id: '0:0',
      type: 'DOCUMENT',
      children: [{ id: '0:1', type: 'CANVAS', name: 'Page 1', children }]
    }
  }
}

describe('figmaColorToHex', () => {
  it('converts 0..1 floats to uppercase hex', () => {
    expect(figmaColorToHex(WHITE)).toBe('#FFFFFF')
    expect(figmaColorToHex(BLACK)).toBe('#000000')
    expect(figmaColorToHex(rgb(26, 26, 46))).toBe('#1A1A2E')
  })

  it('omits the alpha suffix for fully opaque colours', () => {
    expect(figmaColorToHex(rgb(255, 0, 0, 1))).toBe('#FF0000')
  })

  it('folds meaningful alpha into an 8-digit hex', () => {
    expect(figmaColorToHex(rgb(255, 0, 0, 0.5))).toBe('#FF000080')
  })

  it('multiplies paint opacity into the alpha channel', () => {
    expect(figmaColorToHex(rgb(255, 0, 0, 1), 0.5)).toBe('#FF000080')
  })

  it('clamps out-of-range channels instead of emitting invalid hex', () => {
    expect(figmaColorToHex({ r: 2, g: -1, b: 0.5 })).toBe('#FF0080')
  })

  it('falls back to black for a missing colour', () => {
    expect(figmaColorToHex(undefined)).toBe('#000000')
  })
})

describe('contrastRatio', () => {
  it('reports the canonical 21:1 for black on white', () => {
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 1)
  })

  it('reports 1:1 for a colour against itself', () => {
    expect(contrastRatio('#3B82F6', '#3B82F6')).toBeCloseTo(1, 5)
  })

  it('is symmetric', () => {
    expect(contrastRatio('#FFFFFF', '#767676')).toBeCloseTo(contrastRatio('#767676', '#FFFFFF'), 5)
  })

  it('orders luminance correctly', () => {
    expect(relativeLuminance('#FFFFFF')).toBeGreaterThan(relativeLuminance('#808080'))
    expect(relativeLuminance('#808080')).toBeGreaterThan(relativeLuminance('#000000'))
  })
})

describe('slugifyStyleName', () => {
  it('turns Figma folder separators into hyphens', () => {
    expect(slugifyStyleName('Brand/Primary 500')).toBe('brand-primary-500')
  })

  it('strips characters that are illegal in a CSS identifier', () => {
    expect(slugifyStyleName('Accent (hover)!')).toBe('accent-hover')
  })

  it('collapses repeats and trims stray hyphens', () => {
    expect(slugifyStyleName('  //Text//  Body  ')).toBe('text-body')
  })
})

describe('effectToCss', () => {
  it('renders a drop shadow', () => {
    expect(
      effectToCss({ type: 'DROP_SHADOW', radius: 8, offset: { x: 0, y: 4 }, color: rgb(0, 0, 0, 0.25) })
    ).toBe('0px 4px 8px 0px #00000040')
  })

  it('prefixes inner shadows with inset', () => {
    expect(
      effectToCss({ type: 'INNER_SHADOW', radius: 2, offset: { x: 1, y: 1 }, color: BLACK })
    ).toBe('inset 1px 1px 2px 0px #000000')
  })

  it('ignores hidden effects and non-shadow effects', () => {
    expect(effectToCss({ type: 'DROP_SHADOW', visible: false, radius: 4 })).toBeNull()
    expect(effectToCss({ type: 'LAYER_BLUR', radius: 4 })).toBeNull()
  })
})

describe('extractDesignSystem', () => {
  it('counts how often each colour is used', () => {
    const ds = extractDesignSystem(
      fileWith([
        { id: '1:1', type: 'RECTANGLE', fills: [{ type: 'SOLID', color: rgb(59, 130, 246) }] },
        { id: '1:2', type: 'RECTANGLE', fills: [{ type: 'SOLID', color: rgb(59, 130, 246) }] },
        { id: '1:3', type: 'RECTANGLE', fills: [{ type: 'SOLID', color: rgb(239, 68, 68) }] }
      ])
    )
    const blue = ds.colors.find((c) => c.hex === '#3B82F6')
    const red = ds.colors.find((c) => c.hex === '#EF4444')
    expect(blue?.count).toBe(2)
    expect(red?.count).toBe(1)
  })

  it('orders the palette light → dark', () => {
    const ds = extractDesignSystem(
      fileWith([
        { id: '1:1', type: 'RECTANGLE', fills: [{ type: 'SOLID', color: BLACK }] },
        { id: '1:2', type: 'RECTANGLE', fills: [{ type: 'SOLID', color: WHITE }] },
        { id: '1:3', type: 'RECTANGLE', fills: [{ type: 'SOLID', color: rgb(128, 128, 128) }] }
      ])
    )
    expect(ds.colors.map((c) => c.hex)).toEqual(['#FFFFFF', '#808080', '#000000'])
  })

  it('skips hidden layers — they are scaffolding, not design', () => {
    const ds = extractDesignSystem(
      fileWith([
        { id: '1:1', type: 'RECTANGLE', visible: false, fills: [{ type: 'SOLID', color: rgb(1, 2, 3) }] },
        { id: '1:2', type: 'RECTANGLE', fills: [{ type: 'SOLID', color: WHITE }] }
      ])
    )
    expect(ds.colors.map((c) => c.hex)).toEqual(['#FFFFFF'])
  })

  it('skips hidden paints within a visible node', () => {
    const ds = extractDesignSystem(
      fileWith([
        {
          id: '1:1',
          type: 'RECTANGLE',
          fills: [
            { type: 'SOLID', visible: false, color: rgb(1, 2, 3) },
            { type: 'SOLID', color: WHITE }
          ]
        }
      ])
    )
    expect(ds.colors.map((c) => c.hex)).toEqual(['#FFFFFF'])
  })

  it('adopts the published style name when a fill references one', () => {
    const ds = extractDesignSystem(
      fileWith(
        [
          {
            id: '1:1',
            type: 'RECTANGLE',
            fills: [{ type: 'SOLID', color: rgb(59, 130, 246) }],
            styles: { fill: 'S:abc' }
          }
        ],
        { 'S:abc': { name: 'Brand/Primary', styleType: 'FILL' } }
      )
    )
    expect(ds.colors[0].styleName).toBe('Brand/Primary')
  })

  it('keeps the published name even when a later unnamed use of the colour follows', () => {
    const ds = extractDesignSystem(
      fileWith(
        [
          {
            id: '1:1',
            type: 'RECTANGLE',
            fills: [{ type: 'SOLID', color: rgb(59, 130, 246) }],
            styles: { fill: 'S:abc' }
          },
          { id: '1:2', type: 'RECTANGLE', fills: [{ type: 'SOLID', color: rgb(59, 130, 246) }] }
        ],
        { 'S:abc': { name: 'Brand/Primary', styleType: 'FILL' } }
      )
    )
    expect(ds.colors[0].styleName).toBe('Brand/Primary')
    expect(ds.colors[0].count).toBe(2)
  })

  it('collects text styles and orders them largest first', () => {
    const ds = extractDesignSystem(
      fileWith([
        {
          id: '1:1',
          type: 'TEXT',
          characters: 'Body',
          style: { fontFamily: 'Inter', fontSize: 16, fontWeight: 400, lineHeightPx: 24 }
        },
        {
          id: '1:2',
          type: 'TEXT',
          characters: 'Heading',
          style: { fontFamily: 'Inter', fontSize: 48, fontWeight: 700, lineHeightPx: 56 }
        }
      ])
    )
    expect(ds.text.map((t) => t.fontSize)).toEqual([48, 16])
    expect(ds.text[0].fontWeight).toBe(700)
    expect(ds.text[0].lineHeight).toBe(56)
  })

  it('ignores text nodes with no usable font size', () => {
    const ds = extractDesignSystem(
      fileWith([{ id: '1:1', type: 'TEXT', characters: 'x', style: { fontFamily: 'Inter' } }])
    )
    expect(ds.text).toEqual([])
  })

  it('derives the spacing scale from auto-layout gaps and padding', () => {
    const ds = extractDesignSystem(
      fileWith([
        {
          id: '1:1',
          type: 'FRAME',
          layoutMode: 'VERTICAL',
          itemSpacing: 16,
          paddingTop: 24,
          paddingBottom: 24,
          paddingLeft: 8,
          paddingRight: 8
        }
      ])
    )
    expect(ds.spacing.map((s) => s.value)).toEqual([8, 16, 24])
  })

  it('does NOT take spacing from frames without auto-layout', () => {
    // Padding on a non-auto-layout frame is inert in Figma, so treating it as a
    // spacing token would invent a step the design never applies.
    const ds = extractDesignSystem(
      fileWith([{ id: '1:1', type: 'FRAME', layoutMode: 'NONE', itemSpacing: 99, paddingTop: 99 }])
    )
    expect(ds.spacing).toEqual([])
  })

  it('collects both uniform and per-corner radii', () => {
    const ds = extractDesignSystem(
      fileWith([
        { id: '1:1', type: 'RECTANGLE', cornerRadius: 8 },
        { id: '1:2', type: 'RECTANGLE', rectangleCornerRadii: [4, 4, 0, 0] }
      ])
    )
    expect(ds.radii.map((r) => r.value)).toEqual([4, 8])
  })

  it('collects shadows as ready-to-use CSS', () => {
    const ds = extractDesignSystem(
      fileWith([
        {
          id: '1:1',
          type: 'RECTANGLE',
          effects: [{ type: 'DROP_SHADOW', radius: 12, offset: { x: 0, y: 6 }, color: rgb(0, 0, 0, 0.2) }]
        }
      ])
    )
    expect(ds.shadows[0].css).toBe('0px 6px 12px 0px #00000033')
  })

  it('walks nested children', () => {
    const ds = extractDesignSystem(
      fileWith([
        {
          id: '1:1',
          type: 'FRAME',
          children: [
            {
              id: '1:2',
              type: 'FRAME',
              children: [{ id: '1:3', type: 'RECTANGLE', fills: [{ type: 'SOLID', color: WHITE }] }]
            }
          ]
        }
      ])
    )
    expect(ds.colors.map((c) => c.hex)).toEqual(['#FFFFFF'])
    expect(ds.nodesScanned).toBeGreaterThanOrEqual(4)
  })

  it('flags truncation instead of hanging on a pathologically deep tree', () => {
    // 60 levels of nesting, well past MAX_WALK_DEPTH.
    let node: FigmaNode = { id: 'leaf', type: 'RECTANGLE' }
    for (let i = 0; i < 60; i += 1) node = { id: `n${i}`, type: 'FRAME', children: [node] }

    const ds = extractDesignSystem(fileWith([node]))
    expect(ds.truncated).toBe(true)
  })

  it('returns empty collections for an empty document rather than throwing', () => {
    const ds = extractDesignSystem({ name: 'Empty' })
    expect(ds.colors).toEqual([])
    expect(ds.text).toEqual([])
    expect(ds.nodesScanned).toBe(0)
  })
})

// A representative file reused across the emitter tests.
const SAMPLE = extractDesignSystem(
  fileWith(
    [
      {
        id: '1:1',
        type: 'FRAME',
        layoutMode: 'VERTICAL',
        itemSpacing: 16,
        paddingTop: 24,
        cornerRadius: 12,
        fills: [{ type: 'SOLID', color: rgb(26, 26, 46) }],
        styles: { fill: 'S:bg' },
        effects: [{ type: 'DROP_SHADOW', radius: 8, offset: { x: 0, y: 2 }, color: rgb(0, 0, 0, 0.3) }],
        children: [
          {
            id: '1:2',
            type: 'TEXT',
            characters: 'Hello',
            style: { fontFamily: 'Inter', fontSize: 32, fontWeight: 700, lineHeightPx: 40 },
            fills: [{ type: 'SOLID', color: WHITE }]
          }
        ]
      }
    ],
    { 'S:bg': { name: 'Surface/Base', styleType: 'FILL' } }
  )
)

describe('buildVariableIndex', () => {
  /** Wrap variables/collections in the /variables/local response shape. */
  const varsResponse = (
    variables: Record<string, unknown>,
    collections: Record<string, unknown> = {
      'VariableCollectionId:1:1': {
        id: 'VariableCollectionId:1:1',
        name: 'Primitives',
        defaultModeId: 'm-light',
        modes: [
          { modeId: 'm-light', name: 'Light' },
          { modeId: 'm-dark', name: 'Dark' }
        ]
      }
    }
  ): FigmaVariablesResponse =>
    ({ meta: { variables, variableCollections: collections } }) as FigmaVariablesResponse

  it('indexes colour variables by their resolved hex', () => {
    const index = buildVariableIndex(
      varsResponse({
        'VariableID:1:2': {
          id: 'VariableID:1:2',
          name: 'brand/primary',
          variableCollectionId: 'VariableCollectionId:1:1',
          resolvedType: 'COLOR',
          valuesByMode: { 'm-light': rgb(26, 26, 46) }
        }
      })
    )
    expect(index.colors.get('#1A1A2E')).toBe('brand/primary')
  })

  it('indexes numeric variables for spacing and radii', () => {
    const index = buildVariableIndex(
      varsResponse({
        'VariableID:1:3': {
          id: 'VariableID:1:3',
          name: 'spacing/md',
          variableCollectionId: 'VariableCollectionId:1:1',
          resolvedType: 'FLOAT',
          valuesByMode: { 'm-light': 16 }
        }
      })
    )
    expect(index.numbers.get(16)).toBe('spacing/md')
  })

  it('follows an alias to the primitive it points at', () => {
    // Semantic variables almost always alias a primitive; without following the
    // alias, `surface/raised` would resolve to nothing and the name be lost.
    const index = buildVariableIndex(
      varsResponse({
        'VariableID:1:2': {
          id: 'VariableID:1:2',
          name: 'grey/900',
          variableCollectionId: 'VariableCollectionId:1:1',
          resolvedType: 'COLOR',
          valuesByMode: { 'm-light': rgb(26, 26, 46) }
        },
        'VariableID:1:9': {
          id: 'VariableID:1:9',
          name: 'surface/raised',
          variableCollectionId: 'VariableCollectionId:1:1',
          resolvedType: 'COLOR',
          valuesByMode: { 'm-light': { type: 'VARIABLE_ALIAS', id: 'VariableID:1:2' } }
        }
      })
    )
    // Both names resolve to the same hex; the first one indexed wins.
    expect(index.colors.get('#1A1A2E')).toBeDefined()
  })

  it('indexes non-default modes too, so dark-mode values still resolve', () => {
    const index = buildVariableIndex(
      varsResponse({
        'VariableID:1:2': {
          id: 'VariableID:1:2',
          name: 'surface/base',
          variableCollectionId: 'VariableCollectionId:1:1',
          resolvedType: 'COLOR',
          valuesByMode: { 'm-light': WHITE, 'm-dark': rgb(26, 26, 46) }
        }
      })
    )
    expect(index.colors.get('#FFFFFF')).toBe('surface/base')
    expect(index.colors.get('#1A1A2E')).toBe('surface/base')
  })

  it('prefixes the collection only when a name is ambiguous', () => {
    const index = buildVariableIndex(
      varsResponse(
        {
          'VariableID:1:2': {
            id: 'VariableID:1:2',
            name: 'primary',
            variableCollectionId: 'VariableCollectionId:1:1',
            resolvedType: 'COLOR',
            valuesByMode: { 'm-light': rgb(255, 0, 0) }
          },
          'VariableID:2:2': {
            id: 'VariableID:2:2',
            name: 'primary',
            variableCollectionId: 'VariableCollectionId:2:1',
            resolvedType: 'COLOR',
            valuesByMode: { 'm-a': rgb(0, 255, 0) }
          }
        },
        {
          'VariableCollectionId:1:1': { name: 'Light Theme', defaultModeId: 'm-light' },
          'VariableCollectionId:2:1': { name: 'Dark Theme', defaultModeId: 'm-a' }
        }
      )
    )
    expect(index.colors.get('#FF0000')).toBe('Light Theme/primary')
    expect(index.colors.get('#00FF00')).toBe('Dark Theme/primary')
  })

  it('survives an alias cycle instead of hanging', () => {
    const index = buildVariableIndex(
      varsResponse({
        'VariableID:a': {
          id: 'VariableID:a',
          name: 'a',
          variableCollectionId: 'VariableCollectionId:1:1',
          valuesByMode: { 'm-light': { type: 'VARIABLE_ALIAS', id: 'VariableID:b' } }
        },
        'VariableID:b': {
          id: 'VariableID:b',
          name: 'b',
          variableCollectionId: 'VariableCollectionId:1:1',
          valuesByMode: { 'm-light': { type: 'VARIABLE_ALIAS', id: 'VariableID:a' } }
        }
      })
    )
    expect(index.colors.size).toBe(0)
  })

  it('returns an empty index for a missing or errored response', () => {
    expect(buildVariableIndex(null).colors.size).toBe(0)
    expect(buildVariableIndex(undefined).numbers.size).toBe(0)
    expect(buildVariableIndex({ meta: {} }).colors.size).toBe(0)
  })
})

describe('extractDesignSystem with Figma Variables', () => {
  const variables = buildVariableIndex({
    meta: {
      variableCollections: {
        c1: { id: 'c1', name: 'Primitives', defaultModeId: 'm1', modes: [{ modeId: 'm1' }] }
      },
      variables: {
        v1: {
          id: 'v1',
          name: 'brand/primary',
          variableCollectionId: 'c1',
          resolvedType: 'COLOR',
          valuesByMode: { m1: rgb(26, 26, 46) }
        },
        v2: {
          id: 'v2',
          name: 'spacing/md',
          variableCollectionId: 'c1',
          resolvedType: 'FLOAT',
          valuesByMode: { m1: 16 }
        }
      }
    }
  })

  const frame: FigmaNode = {
    id: '1:1',
    type: 'FRAME',
    name: 'Card',
    fills: [{ type: 'SOLID', color: rgb(26, 26, 46) }],
    layoutMode: 'VERTICAL',
    itemSpacing: 16
  }

  it('names a colour from a Variable when no Style defines it', () => {
    // The whole point: a Variables-based file has an empty `styles` map, so
    // without this the token would emit as the frequency-ranked `--color-1`.
    const ds = extractDesignSystem(fileWith([frame]), {}, variables)
    expect(ds.colors.find((c) => c.hex === '#1A1A2E')?.styleName).toBe('brand/primary')
  })

  it('names a spacing step from a Variable', () => {
    const ds = extractDesignSystem(fileWith([frame]), {}, variables)
    expect(ds.spacing.find((s) => s.value === 16)?.name).toBe('spacing/md')
  })

  it('lets a published Style outrank a Variable for the same value', () => {
    // A Style is exact per-node linkage the file states outright; a Variable
    // match is by value. When both exist the stronger claim wins.
    const styled: FigmaNode = { ...frame, styles: { fill: 'S:bg' } }
    const ds = extractDesignSystem(
      fileWith([styled], { 'S:bg': { name: 'Surface/Base', styleType: 'FILL' } }),
      { 'S:bg': { name: 'Surface/Base', styleType: 'FILL' } },
      variables
    )
    expect(ds.colors.find((c) => c.hex === '#1A1A2E')?.styleName).toBe('Surface/Base')
  })

  it('behaves exactly as before when no variables are supplied', () => {
    const ds = extractDesignSystem(fileWith([frame]), {})
    expect(ds.colors.find((c) => c.hex === '#1A1A2E')?.styleName).toBeUndefined()
    expect(ds.spacing.find((s) => s.value === 16)?.name).toBeUndefined()
  })

  it('emits variable-named tokens in every format', () => {
    const ds = extractDesignSystem(fileWith([frame]), {}, variables)
    expect(emitTokens(ds, 'css')).toContain('--brand-primary: #1A1A2E;')
    expect(emitTokens(ds, 'css')).toContain('--spacing-md: 16px;')
    expect(emitTokens(ds, 'scss')).toContain('$brand-primary: #1A1A2E;')
    expect(emitTokens(ds, 'scss')).toContain('spacing-md: 16px')
    expect(JSON.parse(emitTokens(ds, 'json')).spacing['spacing-md']).toBeDefined()
    expect(emitTokens(ds, 'tailwind')).toContain('"spacing-md"')
    expect(emitTokens(ds, 'ts')).toContain('"spacing-md"')
  })

  it('shows the variable name alongside the value in the summary', () => {
    const ds = extractDesignSystem(fileWith([frame]), {}, variables)
    const summary = summarizeDesignSystem(ds)
    expect(summary).toContain('brand/primary')
    expect(summary).toContain('spacing/md (16px)')
  })
})

describe('emitTokens', () => {
  it('emits CSS custom properties using the published style name', () => {
    const css = emitTokens(SAMPLE, 'css')
    expect(css).toContain(':root {')
    expect(css).toContain('--surface-base: #1A1A2E;')
    expect(css).toContain('--space-16: 16px;')
    expect(css).toContain('--radius-12: 12px;')
    expect(css).toMatch(/--text-\d+-size: 32px;/)
  })

  it('emits SCSS variables', () => {
    const scss = emitTokens(SAMPLE, 'scss')
    expect(scss).toContain('$surface-base: #1A1A2E;')
    expect(scss).toContain('$spacing: (')
  })

  it('emits JSON that parses and follows the W3C $value/$type shape', () => {
    const json = emitTokens(SAMPLE, 'json')
    const parsed = JSON.parse(json) as {
      color: Record<string, { $value: string; $type: string }>
      spacing: Record<string, { $value: string }>
    }
    expect(parsed.color['surface-base'].$value).toBe('#1A1A2E')
    expect(parsed.color['surface-base'].$type).toBe('color')
    expect(parsed.spacing['16'].$value).toBe('16px')
  })

  it('emits a Tailwind theme config', () => {
    const tw = emitTokens(SAMPLE, 'tailwind')
    expect(tw).toContain('module.exports')
    expect(tw).toContain('theme:')
    expect(tw).toContain('#1A1A2E')
  })

  it('emits a typed TS module', () => {
    const ts = emitTokens(SAMPLE, 'ts')
    expect(ts).toContain('export const tokens =')
    expect(ts).toContain('as const')
    expect(ts).toContain('#1A1A2E')
  })

  it('defaults unknown formats to CSS rather than emitting nothing', () => {
    expect(emitTokens(SAMPLE, 'css')).toContain(':root {')
  })

  it('never emits duplicate CSS variable names', () => {
    // Two distinct colours whose style names slugify identically must not
    // collapse into one variable — the second gets a -2 suffix.
    const ds = extractDesignSystem(
      fileWith(
        [
          {
            id: '1:1',
            type: 'RECTANGLE',
            fills: [{ type: 'SOLID', color: WHITE }],
            styles: { fill: 'S:a' }
          },
          {
            id: '1:2',
            type: 'RECTANGLE',
            fills: [{ type: 'SOLID', color: BLACK }],
            styles: { fill: 'S:b' }
          }
        ],
        {
          'S:a': { name: 'Brand/Primary', styleType: 'FILL' },
          'S:b': { name: 'Brand Primary', styleType: 'FILL' }
        }
      )
    )
    const css = emitTokens(ds, 'css')
    const names = [...css.matchAll(/^ {2}--([a-z0-9-]+): #/gm)].map((m) => m[1])
    expect(new Set(names).size).toBe(names.length)
  })
})

describe('summarizeDesignSystem', () => {
  it('reports counts, usage numbers and the contrast verdict', () => {
    const summary = summarizeDesignSystem(SAMPLE)
    expect(summary).toContain('Design system — "Test File"')
    expect(summary).toContain('#FFFFFF')
    expect(summary).toContain('Surface/Base')
    expect(summary).toContain('32px')
    expect(summary).toMatch(/Contrast, lightest .* passes AAA/)
  })

  it('flags a failing contrast pair', () => {
    const ds = extractDesignSystem(
      fileWith([
        { id: '1:1', type: 'RECTANGLE', fills: [{ type: 'SOLID', color: rgb(200, 200, 200) }] },
        { id: '1:2', type: 'RECTANGLE', fills: [{ type: 'SOLID', color: rgb(255, 255, 255) }] }
      ])
    )
    expect(summarizeDesignSystem(ds)).toContain('FAILS WCAG AA')
  })

  it('says so plainly when there is no auto-layout to derive spacing from', () => {
    const ds = extractDesignSystem(
      fileWith([{ id: '1:1', type: 'RECTANGLE', fills: [{ type: 'SOLID', color: WHITE }] }])
    )
    expect(summarizeDesignSystem(ds)).toContain('(none — no auto-layout frames)')
  })
})
