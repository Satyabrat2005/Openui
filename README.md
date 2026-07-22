<p align="center">
  <img src="resources/icon.png" width="88" alt="OpenUI">
</p>

<h1 align="center">OpenUI</h1>
<p align="center"><b>A local-first AI copilot that lives in your menu bar</b><br>
Chat, control your desktop, browse the web, and ship code — powered by a model running on <i>your</i> machine.</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License">
  <img src="https://img.shields.io/badge/version-7.1.1-informational.svg" alt="Version 7.1.1">
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS-lightgrey.svg" alt="Windows | macOS">
  <img src="https://img.shields.io/badge/engine-Ollama-000000.svg" alt="Ollama powered">
  <a href="https://github.com/Satyabrat2005/Openui/actions/workflows/pr-check.yml"><img src="https://github.com/Satyabrat2005/Openui/actions/workflows/pr-check.yml/badge.svg" alt="PR Check"></a>
</p>

---

OpenUI is an Electron + React desktop app that sits in your tray and does real work: it can operate your OS (open apps, click, type, read the screen via OCR), automate the browser, review and push code to GitHub, manage your calendar, and rewrite your files — all driven by a local Ollama model, with no API key, no sign-up, and no message limit to get started.

## Contents

[Why it's different](#why-its-different) · [Quick start](#quick-start) · [What it can do](#what-it-can-do) · [Three flavors of multi-agent](#three-flavors-of-multi-agent) · [Model routing](#model-routing) · [Security & trust](#security--trust) · [Building from source](#building-from-source) · [Docs](#further-reading)

## Why it's different

| | |
|---|---|
| **Local by default** | Every chat, plan, and coding turn streams from Ollama on your own hardware. No cloud key is required to use the app fully. |
| **A real desktop agent** | Mouse/keyboard control, screenshots + OCR, clipboard, and a home-directory-confined filesystem — not just a chat window. |
| **Three separate multi-agent systems** | Conversational fan-out, git-worktree-isolated coding subagents, and an idle-time autonomous coding loop — each scoped to what it's actually good at. |
| **Guarded, not just capable** | Per-site browser consent + content sanitization, human-gated GitHub writes, path-confined sandboxes, and opt-in (not opt-out) telemetry. |
| **One clean codebase** | A single TypeScript/Electron tree — the earlier disconnected Python prototype and three experimental backend stacks have been removed entirely. |

## Quick start

```bash
git clone https://github.com/Satyabrat2005/Openui.git
cd Openui
npm install

# OpenUI needs a local Ollama server for chat + coding
ollama pull qwen3.5           # general chat / planning
ollama pull qwen2.5-coder:7b  # autonomous coding agent

npm run dev
```

That's it — no `.env` file is required to start chatting. `.env.example` documents optional integrations (voice, calendar, GitHub tokens, hosted cloud tier) that layer on top.

## What it can do

| Category | Capabilities |
|---|---|
| **Desktop control** | Open/close/list apps; full mouse control (move, left/right/double-click, wheel scroll in native apps); keyboard automation (type text **and** OS-level shortcuts like Ctrl+C, Alt+Tab, Win, F5); screenshots with OCR (Tesseract); clipboard read/write; filesystem tools confined to the home directory with human-in-the-loop confirmation on destructive actions |
| **Browser automation** | Playwright-driven browsing that asks per-site consent before automating a new domain, sanitizes page content pulled into context, and falls back to an in-page vision pass when structured extraction fails |
| **GitHub** | 9 tools — read (list open PRs, get PR diff, post PR comment) and write (check/create repo, update README, push files, open PR, merge). Opening and merging a PR is **always** a human click, regardless of autonomy level |
| **Coding** | `edit_file`, `search_code`, local `git` tools, and a per-project **semantic codebase index** (HNSW vector search over a `.gitignore`-aware, incrementally re-embedded store) via `search_codebase_semantic` |
| **Voice** | Push-to-talk capture, Whisper transcription, ElevenLabs/OpenAI text-to-speech |
| **Productivity** | Native spreadsheet automation (read/write/update cells/formulas via exceljs), Google Calendar invites, an interactive `run_python`, and `research_web` — citation-backed web research over the connected browser with no API key |
| **Documents & design** | PDF parsing, Figma design review |
| **MCP** | Ships as an MCP client — bring your own Model Context Protocol servers (the included `mcp-config.json` is a fully commented-out template; zero servers are wired up out of the box) |

## Three flavors of multi-agent

OpenUI doesn't have one "multi-agent mode" — it has three, each shaped for a different job:

| System | Kicks in when | Isolation model | What it's for |
|---|---|---|---|
| **Conversational subagents** | You ask for several independent things at once | Tool-restricted, up to 4 running concurrently via `Promise.all` | "Check my inbox and also summarize this PDF" |
| **Coding subagents** | You ask for parallel code changes | One **git worktree per subtask**, dependency-ordered scheduling, a per-worker verify gate | Larger refactors split into independent, conflict-safe pieces, merged back serially |
| **Autonomous Coding Mode** | You step away (idle ≥ 5 min) or flip "I'm busy" | A confined sandbox workspace under a visible `~/OpenUI Projects` folder (VS Code opens automatically on the first write) | Pulls a task from `todo.json` or GitHub Issues, then writes code → runs the full test suite → debugs → iterates (≤ 5 tasks per idle window) — and pauses the instant you're back |

All local generation — interactive or autonomous — is serialized through a single-flight lock (`ollamaLock.ts`), since the default hardware target is one 8 GB-VRAM GPU that holds one model at a time.

## Model routing

By default OpenUI is **Ollama-only**: chat, planning, and the coding agent all resolve against whatever compatible model `ollama list` reports, with `qwen3.5` and `qwen2.5-coder:7b` as the expected pair.

An optional **cloud tier** (Anthropic/OpenAI, billed via Stripe + Supabase) exists in the codebase for teams that want a hosted option, but it ships **off**. Turning it on requires all three of:

1. `OPENUI_ENABLE_CLOUD=1` at build/run time (the master switch, off by default),
2. the in-app Settings toggle, and
3. a real API key.

With all three set, tiers and daily cloud-message limits look like this:

| Tier | Price | Cloud messages/day | Notes |
|---|---|---|---|
| Free | $0 | 5 | Local Ollama use is always unlimited regardless of tier |
| Pro | $19/mo | 500 | |
| Enterprise | $49/mo | Unlimited | Adds premium/frontier models |

## Security & trust

- **Browser automation** asks consent per site and sanitizes scraped content before it reaches the model (`browser/consent.ts`, `browser/sanitizer.ts`).
- **GitHub writes** (`open_pull_request`, `merge_pr`) are human-gated no matter what autonomy level is active.
- **Autonomous coding** is contained, not sandboxed against hostile code: paths are confined to the workspace, writes are capped at 512 KB/file, `npm test` runs with a 120 s timeout, and the background loop has zero desktop-control tools — it cannot move a mouse or launch another app.
- **Telemetry is opt-in** (PostHog) and **crash reporting is dual-gated** — a Sentry DSN must be configured *and* the user must consent — with PII scrubbed before anything is sent.
- A broken-object-level-authorization (IDOR) bug in the `create-checkout`, `check-subscription`, and `customer-portal` billing edge functions — which read `userId` straight from an unauthenticated request body — is fixed, brought in line with `chat-proxy`'s existing token-verified user check.
- 136 tests passing, clean `tsc --noEmit`, covering the tool-execution trust boundary, agent loop, and persistence layer.
- MIT licensed, single TypeScript/Electron codebase — no orphaned prototype trees shipping alongside the real app.

## Building from source

```bash
npm run typecheck      # tsc --noEmit
npm run test           # vitest run
npm run fetch:ocr-langs # download bundled OCR language packs → ./tessdata
npm run build:mac      # electron-vite build && electron-builder --mac
npm run build:win      # electron-vite build && electron-builder --win
```

Every PR runs typecheck/test/build in CI (`.github/workflows/pr-check.yml`); tagged releases build signed macOS + Windows installers (`.github/workflows/release.yml`). Local semantic-search/RAG indexing (`hnswlib-node`) ships **macOS-only** — it's stripped from Windows builds due to native ABI constraints.

**Screen OCR languages.** Free-tier screen reading uses local Tesseract OCR. The trained-data packs (English, Spanish, French, German, Portuguese, Hindi, Japanese, Chinese — ~16 MB total) are gitignored binaries fetched by `npm run fetch:ocr-langs` into `./tessdata`; `build:mac`/`build:win` run this automatically before packaging. Pick a language (or **Auto**, which follows the OS locale) under **Settings → Screen OCR language**; a non-English UI whose pack isn't installed fails with a clear message instead of returning garbage English OCR.

## Further reading

| Doc | Covers |
|---|---|
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | Deep dive on the agent loop, tool registry, and process boundaries |
| [`ENGINEERING_HIGHLIGHTS.md`](./ENGINEERING_HIGHLIGHTS.md) | Notable implementation details, with file/line pointers |
| [`CHANGELOG.md`](./CHANGELOG.md) | Version history |
| [`docs/DEMO_RUNBOOK.md`](./docs/DEMO_RUNBOOK.md) | Steps for a reliable live demo |
| [`docs/INSTALL-MACOS-BETA.md`](./docs/INSTALL-MACOS-BETA.md) | macOS beta install instructions |
| [`supabase/functions/README.md`](./supabase/functions/README.md) | The edge functions behind the optional cloud tier |

## License

MIT © OpenUI, 2025
