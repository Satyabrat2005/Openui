/**
 * figmaBuildSpec.ts — the design program OpenUI sends INTO Figma.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * figma.ts pulls designs OUT of Figma and turns them into code. This file is the
 * other direction: a declarative description of a design that the OpenUI Builder
 * plugin executes against Figma's scene-graph API to create real frames, text,
 * shapes and auto-layout inside a real file.
 *
 * It exists as a SPEC rather than as generated plugin code because the spec
 * crosses a trust boundary. The agent authors it, it travels over a localhost
 * socket, and it is executed inside the user's Figma session against their real
 * document. Shipping executable JavaScript across that boundary would mean the
 * plugin eval'ing whatever arrived. A declarative spec that is validated on the
 * way out and interpreted on the way in cannot do anything the interpreter does
 * not already implement — the worst a malformed spec achieves is a rejected
 * build or an ugly rectangle.
 *
 * That is also why validation here is strict rather than permissive: every
 * bound (node count, depth, string length, numeric range) is a bound on what
 * the plugin can be made to do to someone's document.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Hex colour, `#RGB`, `#RRGGBB` or `#RRGGBBAA`. */
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/

// Bounds. These are limits on what a single build may do to a real document,
// not just anti-flooding guards — keep them conservative.
export const MAX_BUILD_NODES = 500
export const MAX_BUILD_DEPTH = 16
export const MAX_NAME_CHARS = 120
export const MAX_TEXT_CHARS = 5_000
/** Figma's canvas is finite; these keep a typo from placing a frame 1e9px away. */
export const MAX_COORD = 100_000
export const MAX_DIMENSION = 50_000

const NODE_TYPES = ['FRAME', 'TEXT', 'RECTANGLE', 'ELLIPSE', 'LINE'] as const
export type BuildNodeType = (typeof NODE_TYPES)[number]

const LAYOUT_MODES = ['HORIZONTAL', 'VERTICAL'] as const
const AXIS_ALIGN = ['MIN', 'CENTER', 'MAX', 'SPACE_BETWEEN'] as const
const COUNTER_ALIGN = ['MIN', 'CENTER', 'MAX', 'BASELINE'] as const
const TEXT_ALIGN = ['LEFT', 'CENTER', 'RIGHT', 'JUSTIFIED'] as const
const POSITIONING = ['AUTO', 'ABSOLUTE'] as const
const SIZING = ['FIXED', 'HUG', 'FILL'] as const

export interface BuildLayout {
  mode: 'HORIZONTAL' | 'VERTICAL'
  /** Space between children, px. */
  gap?: number
  /** [top, right, bottom, left], px. */
  padding?: [number, number, number, number]
  primaryAxis?: (typeof AXIS_ALIGN)[number]
  counterAxis?: (typeof COUNTER_ALIGN)[number]
  wrap?: boolean
  /** Cross-axis gap when wrap is on. */
  rowGap?: number
}

export interface BuildStroke {
  color: string
  weight?: number
}

export interface BuildShadow {
  x?: number
  y?: number
  blur?: number
  spread?: number
  color?: string
  inner?: boolean
}

export interface BuildFont {
  family?: string
  /** Figma font style — "Regular", "Medium", "Bold", "Semi Bold", … */
  style?: string
  size?: number
  lineHeight?: number
  letterSpacing?: number
  align?: (typeof TEXT_ALIGN)[number]
}

export interface BuildNode {
  type: BuildNodeType
  name?: string
  x?: number
  y?: number
  width?: number
  height?: number
  /** How the node sizes itself inside a parent's auto-layout. */
  sizing?: { horizontal?: (typeof SIZING)[number]; vertical?: (typeof SIZING)[number] }
  layout?: BuildLayout
  fill?: string
  stroke?: BuildStroke
  radius?: number
  opacity?: number
  shadows?: BuildShadow[]
  /** TEXT nodes only. */
  text?: string
  font?: BuildFont
  /** ABSOLUTE lifts the node out of its parent's auto-layout flow. */
  positioning?: (typeof POSITIONING)[number]
  /** flex-grow equivalent inside an auto-layout parent. */
  grow?: number
  children?: BuildNode[]
}

export interface BuildSpec {
  /** What is being built — becomes the plugin's progress label. */
  name: string
  /** Page to build on. Created if absent; defaults to the current page. */
  page?: string
  /** Top-level frames. Everything else nests inside these. */
  frames: BuildNode[]
}

/** A validated spec plus the fonts the plugin must preload before building. */
export interface ValidatedBuildSpec {
  spec: BuildSpec
  /** Every (family, style) pair used, deduped — see collectFonts. */
  fonts: { family: string; style: string }[]
  nodeCount: number
}

export const DEFAULT_FONT_FAMILY = 'Inter'
export const DEFAULT_FONT_STYLE = 'Regular'

/** Thrown by validateBuildSpec with a path pointing at the offending field. */
export class BuildSpecError extends Error {}

// ── validation helpers ───────────────────────────────────────────────────────

function fail(path: string, message: string): never {
  throw new BuildSpecError(`${path}: ${message}`)
}

function checkNumber(
  value: unknown,
  path: string,
  { min, max }: { min: number; max: number }
): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(path, `expected a finite number, got ${JSON.stringify(value)}`)
  }
  if (value < min || value > max) {
    fail(path, `${value} is outside the allowed range ${min}..${max}`)
  }
  return value
}

function checkHex(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !HEX_RE.test(value.trim())) {
    fail(path, `expected a hex colour like "#1A1A2E", got ${JSON.stringify(value)}`)
  }
  return value.trim().toUpperCase()
}

function checkEnum<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[]
): T | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    fail(path, `expected one of ${allowed.join(' | ')}, got ${JSON.stringify(value)}`)
  }
  return value as T
}

function checkString(value: unknown, path: string, maxChars: number): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') fail(path, `expected a string, got ${typeof value}`)
  if (value.length > maxChars) {
    fail(path, `is ${value.length} characters, over the ${maxChars} limit`)
  }
  return value
}

// ── validation ───────────────────────────────────────────────────────────────

/**
 * Validate and normalise a raw spec (typically JSON the model produced).
 *
 * Returns a NEW object containing only known fields — unknown keys are dropped
 * rather than passed through, so nothing the interpreter does not understand
 * ever reaches the plugin. Throws BuildSpecError with a field path on the first
 * problem, because a half-built design in someone's real file is worse than a
 * clear rejection.
 */
export function validateBuildSpec(raw: unknown): ValidatedBuildSpec {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new BuildSpecError('spec: expected a JSON object with "name" and "frames".')
  }
  const input = raw as Record<string, unknown>

  const name = checkString(input.name, 'spec.name', MAX_NAME_CHARS)
  if (!name || !name.trim()) {
    throw new BuildSpecError('spec.name: required — a short label for what is being built.')
  }

  const page = checkString(input.page, 'spec.page', MAX_NAME_CHARS)

  if (!Array.isArray(input.frames) || input.frames.length === 0) {
    throw new BuildSpecError('spec.frames: required — a non-empty array of top-level frames.')
  }

  let nodeCount = 0
  const fonts = new Map<string, { family: string; style: string }>()

  const walk = (raw: unknown, path: string, depth: number): BuildNode => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      fail(path, 'expected a node object')
    }
    const n = raw as Record<string, unknown>

    nodeCount += 1
    if (nodeCount > MAX_BUILD_NODES) {
      throw new BuildSpecError(
        `spec: over the ${MAX_BUILD_NODES}-node limit for a single build. ` +
          'Split it into several builds, or build the page structure first and fill in detail after.'
      )
    }
    if (depth > MAX_BUILD_DEPTH) {
      fail(path, `nested deeper than the ${MAX_BUILD_DEPTH}-level limit`)
    }

    const type = checkEnum(n.type, `${path}.type`, NODE_TYPES)
    if (!type) fail(`${path}.type`, `required — one of ${NODE_TYPES.join(' | ')}`)

    const node: BuildNode = { type }

    const nodeName = checkString(n.name, `${path}.name`, MAX_NAME_CHARS)
    if (nodeName) node.name = nodeName

    for (const key of ['x', 'y'] as const) {
      const v = checkNumber(n[key], `${path}.${key}`, { min: -MAX_COORD, max: MAX_COORD })
      if (v !== undefined) node[key] = v
    }
    for (const key of ['width', 'height'] as const) {
      const v = checkNumber(n[key], `${path}.${key}`, { min: 0, max: MAX_DIMENSION })
      if (v !== undefined) node[key] = v
    }

    const opacity = checkNumber(n.opacity, `${path}.opacity`, { min: 0, max: 1 })
    if (opacity !== undefined) node.opacity = opacity

    const radius = checkNumber(n.radius, `${path}.radius`, { min: 0, max: MAX_DIMENSION })
    if (radius !== undefined) node.radius = radius

    const grow = checkNumber(n.grow, `${path}.grow`, { min: 0, max: 1 })
    if (grow !== undefined) node.grow = grow

    const fill = checkHex(n.fill, `${path}.fill`)
    if (fill) node.fill = fill

    const positioning = checkEnum(n.positioning, `${path}.positioning`, POSITIONING)
    if (positioning) node.positioning = positioning

    if (n.sizing !== undefined && n.sizing !== null) {
      if (typeof n.sizing !== 'object' || Array.isArray(n.sizing)) {
        fail(`${path}.sizing`, 'expected an object with "horizontal" and/or "vertical"')
      }
      const s = n.sizing as Record<string, unknown>
      const horizontal = checkEnum(s.horizontal, `${path}.sizing.horizontal`, SIZING)
      const vertical = checkEnum(s.vertical, `${path}.sizing.vertical`, SIZING)
      if (horizontal || vertical) {
        node.sizing = { ...(horizontal ? { horizontal } : {}), ...(vertical ? { vertical } : {}) }
      }
    }

    if (n.stroke !== undefined && n.stroke !== null) {
      if (typeof n.stroke !== 'object' || Array.isArray(n.stroke)) {
        fail(`${path}.stroke`, 'expected an object with "color" and optional "weight"')
      }
      const s = n.stroke as Record<string, unknown>
      const color = checkHex(s.color, `${path}.stroke.color`)
      if (!color) fail(`${path}.stroke.color`, 'required when "stroke" is present')
      const weight = checkNumber(s.weight, `${path}.stroke.weight`, { min: 0, max: 1_000 })
      node.stroke = { color, ...(weight !== undefined ? { weight } : {}) }
    }

    if (n.layout !== undefined && n.layout !== null) {
      if (typeof n.layout !== 'object' || Array.isArray(n.layout)) {
        fail(`${path}.layout`, 'expected an auto-layout object with a "mode"')
      }
      const l = n.layout as Record<string, unknown>
      const mode = checkEnum(l.mode, `${path}.layout.mode`, LAYOUT_MODES)
      if (!mode) fail(`${path}.layout.mode`, 'required — HORIZONTAL or VERTICAL')

      const layout: BuildLayout = { mode }

      const gap = checkNumber(l.gap, `${path}.layout.gap`, { min: -1_000, max: 10_000 })
      if (gap !== undefined) layout.gap = gap

      const rowGap = checkNumber(l.rowGap, `${path}.layout.rowGap`, { min: -1_000, max: 10_000 })
      if (rowGap !== undefined) layout.rowGap = rowGap

      if (l.padding !== undefined && l.padding !== null) {
        if (!Array.isArray(l.padding) || l.padding.length !== 4) {
          fail(`${path}.layout.padding`, 'expected [top, right, bottom, left]')
        }
        layout.padding = l.padding.map((v, i) =>
          checkNumber(v, `${path}.layout.padding[${i}]`, { min: 0, max: 10_000 }) ?? 0
        ) as [number, number, number, number]
      }

      const primaryAxis = checkEnum(l.primaryAxis, `${path}.layout.primaryAxis`, AXIS_ALIGN)
      if (primaryAxis) layout.primaryAxis = primaryAxis
      const counterAxis = checkEnum(l.counterAxis, `${path}.layout.counterAxis`, COUNTER_ALIGN)
      if (counterAxis) layout.counterAxis = counterAxis
      if (typeof l.wrap === 'boolean') layout.wrap = l.wrap

      node.layout = layout
    }

    if (n.shadows !== undefined && n.shadows !== null) {
      if (!Array.isArray(n.shadows)) fail(`${path}.shadows`, 'expected an array')
      if (n.shadows.length > 8) fail(`${path}.shadows`, 'more than 8 shadows on one node')
      node.shadows = n.shadows.map((s, i) => {
        const p = `${path}.shadows[${i}]`
        if (typeof s !== 'object' || s === null) fail(p, 'expected a shadow object')
        const sh = s as Record<string, unknown>
        const shadow: BuildShadow = {}
        const x = checkNumber(sh.x, `${p}.x`, { min: -1_000, max: 1_000 })
        if (x !== undefined) shadow.x = x
        const y = checkNumber(sh.y, `${p}.y`, { min: -1_000, max: 1_000 })
        if (y !== undefined) shadow.y = y
        const blur = checkNumber(sh.blur, `${p}.blur`, { min: 0, max: 1_000 })
        if (blur !== undefined) shadow.blur = blur
        const spread = checkNumber(sh.spread, `${p}.spread`, { min: -1_000, max: 1_000 })
        if (spread !== undefined) shadow.spread = spread
        const color = checkHex(sh.color, `${p}.color`)
        if (color) shadow.color = color
        if (typeof sh.inner === 'boolean') shadow.inner = sh.inner
        return shadow
      })
    }

    if (type === 'TEXT') {
      const text = checkString(n.text, `${path}.text`, MAX_TEXT_CHARS)
      // A TEXT node with no characters is invisible in Figma and looks like the
      // build silently dropped it — reject rather than create a ghost layer.
      if (text === undefined || text === '') {
        fail(`${path}.text`, 'a TEXT node requires non-empty "text"')
      }
      node.text = text
    } else if (n.text !== undefined) {
      fail(`${path}.text`, `only TEXT nodes carry text (this node is ${type})`)
    }

    if (n.font !== undefined && n.font !== null) {
      if (typeof n.font !== 'object' || Array.isArray(n.font)) {
        fail(`${path}.font`, 'expected a font object')
      }
      const f = n.font as Record<string, unknown>
      const font: BuildFont = {}
      const family = checkString(f.family, `${path}.font.family`, MAX_NAME_CHARS)
      if (family) font.family = family
      const style = checkString(f.style, `${path}.font.style`, MAX_NAME_CHARS)
      if (style) font.style = style
      const size = checkNumber(f.size, `${path}.font.size`, { min: 1, max: 1_000 })
      if (size !== undefined) font.size = size
      const lineHeight = checkNumber(f.lineHeight, `${path}.font.lineHeight`, { min: 0, max: 2_000 })
      if (lineHeight !== undefined) font.lineHeight = lineHeight
      const letterSpacing = checkNumber(f.letterSpacing, `${path}.font.letterSpacing`, {
        min: -100,
        max: 100
      })
      if (letterSpacing !== undefined) font.letterSpacing = letterSpacing
      const align = checkEnum(f.align, `${path}.font.align`, TEXT_ALIGN)
      if (align) font.align = align
      node.font = font
    }

    // Every text node contributes a font to preload. Figma THROWS if you set
    // .characters before its font is loaded, and the plugin cannot recover
    // mid-build, so the load list has to be complete before the build starts.
    if (type === 'TEXT') {
      const family = node.font?.family ?? DEFAULT_FONT_FAMILY
      const style = node.font?.style ?? DEFAULT_FONT_STYLE
      fonts.set(`${family} ${style}`, { family, style })
    }

    if (n.children !== undefined && n.children !== null) {
      if (!Array.isArray(n.children)) fail(`${path}.children`, 'expected an array of nodes')
      if (type !== 'FRAME' && n.children.length > 0) {
        fail(`${path}.children`, `only FRAME nodes can have children (this node is ${type})`)
      }
      node.children = n.children.map((c, i) => walk(c, `${path}.children[${i}]`, depth + 1))
    }

    return node
  }

  const frames = input.frames.map((f, i) => {
    const node = walk(f, `spec.frames[${i}]`, 0)
    if (node.type !== 'FRAME') {
      fail(`spec.frames[${i}].type`, 'top-level entries must be FRAME nodes')
    }
    return node
  })

  return {
    spec: { name: name.trim(), ...(page ? { page } : {}), frames },
    fonts: [...fonts.values()],
    nodeCount
  }
}

/**
 * A compact, human-readable outline of what a spec will create — shown to the
 * user BEFORE anything touches their document, so "build this" is reviewable
 * rather than a surprise.
 */
export function describeBuildSpec(validated: ValidatedBuildSpec): string {
  const lines: string[] = []

  const walk = (node: BuildNode, depth: number): void => {
    const pad = '  '.repeat(depth)
    const bits: string[] = [node.type]
    if (node.name) bits.push(`"${node.name}"`)
    if (node.width && node.height) bits.push(`${Math.round(node.width)}×${Math.round(node.height)}`)
    if (node.layout) {
      bits.push(`autolayout:${node.layout.mode === 'HORIZONTAL' ? 'row' : 'column'}`)
      if (node.layout.gap !== undefined) bits.push(`gap:${node.layout.gap}`)
      if (node.layout.wrap) bits.push('wrap')
    }
    if (node.fill) bits.push(`fill:${node.fill}`)
    if (node.positioning === 'ABSOLUTE') bits.push('position:absolute')
    if (node.text) bits.push(`text:${JSON.stringify(node.text.slice(0, 60))}`)
    lines.push(`${pad}- ${bits.join('  ')}`)
    for (const child of node.children ?? []) walk(child, depth + 1)
  }

  for (const frame of validated.spec.frames) walk(frame, 0)

  return [
    `Build "${validated.spec.name}" — ${validated.nodeCount} nodes` +
      (validated.spec.page ? ` on page "${validated.spec.page}"` : ''),
    `Fonts: ${validated.fonts.map((f) => `${f.family} ${f.style}`).join(', ') || '(none)'}`,
    '',
    ...lines
  ].join('\n')
}
