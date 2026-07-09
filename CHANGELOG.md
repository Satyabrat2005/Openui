# Changelog

All notable changes to OpenUI are documented here. Versions follow the git tags;
the newest work lands under **Unreleased** until the next version bump.

## [Unreleased]

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
