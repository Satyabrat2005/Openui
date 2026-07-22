/**
 * figmaDesignSystem.ts — turn a Figma file into a real, shippable design system.
 *
 * This is the bridge from "a designer drew it" to "the website uses it". The
 * Figma REST API can't write to a file, but it CAN tell us, exactly, every
 * colour, type style, spacing step, radius and shadow a design actually uses.
 * That is enough to reconstruct the design system as code — CSS custom
 * properties, a Tailwind theme, SCSS, or W3C-style JSON tokens — with real
 * numbers rather than a model's guess from a screenshot.
 *
 * Two ideas make the output trustworthy:
 *
 *   1. FREQUENCY, NOT PRESENCE. A colour used once in a stray annotation is not
 *      part of the design system. Every extracted value carries a usage count,
 *      values are ranked by it, and long tails are trimmed. What survives is
 *      what the design actually leans on.
 *
 *   2. PUBLISHED NAMES WIN. If the designer named a style ("Brand/Primary"),
 *      that name is the token name — slugified, but never invented. Generated
 *      names (color-1, space-8) are the fallback for unnamed values only, so a
 *      well-maintained library round-trips with its own vocabulary intact.
 */

import type {
  FigmaColor,
  FigmaEffect,
  FigmaFileResponse,
  FigmaNode,
  FigmaPaint,
  FigmaStyleMeta,
  FigmaVariableValue,
  FigmaVariablesResponse
} from './figmaTypes'

// Caps. A large file can hold thousands of distinct values; past a point they
// are noise, and emitting them all would flood the agent's context.
const MAX_COLORS = 48
const MAX_TEXT_STYLES = 24
const MAX_SPACING = 16
const MAX_RADII = 12
const MAX_SHADOWS = 12
/** Depth guard — Figma files can nest deeply, and a cycle would hang the walk. */
const MAX_WALK_DEPTH = 24
/** Total nodes visited per extraction, so a huge file can't stall the agent. */
const MAX_WALK_NODES = 20_000

// ── value models ─────────────────────────────────────────────────────────────

export interface ColorToken {
  /** Uppercase hex, `#RRGGBB` or `#RRGGBBAA` when partially transparent. */
  hex: string
  /** 0..1 alpha, already folded into `hex` when < 1. Kept for JSON output. */
  alpha: number
  count: number
  /** Published Figma style name, when the fill referenced one. */
  styleName?: string
}

export interface TextToken {
  fontFamily: string
  fontSize: number
  fontWeight: number
  /** Pixels. 0 when Figma reported no explicit line height. */
  lineHeight: number
  letterSpacing: number
  count: number
  styleName?: string
}

export interface ScaleToken {
  value: number
  count: number
  /** Figma Variable name, when a variable defines this exact number. */
  name?: string
}

export interface ShadowToken {
  /** Ready-to-use CSS `box-shadow` value. */
  css: string
  count: number
  styleName?: string
}

export interface DesignSystem {
  fileName: string
  colors: ColorToken[]
  text: TextToken[]
  spacing: ScaleToken[]
  radii: ScaleToken[]
  shadows: ShadowToken[]
  /** Nodes visited — surfaced so a truncated walk is visible, not silent. */
  nodesScanned: number
  truncated: boolean
}

// ── colour helpers ───────────────────────────────────────────────────────────

/** Clamp a 0..1 float channel to a 0..255 byte. */
function channel(v: number): number {
  if (!Number.isFinite(v)) return 0
  return Math.max(0, Math.min(255, Math.round(v * 255)))
}

function hex2(v: number): string {
  return v.toString(16).padStart(2, '0').toUpperCase()
}

/**
 * Convert a Figma colour (0..1 floats) to hex. Alpha is folded in as an 8-digit
 * hex only when it is meaningfully below 1 — an `#RRGGBBFF` suffix on every
 * opaque colour would be noise in the emitted CSS.
 */
export function figmaColorToHex(color: FigmaColor | undefined, opacity = 1): string {
  if (!color) return '#000000'
  const a = (typeof color.a === 'number' ? color.a : 1) * (Number.isFinite(opacity) ? opacity : 1)
  const base = `#${hex2(channel(color.r))}${hex2(channel(color.g))}${hex2(channel(color.b))}`
  if (a >= 0.999) return base
  return `${base}${hex2(channel(a))}`
}

/**
 * Relative luminance per WCAG 2.x. Used to order the palette light→dark, which
 * reads far better in generated CSS than frequency order does.
 */
export function relativeLuminance(hex: string): number {
  const m = /^#([0-9A-F]{2})([0-9A-F]{2})([0-9A-F]{2})/i.exec(hex)
  if (!m) return 0
  const toLinear = (h: string): number => {
    const c = parseInt(h, 16) / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * toLinear(m[1]) + 0.7152 * toLinear(m[2]) + 0.0722 * toLinear(m[3])
}

/**
 * WCAG contrast ratio between two hex colours (1..21). Alpha is ignored — a
 * translucent colour's real contrast depends on what is behind it, which the
 * REST API does not tell us, so reporting a composited number would be a lie.
 */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const lighter = Math.max(la, lb)
  const darker = Math.min(la, lb)
  return (lighter + 0.05) / (darker + 0.05)
}

// ── name helpers ─────────────────────────────────────────────────────────────

/**
 * Turn a Figma style name into a CSS-safe token slug: "Brand/Primary 500" →
 * "brand-primary-500". Figma's "/" is a folder separator in the styles panel,
 * so it becomes a hyphen rather than being dropped.
 */
export function slugifyStyleName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[/\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * Assign a unique token name to every entry. Published style names are used
 * verbatim (slugified); anything unnamed falls back to `${prefix}-${n}`. A
 * trailing counter breaks ties so two styles that slugify identically cannot
 * silently collapse into one CSS variable.
 */
function assignNames<T extends { styleName?: string }>(
  items: T[],
  prefix: string
): { item: T; name: string }[] {
  const used = new Set<string>()
  let auto = 0

  return items.map((item) => {
    let base = item.styleName ? slugifyStyleName(item.styleName) : ''
    if (!base) {
      auto += 1
      base = `${prefix}-${auto}`
    }
    let name = base
    let dup = 2
    while (used.has(name)) {
      name = `${base}-${dup}`
      dup += 1
    }
    used.add(name)
    return { item, name }
  })
}

// ── Figma Variables ──────────────────────────────────────────────────────────
//
// Variables are the modern replacement for Styles, and they are a DIFFERENT
// system reached through a different endpoint. A file that defines its design
// system in Variables has an empty `styles` map, so name resolution that only
// consults Styles reports frequency-ranked raw values — #1A1A2E [42] — instead
// of the designer's actual vocabulary (`--surface-raised`). Indexing variables
// by their resolved VALUE lets the walk below attach those real names.
//
// Value-matching is the right join here because the document walk sees resolved
// values, and it is what makes a name available for every use of that value,
// not just uses the file happens to have bound explicitly.

/** Resolved Figma Variables, keyed by the value they produce. */
export interface VariableIndex {
  /** Uppercase hex → token name. */
  colors: Map<string, string>
  /** Rounded number → token name (spacing, radii). */
  numbers: Map<number, string>
}

export function emptyVariableIndex(): VariableIndex {
  return { colors: new Map(), numbers: new Map() }
}

function isAlias(
  v: FigmaVariableValue | undefined
): v is { type?: 'VARIABLE_ALIAS'; id?: string } {
  return typeof v === 'object' && v !== null && 'id' in v && !('r' in v)
}

/**
 * Turn a /variables/local response into a value→name index.
 *
 * Details that matter:
 *   - ALIASES are followed (a semantic variable like `surface/raised` usually
 *     points at a primitive like `grey/900`), with a hop cap so a cycle in the
 *     file cannot hang the extraction.
 *   - EVERY MODE is indexed, not just the default, so a file's dark-mode values
 *     resolve to names too. The default mode is indexed first and never
 *     overwritten, so it wins any collision.
 *   - NAMES stay the designer's own. Figma's "/" folder separator survives into
 *     the slug ("brand/primary" → "brand-primary"). The collection name is only
 *     prefixed when two collections define the same variable name, since
 *     prefixing everything would bury the useful part.
 */
export function buildVariableIndex(response: FigmaVariablesResponse | null | undefined): VariableIndex {
  const index = emptyVariableIndex()
  const variables = response?.meta?.variables
  if (!variables) return index

  const collections = response?.meta?.variableCollections ?? {}

  // Detect names that appear in more than one collection; only those get a
  // collection prefix, so the common case stays terse.
  const nameCounts = new Map<string, number>()
  for (const v of Object.values(variables)) {
    if (typeof v?.name === 'string' && v.name.trim()) {
      nameCounts.set(v.name, (nameCounts.get(v.name) ?? 0) + 1)
    }
  }

  const displayName = (variableId: string): string | undefined => {
    const v = variables[variableId]
    if (!v || typeof v.name !== 'string' || !v.name.trim()) return undefined
    if ((nameCounts.get(v.name) ?? 0) <= 1) return v.name
    const collection = v.variableCollectionId ? collections[v.variableCollectionId]?.name : undefined
    return collection ? `${collection}/${v.name}` : v.name
  }

  /** Follow aliases to a literal value. Bounded, so a cycle can't hang us. */
  const resolve = (value: FigmaVariableValue | undefined, hops = 0): FigmaVariableValue | undefined => {
    if (hops > 8 || value === undefined) return undefined
    if (isAlias(value)) {
      const target = value.id ? variables[value.id] : undefined
      if (!target) return undefined
      const collection = target.variableCollectionId
        ? collections[target.variableCollectionId]
        : undefined
      const modeId = collection?.defaultModeId
      const next =
        (modeId ? target.valuesByMode?.[modeId] : undefined) ??
        Object.values(target.valuesByMode ?? {})[0]
      return resolve(next, hops + 1)
    }
    return value
  }

  const record = (variableId: string, value: FigmaVariableValue | undefined): void => {
    const resolved = resolve(value)
    if (resolved === undefined) return
    const name = displayName(variableId)
    if (!name) return

    if (typeof resolved === 'object' && resolved !== null && 'r' in resolved) {
      const hex = figmaColorToHex(resolved as FigmaColor)
      if (!index.colors.has(hex)) index.colors.set(hex, name)
      return
    }
    if (typeof resolved === 'number' && Number.isFinite(resolved)) {
      const rounded = Math.round(resolved)
      if (rounded > 0 && !index.numbers.has(rounded)) index.numbers.set(rounded, name)
    }
  }

  // Pass 1: default modes only, so they win any value collision.
  for (const [id, v] of Object.entries(variables)) {
    const collection = v?.variableCollectionId ? collections[v.variableCollectionId] : undefined
    const modeId = collection?.defaultModeId
    if (modeId && v?.valuesByMode && modeId in v.valuesByMode) record(id, v.valuesByMode[modeId])
  }
  // Pass 2: every remaining mode (dark, compact, …).
  for (const [id, v] of Object.entries(variables)) {
    for (const value of Object.values(v?.valuesByMode ?? {})) record(id, value)
  }

  return index
}

/**
 * The ScaleToken equivalent of assignNames. A spacing/radius step named by a
 * Figma Variable emits under that name (`--spacing-md`); an unnamed one keeps
 * the value-derived fallback (`--space-16`), which stays self-describing in a
 * way a bare counter would not. `fallback` is per-format because each emitter
 * spells the unnamed case differently (`space-16`, `16`, `s16`).
 */
function namedScale(
  items: ScaleToken[],
  fallback: (item: ScaleToken) => string
): { item: ScaleToken; name: string }[] {
  const used = new Set<string>()
  return items.map((item) => {
    const base = (item.name ? slugifyStyleName(item.name) : '') || fallback(item)
    let name = base
    let dup = 2
    while (used.has(name)) {
      name = `${base}-${dup}`
      dup += 1
    }
    used.add(name)
    return { item, name }
  })
}

// ── extraction ───────────────────────────────────────────────────────────────

/** Accumulator keyed by a canonical string, tracking count + best-known name. */
interface Bucket<T> {
  value: T
  count: number
  styleName?: string
}

function bump<T>(map: Map<string, Bucket<T>>, key: string, value: T, styleName?: string): void {
  const existing = map.get(key)
  if (existing) {
    existing.count += 1
    // First published name wins — later unnamed uses must not erase it.
    if (!existing.styleName && styleName) existing.styleName = styleName
    return
  }
  map.set(key, { value, count: 1, styleName })
}

function isVisiblePaint(p: FigmaPaint): boolean {
  return p.visible !== false && (p.type === 'SOLID' || typeof p.color === 'object')
}

/** Render a Figma effect as a CSS box-shadow, or null if it isn't one. */
export function effectToCss(effect: FigmaEffect): string | null {
  if (effect.visible === false) return null
  if (effect.type !== 'DROP_SHADOW' && effect.type !== 'INNER_SHADOW') return null
  const x = Math.round(effect.offset?.x ?? 0)
  const y = Math.round(effect.offset?.y ?? 0)
  const blur = Math.round(effect.radius ?? 0)
  const spread = Math.round(effect.spread ?? 0)
  const color = figmaColorToHex(effect.color as FigmaColor | undefined)
  const inset = effect.type === 'INNER_SHADOW' ? 'inset ' : ''
  return `${inset}${x}px ${y}px ${blur}px ${spread}px ${color}`
}

/**
 * Walk the document and tally every design value it uses.
 *
 * `styleMeta` maps published style ids → their metadata, so a node that
 * references a style contributes that style's NAME to the token, not just its
 * resolved value. That is what lets a well-named Figma library export as
 * `--brand-primary` instead of `--color-3`. It defaults to the file's own
 * `styles` map — passing it separately is only useful when merging in styles
 * fetched from a different file, and defaulting it means a caller who omits it
 * can't silently lose every published name.
 *
 * `variables` is the same idea for Figma Variables (see buildVariableIndex).
 * Name priority is: published Style name → Variable name → generated fallback.
 * A Style reference is exact per-node linkage the file states outright, whereas
 * a Variable match is by value, so the Style is the stronger claim when a value
 * somehow has both. Either way a real, designer-authored name beats `color-3`.
 */
export function extractDesignSystem(
  file: FigmaFileResponse,
  styleMeta: Record<string, FigmaStyleMeta> = file.styles ?? {},
  variables?: VariableIndex
): DesignSystem {
  const colors = new Map<string, Bucket<{ hex: string; alpha: number }>>()
  const texts = new Map<string, Bucket<Omit<TextToken, 'count' | 'styleName'>>>()
  const spacing = new Map<string, Bucket<number>>()
  const radii = new Map<string, Bucket<number>>()
  const shadows = new Map<string, Bucket<string>>()

  let nodesScanned = 0
  let truncated = false

  const nameOf = (id: string | undefined): string | undefined => {
    if (!id) return undefined
    const meta = styleMeta[id]
    return typeof meta?.name === 'string' && meta.name.trim() ? meta.name : undefined
  }

  const visit = (node: FigmaNode, depth: number): void => {
    if (nodesScanned >= MAX_WALK_NODES) {
      truncated = true
      return
    }
    if (depth > MAX_WALK_DEPTH) {
      truncated = true
      return
    }
    // Hidden layers are scaffolding, not design — counting them would inflate
    // the palette with values the rendered design never shows.
    if (node.visible === false) return

    nodesScanned += 1

    const fillStyle = nameOf(node.styles?.fill)
    const strokeStyle = nameOf(node.styles?.stroke)
    const textStyle = nameOf(node.styles?.text)
    const effectStyle = nameOf(node.styles?.effect)

    for (const paint of node.fills ?? []) {
      if (!isVisiblePaint(paint)) continue
      const hex = figmaColorToHex(paint.color as FigmaColor | undefined, paint.opacity ?? 1)
      const alpha = (paint.color?.a ?? 1) * (paint.opacity ?? 1)
      bump(colors, hex, { hex, alpha }, fillStyle)
    }

    for (const paint of node.strokes ?? []) {
      if (!isVisiblePaint(paint)) continue
      const hex = figmaColorToHex(paint.color as FigmaColor | undefined, paint.opacity ?? 1)
      const alpha = (paint.color?.a ?? 1) * (paint.opacity ?? 1)
      bump(colors, hex, { hex, alpha }, strokeStyle)
    }

    if (node.type === 'TEXT' && node.style) {
      const s = node.style
      const token = {
        fontFamily: s.fontFamily ?? 'Unknown',
        fontSize: Math.round((s.fontSize ?? 0) * 100) / 100,
        fontWeight: s.fontWeight ?? 400,
        lineHeight: Math.round((s.lineHeightPx ?? 0) * 100) / 100,
        letterSpacing: Math.round((s.letterSpacing ?? 0) * 100) / 100
      }
      if (token.fontSize > 0) {
        const key = `${token.fontFamily}|${token.fontSize}|${token.fontWeight}|${token.lineHeight}|${token.letterSpacing}`
        bump(texts, key, token, textStyle)
      }
    }

    // Auto-layout gaps and padding ARE the spacing scale — they're the numbers
    // the designer typed, as opposed to distances we'd have to infer from
    // absolute coordinates (which mix in layout drift and are not reusable).
    if (node.layoutMode && node.layoutMode !== 'NONE') {
      for (const v of [
        node.itemSpacing,
        node.paddingLeft,
        node.paddingRight,
        node.paddingTop,
        node.paddingBottom
      ]) {
        if (typeof v === 'number' && v > 0 && Number.isFinite(v)) {
          const r = Math.round(v)
          bump(spacing, String(r), r)
        }
      }
    }

    if (typeof node.cornerRadius === 'number' && node.cornerRadius > 0) {
      const r = Math.round(node.cornerRadius)
      bump(radii, String(r), r)
    }
    for (const r of node.rectangleCornerRadii ?? []) {
      if (typeof r === 'number' && r > 0) {
        const rr = Math.round(r)
        bump(radii, String(rr), rr)
      }
    }

    for (const effect of node.effects ?? []) {
      const css = effectToCss(effect)
      if (css) bump(shadows, css, css, effectStyle)
    }

    for (const child of node.children ?? []) visit(child, depth + 1)
  }

  if (file.document) visit(file.document, 0)

  const colorTokens: ColorToken[] = [...colors.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_COLORS)
    .map((b) => ({
      hex: b.value.hex,
      alpha: b.value.alpha,
      count: b.count,
      // Style name → Variable name → (later) generated fallback.
      styleName: b.styleName ?? variables?.colors.get(b.value.hex)
    }))
    // Frequency decides WHICH colours make the cut; luminance decides the order
    // they're written in, because a palette reads as a ramp, not a histogram.
    .sort((a, b) => relativeLuminance(b.hex) - relativeLuminance(a.hex))

  const textTokens: TextToken[] = [...texts.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_TEXT_STYLES)
    .map((b) => ({ ...b.value, count: b.count, styleName: b.styleName }))
    .sort((a, b) => b.fontSize - a.fontSize)

  const scale = (m: Map<string, Bucket<number>>, cap: number): ScaleToken[] =>
    [...m.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, cap)
      .map((b) => ({ value: b.value, count: b.count, name: variables?.numbers.get(b.value) }))
      .sort((a, b) => a.value - b.value)

  const shadowTokens: ShadowToken[] = [...shadows.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_SHADOWS)
    .map((b) => ({ css: b.value, count: b.count, styleName: b.styleName }))

  return {
    fileName: typeof file.name === 'string' ? file.name : '(unnamed)',
    colors: colorTokens,
    text: textTokens,
    spacing: scale(spacing, MAX_SPACING),
    radii: scale(radii, MAX_RADII),
    shadows: shadowTokens,
    nodesScanned,
    truncated
  }
}

// ── emitters ─────────────────────────────────────────────────────────────────

export type TokenFormat = 'css' | 'scss' | 'json' | 'tailwind' | 'ts'

function header(ds: DesignSystem, comment: '/*' | '//'): string {
  const line =
    comment === '/*'
      ? (t: string): string => `/* ${t} */`
      : (t: string): string => `// ${t}`
  return [
    line(`Design tokens extracted from Figma file "${ds.fileName}".`),
    line(`${ds.nodesScanned} nodes scanned. Generated by OpenUI — do not edit by hand;`),
    line(`re-run export_figma_tokens to refresh after the design changes.`)
  ].join('\n')
}

/** Name colours/text/shadows once, so every format agrees on the token names. */
function namedTokens(ds: DesignSystem): {
  colors: { item: ColorToken; name: string }[]
  text: { item: TextToken; name: string }[]
  shadows: { item: ShadowToken; name: string }[]
} {
  return {
    colors: assignNames(ds.colors, 'color'),
    text: assignNames(ds.text, 'text'),
    shadows: assignNames(ds.shadows, 'shadow')
  }
}

function emitCss(ds: DesignSystem): string {
  const { colors, text, shadows } = namedTokens(ds)
  const out: string[] = [header(ds, '/*'), '', ':root {']

  out.push('  /* colour */')
  for (const { item, name } of colors) {
    out.push(`  --${name}: ${item.hex}; /* ${item.count}× */`)
  }

  if (ds.spacing.length) {
    out.push('', '  /* spacing */')
    for (const { item, name } of namedScale(ds.spacing, (s) => `space-${s.value}`)) {
      out.push(`  --${name}: ${item.value}px;`)
    }
  }

  if (ds.radii.length) {
    out.push('', '  /* radius */')
    for (const { item, name } of namedScale(ds.radii, (r) => `radius-${r.value}`)) {
      out.push(`  --${name}: ${item.value}px;`)
    }
  }

  if (text.length) {
    out.push('', '  /* typography */')
    for (const { item, name } of text) {
      out.push(`  --${name}-size: ${item.fontSize}px;`)
      out.push(`  --${name}-weight: ${item.fontWeight};`)
      if (item.lineHeight > 0) out.push(`  --${name}-line-height: ${item.lineHeight}px;`)
    }
  }

  if (shadows.length) {
    out.push('', '  /* elevation */')
    for (const { item, name } of shadows) out.push(`  --${name}: ${item.css};`)
  }

  out.push('}')

  if (text.length) {
    out.push('', '/* Ready-to-use type classes. */')
    for (const { item, name } of text) {
      out.push(`.${name} {`)
      out.push(`  font-family: ${JSON.stringify(item.fontFamily)}, sans-serif;`)
      out.push(`  font-size: var(--${name}-size);`)
      out.push(`  font-weight: var(--${name}-weight);`)
      if (item.lineHeight > 0) out.push(`  line-height: var(--${name}-line-height);`)
      if (item.letterSpacing) out.push(`  letter-spacing: ${item.letterSpacing}px;`)
      out.push('}')
    }
  }

  return out.join('\n') + '\n'
}

function emitScss(ds: DesignSystem): string {
  const { colors, text, shadows } = namedTokens(ds)
  const out: string[] = [header(ds, '//'), '']

  out.push('// colour')
  for (const { item, name } of colors) out.push(`$${name}: ${item.hex}; // ${item.count}×`)

  if (ds.spacing.length) {
    out.push('', '// spacing')
    const entries = namedScale(ds.spacing, (s) => String(s.value))
    out.push(`$spacing: (${entries.map(({ item, name }) => `${name}: ${item.value}px`).join(', ')});`)
  }
  if (ds.radii.length) {
    out.push('', '// radius')
    const entries = namedScale(ds.radii, (r) => String(r.value))
    out.push(`$radii: (${entries.map(({ item, name }) => `${name}: ${item.value}px`).join(', ')});`)
  }
  if (text.length) {
    out.push('', '// typography')
    for (const { item, name } of text) {
      out.push(
        `$${name}: (family: ${JSON.stringify(item.fontFamily)}, size: ${item.fontSize}px, ` +
          `weight: ${item.fontWeight}, line-height: ${item.lineHeight || 'normal'});`
      )
    }
  }
  if (shadows.length) {
    out.push('', '// elevation')
    for (const { item, name } of shadows) out.push(`$${name}: ${item.css};`)
  }

  return out.join('\n') + '\n'
}

function emitJson(ds: DesignSystem): string {
  const { colors, text, shadows } = namedTokens(ds)
  // Shaped after the W3C Design Tokens draft ($value / $type), which is what
  // Style Dictionary and friends consume.
  const doc = {
    $description: `Design tokens extracted from Figma file "${ds.fileName}" by OpenUI.`,
    color: Object.fromEntries(
      colors.map(({ item, name }) => [
        name,
        { $value: item.hex, $type: 'color', $extensions: { 'com.openui.usageCount': item.count } }
      ])
    ),
    spacing: Object.fromEntries(
      namedScale(ds.spacing, (s) => String(s.value)).map(({ item, name }) => [
        name,
        { $value: `${item.value}px`, $type: 'dimension' }
      ])
    ),
    radius: Object.fromEntries(
      namedScale(ds.radii, (r) => String(r.value)).map(({ item, name }) => [
        name,
        { $value: `${item.value}px`, $type: 'dimension' }
      ])
    ),
    typography: Object.fromEntries(
      text.map(({ item, name }) => [
        name,
        {
          $type: 'typography',
          $value: {
            fontFamily: item.fontFamily,
            fontSize: `${item.fontSize}px`,
            fontWeight: item.fontWeight,
            ...(item.lineHeight > 0 ? { lineHeight: `${item.lineHeight}px` } : {}),
            ...(item.letterSpacing ? { letterSpacing: `${item.letterSpacing}px` } : {})
          }
        }
      ])
    ),
    shadow: Object.fromEntries(
      shadows.map(({ item, name }) => [name, { $value: item.css, $type: 'shadow' }])
    )
  }
  return JSON.stringify(doc, null, 2) + '\n'
}

function emitTailwind(ds: DesignSystem): string {
  const { colors, text, shadows } = namedTokens(ds)
  const obj = {
    colors: Object.fromEntries(colors.map(({ item, name }) => [name, item.hex])),
    spacing: Object.fromEntries(
      namedScale(ds.spacing, (s) => String(s.value)).map(({ item, name }) => [name, `${item.value}px`])
    ),
    borderRadius: Object.fromEntries(
      namedScale(ds.radii, (r) => String(r.value)).map(({ item, name }) => [name, `${item.value}px`])
    ),
    fontSize: Object.fromEntries(
      text.map(({ item, name }) => [
        name,
        item.lineHeight > 0
          ? [`${item.fontSize}px`, { lineHeight: `${item.lineHeight}px` }]
          : `${item.fontSize}px`
      ])
    ),
    fontFamily: Object.fromEntries(
      [...new Set(text.map((t) => t.item.fontFamily))].map((f) => [slugifyStyleName(f) || 'sans', [f, 'sans-serif']])
    ),
    boxShadow: Object.fromEntries(shadows.map(({ item, name }) => [name, item.css]))
  }
  return (
    header(ds, '//') +
    '\n\n/** @type {import("tailwindcss").Config} */\n' +
    'module.exports = {\n  theme: {\n    extend: ' +
    JSON.stringify(obj, null, 2)
      .split('\n')
      .join('\n    ') +
    '\n  }\n}\n'
  )
}

function emitTs(ds: DesignSystem): string {
  const { colors, text, shadows } = namedTokens(ds)
  const obj = {
    colors: Object.fromEntries(colors.map(({ item, name }) => [name, item.hex])),
    spacing: Object.fromEntries(
      namedScale(ds.spacing, (s) => `s${s.value}`).map(({ item, name }) => [name, item.value])
    ),
    radii: Object.fromEntries(
      namedScale(ds.radii, (r) => `r${r.value}`).map(({ item, name }) => [name, item.value])
    ),
    typography: Object.fromEntries(
      text.map(({ item, name }) => [
        name,
        {
          fontFamily: item.fontFamily,
          fontSize: item.fontSize,
          fontWeight: item.fontWeight,
          ...(item.lineHeight > 0 ? { lineHeight: item.lineHeight } : {})
        }
      ])
    ),
    shadows: Object.fromEntries(shadows.map(({ item, name }) => [name, item.css]))
  }
  return (
    header(ds, '//') +
    '\n\nexport const tokens = ' +
    JSON.stringify(obj, null, 2) +
    ' as const\n\nexport type Tokens = typeof tokens\n'
  )
}

/** Render an extracted design system in the requested format. */
export function emitTokens(ds: DesignSystem, format: TokenFormat): string {
  switch (format) {
    case 'scss':
      return emitScss(ds)
    case 'json':
      return emitJson(ds)
    case 'tailwind':
      return emitTailwind(ds)
    case 'ts':
      return emitTs(ds)
    case 'css':
    default:
      return emitCss(ds)
  }
}

/** File extension each format should be written with. */
export const FORMAT_EXTENSION: Record<TokenFormat, string> = {
  css: 'css',
  scss: 'scss',
  json: 'json',
  tailwind: 'js',
  ts: 'ts'
}

// ── human-readable summary ───────────────────────────────────────────────────

/**
 * A compact report for the agent to reason over (and to show the user), as
 * opposed to the machine-consumable token file. Includes a contrast audit of
 * the darkest and lightest palette entries, which is the single most common
 * real accessibility defect in a design system.
 */
/** `16px`, or `md (16px)` when a Figma Variable names the step. */
function scaleLabel(t: ScaleToken): string {
  return t.name ? `${t.name} (${t.value}px)` : `${t.value}px`
}

export function summarizeDesignSystem(ds: DesignSystem): string {
  const out: string[] = [
    `Design system — "${ds.fileName}"`,
    `Scanned ${ds.nodesScanned.toLocaleString()} nodes${ds.truncated ? ' (truncated — file is very large)' : ''}.`,
    ''
  ]

  out.push(`COLOURS (${ds.colors.length}, light → dark, usage count in brackets):`)
  for (const c of ds.colors) {
    out.push(`  ${c.hex}${c.styleName ? `  "${c.styleName}"` : ''}  [${c.count}]`)
  }

  if (ds.colors.length >= 2) {
    const lightest = ds.colors[0]
    const darkest = ds.colors[ds.colors.length - 1]
    const ratio = contrastRatio(lightest.hex, darkest.hex)
    out.push(
      '',
      `Contrast, lightest (${lightest.hex}) on darkest (${darkest.hex}): ${ratio.toFixed(2)}:1 — ` +
        `${ratio >= 7 ? 'passes AAA' : ratio >= 4.5 ? 'passes AA' : ratio >= 3 ? 'large text only' : 'FAILS WCAG AA'}.`
    )
  }

  out.push('', `TYPOGRAPHY (${ds.text.length}, largest first):`)
  for (const t of ds.text) {
    out.push(
      `  ${t.fontSize}px / ${t.fontWeight}${t.lineHeight ? ` / lh ${t.lineHeight}px` : ''} ` +
        `${t.fontFamily}${t.styleName ? `  "${t.styleName}"` : ''}  [${t.count}]`
    )
  }

  out.push(
    '',
    // A named step reads as `md (16px)` so the agent can reuse the designer's
    // vocabulary rather than hard-coding the number.
    `SPACING SCALE: ${ds.spacing.map(scaleLabel).join(', ') || '(none — no auto-layout frames)'}`,
    `RADII: ${ds.radii.map(scaleLabel).join(', ') || '(none)'}`,
    `SHADOWS: ${ds.shadows.length}`
  )
  for (const s of ds.shadows) out.push(`  ${s.css}  [${s.count}]`)

  return out.join('\n')
}
