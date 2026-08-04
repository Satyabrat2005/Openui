# Run Console — Web Port Verification

_The web app's UI is a direct port of the desktop `RunConsole.tsx` (Openui repo),
not a re-imagining. Only the data layer differs: Electron IPC → REST/SSE. `index.css`
(140 KB, all 181 `ou-rc` rules) and the 7 IBM Plex `.woff2` files were copied
**verbatim**; the component markup and class names are unchanged._

## Step 5 — parity spot-checks (live `getComputedStyle`, web app in-browser)

| Value | Desktop (recorded, docs/runconsole-verification-2026-08.md) | Web port (measured) | Result |
|---|---|---|---|
| `--ou-accent` (dark) | `#2f7d5f` | `#2f7d5f` | ✅ exact |
| Sidebar width | `246px` | `246px` | ✅ exact |
| Inspector width | `352px` | `352px` | ✅ exact |
| CAN TOUCH bar padding | `9px 12px 9px 14px` | `9px 12px 9px 14px` | ✅ exact |
| `.ou-rc-startrun` bg | `rgb(47,125,95)` | `rgb(47,125,95)` | ✅ exact |
| Run status-dot (running) | `border-radius: 50%` | `50%` | ✅ exact |
| Run status-dot (finished) | `border-radius: 2px` | `2px` | ✅ exact |
| Body font | IBM Plex Sans | `"IBM Plex Sans", …` | ✅ exact |
| Card bg (`--ou-bg-card`) | `#1c1f22` → `rgb(28,31,34)` | `rgb(28,31,34)` | ✅ exact |

Parity is **exact by construction** (verbatim CSS + fonts + markup); these checks
confirm the copy landed without mangling.

## Screenshot constraint (honest)
No side-by-side screenshot was possible: the Browser pane in this environment
**cannot composite frames** (`innerWidth/Height` report 0 until a viewport is
forced; `computer{screenshot}` times out with "pane is not displayed"). This is
the **same** limitation the original desktop verification pass recorded. All
parity evidence above is from `getComputedStyle`, which does not require
compositing. The Electron desktop app likewise cannot be captured in this sandbox.

## Electron IPC → web data-layer swaps
| Desktop call | Web replacement |
|---|---|
| `window.openui.chat(text, tier)` | `POST /api/chat` (SSE) via `sendChat()` |
| `window.openui.onChunk` / `onDone` | SSE `data:{delta}` reader in `api.streamChat` |
| `window.openui.onHitlRequest` / HITL props | `/api/tool` confirmation gate → `pendingApproval` |
| `window.openui.getUser` (AuthContext) | `GET /api/me` (Supabase getUser server-side) |
| `getConnections`/`subscribeConnections` (ConnectAppsModal) | `GET /api/connections` + `context/connections.ts` |
| `window.openui.listWorkflows` | `GET /api/workflows` |
| `window.openui.getSetting` (guardrails) | `localStorage` |
| `window.openui.clearHistory` | `clearRuns()` (client) |
| `window.openui.captureScreenThumbnail` (LIVE VIEW) | **removed** — screen capture is desktop-only |
| `window.openui.resumeConversation` | deferred (history drawer placeholder) |

## Approve / Deny (Step 3 — real, not cosmetic)
Verified in-browser: a gated tool (`write_spreadsheet`, `create_repo`) enters the
`NEEDS YOU` queue with an inline callout and **produces no file** until confirmed.
- **Approve** → tool runs → `FINISHED`, real `Report.xlsx` link, `TOUCHED` row
  `Report.xlsx WRITE`, plan step `✓ Wrote Report.xlsx`.
- **Deny** → `Denied — nothing ran.`, `TOUCHED` row `write_spreadsheet HELD`, no file.
Filter pills (`All / Running / Needs you / Finished`) already drive real run
filtering (ported unchanged). Desktop `RunConsole.tsx` has no Pause control, so
none was added (non-goal: no new features).

## Ported verbatim vs adapted
- **Verbatim** (markup/classes/CSS/fonts): the whole three-column layout, sidebar,
  composer + CAN TOUCH bar, run ledger, run rows, inspector PLAN/TOUCHED/GUARDRAILS,
  `lib/runQueue.ts` (only its import path changed: `../env` → `../types`).
- **Adapted** (data only): `RunConsole.tsx` data wiring, `TaskActivityContext` →
  `WebTaskActivityContext` (folds chat SSE + gate into the same TaskCard shape),
  `AuthContext` → `WebAuthContext`, connection store.
- **Removed**: LIVE VIEW inspector section (`useScreenThumbnail`) — desktop-only.
- **New surface**: `SignIn.tsx` (desktop README lists sign-in as "Not yet designed";
  built only from existing tokens — no new palette).
