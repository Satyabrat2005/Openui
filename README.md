# OpenUI

**OpenUI** is a Windows and macOS menu-bar AI assistant built with Electron, React, TypeScript, and Vite. It lives quietly in the system tray and surfaces as a transparent floating overlay when you need it. Under the hood it connects to Anthropic Claude (cloud-first via a Supabase proxy), OpenAI Whisper, Ollama (optional local fallback), and a suite of OS-automation, code, design, and developer tools.

---

## Feature Overview

| Phase | Feature | Status |
|---|---|---|
| **Phase 1** | UI shell — transparent overlay, tray icon, GSAP animations | ✅ Complete |
| **Phase 2** | Agent backend — model router, streaming IPC, tool-calling, conversation history | ✅ Complete |
| **Phase 2.5** | OS automation — macOS AppleScript tools, cross-platform nut.js mouse/keyboard, live TaskListPopup | ✅ Complete |
| **Phase 3** | UI wiring — live chat input, streaming transcript, real audio bars | ✅ Complete |
| **Phase 4** | Screen vision — `read_screen()` via desktopCapturer, Claude Vision (pro/enterprise), Tesseract.js OCR (free) | ✅ Complete |
| **Phase 5** | Voice input — push-to-talk mic, MediaRecorder, OpenAI Whisper, auto-route to agent | ✅ Complete |
| **Phase 6** | macOS permission hardening — pre-flight OS checks, PermissionModal, unhandled-rejection fixes | ✅ Complete |
| **Distribution** | electron-builder — Windows NSIS installer, macOS DMG, `openui://` deep-link, single-instance lock | ✅ Complete |
| **Phase 7** | Auth + subscriptions — Google OAuth via Supabase, SQLite persistence, tier routing, Stripe checkout | ✅ Complete |
| **Sub-Phase 4** | Telemetry — PostHog analytics, opt-in `ConsentModal`, Settings toggle, GDPR-safe design | ✅ Complete |
| **Phase 8** | Autonomous Coding Mode — unattended sandbox agent, todo.json/GitHub Issues tasks, write/test loop | ✅ Complete |
| **Phase 9** | AI Interviewer — voice-driven technical screening, TTS responses, structured 10-turn sessions | ✅ Complete |
| **Phase 10** | GitHub PR Review — `list_open_prs`, `get_pr_diff`, `post_pr_comment` via `@octokit/rest` | ✅ Complete |
| **Phase 11** | Figma Design Tools — `get_figma_file`, `export_figma_frames` with Vision analysis, `create_figma_comment` | ✅ Complete |
| **Onboarding** | Cloud-first routing, 4-step OnboardingWizard, daily usage counter, Ollama as optional fallback | ✅ Complete |
| **Auto-updater** | `electron-updater` + GitHub Releases — Windows in-app install, macOS browser redirect | ✅ Complete |

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Quick Start](#quick-start)
3. [Environment Variables](#environment-variables)
4. [Architecture Overview](#architecture-overview)
5. [Agent & Model Routing](#agent--model-routing)
6. [OS Automation Tools](#os-automation-tools)
7. [Screen Vision (`read_screen`)](#screen-vision-read_screen)
8. [Voice Input](#voice-input)
9. [GitHub PR Review](#github-pr-review)
10. [Figma Design Tools](#figma-design-tools)
11. [Autonomous Coding Mode](#autonomous-coding-mode)
12. [AI Interviewer](#ai-interviewer)
13. [Auth & Subscription Gating](#auth--subscription-gating)
14. [Telemetry & Privacy](#telemetry--privacy)
15. [Auto-Updater](#auto-updater)
16. [Onboarding & Cloud-First Routing](#onboarding--cloud-first-routing)
17. [Building for Distribution](#building-for-distribution)
18. [Security Model](#security-model)

---

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| **Node.js** | 20+ | [nodejs.org](https://nodejs.org) |
| **npm** | 10+ | Bundled with Node.js |
| **macOS** | 12+ | Primary target; Windows dev supported |
| **Supabase project** | — | Required for cloud chat proxy + guest/anon sessions (enable Anonymous sign-ins) |
| **Ollama** _(optional)_ | v0.5+ | Hidden power-user local path; never required, never prompted |

---

## Quick Start

```bash
git clone https://github.com/Satyabrat2005/Openui.git
cd Openui
npm install          # also generates tray icons via postinstall
cp .env.example .env # fill in your keys (see Environment Variables)
npm run dev          # Electron + Vite HMR dev mode
```

The app appears as a tray icon. Click it to toggle the overlay. Press **Escape** or click outside the popup to hide it.

---

## Environment Variables

Create a `.env` file in the project root (gitignored). Only `SUPABASE_URL` and `SUPABASE_ANON_KEY` are required; the rest unlock optional features.

```env
# ── Required for cloud chat + auth ───────────────────────────────────────────
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=eyJ...

# ── Required for direct Vision and local-dev chat fallback ───────────────────
ANTHROPIC_API_KEY=sk-ant-...

# ── Required for Whisper voice transcription (pro/enterprise tiers) ──────────
OPENAI_API_KEY=sk-...

# ── Required for GitHub PR review + task source ──────────────────────────────
GITHUB_TOKEN=ghp_...          # repo read + write:discussion scopes
GITHUB_REPO=owner/repo        # optional default repo

# ── Required for Figma design tools ─────────────────────────────────────────
FIGMA_TOKEN=figd_...           # Figma personal access token

# ── Required for Stripe checkout ─────────────────────────────────────────────
STRIPE_PRO_PRICE_ID=price_...
STRIPE_ENTERPRISE_PRICE_ID=price_...

# ── Required for PostHog analytics (optional — disables telemetry if unset) ──
POSTHOG_API_KEY=phc_...
POSTHOG_HOST=https://us.i.posthog.com   # default

# ── Optional — Ollama (local AI fallback) ────────────────────────────────────
OLLAMA_HOST=http://127.0.0.1:11434
OLLAMA_MODEL=llama3:8b

# ── Optional — local Whisper for free tier ───────────────────────────────────
WHISPER_CPP_PATH=/path/to/whisper/binary

# ── Optional — enterprise chat fallback (GLM) ────────────────────────────────
GLM_BASE_URL=http://127.0.0.1:8080/v1
GLM_API_KEY=no-key
GLM_MODEL=glm-4

# ── Optional — override the autonomous coding workspace path ─────────────────
OPENUI_WORKSPACE=/path/to/workspace
```

---

## Architecture Overview

OpenUI is a standard Electron app with three Vite bundles (main, preload, renderer) built by `electron-vite`.

```
src/
├── main/                         # Node / Electron main process
│   ├── index.ts                  # App bootstrap, tray, BrowserWindow, IPC registration
│   ├── agent.ts                  # LLM agent: model router, streaming, agentic tool loop
│   ├── tools.ts                  # OS automation tool registry + executeTool dispatcher
│   ├── voice.ts                  # Whisper transcription, TTS synthesis, voice IPC handler
│   ├── github.ts                 # GitHub PR tools (Phase 10)
│   ├── figma.ts                  # Figma design tools (Phase 11)
│   ├── autonomous.ts             # Autonomous Coding Mode loop (Phase 8)
│   ├── codingTools.ts            # Sandbox-only tools: write_file, read_file, run_tests
│   ├── sandbox.ts                # Sandboxed workspace I/O + test runner
│   ├── tasks.ts                  # Task sources: todo.json + GitHub Issues
│   ├── interviewer.ts            # AI Interviewer session management (Phase 9)
│   ├── permissions.ts            # macOS systemPreferences permission helpers
│   ├── updater/updater.ts        # electron-updater wrapper
│   ├── local/ollamaManager.ts    # Ollama install/start/pull helpers
│   ├── cloudFreeTier.ts          # chat-proxy SSE streaming client
│   ├── telemetry/                # PostHog integration (events, consent, posthog client)
│   ├── stripe/                   # Stripe pricing, checkout, subscription sync
│   └── database/                 # better-sqlite3 schema, repos (users, conversations, messages, settings)
├── preload/
│   └── index.ts                  # contextBridge — exposes window.openui to renderer
└── renderer/src/
    ├── App.tsx                   # Transparent overlay, onboarding gate, update banner wiring
    ├── components/
    │   ├── AssistantPopup.tsx    # Main chat UI — input, mic, transcript, chips
    │   ├── TaskListPopup.tsx     # Live tool-call task list
    │   ├── OnboardingWizard/     # 4-step first-run wizard
    │   ├── AuthButton.tsx        # Google sign-in / user avatar
    │   ├── SubscriptionStatus.tsx
    │   ├── ConversationList.tsx  # Sidebar conversation history
    │   ├── TierUpgradeModal.tsx
    │   ├── ConsentModal.tsx      # Telemetry opt-in prompt
    │   ├── SettingsModal.tsx     # Analytics toggle, conversation controls
    │   ├── UpdateBanner.tsx      # "v1.x available" slim banner
    │   ├── UpdateProgress.tsx    # Download progress bar
    │   ├── UpdateReady.tsx       # "Restart to install" prompt
    │   ├── LocalAIStatus.tsx     # Ollama availability status
    │   ├── OllamaSuggestion.tsx  # Prompt to set up Ollama for offline use
    │   ├── SignInBanner.tsx      # Upsell to sign in
    │   ├── PermissionModal.tsx   # macOS Accessibility / Microphone settings deep-link
    │   └── UsageCounter.tsx      # "15/20 messages today"
    └── context/AuthContext.tsx   # User, tier, upgrade payload global state
```

### Security model (IPC)

```
Renderer (Chromium)         Preload (contextBridge)         Main (Node)
─────────────────────       ────────────────────────        ──────────────────
contextIsolation: true   →  window.openui (safe API)    →  ipcMain handlers
nodeIntegration: false      sandbox: true                   (full Node access)
```

API keys, `process.env`, `desktopCapturer`, and all tool execution stay in the main process and never cross the contextBridge.

---

## Agent & Model Routing

`agent.ts` implements a cloud-first agentic loop with automatic fallback.

### Model routing (per tier)

```
callModel(tier)
  ├─ free:        Ollama (if running) → else cloud proxy → claude-3-5-haiku
  ├─ pro:         Ollama for simple tasks → else cloud proxy → claude-sonnet-4-6
  └─ enterprise:  cloud proxy → claude-sonnet-4-6 (or GLM in local dev)
```

The **cloud proxy** (`supabase/functions/chat-proxy`) holds our LLM API keys server-side. Every authenticated user can chat immediately — no local setup required. Ollama is an optional cost-saver / offline fallback; a missing or stopped Ollama is never an error.

### Agentic tool loop

```
handleChat()
  └── loop (≤ 8 turns, or 32 for PR review):
        callModel() → stream tokens → parse response
        ├── plain text   → finalise, send openui:chat:done
        └── JSON tool call → executeTool() → push result to history → continue loop
```

The loop is rolled back entirely on error so history stays consistent.

### Conversation history

Conversations and messages are persisted in a local SQLite database (`better-sqlite3`). Past sessions are accessible from the `ConversationList` sidebar. History survives popup hide/show but resets on `clearHistory()`.

---

## OS Automation Tools

Available to the interactive assistant (not the autonomous coding agent):

| Tool | Platform | Description |
|---|---|---|
| `open_app(appName)` | macOS | Open any application via AppleScript |
| `search_files(query)` | macOS | Spotlight search via `mdfind` (returns up to 20 results) |
| `control_calendar(action, eventDetails?)` | macOS | Create or list Calendar.app events |
| `move_mouse(x, y)` | Cross-platform | Move pointer to absolute screen coordinates |
| `left_click()` | Cross-platform | Click at the current pointer position |
| `type_text(text)` | Cross-platform | Synthesise keyboard input via `@nut-tree-fork/nut-js` |
| `read_screen()` | macOS† | Capture screen + Claude Vision or Tesseract OCR (see below) |

All tools are loaded lazily — a missing native package surfaces as a `{ ok: false, error }` tool result rather than a crash.

---

## Screen Vision (`read_screen`)

`read_screen()` captures the full display via `desktopCapturer`, then:

- **Pro / Enterprise:** sends the PNG to Claude Vision (`claude-sonnet-4-6`) for a detailed description of every visible UI element with approximate X,Y coordinates.
- **Free:** runs Tesseract.js OCR and returns extracted text.

The agent uses this for "screen navigation" workflows:

```
User: "Open the GitHub Pull Requests panel in VS Code"
  1. read_screen()  → "VS Code open. GitHub PR icon at (48, 380)."
  2. move_mouse(48, 380)
  3. left_click()
  4. "Done — the GitHub Pull Requests panel is now open."
```

**macOS note:** Screen Recording permission must be granted in System Settings → Privacy & Security → Screen Recording.

---

## Voice Input

Push-to-talk voice input is built into the mic orb in the assistant popup.

**Flow:**
1. Click the mic orb → `getUserMedia()` starts recording; audio bars go live.
2. Click again to stop → `MediaRecorder` produces `audio/webm;codecs=opus`.
3. Audio is sent to the main process → OpenAI Whisper (`whisper-1`) transcribes it.
4. Transcript appears in the bubble; the agent streams its reply.

**Tier routing:**

| Tier | Backend |
|---|---|
| `free` + `WHISPER_CPP_PATH` set | Local `whisper.cpp` binary |
| `free` + no binary | Actionable upgrade message |
| `pro` / `enterprise` | OpenAI Whisper API |

Voice also powers the **AI Interviewer** (see below) where the assistant both listens and speaks back with synthesised audio.

---

## GitHub PR Review

Say **"Review my PRs"** or **"Review pull requests"** and OpenUI triggers a dedicated PR review session:

- **Model:** always `claude-sonnet-4-6` (pro), regardless of the user's current tier in the UI.
- **Turn budget:** up to 32 turns (list + diff × N + comment × N).
- **System prompt:** strict reviewer mandate — outputs structured markdown per PR.

**Tools registered** (`src/main/github.ts`):

| Tool | Description |
|---|---|
| `list_open_prs(repo?)` | Fetch up to 30 open PRs, sorted by most-recently-updated |
| `get_pr_diff(repo, pr_number)` | Raw unified diff, capped at 24 000 chars |
| `post_pr_comment(repo, pr_number, body)` | Post a markdown review comment via GitHub Issues API |

**Each posted review follows this format:**

```markdown
## OpenUI Automated Code Review
**Decision: [APPROVE / REQUEST CHANGES / COMMENT ONLY]**
### Bugs
### Security Issues
### Architecture
### Verdict
```

**Setup:**
```env
GITHUB_TOKEN=ghp_...      # repo read + write:discussion scopes
GITHUB_REPO=owner/repo    # optional default; can also be supplied in the chat prompt
```

**Security:** repo names validated against `^[\w.-]+\/[\w.-]+$`; diff capped; comment capped at 65 536 chars (GitHub limit); never merges or closes PRs.

---

## Figma Design Tools

OpenUI can inspect Figma files, export frames, analyse them with Claude Vision, and post comments back to Figma — all from the chat UI.

**Tools registered** (`src/main/figma.ts`):

| Tool | Description |
|---|---|
| `get_figma_file(file_key)` | File name, last-modified, and full top-level frame inventory with node IDs |
| `export_figma_frames(file_key, node_ids?)` | PNG export + Claude Vision analysis: layout, colour/contrast, typography, accessibility, 3–5 improvement suggestions |
| `create_figma_comment(file_key, message, node_id?)` | Post AI-generated design feedback directly in Figma (optionally anchored to a frame) |

**Example workflow:**

```
User: "Review my Figma mockups"
  1. get_figma_file(key)          → frame inventory
  2. export_figma_frames(key)     → Vision analysis of top 3 frames
  3. create_figma_comment(key, …) → feedback posted in Figma
  4. "Here's the design review…"
```

**Setup:**
```env
FIGMA_TOKEN=figd_...        # Figma personal access token
ANTHROPIC_API_KEY=sk-ant-… # for Vision analysis
```

**Security:** file keys validated; node IDs validated; image download capped at 10 MB; max 3 frames per call; HTTPS-only downloads.

---

## Autonomous Coding Mode

When you're away or busy, OpenUI's autonomous coding agent works through a task list in the background — no user in the loop.

### How it works

1. **Task source** — reads from `todo.json` in the sandbox workspace (or GitHub Issues when `GITHUB_REPO` is set).
2. **Coding loop** — for each pending task: write files → run `npm test` → read output → fix and iterate (up to 20 turns per task, 5 tasks per idle window).
3. **Sandbox** — all file operations are confined to `<userData>/autonomous-workspace` (or `OPENUI_WORKSPACE`). Path traversal is blocked at the API level. The test command is static (`npm test`) — the model never supplies it.
4. **Status** — streamed to the renderer via `openui:autonomous:status` and shown in the TaskListPopup "Background Agent" banner.

### Coding tools (separate registry — desktop tools excluded)

| Tool | Description |
|---|---|
| `write_file(path, content)` | Create or overwrite a file; parent dirs created automatically |
| `read_file(path)` | Read a file (capped at 16 000 chars) |
| `list_files()` | List all workspace files |
| `run_tests()` | Run `npm test` in the workspace; returns `TESTS PASSED` / `TESTS FAILED` + full output |

### Task sources

| Source | Config | Behaviour |
|---|---|---|
| `todo.json` | Default (no config) | Reads `{ tasks: [{ id, title, description?, status }] }`; writes back `done`/`failed` |
| GitHub Issues | `GITHUB_REPO` env var | Fetches open issues as tasks; outcomes mirrored locally — **never writes to GitHub** |

---

## AI Interviewer

OpenUI can conduct structured technical screening interviews using voice — ask questions, listen to the candidate's answers, and generate a structured evaluation.

**How to start:** type or say "Start interview" and provide a job description and resume.

**Session structure (10 turns):**
1. Warm opener about background
2–4. Technical skills and relevant experience
5–6. Situational / problem-solving question
7–8. Behavioural (STAR format)
9–10. Role-fit and motivation
- Closing: thank-you + "any questions for me?"

The interviewer speaks each question aloud using Text-to-Speech synthesis and listens for the candidate's voice response via OpenAI Whisper. Sessions require `ANTHROPIC_API_KEY` (for Claude question generation) and `OPENAI_API_KEY` (for Whisper + TTS).

---

## Auth & Subscription Gating

### Sign-in flow

1. Click **Sign in with Google** → system browser opens Google OAuth via Supabase.
2. Supabase redirects to `openui://auth/callback?access_token=…`.
3. macOS routes the deep-link back to the running app → user row written to SQLite → `openui:auth-success` pushed to renderer → `AuthContext` updates.

### Tiers

| Tier | Cloud messages/day | Models | Voice | Screen Vision |
|---|---|---|---|---|
| **Free** | 20 | claude-3-5-haiku | whisper.cpp local only | Tesseract OCR |
| **Pro** | 500 | claude-sonnet-4-6 | OpenAI Whisper API | Claude Vision |
| **Enterprise** | Unlimited | claude-sonnet-4-6 (GLM in local dev) | OpenAI Whisper API | Claude Vision |

Tier is resolved server-side (`chat-proxy` reads `app_metadata.tier` from the Supabase JWT) — the renderer's tier hint cannot be spoofed. SQLite caches the tier for up to 24 hours so the app works offline.

### Stripe subscription lifecycle

- **Upgrade:** `window.openui.checkout(priceId)` → `create-checkout` Edge Function → Stripe hosted checkout.
- **Manage/cancel:** `window.openui.manageSubscription()` → `customer-portal` Edge Function → Stripe Billing Portal.
- **Webhook:** Stripe fires to `stripe-webhook` Edge Function → `subscriptions` table updated → `getTierForUser()` picks it up on next call.

---

## Telemetry & Privacy

OpenUI ships an **opt-in only** analytics layer built on PostHog. Nothing is collected — and the PostHog client is never initialised — until the user explicitly grants consent.

### First-launch consent

On first run, a `ConsentModal` offers **Allow Analytics** and **Skip** — both buttons are the same size (no dark patterns). Choosing **Skip** permanently records `DENIED` in the `settings` table; the prompt never reappears. The choice is always reversible from the Settings gear icon.

### What IS collected (only after opt-in)

- App opens, closes, crashes, version, and auto-update events
- Feature usage: which tools run, which models/tiers are selected, voice and vision usage
- Performance: response latency, tool execution time, token counts
- Subscription tier, OS platform, app version
- A random anonymous device id (replaced by Supabase user id after sign-in)

### What is NEVER collected

- Chat messages or voice recordings (only lengths/counts, never content)
- File or screen contents, OCR text, screenshots
- Personal data beyond the post-login user id
- API keys or environment secrets

### Changing the choice later

Settings (gear icon) → **Anonymous Usage Analytics** toggle.

```env
POSTHOG_API_KEY=phc_...    # leave unset to disable telemetry build-wide
```

---

## Auto-Updater

OpenUI uses `electron-updater` backed by GitHub Releases.

| Platform | Behaviour |
|---|---|
| **Windows** | Checks on startup (+30 s), every 4 hours, and on focus. If an update is found, a slim `UpdateBanner` appears. User clicks **Download** → progress bar → **Restart & Install**. |
| **macOS** | Same check schedule. Because the current build is unsigned, in-app install is not possible. **Open Download Page** opens the GitHub Releases page in the user's browser. |

Update events are tracked via telemetry (`UPDATE_AVAILABLE`, `UPDATE_DOWNLOADED`, `UPDATE_INSTALL_RESTART`, `UPDATE_ERROR`).

---

## Onboarding & Cloud-First Routing

### First-run wizard

New users walk through a 4-step onboarding wizard before the chat interface appears:

| Step | Content |
|---|---|
| 1. Welcome | Product intro, animated entrance |
| 2. Sign In | Google OAuth — cannot be skipped |
| 3. Tour | Feature highlights with interactive callouts |
| 4. First Chat | Type or speak a first message; transitions to the main chat |

Step completion and timing are tracked via telemetry (`onboarding_started`, `onboarding_step_reached`, `onboarding_completed`).

### Cloud-first routing

The product promise is **launch it and it works — no account screen, no Ollama, no local setup**. On first launch the app mints a silent **anonymous Supabase session** (`ensureGuestSession` in `sessionManager.ts`); that token is all the `chat-proxy` Edge Function needs to serve the free tier, so cloud Claude is available immediately. Signing in with Google later is an optional upgrade that syncs the plan/preferences and unlocks Pro — never a gate.

> **Ops note:** anonymous sessions require **Authentication → Sign In / Providers → Anonymous sign-ins = enabled** in the Supabase dashboard. If it's disabled, `ensureGuestSession` no-ops and unsigned users fall back to whatever local model is present.

Local AI (Ollama) is a hidden power-user path only — auto-detected and routed to if it happens to be running, but never advertised as something to install:

- `LocalAIStatus` shows the active plan ("Cloud AI · 20 messages/day free"), or "Local AI · Unlimited" when an Ollama server is detected.
- `OllamaSuggestion` is disabled (no install prompts).
- The **daily usage counter** (`UsageCounter`) shows "15/20 messages today" drawn from `x-ratelimit-remaining` headers returned by `chat-proxy`.

A 429 from the proxy triggers a friendly upsell message and `TierUpgradeModal` — never a raw error.

---

## Building for Distribution

```bash
# Windows (run on Windows)
npm run build:win    # → dist/OpenUI.Setup.exe (NSIS x64 + ia32)

# macOS (run on macOS)
npm run build:mac    # → dist/OpenUI.dmg (universal arm64 + x64)
```

**Signed releases** require the following GitHub Actions secrets (Settings → Secrets and variables → Actions):

| Secret | Platform | Description |
|--------|----------|-------------|
| `CSC_LINK` | macOS | Base64-encoded Developer ID Application `.p12` cert (`base64 -i cert.p12 \| pbcopy`) |
| `CSC_KEY_PASSWORD` | macOS | Passphrase for the `.p12` |
| `APPLE_ID` | macOS | Apple ID email used for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | macOS | App-specific password from [appleid.apple.com](https://appleid.apple.com) |
| `APPLE_TEAM_ID` | macOS | 10-character Team ID from [developer.apple.com/account](https://developer.apple.com/account) |
| `WIN_CSC_LINK` | Windows | Base64-encoded EV/OV `.pfx` cert |
| `WIN_CSC_KEY_PASSWORD` | Windows | Passphrase for the `.pfx` |

All signing secrets are optional — if absent, builds succeed but ship unsigned (Gatekeeper / SmartScreen warnings apply).

**Icon generation** runs automatically on `npm install` via `scripts/convert-icon.js` (synthesises a 1024×1024 orb PNG, emits `.ico` and `.icns` — no external tooling required).

**Native modules** (`@nut-tree-fork/nut-js`, `better-sqlite3`) are rebuilt against the target Electron ABI by `electron-builder`'s `npmRebuild: true` setting. On macOS, run `npx electron-rebuild` after install to compile `better-sqlite3` locally.

**Deep-link + single-instance:** the packaged app registers `openui://` as a protocol handler and acquires a single-instance lock — duplicate tray icons are impossible, and OAuth callbacks are routed back to the running instance.

---

## Security Model

### Trust boundaries

| Boundary | What is trusted |
|---|---|
| Renderer → Preload | Only `window.openui` methods exposed via `contextBridge` |
| Preload → Main | IPC payloads validated (type, size, allowlist) in every `ipcMain.handle` |
| Main → LLM | Tool arguments validated (required keys, JSON types, enums) before execution |
| LLM → OS | AppleScript uses `asStringLiteral()` escaping; `search_files` uses `execFile` (no shell) |
| Cloud → Main | Supabase JWT verified; tier read from `app_metadata` (server-authoritative) |
| Stripe → Supabase | Stripe signature verified before trusting any webhook payload |

### Content Security Policy

Applied to every renderer response via `session.webRequest.onHeadersReceived`. Production: `default-src 'self'`, `script-src 'self'`, `object-src/frame-src 'none'`. Dev mode relaxes it for Vite HMR only.

### What the autonomous coding agent can and cannot do

The autonomous coding agent has access **only** to `write_file`, `read_file`, `list_files`, and `run_tests`. Desktop-automation tools (`move_mouse`, `open_app`, `read_screen`, etc.) are not in its registry. All file paths are sandbox-checked; the test command is a static string (no model-supplied shell commands).

---

## Supabase Edge Functions

Six Deno Edge Functions live in `supabase/functions/`:

| Function | Purpose |
|---|---|
| `chat-proxy` | Cloud-first chat: verify JWT → check daily limit → proxy to Anthropic/OpenAI → normalised SSE |
| `create-checkout` | Create Stripe Checkout Session |
| `customer-portal` | Create Stripe Billing Portal session |
| `check-subscription` | Return live `{ tier, status, currentPeriodEnd }` |
| `stripe-webhook` | Handle Stripe events → update `app_metadata.tier` |
| `waitlist` | Proxy waitlist email to Mailchimp (keeps API key server-side) |

Stripe secret key and Supabase service-role key never leave the Edge Functions. The Electron app only holds the Supabase anon key.

```bash
supabase functions deploy chat-proxy
supabase functions deploy create-checkout
supabase functions deploy customer-portal
supabase functions deploy check-subscription
supabase functions deploy stripe-webhook --no-verify-jwt
supabase db push   # creates the usage_tracking table
```

---

## Runtime Dependencies

| Package | Version | Role |
|---|---|---|
| `@anthropic-ai/sdk` | ^0.40.0 | Claude models, streaming, Vision |
| `openai` | ^4.0.0 | Whisper transcription, TTS, GLM fallback |
| `ollama` | ^0.5.0 | Local LLM client (optional) |
| `@supabase/supabase-js` | ^2.108.2 | Auth, Edge Function calls, JWT refresh |
| `better-sqlite3` | ^12.11.1 | Local persistence (users, conversations, messages, settings) |
| `electron-updater` | ^6.8.9 | GitHub Releases auto-update |
| `posthog-node` | ^4.18.0 | Privacy-first analytics |
| `@octokit/rest` | ^20.0.0 | GitHub PR tools |
| `@nut-tree-fork/nut-js` | ^4.2.0 | Cross-platform mouse/keyboard automation |
| `node-osascript` | ^2.1.0 | macOS AppleScript execution |
| `tesseract.js` | ^5.1.0 | Free-tier OCR fallback |
| `gsap` | ^3.12.5 | UI animations |
| `react` / `react-dom` | ^18.3.1 | Renderer UI |
| `playwright` | ^1.44.0 | (available for future browser automation tools) |

All heavy native packages (`@nut-tree-fork/nut-js`, `tesseract.js`, `node-osascript`) are lazy-loaded at call time — the bundle builds cleanly even when they are absent.

---

## License

MIT — see [LICENSE](LICENSE).
