/**
 * figmaTypes.ts — a typed, minimal view of the Figma REST API's node model.
 *
 * The Figma document is a deeply polymorphic scene graph: every node type
 * carries a different subset of ~80 possible properties. Modelling all of it
 * would be a maintenance burden for no gain, so this file declares ONLY the
 * fields the OpenUI design tools actually read, all optional, on one permissive
 * `FigmaNode`. That buys real type-safety at the call sites (no `any` leaking
 * into the extractors) while staying tolerant of the API adding fields.
 *
 * Everything here is READ-shaped. The Figma REST API cannot create or mutate
 * file content — see the "WRITE ACCESS" note at the top of figma.ts.
 */

/** Figma colour channels are 0..1 floats, NOT 0..255 bytes. */
export interface FigmaColor {
  r: number
  g: number
  b: number
  a?: number
}

/** A fill or stroke. Solid paints carry `color`; gradients carry stops. */
export interface FigmaPaint {
  type?: string
  visible?: boolean
  opacity?: number
  color?: FigmaColor
  gradientStops?: { color?: FigmaColor; position?: number }[]
}

/** Text styling, present on TEXT nodes as `style`. */
export interface FigmaTypeStyle {
  fontFamily?: string
  fontPostScriptName?: string
  fontWeight?: number
  fontSize?: number
  lineHeightPx?: number
  lineHeightPercent?: number
  letterSpacing?: number
  textAlignHorizontal?: string
  textAlignVertical?: string
  textCase?: string
  textDecoration?: string
}

/** Shadows and blurs. */
export interface FigmaEffect {
  type?: string
  visible?: boolean
  radius?: number
  color?: FigmaColor
  offset?: { x?: number; y?: number }
  spread?: number
}

/** Axis-aligned bounds in absolute canvas coordinates. */
export interface FigmaBoundingBox {
  x?: number
  y?: number
  width?: number
  height?: number
}

/**
 * A node in the Figma scene graph. Every field is optional because which ones
 * exist depends entirely on `type` (FRAME, TEXT, RECTANGLE, INSTANCE, …).
 */
export interface FigmaNode {
  id?: string
  name?: string
  type?: string
  visible?: boolean
  opacity?: number
  children?: FigmaNode[]

  absoluteBoundingBox?: FigmaBoundingBox | null

  fills?: FigmaPaint[]
  strokes?: FigmaPaint[]
  strokeWeight?: number
  strokeAlign?: string

  cornerRadius?: number
  /** Per-corner radii [topLeft, topRight, bottomRight, bottomLeft]. */
  rectangleCornerRadii?: number[]

  effects?: FigmaEffect[]

  /** TEXT nodes only. */
  characters?: string
  style?: FigmaTypeStyle

  /** Auto-layout (Figma's flexbox). NONE means absolute positioning. */
  layoutMode?: string
  /** NO_WRAP | WRAP — WRAP is the auto-layout equivalent of `flex-wrap: wrap`. */
  layoutWrap?: string
  /**
   * AUTO | ABSOLUTE — set on a CHILD, not the auto-layout parent. ABSOLUTE
   * takes the child out of the layout flow (badges, overlays, notches) while
   * leaving it parented to the frame.
   */
  layoutPositioning?: string
  itemSpacing?: number
  /** Cross-axis gap, used only when layoutWrap is WRAP. */
  counterAxisSpacing?: number
  paddingLeft?: number
  paddingRight?: number
  paddingTop?: number
  paddingBottom?: number
  primaryAxisAlignItems?: string
  counterAxisAlignItems?: string
  primaryAxisSizingMode?: string
  counterAxisSizingMode?: string
  layoutGrow?: number
  layoutAlign?: string

  /** Maps a property ("fill", "text", "effect", "stroke") → published style id. */
  styles?: Record<string, string>

  /** INSTANCE nodes point at the COMPONENT they were spawned from. */
  componentId?: string

  clipsContent?: boolean
}

/** Top-level shape of GET /v1/files/{key}. */
export interface FigmaFileResponse {
  name?: string
  lastModified?: string
  version?: string
  editorType?: string
  document?: FigmaNode
  components?: Record<string, FigmaComponentMeta>
  componentSets?: Record<string, FigmaComponentMeta>
  styles?: Record<string, FigmaStyleMeta>
}

export interface FigmaComponentMeta {
  key?: string
  name?: string
  description?: string
  componentSetId?: string
  documentationLinks?: { uri?: string }[]
}

export interface FigmaStyleMeta {
  key?: string
  name?: string
  description?: string
  /** FILL | TEXT | EFFECT | GRID */
  styleType?: string
}

/** Shape of GET /v1/files/{key}/nodes?ids=… */
export interface FigmaNodesResponse {
  name?: string
  nodes?: Record<string, { document?: FigmaNode } | undefined>
}

/** Shape of GET /v1/images/{key}?ids=… */
export interface FigmaImagesResponse {
  err?: string | null
  images?: Record<string, string | null>
}

/** Shape of GET /v1/files/{key}/comments */
export interface FigmaCommentsResponse {
  comments?: {
    id?: string
    message?: string
    created_at?: string
    resolved_at?: string | null
    user?: { handle?: string }
    client_meta?: { node_id?: string } | null
    parent_id?: string
  }[]
}

/**
 * Shape of GET /v1/files/{key}/variables/local.
 *
 * Figma Variables are a SEPARATE system from the legacy Styles that appear in
 * `FigmaFileResponse.styles` — a modern file commonly defines its whole design
 * system in Variables, in which case its `styles` map is empty and every token
 * name lives here instead.
 *
 * NOTE: this endpoint is gated. It needs a token with the `file_variables:read`
 * scope AND a file on an Enterprise-plan org; anything else returns 403. Callers
 * must treat "no variables" as normal rather than an error.
 */
export interface FigmaVariablesResponse {
  status?: number
  error?: boolean
  meta?: {
    variables?: Record<string, FigmaVariable>
    variableCollections?: Record<string, FigmaVariableCollection>
  }
}

/** A variable value: a literal, or an alias pointing at another variable. */
export type FigmaVariableValue =
  | number
  | string
  | boolean
  | FigmaColor
  | { type?: 'VARIABLE_ALIAS'; id?: string }

export interface FigmaVariable {
  id?: string
  name?: string
  variableCollectionId?: string
  /** COLOR | FLOAT | STRING | BOOLEAN */
  resolvedType?: string
  /** Mode id → the value in that mode (light/dark, compact/comfortable, …). */
  valuesByMode?: Record<string, FigmaVariableValue>
  description?: string
  remote?: boolean
}

export interface FigmaVariableCollection {
  id?: string
  name?: string
  defaultModeId?: string
  modes?: { modeId?: string; name?: string }[]
}

/** Shape of GET /v1/files/{key}/versions */
export interface FigmaVersionsResponse {
  versions?: {
    id?: string
    created_at?: string
    label?: string | null
    description?: string | null
    user?: { handle?: string }
  }[]
}
