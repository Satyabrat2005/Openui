# Run Console — Verification & Gap-Closure Report

_2026-08-03. Scope: verify the Run Console redesign end-to-end, close the one real test gap, and report on the three design decisions the original prompt required a stop on. Baseline after this pass: full vitest suite **1376 passing / 1 skipped / 0 failing** (81 files, +10 new RunConsole component tests). New testing infra added: `jsdom` + `@testing-library/react` (first renderer component tests in the repo)._

## Summary

| Area | Verdict |
|------|---------|
| Confirmed-real items (5) | **VERIFIED** — all present as described |
| Step 1 — RunConsole test gap | **CLOSED** — 10 real component tests (render + click), all green |
| Step 2a — light/dark tokens | **PASS** — light has real derived values; RunConsole surfaces flip (proven by computed styles in a real browser) |
| Step 2b — `waiting` queue derivation | **PASS** — event-driven; cleared on next activity, does not stick after a resolved approval |
| Step 2c — font self-hosting | **PASS** — 7 IBM Plex `.woff2` vendored; zero CDN references |
| Step 3 — pixel/token accuracy (6 sampled) | **PASS** — every sampled value landed exactly, no approximation |

No substantive design defects found. Nothing in Steps 2–3 required a change, so none was made (per the "report before changing theme/token decisions" instruction).

## Confirmed-real items (re-verified, untouched)
- `RunConsole.tsx` (640 lines) imported + rendered in `App.tsx`; not dead code.
- `RunQueue = 'active'|'waiting'|'done'` exists (`env.d.ts:303`); `'scheduled'` is intentionally not a live TaskCard state (scheduled = saved workflows, sidebar count only).
- `TaskTouchedPayload`/`TouchedResource` with operation enum `READ|WRITE|DRAFT|POST|HELD` (`env.d.ts:254`) — exact spec.
- Approval callout calls the real `onRespondHitl`/`onRespondPlan` props (`RunConsole.tsx:209-218`), not a second pipeline.
- `ConversationList.tsx` still coexists (rendered in the history drawer, `RunConsole.tsx:439`) — conversation+run models coexist.

## Step 1 — Test gap CLOSED
`RunConsole.tsx` had **zero** tests (its pure derivations in `lib/runQueue.ts` were tested; the component glue was not). Added `src/renderer/src/components/RunConsole.test.tsx` — 10 tests exercising real component behaviour, not render-without-crash:
- **Queue bucketing** (3): the `Needs you` / `Running` / `Finished` ledger filters bucket runs correctly — notably a `waiting` run (in_progress but paused on approval) is excluded from `Running` and only appears under `Needs you`.
- **Approval callout** (5): PLAN request renders "Approve the plan" with the pluralised step count and `Approve` fires `onRespondPlan(true)`; HITL request renders "Approve this action" from the request label and `Deny` fires `onRespondHitl(false)`; plan takes precedence over a simultaneous HITL; no callout when a request exists but no run is `waiting`.
- **TOUCHED list** (2): renders one row per `TouchedResource` with the verbatim operation label; shows the "Nothing touched yet." empty state otherwise.

## Step 2 — The three decisions

### (a) Light/dark token handling — PASS
`:root[data-theme='light']` (`index.css:235`) redeclares the full base-token contract with real derived light values (warm off-white surfaces, deepened accent for AA on white, black-on-white borders). Components consume `var(--ou-*)` tokens, so they flip without per-component light styles. **Verified empirically, not by reading CSS**: rendered the real RunConsole markup against the real `index.css` in a browser and read `getComputedStyle` in both themes —

| token / element | dark | light |
|---|---|---|
| `--ou-bg-app` | `#181a1c` | `#f4f6f5` |
| `--ou-bg-card` | `#1c1f22` | `#ffffff` |
| `--ou-text-base` | `#e8ebec` | `#24292c` |
| `--ou-accent` | `#2f7d5f` | `#256b50` |
| `.ou-rc-sidebar` bg | `rgb(20,22,24)` | `rgb(236,238,237)` |
| `.ou-rc-run-title` color | `rgb(238,241,242)` | `rgb(27,31,34)` |
| `.ou-rc-startrun` bg | `rgb(47,125,95)` | `rgb(37,107,80)` |

The redesigned surfaces are **not** dark-only. Minor note (not a defect): a few RunConsole rules hardcode status hues rather than tokens — `#a5c8e6` (scheduled dot), `#9aa1a5` (de-emphasised trace label), `#eec478` (approve-hover amber). They read acceptably in both themes; only `#9aa1a5` on light surfaces is slightly low-contrast. Left as-is (cosmetic, and changing token/theme values was explicitly gated on your sign-off).

### (b) `waiting` queue derivation — PASS
`queue: 'waiting'` is set **only** by `onHitlRequest`/`onPlanRequest`, and **only** while the card is `in_progress` (`TaskActivityContext.tsx:195-200`). It is cleared back to `active` by the next real activity — a step update (`:148`), a tool call (`:161`), or a HITL timeout (`:203`) — and to `done` on finalize. So a run shows `waiting` only while it has a genuinely unresolved request; it does **not** stick just because HITL fired once during the run. `deriveCounts` also guarantees a `waiting` run is never double-counted as `running` (`runQueue.test.ts:49`).

### (c) Font self-hosting — PASS
`index.css:19-` declares `@font-face` for IBM Plex Sans (400/500/600/700) + Mono (400/500/600) pointing at local `./assets/fonts/*.woff2`. All **7 files are vendored** in `src/renderer/src/assets/fonts/` (14–24 KB each). `grep` across `src/` finds **zero** `fonts.googleapis`/`fonts.gstatic`/Google `@import` references. Offline-first positioning holds.

## Step 3 — Pixel/token accuracy (6 sampled, all exact)
Verified live via `getComputedStyle` on the rendered component:

| Value | Spec (as quoted) | Implemented | Result |
|---|---|---|---|
| Accent color | `#2f7d5f` | `--ou-accent: #2f7d5f` (dark) | ✅ exact |
| Status-dot shape encodes state | circle running / square finished | running dot `border-radius: 50%`, finished dot `2px` | ✅ exact |
| Sidebar width | 246px (component doc) | `246px` | ✅ exact |
| Inspector width | 352px (component doc) | `352px` | ✅ exact |
| CAN TOUCH bar padding | (authoritative in README) | `9px 12px 9px 14px` | ✅ deliberate/specific (see note) |
| Mono font | IBM Plex Mono self-hosted | `--ou-font-mono: 'IBM Plex Mono', …` | ✅ exact |

## Needs-your-eyes (visual)
The Browser pane in this environment cannot composite frames, so no automated screenshot was possible. Instead a **self-contained, interactive light/dark preview** (real markup + real `index.css`, one-click theme toggle) was produced and sent to you as `runconsole-theme-check.html`. Open it and hit the toggle to eyeball spacing/contrast — everything token-checkable is already proven above.

## Caveats
- The **design handoff README is not in this checkout** (it lived on the `run-console-redesign-pr` branch / PR; this working copy is not a git repo). Step 3 was therefore verified against the values quoted in the task and the component's own doc comments. The exact authoritative number for CAN TOUCH padding could not be diffed against the README; the implemented value is deliberate and asymmetric (not a round approximation).
- No release/signing, no new features, no automation-tool work touched (non-goals honoured).
