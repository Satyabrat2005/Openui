# Changelog

All notable changes to OpenUI are documented here. Versions follow the git tags;
the newest work lands under **Unreleased** until the next version bump.

## [Unreleased]

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
