# Changelog

All notable changes to OpenUI are documented here. Versions follow the git tags;
the newest work lands under **Unreleased** until the next version bump.

## [Unreleased]

## v7.1.3 — 2026-07-16

Turns the browser layer into a full CDP-driven automation surface — your
real Edge/Chrome profile, not a throwaway one — with an assisted,
human-gated flow for account cancellation and refunds, plus four
local-build reliability fixes surfaced while smoke-testing the
local-Ollama chat/builder path. 2 PRs, 4 commits since v7.1.2.

### Added

- **`connect_browser` now drives your real Edge/Chrome** via a DevTools
  debug port + CDP — your actual profile, logins, and multiple profiles
  (via `profile` arg / `OPENUI_BROWSER_*` env), falling back to an
  isolated profile if attach fails. Previously it launched an empty
  throwaway profile. (#122)
- **Full browser control surface**: `browser_read_elements` (structured
  interactive elements with ready-to-use selectors — reliable clicking
  without cloud vision), `browser_list_tabs` / `browser_open_tab` /
  `browser_switch_tab` / `browser_close_tab`, `browser_scroll`,
  `browser_screenshot`, `browser_wait_for`, `browser_history`,
  `browser_press_key`. (#122)
- **`research_audit`**: opens one tab per source (kept open), scrolls,
  highlights query terms on-page, and saves an `audit.md` plus
  per-source screenshots to `~/OpenUI Research/`. (#122)
- **`write_latex`**: assembles and saves a compilable LaTeX paper, with
  an optional Overleaf open for manual import. (#122)
- **Assisted account tasks, gated to never take the irreversible step**:
  `scan_accounts` (read-only login scan across 56 built-in services —
  streaming, AI, productivity, gaming, fitness, cloud/dev, VPN,
  learning, India streaming/reading), `open_cancellation` (drives to a
  service's cancellation page and stops before the final click), and
  `draft_refund_email` (drafts only — sending still goes through the
  HITL-gated `send_email`). Every irreversible click stays behind
  `SENSITIVE_ACTION_RE`, `browser_press_key` is limited to non-submit
  keys so it can't bypass that gate, and read-only tools
  (`browser_read_elements`, `browser_list_tabs`, `browser_screenshot`,
  `browser_wait_for`, `scan_accounts`) skip the HITL gate while
  state-changing ones stay behind it. (#122)
- New `open_in_browser` coding tool for Builder Mode (`shell.openPath`
  on a sandbox-resolved path, via a new escape-checked
  `resolveSandboxPath` in `sandbox.ts`) — previously asking to "open it
  in my browser" made the model hallucinate a nonexistent `open_url`
  tool. (#121)

### Fixed

- **`openTopWhatsAppSearchResult` now waits for the results list to
  render** before sending `Down`/`Enter` (tunable via
  `OPENUI_WA_SELECT_MS`), fixing a bug where the chat was searched but
  never opened. (#122)
- **Dead GitHub/Figma prompt weight trimmed from
  `buildDefaultSystemPrompt`.** Tool schemas and workflow prose for
  GitHub/Figma were always included even with no token configured,
  though those tools are unusable in that state (instant
  `tokenRequiredError`). On local models with an 8192 `num_ctx`, that
  dead weight pushed a brand-new one-line chat to ~7968/8192 tokens — a
  hair from Ollama silently truncating the prompt. Now gated on
  `getGithubToken()` / `getFigmaToken()` actually returning something.
  (#121)
- **An unreachable Ollama server used to masquerade as the model
  declining to build.** `callModel`'s "can't reach the local AI engine"
  string came back as a zero-tool-call reply, so the zero-tool-retry
  loop nudged a dead server and gave up with a misleading "name the
  tech stack you want used." `runBuilderSession` now checks
  reachability up front and reports the real cause. (#121)
- **Build follow-ups ("now add a backend", "make it dark mode") no
  longer scatter across new project folders.** A follow-up carrying an
  edit verb but no build noun missed `BUILD_RE` and fell into the OS
  chat loop, which has no coding tools, so the model narrated the
  change without writing anything; even when it did reach the builder,
  it derived a new project folder from its own wording.
  `isBuildContinuation()` + `activeProjectHasFiles()` now route
  follow-ups to the builder and reuse the current project, seeding the
  model with the existing file list and an "edit in place, don't start
  over" instruction; the UI shows "Continuing project: &lt;slug&gt;".
  (#121)

## v7.1.2 — 2026-07-13

Closes a safety-critical HITL bypass in sub-agent spawning, adds Gmail
send/reply integration, and fixes 8 defects surfaced by a hands-on QA pass —
plus the plan-approval hang and MCP approval-gate fixes from the previous
cycle. 3 PRs, 19 commits since v7.1.1.

### Security

- **`spawn_subagents` bypassed the app's own HITL confirmation entirely**,
  and sub-agents could write or overwrite files with zero human
  confirmation — `write_file`/`create_folder` weren't in
  `DESTRUCTIVE_TOOLS`. The fan-out is now gated through the existing
  approval pipeline, and both tools are in `DESTRUCTIVE_TOOLS`. (#119)
- **MCP tools now honour the per-tool approval gate.** The MCP fallback ran
  *after* the executeTool HITL gate, and MCP tool names aren't in
  `DESTRUCTIVE_TOOLS`, so an MCP tool (a stdio server can run arbitrary local
  actions) executed with no confirmation in every autonomy mode. It is now gated
  like built-in state-changing tools: outside autopilot (full-auto / an approved
  plan) it requires one human confirmation before running. (#118)
- **Narrowed the read trust boundary (`pathSafety.ts`).** Reads stay unconfined
  within the user's own space (project/data files on other drives keep working),
  but a read of a path *outside* home is now refused if it targets a system-level
  secret store (`SYSTEM_SECRET_PATH_RE`: Windows registry hives, `/etc/shadow`,
  private TLS/SSH keys, the macOS local directory DB) or another user's home
  directory — closing an information-disclosure surface without breaking
  legitimate cross-drive reads. (#118)

### Added

- **Gmail integration**: new `gmail.ts` module sharing the existing Google
  OAuth client with Calendar (own refresh token/scope), `send_email` /
  `find_email_thread` tools, an attachment picker, and a Gmail card in
  Settings. (#117)
- Finished or in-progress autonomous builds can now be handed off to a named
  installed editor (e.g. "...open it in Antigravity"). (#117)

### Fixed

- **The plan-approval prompt could hang a chat turn forever.** `waitForPlanApproval`
  in `agent.ts` awaited the renderer's `openui:plan:response` with no backstop
  timeout, unlike `waitForHitlApproval`. If that response never arrived — the
  window was closed while the plan modal was open, the renderer crashed/reloaded,
  the modal was dismissed, or the IPC message was dropped — the turn's Promise
  never settled: no `openui:chat:done` fired, the UI stayed stuck in "working,"
  and the pending resolver leaked. Since `approve-plan` is the default autonomy
  level, this sat on the primary path. Added the same 150s backstop the HITL gate
  uses; on timeout the plan auto-cancels and emits `openui:plan:timeout`. (#118)
- **The interactive "build me an app" session ran on the wrong model.**
  `runBuilderSession` (`agent.ts`) — the feature behind any "build/scaffold/create
  a website/app/component" chat request — called `callModel` without
  `{ coding: true }`, so it silently ran on the general chat model instead of the
  code-tuned model the autonomous coding loop already uses. Reproduced live:
  asking it to build a Pomodoro timer produced JSX/JS with mismatched braces,
  stray escaped quotes, and undefined variables. Now passes `{ coding: true }`,
  matching `autonomous.ts`. (#118)
- **Builder sessions could produce a JSON blob describing the project instead
  of real files.** A build request like "build a website like antigravity or
  claude" could get a JSON-shaped non-call or a zero-tool "done" reply.
  `runBuilderSession` now detects both, nudges for a real `write_file` call
  (bounded retries), and fails honestly instead of looping forever. (#117)
- **WhatsApp contact resolution blindly trusted WhatsApp's in-app search with
  zero verification.** It's now a two-phase, OCR-verified resolution (reusing
  `appResolver.ts`'s scoring engine) that fails closed — ambiguous or
  unconfident matches always require an explicit user pick via a new
  candidate-picker UI, never a silent send. (#117)
- **The main OS-automation loop burned its entire turn budget silently when a
  precondition was missing** (e.g. an app isn't installed). It now recognizes
  the known "needs setup" error shapes and stops early with an explanation
  instead of retrying blindly. (#117)
- **Malformed tool-call JSON leaked into the visible chat transcript** (e.g.
  an unescaped backslash in a Windows path) instead of being withheld —
  fixed the classifier and wired the missing check into the main loop,
  `autonomous.ts`, and `codingSubagents.ts`. (#119)
- **Conversation history never appeared in the sidebar for any user** (guest
  or signed-in), because conversations were always stored under
  `user_id = NULL` while the query filtered on a non-null match. (#119)
- Settings modal's close button and first two toggles rendered off-screen on
  shorter viewports (no `maxHeight`/`overflowY` on the card). (#119)
- Onboarding progress was lost if you quit partway through — the step state
  was never persisted. (#119)
- The "nearing context limit" warning only reached `console.warn`, never the
  UI (missing `emit` call on the 90% branch, unlike its 100% sibling). (#119)
- A Google Fonts `@import` that the app's own CSP has always blocked
  (contradicting its own comment). (#119)
- Several modals were missing `role="dialog"`/`aria-modal` and
  Escape-to-close handling. (#119)

**Full Changelog**: https://github.com/Satyabrat2005/Openui/compare/v7.1.1...v7.1.2

## v7.1.1 — 2026-07-12

A security fix plus a large expansion of the autonomous coding agent:
semantic codebase indexing, parallel worktree agents, a structured debug/verify
loop, new productivity tools (spreadsheets, Calendar, interactive Python, web
research, WhatsApp), an Ollama-only launch path, and a first unit-test safety
net for the tool-execution and persistence layers. 19 PRs, 78 commits since
v7.1.0.

### Security

- **Fixed broken object-level authorization (IDOR) on billing endpoints.**
  The `create-checkout`, `check-subscription`, and `customer-portal` Supabase
  Edge Functions read `userId` straight from the unauthenticated request body
  and trusted it, so any caller with a valid session — or, for
  `customer-portal`, no session at all — could act on another user's Stripe
  account by supplying their id. Brought in line with `chat-proxy`'s existing
  `supabase.auth.getUser(token)` check. (#96)

### Added — Agent capability

- **Semantic codebase index + symbol map** (`codebaseIndex.ts`,
  `embeddings.ts`): a per-project HNSW vector index, `.gitignore`-aware,
  with incremental content-hash re-embedding and a
  `search_codebase_semantic` tool. Adds parallel worktree agents, patch
  application, and run resume. (#113)
- **Structured debug loop + full-suite verify gate** for autonomous coding
  on larger codebases; fixes a shipped bug where `lastVerificationPassed`
  stayed set from a stale run. (#110)
- **Coding-partner upgrade**: `edit_file`, `search_code`, and local `git`
  tools; a verify loop that refuses to report success on code it never ran;
  an opt-in bring-your-own-key cloud tier with local Ollama as the private
  default. (#107)
- **Native spreadsheet automation** (`read_spreadsheet`, `write_spreadsheet`,
  `update_cells`, `add_formula`, `list_sheets`) via exceljs, confined through
  the existing `resolveSafePath`; Google Calendar invite creation; and an
  interactive `run_python`. (#98)
- **`research_web`**: read-only, no-API-key web research over the connected
  Playwright browser (DuckDuckGo search, cited multi-page synthesis); plus
  WhatsApp message send and a fix for the WhatsApp connect error. (#109)
- **Practice/learning coach mode**, shipped alongside the Ollama-only launch
  path. (#108)
- Autonomous builds now write to a visible `~/OpenUI Projects` directory
  instead of a buried `userData` path, and VS Code opens automatically on
  the first write. (#106)

### Fixed — Reliability

- **Build automation now runs and reports honestly.** The general agent loop
  previously marked every plan step "done" on any prose reply with no
  verification, and multi-line tool calls (local models emitting literal
  newlines inside JSON strings) were silently dropped instead of executed.
  Both are fixed. (#114)
- **Ollama GPU-runner crash recovery**, and qwen3.5 support on 8 GB GPUs;
  builds no longer go invisible when the runner restarts mid-request.
  (#111, #112)
- **Ollama model resolution against the actually-installed set**, fixing
  `model 'qwen3.5:9b' not found` when the installed tag was
  `qwen3.5:latest`. (#104)
- **`.env` now loads in the main process during dev.** Bare `process.env.*`
  reads (Ollama host/model, GitHub/Figma tokens, Google OAuth, Whisper path)
  were previously always `undefined` outside of the vars baked in at build
  time. (#105)
- **Native modules rebuilt against the Electron ABI on install**, fixing a
  startup crash from a `better-sqlite3` `NODE_MODULE_VERSION` mismatch.
  (#103)
- **GitHub token now read from Settings**, not an undefined `GITHUB_TOKEN`
  env var — PR review and the autonomous coding issue source were silently
  broken in every installed build. (#97)

### Changed

- **Ollama-only launch**: cloud API access and billing are off by default
  for the initial self-hosted release (kept, not deleted, behind
  `OPENUI_ENABLE_CLOUD`). (#108)
- Removed ~730 lines of dead cloud-proxy chat path left behind by the
  Ollama-only migration. (#102)
- Landed the schema-migration mechanism (repo-hygiene Phase 2.4): a
  testable migration runner plus the first real migration (archived flag).
  (#100, #101)

### Testing

- **Phase 1 safety net**: unit coverage added for `tools.ts`, `agent.ts`,
  and the DB repository layer — the tool-execution trust boundary, agent
  loop, and persistence tier had zero tests before this. 136 tests passing
  (was 72); `npm run typecheck` clean. (#99)

**Full Changelog**: https://github.com/Satyabrat2005/Openui/compare/v7.1.0...v7.1.1

## v7.1.0 — 2026-07-09

Production-readiness hardening ahead of the first cross-platform (Windows +
macOS) public release, plus a major expansion of autonomous agent capability:
safer browser automation, GitHub write access, project-aware coding, local
fine-tuning, and consent-gated crash reporting.

### Added — Agent capability

- **Per-site browser consent + content sanitization + in-page vision
  fallback.** The agent now asks before automating a new site, sanitizes
  page content pulled into context, and falls back to an in-page vision pass
  when structured extraction fails.
- **GitHub write access, always human-confirmed.** New `push_files` and
  `merge_pr` tools (with a token fallback) plus a design-in-browser flow, so
  the agent can propose and land changes with an explicit approval gate.
- **Project-type branching in the autonomous coding loop.** The coding loop
  now detects project type and adapts its sandboxing/tooling accordingly
  instead of using one generic path for every repo.
- **Local LoRA fine-tuning** with versioned checkpoints and an eval-gated
  promotion pipeline, so the local model can improve from collected
  trajectories without a manual review step.
- **Structured run logs, lane-based task queue, and workspace rollback** for
  clearer visibility into and recovery from autonomous runs.
- **Generalized screenshot → reason → act loop** (`computer_use`) and real
  parallel sub-agents with a live screen preview in a three-zone task view.
- **Local model routing** to Ollama qwen models with a single-flight VRAM
  lock to prevent concurrent local-model contention.
- **App-resolution engine + `list_apps` tool**, and a WhatsApp chat tool with
  surfaced `open_app` errors.
- macOS brought to QoL/security parity with Windows (window resize with task
  activity, OS automation).

### Added — Reliability & trust

- **Consent-gated Sentry error tracking with PII scrubbing.**
- **Demo reliability hardening**: renderer error boundaries, a HITL
  auto-deny timeout so an unattended prompt can't hang a demo, and a new
  demo runbook (`docs/DEMO_RUNBOOK.md`).
- Repo hygiene pass for technical diligence.

### Fixed

- **Voice, cloud vision, interviewer & Figma now work in production.** These four
  features previously called the OpenAI/Anthropic/ElevenLabs SDKs directly with
  `process.env` keys that are never baked into the shipped client, so they broke
  silently for real users. They now route through authenticated Supabase Edge
  Functions (a new `voice-proxy`, plus the existing `chat-proxy` for vision and
  interviewer questions) that verify the caller's Supabase token and keep the
  provider keys server-side.
- **Accurate voice-minute metering.** Voice usage is now charged against the real
  decoded audio duration (parsed from the WAV/Ogg/WebM container header) instead
  of a byte-size guess, so the monthly Free-tier cap reflects true seconds.
- Cloud-proxy failures now surface a diagnosable error and fall back to a local
  model instead of a blank "AI service temporarily unavailable".
- Free tier is cloud-only and metered (5 messages/day), removing the earlier
  Ollama bypass so tier limits are actually enforced.

### Added

- **Figma token Settings UI** — the per-user Figma personal-access token is now a
  Settings-backed value (stored locally on device) with a live "Saved"
  confirmation, replacing the dev-only `FIGMA_TOKEN` env var.
- **Local Ollama fallback** so the app remains usable with no cloud keys
  configured (demo-safe offline mode).
- **Filesystem + clipboard desktop tools** (read/write/move/copy/delete files,
  create folders, clipboard read/write) with home-directory confinement and
  human-in-the-loop gating on destructive actions.
- **Plan-then-execute autonomy**: the agent lists every step up front, asks for a
  single plan approval, then executes autonomously with per-step checkpoints.
- **Central training store** capturing full task trajectories for the
  self-improvement loop, with JSONL export.
- **Real resizable app window** with custom title bar (minimize / maximize /
  close) and a pinned session sidebar, replacing the old floating overlay; macOS
  window chrome brought to parity with Windows.
- Global crash reporting and a guest-session mint cap to curb abuse.
- Renderer UI telemetry wired through the main-process PostHog pipe (consent-
  gated); waitlist events unified onto the same pipe. DAU / active-hours tracking.
- Pure-black Claude-style theme with a live streaming chat thread.

### Build / CI

- macOS + Windows code signing and notarization wired into the release build;
  `chat-proxy` hardened.
- **Vitest test suite added** (path-safety extracted for testability, high-risk
  paths covered) and now run in CI. Includes audio-duration decoding tests.

## v7.0.4 — 2026-07-01

- Diagnosable cloud-proxy errors with automatic local-model fallback.

## v7.0.3 — 2026-07-01

- Zero-setup cloud AI via silent guest sessions (no sign-in required to start).
- Pure-black Claude-style theme; live chat thread; hardened tool-call parsing.
- Tool calls hidden in model prose are now executed instead of printed as JSON.

## v7.0.2 — 2026-06-29

- Release build retries electron-builder to survive flaky binary downloads.

## v7.0.1 — 2026-06-29

- Supabase URL/key are baked into the packaged Electron main bundle so signed
  builds ship with working config.

## v7.0.0 "Aurora" — 2026-06-29

- Major version line for the cross-platform desktop app; release-upload pipeline
  cleaned up (excludes `builder-debug.yml`).

## v6.9.0 — 2026-06-28

- Windows support documented in the README.
- Supabase keys passed into both macOS and Windows build environments.

## v0.1.3 — 2026-06-28

- Maintenance release (build/config tidy-up).

## v0.1.2 — 2026-06-28

- Google OAuth via the system browser; conversation history keyed to the user id.
- Automatic system-prompt self-improvement from conversation feedback.
- Conversation-history sidebar in the assistant popup.
- Free-tier coding tasks routed to Ollama to save cloud quota.
- Admin dashboard (`admin-dashboard.html`) added.
- Professional UI pass (emoji removed) and a proper Windows NSIS installer.
- macOS notarization + Windows code signing added to the release workflow;
  packaged builds bake in Supabase/Stripe/PostHog env vars.
- Fixes: strip UTF-8 BOM from `package.json`, remove invalid NSIS schema fields,
  disable macOS signing auto-discovery on CI, resolve 7 pre-launch bugs.

## v0.1.1 — 2026-06-26

- Reveal the window on launch so the installed app actually opens.

## v0.1.0 — Initial Release

### Features

- macOS menu bar AI assistant with floating chat window
- Windows system tray integration
- Local LLM routing via Ollama (Free tier)
- Cloud LLM routing via Anthropic/OpenAI APIs (Pro/Enterprise tier)
- macOS OS automation (open apps, search files, control calendar)
- Windows OS automation (open apps, search files)
- Screen understanding with Vision models (Pro) and local OCR (Free)
- Voice input via Whisper
- Google OAuth authentication via Supabase
- Stripe subscription management (Free / Pro / Enterprise)
- Local SQLite database for conversation history and settings
- Cross-platform deep linking for auth callbacks
- Security hardened (sandbox, CSP, IPC validation, AppleScript injection fixes)
