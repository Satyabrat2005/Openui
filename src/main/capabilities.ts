/**
 * capabilities.ts — product-surface switches, read at call time.
 *
 * WHY THE CODING SURFACE IS OFF. OpenUI is a cross-channel texting agent: read
 * four inboxes, summarise them, draft and send, remember across channels. The
 * coding surface — the sandbox builder, the autonomous coding loop, the GitHub
 * and Figma tools, `run_python` — grew alongside that and is a different
 * product with a different buyer. It is switched off so the shipped app is the
 * one thing it claims to be.
 *
 * IT DOES NOT MAKE THE PROMPT SMALLER, and it was worth measuring before
 * claiming otherwise. Per-turn tool grouping (#161) already means a messaging
 * turn never loaded the github or figma schemas in the first place, so the
 * saving on the requests this product is actually about is **zero**:
 *
 *   summarise my inbox                 25 → 25 schemas
 *   send a whatsapp to Ashu            20 → 20
 *   draft an email to …                19 → 19
 *   message the team on slack          26 → 26
 *   open a pull request                25 → 16   (the only real reduction)
 *   run a python script                17 → 20   (MORE — see below)
 *
 * So this is a product decision and nothing else: OpenUI is the one thing it
 * claims to be. Do not sell it internally as a quality win.
 *
 * THE ONE SURPRISE, recorded so nobody re-derives it: disabling a group can
 * *widen* the surface for requests that targeted it. With `python` unavailable
 * no trigger fires, selection falls back to FALLBACK_GROUPS, and that fallback
 * is broader than the single group would have been. Harmless here — three
 * schemas on an off-domain request — but it means "remove a group to save
 * tokens" is not a reliable move in this codebase.
 *
 * A FLAG, NOT A DELETION — on purpose. The coding paths are built, reviewed and
 * tested; deleting them would mean reviewing a very large removal across modules
 * the messaging paths also import, and the pilot has not yet proven nothing is
 * missed. `OPENUI_ENABLE_CODING=1` brings the whole surface back with no code
 * change, exactly as `OPENUI_ENABLE_CLOUD` does for the cloud tier (see
 * models.ts). Once a pilot confirms the cut, the dead modules can be removed in
 * their own change, where the diff can actually be reviewed.
 *
 * Read at call time rather than captured at module load, so a test can set the
 * variable per case and so the switch is honest about being an env flag.
 */

/**
 * Is the coding/builder surface reachable?
 *
 * Off unless `OPENUI_ENABLE_CODING=1`. When off:
 *   - the `github`, `figma` and `python` tool groups are never selected, and are
 *     not advertised in the "capabilities not loaded" index either — promising a
 *     capability the app then refuses is worse than not mentioning it;
 *   - the builder route in `handleChat` does not fire, so a "build me an app"
 *     request is answered by the normal assistant instead of silently starting a
 *     sandbox session;
 *   - `executeTool` refuses a coding tool by name, so a model that has seen one
 *     in its training data cannot reach it by guessing.
 *
 * The last of those three matters most: gating only the prompt would leave the
 * tools live for any turn where the model names one anyway.
 */
export function isCodingEnabled(): boolean {
  return process.env.OPENUI_ENABLE_CODING === '1'
}

/**
 * Tool groups that only exist to serve the coding surface.
 *
 * `github` and `figma` are developer/designer workflows; `python` is arbitrary
 * code execution, which has no place in a texting product. Deliberately NOT
 * listed here: `docs`, `slides`, `spreadsheet`, `drive`, `media`, `archive` and
 * `print` — those are things a person doing ordinary work asks for by message
 * ("summarise this and put it in a doc") and they are part of the product.
 */
export const CODING_TOOL_GROUPS = ['github', 'figma', 'python'] as const

/**
 * Individual tools that belong to the coding surface even though their group
 * does not, so `executeTool` can refuse them by name.
 *
 * Kept as an explicit list rather than derived from the groups above, because
 * the enforcement point needs to be readable on its own: a reviewer asking
 * "what can a signed-in user no longer run" should get the answer from one
 * place.
 */
export const CODING_TOOLS: readonly string[] = [
  'run_python',
  'design_preview'
]

/** True when `tool` is part of the switched-off coding surface. */
export function isCodingTool(tool: string): boolean {
  return CODING_TOOLS.includes(tool)
}

/**
 * What the user is told when a coding tool is reached anyway.
 *
 * Names the product boundary rather than pretending the tool is broken — an
 * error that reads like a bug invites a bug report, and invites the model to
 * retry. It also must not name a terminal or a shell command; see
 * terminalBoundary.test.ts.
 */
export const CODING_DISABLED_MESSAGE =
  'OpenUI is a messaging assistant — it works across WhatsApp, Telegram, Slack, Gmail and your calendar. It does not build software or run code.'
