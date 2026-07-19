# OpenUI — Production Readiness Audit

**Reviewed as:** full working tree at `Openui-main` (Electron desktop app, package version `7.1.3`)
**Standard applied:** ready-for-real-users production product, not an MVP
**Original audit:** performed at `7.0.4`
**Last refreshed:** 2026-07-19 — re-verified against the working tree; see §4 for what changed.
**Out of scope (per engagement instructions):** marketing site / landing pages / demo-request flows, "pro"/roadmap features not yet built, API key & secrets configuration (judged as if correctly configured server-side)
**Method:** direct source review (not README/ARCHITECTURE.md claims) — every finding below is traced to a specific file and, where useful, a line number.

> **Status at refresh:** every 🔴 URGENT and 🟠 HIGH finding from the original audit has been resolved.
> Four minor items remain open (🟡 #2, #5, #7 and 🟢 #5), none of them blockers. Details in §3.

---

## 1. Architecture & Flow Summary

This repository now contains **one codebase and its backend**. The original audit found four
overlapping codebases; three have since been deleted (see §4).

**A. The shipping product** — `src/main` (Electron main process, TypeScript) + `src/renderer` (React UI) + `src/preload`. "OpenUI" is a Windows/macOS desktop menu-bar assistant that signs the user in (Google OAuth via system browser, or a zero-friction anonymous guest session), routes chat through a Supabase Edge Function that holds the LLM keys server-side, and lets the model call a set of OS-automation tools (open apps, search files, control the calendar, move the mouse/keyboard, read/write files inside the home folder, control a headful Playwright browser) with a filesystem sandbox and a human-in-the-loop approval gate on state-changing actions. Billing runs through Stripe Checkout/Portal opened in isolated Electron windows, with Stripe webhooks writing the authoritative tier into Supabase `app_metadata` and the client re-syncing every 5 minutes. Conversations, users, and subscription cache are persisted locally in SQLite (`better-sqlite3`). This is what `package.json`, `electron.vite.config.ts`, `.github/workflows/release.yml` and the auto-updater all build and ship.

**B. `supabase/functions/*`** — the Deno Edge Functions that are the *actual* backend for (A): `chat-proxy`, `voice-proxy`, `check-subscription`, `create-checkout`, `customer-portal`, `stripe-webhook`, `waitlist`. No LLM or vendor key ever reaches the client; every feature that needs one goes through a proxy here.

**C. `scripts/finetune/train_lora.py`** — the one remaining Python file, and it is *live*, not legacy: a LoRA fine-tuning sidecar (transformers + peft) invoked by `src/main/finetune/pipeline.ts:253`. Its absence degrades gracefully.

The **working end-to-end flow** is: app launches → `ensureGuestSession()` silently mints a Supabase anonymous session so the app is usable with zero setup → user types or speaks a request → `handleChat()` in `src/main/agent.ts` optionally builds a multi-step plan (`planner.ts`), asks for one approval, then loops the model through `chat-proxy` → the model emits a `{"tool": ..., "args": ...}` JSON object → `executeTool()` runs it (with a path-safety/permission/HITL gate for anything that touches disk, mouse, keyboard or the browser) → the result is fed back to the model → the loop continues until a natural-language answer is produced → the turn is persisted to SQLite and to a "training store" used by a weekly local self-improvement job. Subscription state, once a Stripe checkout completes, flows Stripe → `stripe-webhook` Edge Function → Supabase `app_metadata.tier` → `syncSubscriptionStatus()` → local cache → renderer.

---

## 2. Project Completeness Rating

### 88 / 100 — Grade B+

*(Originally 60/100, Grade C-. See §4 for what moved it.)*

Graded strictly as "can I put this in front of paying users today," not against the bar of a typical early-stage repo.

**What earns real credit.** The security and sandboxing work remains the strongest part of this codebase, and it was strong at the original audit: OAuth is routed through the system browser specifically to work around Google's embedded-webview block (`src/main/auth/authWindow.ts`); OS commands are parameterized through child-process environment variables instead of string concatenation, closing off PowerShell/AppleScript injection (`src/main/tools.ts`); every LLM-supplied filesystem path is resolved and checked against a sensitive-path blocklist and a home-directory boundary before use (`src/main/fs/pathSafety.ts`); a compromised renderer cannot escalate its own subscription tier because the tier is clamped server-side against the verified entitlement (`clampTierToEntitlement` in `src/main/stripe/pricing.ts`); the Electron CSP, sandboxing, and navigation lockdown in `src/main/index.ts` are genuinely thorough.

**What has since been fixed.** The three things that disqualified the original grade are gone. (1) Every headline feature that could not work for a shipped user — voice I/O, Pro-tier cloud vision, the AI interviewer, the Figma workflow, GitHub PR review — now reaches its credential through either a server-side proxy or a per-user Settings field. (2) The broken object-level authorization on the three billing-adjacent Edge Functions is closed: `create-checkout`, `check-subscription` and `customer-portal` all now verify the caller's JWT via `requireVerifiedUser()` and accept a body-supplied `userId` only when it matches the verified id. (3) The repository is no longer ~40% dead code, and test coverage went from 3 files to 53 files / 796 tests, now enforced in CI.

**What keeps it off a higher grade.** The remaining gap is discipline rather than defect: there is no linter configured (no ESLint/Prettier config exists), the renderer runs two competing styling systems (🟡 #5), and a handful of tier-boundary UX messages still read as errors rather than as product boundaries (🟡 #7). None of these will break for a paying user; they are the things that make the *next* year of changes more expensive than they need to be.

---

## 3. Open Findings

Nothing in 🔴 URGENT or 🟠 HIGH remains open. The four items below are all that survive.

### 🟡 MEDIUM

**2. Stale/incorrect comment on the usage-tracking migration.**
`supabase/migrations/001_create_usage_tracking.sql` says *"Free = 20/day on OUR API keys"* in a comment, but the two places that actually enforce the limit — `chat-proxy`'s `DAILY_LIMIT` map and `TIERS.free.dailyMessageLimit` in `src/main/stripe/pricing.ts` — agree on **5**/day. Enforcement is internally consistent (not a functional bug), but the stale comment will mislead the next person who edits this file.

**5. ~~The renderer has two styling systems, and Tailwind is the unused one.~~ Partially resolved 2026-07-19 — dead Tailwind removed; inline styles remain.**
*(Corrected 2026-07-19. The original audit framed this as "inline styles bypass the configured Tailwind" and prescribed converting them to Tailwind. Re-checking the tree showed that prescription was wrong and would have made things worse — it is recorded here accurately instead.)*

What is actually true:

- **Tailwind utility classes are used nowhere in the renderer.** Grepping every `.tsx` for the common utility set (`flex`, `p-*`, `text-sm`, `bg-*`, `rounded`, `items-center`, …) returns no matches.
- The real styling system is a hand-written CSS design system: **2,958 lines** in `src/renderer/src/index.css` defining **302** `ou-*` / `openui-*` semantic classes on top of `--ou-*` custom-property tokens. All **256** `className=` uses in the renderer point at it.
- The second system is inline `style={{...}}` objects — ~69 occurrences in `SettingsModal.tsx` (which uses zero `className`s), 26 in `RecorderUI.tsx`, 24 in `AssistantPopup.tsx`, ~240 across the tree.

So converting inline styles to Tailwind would introduce a **third** system rather than collapsing two. It is also not mechanically possible without altering the design: the inline styles use `fontSize: 13.5` / `11.5`, `#8e8e93`, `borderRadius: 9` — none of which exist in Tailwind's default scale, and `theme.extend` is empty. Conversion would either silently change the visuals or require arbitrary-value classes (`text-[13.5px]`) everywhere, defeating the purpose.

**Correct fix:** migrate the inline styles to `ou-*` classes in the existing design system, and treat Tailwind as dead configuration to remove.

**Done (half of it):** Tailwind was removed — `tailwind.config.js` deleted, the plugin dropped from `postcss.config.js` and `electron.vite.config.ts` (Autoprefixer kept), the dependency uninstalled, and the `@tailwind` directives replaced in `index.css`. Built CSS went 85.70 KB → 75.03 KB.

Removing it was *not* a free deletion: `@tailwind base` emits Preflight, a live CSS reset. `index.css` already duplicated Preflight's box-model rules, but its **element-level** normalization was load-bearing and is now reproduced explicitly under the `PREFLIGHT PORT` heading in `index.css`. Verified in a real browser against the built stylesheet:

| Element | Without the port | With the port |
|---|---|---|
| `button` (×16) | `rgb(240,240,240)`, Arial, `outset` border | transparent, Inter, no border |
| `h1`–`h6` (×9) | 32px / 700 | inherits (16px / 400) |
| `ul` (×2) | `disc` bullets, 40px padding | `none` |
| `svg` (×51) | `inline` / `baseline` — reintroduces a gap under every icon | `block` / `middle` |
| `a` | underlined | `none` |

Borders were checked and do **not** rely on Preflight's implicit `border-style: solid` (every border in `index.css` names its style), so that rule was deliberately not ported.

**Still open:** the ~240 inline `style={{...}}` sites. Migrating them to `ou-*` classes is the remaining half, deliberately left as a separate deliberate pass — it is a large diff with no styling test coverage to catch regressions.

Note also that `SettingsModal`'s light palette (`#1c1c1e` text, `#8e8e93` labels) is **not** a bug despite the app being dark-themed: the modal deliberately paints its own `rgba(255, 255, 255, 0.98)` light sheet.

**7. No in-app expectation-setting for the free-tier `read_screen` fallback.**
`read_screen()` in `tools.ts` degrades to Tesseract OCR text-only output for free-tier users, versus the coordinate-aware vision description Pro/Enterprise tiers get. The tool result tells the *model* to consider recommending an upgrade, but there's no proactive UI messaging before the user hits this, so the capability gap reads as a bug rather than a tier boundary the first time someone hits it.

### 🟢 LOW

**5. The free-tier local-Whisper fallback (`WHISPER_CPP_PATH`) is a developer-only escape hatch.**
It requires a self-compiled `whisper.cpp` binary with no installer or setup flow — realistically never set on a real user's machine. Now that voice is properly proxied, consider dropping this path rather than maintaining dead configuration surface.

### Not previously tracked — now resolved

**~~No linter is configured.~~ Resolved 2026-07-19.** `eslint.config.mjs` (flat config; ESLint 9 + typescript-eslint 8 + react-hooks) is in the tree, `npm run lint` is a script, and CI runs it in `pr-check.yml` ahead of typecheck. Scoped to correctness and dead-code rules only — no Prettier — so it was adoptable without a repo-wide reformat.

The first run reported 76 problems; that is now **2 warnings, 0 errors** (both `no-explicit-any` on genuinely untyped external Figma API responses). What it caught, all since fixed:

- A bare `win` expression statement in `agent.ts` commented *"referenced to satisfy linter"* — dead code appeasing a linter that was never running.
- Unused imports (`resolvePath`, `sep`, `InstalledApp` in `tools.ts`; `User` in `preload/index.ts`) and an unused `const d` in `ConversationList.tsx`.
- A `no-control-regex` disable on the wrong line of a two-line statement, suppressing nothing.
- 27 files carrying stale `@typescript-eslint/no-var-requires` disables — a rule typescript-eslint v8 renamed to `no-require-imports`.
- A missing `react-hooks/exhaustive-deps` dependency pair in `useAssistantAnimations.ts`.

One deliberate configuration choice: `@typescript-eslint/no-require-imports` is **off for `src/main/**`**. Those ~22 `require()` calls are intentional lazy loads of native/heavy modules (`better-sqlite3`, tesseract, `screenshot-desktop`, googleapis) so a missing optional binary degrades to a caught error instead of crashing startup; static imports would hoist that failure to app launch. The rationale is recorded in the config.

The tree remains clean by proxy measures too: zero `@ts-ignore`/`@ts-expect-error` and zero real `TODO`/`FIXME`/`HACK` markers in non-test source.

---

## 4. Changelog vs. the original audit

Verified against the working tree at `7.1.3` on 2026-07-19.

### Resolved

| # | Finding | Resolution |
|---|---|---|
| 🔴 1 | Voice I/O non-functional for shipped users | `voice-proxy` Edge Function + shared `src/main/edgeFunctions.ts`; SDKs removed from client |
| 🔴 2 | Pro "cloud vision" broken | `read_screen()` routes image blocks through `chat-proxy`; Anthropic client removed |
| 🔴 3 | AI Interviewer non-functional | `generateQuestion()` via `chat-proxy`; STT/TTS via `voice-proxy` |
| 🔴 4 | Figma workflow non-functional | Vision via `chat-proxy`; Figma PAT moved to a Settings field |
| 🔴 5 | GitHub features non-functional | `github.ts:56` reads a `github_token` setting; env kept as dev fallback |
| 🔴 6 | Broken object-level auth on 3 billing endpoints | All three call `requireVerifiedUser(req, supabase, userId)`; body `userId` honored only if it matches the verified JWT |
| 🔴 7 | `server/fastapi_app.py` syntax error | `server/` deleted |
| 🔴 8 | `server/` serves a fake echo API | `server/` deleted |
| 🟠 1 | Effectively no test coverage | 53 test files, 796 tests passing (incl. all 7 DB repositories, agent, tools) |
| 🟠 2 | Tests not run in CI | `.github/workflows/pr-check.yml:22` runs `npm test` |
| 🟠 3 | Orphaned `api/` FastAPI service | `api/` deleted |
| 🟠 4 | ~11,500 lines of orphaned legacy Python | Root `main.py`, `core/`, `tools/`, `ui/`, `voice/`, `models/` deleted. The shadow-filename risk (`core/agent.py` vs `src/main/agent.ts`) is gone with it |
| 🟠 5 | Duplicate dead `database/db.ts` | Deleted; no references remain anywhere in `src/` |
| 🟠 6 | No real SQLite migration path | `migrations.ts` now registers `001_conversations_add_archived`, exercised by `migrations.test.ts` and `migrations.realdb.test.ts` |
| 🟠 7 | Free-tier telemetry logged wrong model | Moot — tiers no longer map to different cloud models (`agent.ts:797`) |
| 🟡 1 | Voice error steered users to an equally-broken tier | Moot once 🔴 1 landed |
| 🟡 3 | MCP IPC accepted arbitrary spawn config | `ALLOWED_MCP_STDIO_COMMANDS` allowlist in `index.ts:721` + a real `ConnectAppsModal.tsx` UI |
| 🟡 4 | Voice metered by byte-size heuristic | `decodeAudioDurationSeconds()` parses the container header; byte estimate kept only as a documented fallback (`voice.ts:220-228`) |
| 🟡 6 | `server/tiers.py` duplicated pricing logic | Moot — `server/` deleted |
| 🟢 1 | `package.json` copy said "macOS menu-bar" | Now describes the cross-platform Windows + macOS product |
| 🟢 2 | Three dependency graphs in one repo | Collapsed to one (`package.json`) with the deletions above |
| 🟢 3 | `admin-dashboard.html` / `design.html` at repo root | Deleted |
| 🟢 4 | `CHANGELOG.md` was 761 bytes at v7.0.4 | Now ~22 KB and tracking releases |

### Verification performed at refresh

- `npm run lint` (ESLint 9) — 0 errors, 2 warnings.
- `npm run typecheck` (`tsc --noEmit`) — clean, zero errors.
- `npm test` (vitest) — 53 files, 796 passed / 1 skipped **when run with `--no-file-parallelism`** (see the flakiness note below).
- `npm run build` (electron-vite) — main, preload and renderer bundles all built.
- Computed-style probe in a real browser against the built stylesheet, confirming the Preflight port (table in 🟡 #5).
- Repo-wide greps confirming the deletions above left no dangling imports or references.

### Known flakiness — pre-existing, not yet fixed

Under the default parallel worker pool on a loaded machine, 2–6 tests fail intermittently in `src/main/models.test.ts` and `src/main/runLog.test.ts`. All pass in isolation and all 796 pass with `--no-file-parallelism`, so these are resource-contention races rather than defects:

- `runLog.test.ts` reads the JSONL log file back before the last two lines have flushed (`expected ['run_start','tool_call'] to deeply equal [...4 items]`) — a real write/read race in the test.
- `models.test.ts > resolveOllamaModel` exceeds even a 20 s timeout under load while taking ~1.8 s in isolation.

This is worth fixing before it costs someone a red CI run on an unrelated PR.
