# OpenUI — Architecture Reference

## Phase Status

| Phase | Scope | Status |
|---|---|---|
| **Phase 1** | UI shell — transparent overlay, tray icon, GSAP animations, static components | **Complete** |
| **Phase 2** | Agent backend — model router, streaming IPC, tool-calling, conversation history | **Complete** |
| **Phase 2.5** | OS automation — macOS tools (`tools.ts`), in-main agentic tool-execution loop, live `TaskListPopup` via IPC | **Complete** |
| **Phase 3** | UI wiring — functional chat input, live transcript, real audio bars | **Complete** |
| **Phase 4** | Screen vision — `read_screen()` tool: `desktopCapturer` capture, Claude Vision (pro/enterprise), Tesseract.js OCR (free) | **Complete** |
| **Phase 5** | Voice input — push-to-talk mic, MediaRecorder + AnalyserNode, Whisper transcription, auto-route to agent | **Complete** |
| **Phase 6** | macOS permission hardening — pre-flight OS permission checks, graceful degradation, in-app System Settings modal, unhandled-rejection fixes | **Complete** |
| **Distribution** | `electron-builder` Windows NSIS (`x64`+`ia32`) + macOS DMG (`arm64`+`x64`); `build:win` / `build:mac` scripts; generated `.ico` / `.icns` via `scripts/convert-icon.js`; `openui://` deep-link + single-instance lock; comprehensive README | **Complete** |
| **Phase 7** | Auth + subscription gating — Google OAuth via Supabase, SQLite persistence, tier-based model routing, Stripe checkout, voice tier routing, `AuthContext`, `TierUpgradeModal`, `ConversationList` | **Complete** |
| **Sub-Phase 4** | Telemetry & privacy — PostHog analytics (4A core, 4B event instrumentation), opt-in privacy consent layer with `ConsentModal` + Settings toggle (4C) | **Complete** |
| **Phase 10** | GitHub PR review — `github.ts` tool module (`list_open_prs`, `get_pr_diff`, `post_pr_comment` via `@octokit/rest`), `PR_REVIEW_RE` trigger in `agent.ts`, strict `PR_REVIEW_SYSTEM_PROMPT`, forced Claude Sonnet (pro tier), 32-turn budget for multi-PR sessions | **Complete** |
| **Onboarding Phase A** | Cloud-only routing — every tier works with no local setup via the `chat-proxy` Edge Function (our keys, server-side), per-tier daily/monthly limits (`usage_tracking`), no local-model routing path anywhere, live usage counter | **Complete** |
| **MCP Integration** | Model Context Protocol client (`mcp-client.ts`) — connects to external stdio/SSE tool servers, merges their tool schemas into the agent loop, IPC handler `openui:mcp:connect`, config via `mcp-config.json` | **Complete** |

---

## 1. Project Structure

```
C:\Users\Ashu\Documents\OpenUI\
├── design.html                          # Original UI reference (read-only)
├── package.json                         # npm config; postinstall generates tray icons
├── electron.vite.config.ts              # Three-bundle build: main / preload / renderer
├── tsconfig.json                        # Strict TS, moduleResolution: Bundler, jsx: react-jsx
├── tailwind.config.js                   # content: src/renderer/src/**
├── postcss.config.js
├── ARCHITECTURE.md                      # This file
├── .gitignore
├── resources/                           # Generated tray icon PNGs (via postinstall)
│   ├── tray.png                         # 16×16 coloured orb (Windows / Linux)
│   ├── tray@2x.png                      # 32×32 coloured orb
│   ├── trayTemplate.png                 # 16×16 monochrome (macOS template image)
│   └── trayTemplate@2x.png             # 32×32 monochrome
├── scripts/
│   └── generate-tray-icon.cjs          # Pure-Node PNG generator (zlib only)
└── src/
    ├── main/
    │   ├── index.ts                     # Electron main: Tray + BrowserWindow + IPC bootstrap
    │   ├── agent.ts                     # LLM agent: model router, streaming, agentic tool-exec loop
    │   ├── voice.ts                     # Phase 5: Whisper transcription + voice IPC handler
    │   └── tools.ts                     # OS automation tools + JSON schemas + dispatcher
    ├── preload/
    │   └── index.ts                     # contextBridge — exposes window.openui to renderer
    └── renderer/
        ├── index.html                   # Vite HTML entry point
        └── src/
            ├── main.tsx                 # React entry — no StrictMode (intentional)
            ├── App.tsx                  # Transparent overlay; recordingRef/captionLockedRef shared
            ├── index.css                # @tailwind directives + all ported popup CSS classes
            ├── env.d.ts                 # Global Window.openui type augmentation
            ├── components/
            │   ├── AssistantPopup.tsx   # Phase 3+5: voice recording, text input, live transcript
            │   └── TaskListPopup.tsx    # React port of #task-popup; live rows from onTask/onTaskReset
            └── hooks/
                └── useAssistantAnimations.ts  # GSAP entrance + mic-pulse + sound-bar loops
```

### Build output (`out/` — gitignored)

```
out/
├── main/index.js          — Electron main process (CJS)
├── preload/index.js       — contextBridge shim (CJS)
└── renderer/
    ├── index.html
    └── assets/
        ├── index-*.css    — Tailwind utilities + popup CSS
        └── index-*.js     — React + GSAP + all components
```

### Key design decisions

| Decision | Rationale |
|---|---|
| **Single transparent overlay window** spanning the full work area | Lets CSS position the assistant popup (centred) and task list (bottom-right) exactly as designed, without per-popup windows or positioning math |
| **Custom CSS classes in `index.css`** (not Tailwind utilities) | `design.html` used hand-authored classes inside a `<style>` block; ported verbatim to avoid visual divergence |
| **No `React.StrictMode`** | StrictMode double-invokes effects in dev, which fires the GSAP entrance timeline twice |
| **Window hidden, never destroyed** | `win.hide()` / `win.show()` on tray toggle — avoids re-mounting React and replaying the entrance animation |
| **Tray icons generated at postinstall** | `scripts/generate-tray-icon.cjs` uses only `zlib` (stdlib) — no external image tooling required |
| **LLM clients instantiated per-call** | Guarantees environment variables are read at call time, not at module initialisation |
| **API keys stay in the main process** | `agent.ts` is never imported by the renderer — keys are read from `process.env` in Node and never cross the contextBridge |
| **`Tier` exported from `tools.ts`** | Both `agent.ts` and `tools.ts` need the type; defining it in `tools.ts` avoids a circular dependency |

---

## 2. Build System

### Dev / compile pipeline

electron-vite produces three separate Rollup/Vite bundles.

| Bundle | Entry | Output | Format | Node modules |
|---|---|---|---|---|
| `main` | `src/main/index.ts` | `out/main/index.js` | CJS | Externalised (loaded at runtime) |
| `preload` | `src/preload/index.ts` | `out/preload/index.js` | CJS | Externalised |
| `renderer` | `src/renderer/index.html` | `out/renderer/` | ESM | Bundled |

Because the main and preload bundles externalise `node_modules`, all runtime packages (`@anthropic-ai/sdk`, `openai`, `ollama`, `tesseract.js`, etc.) are loaded via `require()` at runtime — they are not bundled and do not affect the renderer bundle size.

**Runtime dependencies** (must be present in `node_modules` at launch):

```
@anthropic-ai/sdk        ^0.40.0   — Anthropic streaming Messages API + Vision
openai                   ^4.0.0    — OpenAI-compatible chat completions (used for GLM)
ollama                   ^0.5.0    — Ollama local model client
node-osascript           ^2.1.0    — AppleScript execution (macOS only; loaded lazily in tools.ts)
@nut-tree-fork/nut-js   ^4.2.0    — Cross-platform mouse/keyboard control (loaded lazily in tools.ts)
tesseract.js             ^5.1.0    — WebAssembly OCR for free-tier read_screen() (loaded lazily in tools.ts)
gsap                     ^3.12.5   — Animation library (renderer only)
react / react-dom        ^18.3.1   — UI (renderer only)
```

> `node-osascript`, `@nut-tree-fork/nut-js`, and `tesseract.js` are loaded with a runtime `require()` (not a static `import`) **inside** `tools.ts`, so the bundle still typechecks and builds when they are absent; a missing/unsupported package surfaces as a tool error rather than a crash.

> **Note:** `@nut-tree/nut-js` was removed from the npm registry; the project now depends on the drop-in fork `@nut-tree-fork/nut-js`. The lazy-loading logic in `tools.ts` tries both names so existing installs are not broken.

### Distribution pipeline (`npm run build:win` / `npm run build:mac`)

```
npm run build:win                            npm run build:mac
  │                                            │
  ├── electron-vite build → out/               ├── electron-vite build → out/
  └── electron-builder --win → dist/           └── electron-builder --mac → dist/
```

**electron-builder configuration** (in `package.json` → `"build"` key):

| Field | Value |
|---|---|
| `appId` | `com.openui.app` |
| `productName` | `OpenUI` |
| `directories.output` | `dist/` |
| `npmRebuild` | `true` — rebuild native `node_modules` (nut.js) against Electron's ABI |
| `asarUnpack` | `**/*.node` — keep native bindings outside the asar so they load at runtime |
| `extraResources` | `{ from: resources, to: resources }` — see note below |
| `win.target` | `nsis` — `x64` |
| `win.icon` | `resources/icon.ico` (generated; see *Icon generation*) |
| `win.artifactName` | `OpenUI.Setup.${version}.${ext}` → `dist/OpenUI.Setup.0.1.0.exe` |
| `nsis` | interactive installer: `oneClick: false`, `allowToChangeInstallationDirectory: true`, `shortcutName: OpenUI`, `uninstallDisplayName: OpenUI`, `license: LICENSE`, `installerLanguages: [en_US]`, `language: 1033` |
| `mac.category` | `public.app-category.productivity` |
| `mac.target` | `dmg` — `arm64` + `x64` |
| `mac.icon` | `resources/icon.icns` (generated when png2icons is installed) |

**Files packaged.** electron-builder always collects the production-`dependencies` subtree of `node_modules` automatically (verified in the build log: `@anthropic-ai/sdk`, `openai`, `ollama`, `tesseract.js`, `@nut-tree-fork/*`, `node-osascript` are all packed; dev-dependencies and the orphaned `better-sqlite3` are not). The explicit `files` array additionally includes `out/**/*` (compiled bundles), `resources/**/*`, and `package.json` (read at runtime for the `main` entry point).

> **`extraResources` (runtime resource path).** `resourcePath()` in `index.ts` resolves packaged assets from `process.resourcesPath/resources/…`. The `files` array only places `resources/` *inside* the asar, which `process.resourcesPath` does not point at — so without `extraResources` the tray icon would be missing in the installed app. `extraResources: [{ from: 'resources', to: 'resources' }]` copies the folder to `<app>/resources/resources/`, exactly where `resourcePath()` reads it.

> **`nodeGypRebuild` is intentionally NOT set.** It runs `node-gyp rebuild` against a `binding.gyp` in the project root; OpenUI has no first-party native addon (its only native dependency, nut.js, ships prebuilt binaries), so enabling it would fail the build with "binding.gyp not found". `npmRebuild: true` is the correct switch for rebuilding native modules that live in `node_modules`.

### Icon generation (`scripts/convert-icon.js`)

OpenUI ships no branded source art, so `scripts/convert-icon.js` synthesises a 1024×1024 "orb" PNG (`resources/icon.png`) with Node's `zlib` alone, then emits `resources/icon.ico` (and `resources/icon.icns` on installs that have the optional `png2icons` dev-dependency). The script prefers `png2icons` when present and otherwise falls back to a built-in multi-size PNG-in-ICO encoder (16–256 px; the 256 px entry satisfies electron-builder's minimum-icon-size check). It runs on `postinstall` and via `npm run icons`, so the icons exist before any packaging step — including on the `windows-latest` CI runner.

### Deep linking & single-instance (`index.ts`)

The packaged Windows app registers `app.setAsDefaultProtocolClient('openui')` and acquires `app.requestSingleInstanceLock()`. Windows delivers an `openui://…` launch as a `process.argv` entry to a *second* process; the `second-instance` handler extracts that URL and forwards the existing window (macOS instead emits `open-url` on the original process). The single-instance lock also prevents a duplicate tray icon. `handleDeepLink()` is currently a window-surfacing stub — the OAuth/auth consumer is not part of this build — and is the integration point for the future auth callback.

### Cross-platform notes

Each installer must be built on its target OS: the Windows `.exe` on Windows (platform-specific native-module binaries) and the macOS `.dmg` on macOS (Apple toolchain). Cross-compiling native modules is not supported. The cross-platform runtime features (chat, voice, `read_screen`, nut.js mouse/keyboard) work on both; the macOS-only tools (`open_app`, `search_files`, `control_calendar`) return a graceful unsupported-platform error elsewhere.

---

## 3. IPC Architecture

### Security model

```
Renderer (Chromium)         Preload (Node/Chromium bridge)      Main (Node)
────────────────────        ──────────────────────────────      ─────────────────
contextIsolation: true  →   contextBridge.exposeInMainWorld  →  ipcMain handlers
nodeIntegration: false      (safe, enumerable API surface)       (full Node access)
sandbox: true               (OS-sandboxed renderer process)      (validates all input)
```

The renderer never has access to Node APIs directly. All communication goes through `window.openui`, which is the object exposed by the contextBridge. LLM SDK imports, API keys, `process.env`, `desktopCapturer`, and tool execution are confined to the main process.

**Hardening (`applySecurityHardening()` in `index.ts`, run on `app.whenReady`):**

- **`webPreferences`** — `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`, `nodeIntegrationInWorker: false`.
- **Content-Security-Policy** — applied to every renderer response via `session.webRequest.onHeadersReceived`. Production is strict (`default-src 'self'`, `script-src 'self'`, `object-src/frame-src 'none'`, `base-uri/form-action 'none'`); the renderer makes no direct network calls, so nothing legitimate is blocked. Dev mode relaxes it for the Vite dev server / HMR only.
- **Navigation lock** — a global `web-contents-created` handler denies `window.open` (external `https://` links are handed to the OS browser via `shell.openExternal`), blocks `will-navigate` away from the app origin, and blocks `<webview>` attachment.

**IPC input validation.** Every channel treats the renderer payload as untrusted:

- `openui:chat` — `message` must be a non-empty string ≤ 16 000 chars; `tier` is coerced via `coerceTier()` (unknown ⇒ `free`).
- `openui:voice` — audio must be a non-empty byte view ≤ 25 MB; `mimeType` is matched against an audio MIME allowlist; `tier` coerced.
- `openui:permission:open-settings` — `permission` is checked against the `{accessibility, microphone}` allowlist before resolving a `shell.openExternal` deep-link.

### Channel reference

#### Renderer → Main (fire-and-forget via `ipcRenderer.send`)

| Channel | Sender | Handler | Effect |
|---|---|---|---|
| `openui:hide` | `App.tsx` (backdrop click / Escape) | `ipcMain.on` | `win.hide()` |
| `openui:quit` | (future quit button) | `ipcMain.on` | `app.quit()` |
| `openui:clear-history` | renderer | `ipcMain.on` | `history.length = 0` in `agent.ts` |
| `openui:voice` (invoke) | `AssistantPopup.tsx` | `ipcMain.handle` | Transcribes audio with Whisper, pushes `openui:voice:transcript`, then calls `handleChat()` |

#### Renderer → Main (request-response via `ipcRenderer.invoke`)

| Channel | Payload | Handler | Effect |
|---|---|---|---|
| `openui:chat` | `{ message: string, tier: 'free' \| 'pro' \| 'enterprise' }` | `ipcMain.handle` | Calls `handleChat()`, returns when streaming is complete |

#### Main → Renderer (push via `win.webContents.send`)

| Channel | Payload | When emitted |
|---|---|---|
| `openui:chat:chunk` | `string` (token delta) | On every streamed token from the LLM (every loop turn) |
| `openui:chat:tool` | `{ tool: string, args: Record<string, unknown> }` | Informational — when a tool call is detected; execution happens in main, renderer need not act |
| `openui:task:reset` | *(none)* | At the start of each chat turn — clears the task list |
| `openui:task:update` | `{ id, label, status: 'pending'\|'working'\|'done'\|'error', detail? }` | When a tool starts (`working`) and finishes (`done`/`error`) |
| `openui:chat:done` | `{ text: string, toolCall: null }` | After the agentic loop ends with a natural-language answer |
| `openui:chat:error` | `string` (error message) | On any LLM or network error (the whole turn is rolled back from history) |
| `openui:voice:transcript` | `string` (transcript text) | After Whisper returns successfully, before the agent starts streaming — renderer uses this to populate `#transcript-bubble` |

### Preload bridge (`src/preload/index.ts`)

```typescript
// Invoke a chat turn. Returns a Promise that resolves when the LLM stream ends.
// Streaming chunks arrive via onChunk() before the Promise resolves.
window.openui.chat(message, tier)

// Clear the in-memory conversation history.
window.openui.clearHistory()

// Subscribe to streaming events. Each method returns a cleanup function.
const off = window.openui.onChunk((delta: string) => { /* append to UI */ })
const off = window.openui.onToolCall((tool: ToolCallPayload) => { /* informational only */ })
const off = window.openui.onDone((result: ChatDonePayload) => { /* finalise UI */ })
const off = window.openui.onError((msg: string) => { /* show error */ })

// Voice input: send recorded audio, get transcript + streamed response.
await window.openui.transcribeAndChat(arrayBuffer, mimeType, tier)
const off = window.openui.onTranscript((text: string) => { /* populate #transcript-bubble */ })

// Live task list (consumed by TaskListPopup).
const off = window.openui.onTask((task: TaskUpdatePayload) => { /* upsert row by task.id */ })
const off = window.openui.onTaskReset(() => { /* clear all rows */ })
off() // call the returned function to remove the listener
```

The preload exports its API shape as `OpenUIApi` (re-derived from the `api` object via `typeof api`), which is mirrored verbatim in `src/renderer/src/env.d.ts` so the renderer has full TypeScript coverage of `window.openui`.

### Window visibility flow

```
Tray left-click  ──→  toggleWindow()  ──→  show (if hidden) | hide (if visible)
Tray right-click ──→  context menu    ──→  "Show / Hide OpenUI" calls toggleWindow()
Window blur      ──→  hideWindow()    ──→  only when app.isPackaged (DevTools usable in dev)
openui:hide IPC  ──→  win.hide()
openui:quit IPC  ──→  app.quit()
```

`app.on('window-all-closed', () => {})` is a deliberate no-op — keeps the app alive in the tray when the popup is hidden.

---

## 4. LLM Agent Backend (`src/main/agent.ts`)

### Model router — cloud-first (Onboarding Phase A)

The product promise: **sign in and it works — no local setup.** Every tier is
served **exclusively** by the cloud, via the `chat-proxy` Supabase Edge Function
which holds OUR LLM API keys server-side (`src/main/cloudFreeTier.ts`). There is
no local-model (Ollama) routing path anywhere in the app: nothing a user installs
on their own machine can change how a message is billed or capped. Free is 5
cloud messages/day and 120 voice minutes/month; Pro and Enterprise raise those
caps (see `src/main/stripe/pricing.ts`).

`callModel(win, tier, messages, systemPrompt)` is an async router:

```
callModel(tier)
  ├─ free:           → routeCloudOrDirect('free-default')
  ├─ pro:            → routeCloudOrDirect('pro-default')
  └─ enterprise:     → routeCloudOrDirect('enterprise-default')

routeCloudOrDirect(modelKey)
  ├─ isCloudProxyConfigured()  (Supabase env set AND a user is signed in)
  │     └─ true  → callCloudProxy(win, tier, messages, system, modelKey)   ← SHIPPED PATH
  │     └─ false → local-dev direct fallback (uses .env keys, unreachable in production):
  │                   enterprise → callEnterprise (GLM)
  │                   pro        → callAnthropic(DIRECT_PRO_MODEL = claude-sonnet-4-6)
  │                   free       → callAnthropic(DIRECT_FREE_MODEL = claude-3-5-haiku)
  │                                or a neutral "couldn't reach the AI service" message
```

`callCloudProxy` streams over the `openui:chat:chunk` channel, so the agentic loop
is provider-agnostic. It:

1. Resolves the signed-in user's Supabase access token (refreshing once if expired).
2. `fetch`es `${SUPABASE_URL}/functions/v1/chat-proxy` with `Authorization: Bearer <token>`,
   sending `{ messages, system, modelKey, stream: true }`.
3. Parses the normalized SSE (`data: {"delta":"…"}` … `data: [DONE]`) the Edge
   Function emits regardless of the underlying provider.
4. On **429** (daily limit hit) it does NOT error: it streams a friendly upsell,
   emits `openui:usage-update { remaining: 0 }`, and fires `openui:tier-upgrade-needed`.
5. Reads `x-ratelimit-{tier,limit,remaining}` headers and emits `openui:usage-update`
   → the renderer's `UsageCounter` shows "15/20 today".

The clients (`@anthropic-ai/sdk`, `openai`) are created inside their call
functions (not at module load), so env vars are read at first-request time.

### Cloud proxy + daily limits (`chat-proxy` Edge Function)

```
callCloudProxy (main)                       chat-proxy (Deno Edge Function, OUR keys)
─────────────────────                       ─────────────────────────────────────────
fetch /functions/v1/chat-proxy   ─────────▶ verify access token → user
  Authorization: Bearer <userJWT>           tier = user.app_metadata.tier  (authoritative)
  { messages, system, modelKey, stream }    count = usage_tracking[user, today]
                                            count ≥ DAILY_LIMIT[tier]?
                                              └─ yes → 429 { rate_limited, remaining:0, limit }
                                            resolveModel(modelKey, tier)  (gated to tier)
                                              ├─ anthropic → api.anthropic.com/v1/messages
                                              └─ openai    → api.openai.com/v1/chat/completions
                                            usage_tracking ++ (upsert count+1)
  normalized SSE  ◀───────────────────────  normalizeSSE(provider stream) + rate-limit headers
  data: {"delta":"…"} … [DONE]
```

`DAILY_LIMIT` in the function mirrors `dailyMessageLimit()` in `pricing.ts`
(Free 20, Pro 500, Enterprise unlimited). The `usage_tracking` table
(`supabase/migrations/001_create_usage_tracking.sql`) is keyed `(user_id, date)`
so the count resets each day. See `supabase/functions/README.md`.

### Streaming flow

```
window.openui.chat(msg, tier)               [renderer]
  │
  └─→ ipcRenderer.invoke('openui:chat', …)  [preload]
        │
        └─→ ipcMain.handle('openui:chat', …) [main]
              │
              └─→ handleChat(win, msg, tier) [agent.ts]
                    │
                    ├── push { role:'user', content } to history[]
                    ├── send('openui:task:reset')
                    │
                    └── loop (≤ MAX_TOOL_TURNS = 8):
                          │
                          ├── callModel (cloud proxy / direct Anthropic / Enterprise dev fallback)
                          │     └── for await (token of stream)
                          │           └── send('openui:chat:chunk', delta)
                          │
                          ├── push { role:'assistant', content } to history[]
                          │
                          ├── parseToolCall(responseText)
                          │     ├── none → finalText = response; BREAK
                          │     └── match:
                          │           ├── send('openui:chat:tool', toolCall)        (informational)
                          │           ├── send('openui:task:update', {…, working})
                          │           ├── result = executeTool(tool, args, { tier }) [tools.ts, in Node]
                          │           ├── send('openui:task:update', {…, done|error})
                          │           └── push { role:'user', content:'TOOL RESULT …' } to history[]
                          │                 (feeds the result back; loop continues)
                          │
                    ── after loop ──→ send('openui:chat:done', { text: finalText, toolCall: null })
```

The loop is the core of Phase 2.5: the model emits a tool call → the main process executes it with the current tier context → the textual result is pushed back as a `user` message → the model reasons about the next step, until it replies in plain language (or the 8-turn safety bound is hit).

On error: the **entire** turn is rolled back (`history.length = turnStart`, removing the user message and every assistant/tool message appended during the loop) and `openui:chat:error` is emitted.

### Tool-call detection (`parseToolCall`) & execution

After each model turn, `parseToolCall` checks whether the response is a standalone JSON object containing a `tool` (string) and `args` (object) key. If so it returns a `ToolCall`; otherwise `null` (final answer). The LLM is instructed via the system prompt to output tool calls as the **only** content in its response.

```typescript
// Detected when the entire response is exactly this shape:
{ "tool": "tool_name", "args": { ... } }
```

`executeTool(name, args, context)` dispatches through a registry, never throws, and returns `{ ok, output?, error? }`. The `context` carries the current `tier` so tier-sensitive tools (such as `read_screen`) can branch behaviour without an external configuration step.

### Conversation history

`history` is a module-level `Message[]` array (`{ role: 'user' | 'assistant', content: string }`). It persists for the lifetime of the Electron process (survives popup hide/show) and is shared across all tiers. `clearHistory()` resets it via `history.length = 0`. There is currently no persistence to disk — history is lost on app quit.

### System prompt

The system prompt is generated dynamically from `toolSchemas` at module load:

```
You are OpenUI, an intelligent desktop assistant running as a menu-bar app…

Available tools:
- open_app(appName: string) — …
- search_files(query: string) — …
- control_calendar(action: string (create|list), eventDetails?: object) — …
- move_mouse(x: number, y: number) — …
- left_click() — …
- type_text(text: string) — …
- read_screen() — …

Screen navigation workflow — use this when a task requires clicking UI elements
that have no AppleScript API (e.g. web-browser content, VS Code side-bar panels,
extension icons, or any Electron app):
1. Call read_screen() — returns description of every visible UI element with
   approximate X,Y coordinates.
2. Identify the target element's coordinates from the description.
3. Call move_mouse(x, y) to position the pointer over it.
4. Call left_click() to activate it.
```

### Environment variables

| Variable | Default | Used by |
|---|---|---|
| `SUPABASE_URL` | *(required for the cloud chat path)* | `callCloudProxy` (Edge Function URL), auth, sync |
| `SUPABASE_ANON_KEY` | *(required for the cloud chat path)* | `callCloudProxy` (`apikey` header), auth |
| `ANTHROPIC_API_KEY` | *(read_screen vision + local-dev chat fallback only)* | `read_screen`, `callAnthropic` fallback |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | `promptRefiner`'s internal self-improvement job only *(never used for chat)* |
| `GLM_BASE_URL` | `http://127.0.0.1:8080/v1` | `callEnterprise` *(dev fallback)* |
| `GLM_API_KEY` | `no-key` | `callEnterprise` *(dev fallback)* |
| `GLM_MODEL` | `glm-4` | `callEnterprise` *(dev fallback)* |

> In the **shipped** app every chat turn routes through `chat-proxy`, whose own
> `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` (Supabase secrets) are the source of
> truth for cloud chat. The local `ANTHROPIC_API_KEY` / `GLM_*` keys above only
> drive the dev fallback used before Supabase auth is wired up.

---

## 5. Tools (`src/main/tools.ts`)

### Exported types

| Export | Kind | Description |
|---|---|---|
| `Tier` | `type` | `'free' \| 'pro' \| 'enterprise'` — imported by `agent.ts` |
| `ExecutorContext` | `interface` | `{ tier: Tier }` — passed by the agent loop into every tool call |
| `ToolResult` | `interface` | `{ ok: boolean, output?: string, error?: string }` — uniform tool return shape |
| `ToolSchema` | `interface` | JSON-Schema-style descriptor used to generate the system-prompt tool list |
| `toolSchemas` | `ToolSchema[]` | Schema array; the single source of truth for what the LLM can call |
| `executeTool` | `function` | `(name, args, context?) => Promise<ToolResult>` — never throws |
| `describeToolCall` | `function` | Human-readable task-list label for each tool call |

### Tool registry

| Tool | Args | Mechanism | Platform | Notes |
|---|---|---|---|---|
| `open_app` | `{ appName: string }` | AppleScript `activate` via `node-osascript` | macOS | Calls `assertMac()` — returns an error on other platforms |
| `search_files` | `{ query: string }` | `mdfind` via `child_process.exec` | macOS | Returns up to 20 Spotlight matches |
| `control_calendar` | `{ action: 'create'\|'list', eventDetails?: {...} }` | AppleScript against Calendar.app | macOS | `create` requires `eventDetails.title`; dates are natural strings |
| `move_mouse` | `{ x: number, y: number }` | `@nut-tree-fork/nut-js` `mouse.setPosition` | cross-platform | Coordinates are absolute screen pixels |
| `left_click` | `{}` | `@nut-tree-fork/nut-js` `mouse.leftClick` | cross-platform | Clicks at the current pointer position |
| `type_text` | `{ text: string }` | `@nut-tree-fork/nut-js` `keyboard.type` | cross-platform | Synthesised keyboard input |
| `read_screen` | `{}` | `desktopCapturer` → Claude Vision or Tesseract.js | macOS† | See §5.1 below |

> † `read_screen` uses `desktopCapturer`, which is a main-process Electron API and works on all platforms; however the rest of the tool suite targets macOS, and Screen Recording permission must be granted on macOS 10.15+.

### 5.1 `read_screen()` — Phase 4 detail

```
read_screen()
  │
  ├── desktopCapturer.getSources({ types: ['screen'], thumbnailSize: 1920×1080 })
  │     └── sources[0].thumbnail.toPNG()  →  pngBuffer: Buffer
  │
  ├── tier === 'pro' | 'enterprise'
  │     └── Anthropic client (claude-sonnet-4-6, Vision)
  │           messages: [{ role:'user', content: [
  │             { type:'image', source:{ type:'base64', media_type:'image/png', data: base64 } },
  │             { type:'text',  text: 'Describe the UI elements and their X,Y coordinates.' }
  │           ]}]
  │           → TextBlock description returned to LLM
  │
  └── tier === 'free'
        └── tesseract.js  (lazy-loaded via requireFirst(['tesseract.js']))
              Tesseract.recognize(pngBuffer, 'eng', { logger: () => {} })
              → OCR text returned to LLM
```

**Screen Recording permission (macOS):** the Electron app must be granted permission in System Settings → Privacy & Security → Screen Recording. Without it, `desktopCapturer` returns sources with blank (black) thumbnails — Vision and OCR will both receive an empty image.

**Typical agent workflow for VS Code navigation:**

```
User: "open the team's pull requests in VS Code"
  │
  ├─ LLM → { "tool": "read_screen", "args": {} }
  │         TOOL RESULT: "VS Code window at center. Source Control icon at (48, 340).
  │                       GitHub Pull Requests panel icon at (48, 380)…"
  ├─ LLM → { "tool": "move_mouse", "args": { "x": 48, "y": 380 } }
  │         TOOL RESULT: "Moved pointer to (48, 380)."
  ├─ LLM → { "tool": "left_click", "args": {} }
  │         TOOL RESULT: "Performed a left click."
  └─ LLM → "I've opened the GitHub Pull Requests panel in VS Code."
```

### Lazy-loading pattern

`node-osascript`, `@nut-tree-fork/nut-js`, and `tesseract.js` are loaded with `requireFirst()` at call time rather than at module import. This means:
- The bundle typechecks and builds even when these packages are absent.
- A missing package surfaces as `{ ok: false, error: "Could not load…" }` in the tool result, which the agent can report to the user rather than crashing.
- `requireFirst` tries `@nut-tree/nut-js` then `@nut-tree-fork/nut-js` so both install names are supported.

---

## 6. Renderer (`src/renderer/`)

### Component tree

```
main.tsx
  └── <App>                         # Transparent overlay div; backdrop + Escape → hide
        ├── <AssistantPopup>        # Static UI: mic orb, sound bars, input strip, chips
        └── <TaskListPopup>         # Live: subscribes to onTask / onTaskReset
```

### `App.tsx`

- Renders a full-screen transparent `div.openui-overlay`.
- `onMouseDown` on the overlay itself (not its children) calls `window.openui.hide()`.
- A `keydown` listener on `window` calls `window.openui.hide()` on `Escape`.
- Passes a `ref` to `useAssistantAnimations` which drives all GSAP animation.

### `AssistantPopup.tsx`

Static React port of `#openui-popup` from `design.html`. No live state yet — all elements are markup placeholders pending Phase 3 wiring:

| Element | Current state | Phase 3 target |
|---|---|---|
| `.input-strip` | Static `<span>` placeholder | `<input>` that calls `window.openui.chat()` |
| `#caption-text` | GSAP typewriter (hardcoded string) | Live STT transcript or streaming LLM response via `onChunk` |
| `#sound-bars` (`.sbar` ×8) | Random heights every 150–240 ms via GSAP | Real audio levels from `getUserMedia` + `AnalyserNode` |
| `#mic-orb` | Visual only | Toggle recording on click |
| `.chip` buttons | Static markup | Fire predefined prompts via `window.openui.chat()` |
| `#transcript-bubble` | Hidden | Show assembled response from `onDone` |

### `TaskListPopup.tsx`

Fully live. Subscribes to `window.openui.onTaskReset` and `window.openui.onTask` in a single `useEffect`. Renders one row per tool call with a status indicator:

| Status | Indicator | Row background |
|---|---|---|
| `pending` | empty circle | default |
| `working` | CSS spinner (border animation) | `#f0f7ff` |
| `done` | green filled circle + check | default |
| `error` | red filled circle + ✕ | default |

A **Workflow complete / Workflow finished with errors** banner is conditionally rendered once all tasks have settled (`done` or `error`), with green/red styling respectively.

### `useAssistantAnimations.ts`

GSAP hook scoped to the overlay `ref`. Runs once on mount:

1. `#openui-popup` — fade + scale entrance at t=0.2 s
2. `#task-popup` — slide-up entrance at t=1.1 s
3. Mic pulse rings (`#ring-1/2/3`) — staggered outward wave, `repeat: -1`
4. Sound bars (`.sbar`) — stochastic random-height tween every 150–240 ms
5. `#caption-text` — typewriter at 55 ms/character from t=1.6 s

All timers and tweens are torn down via the returned cleanup function.

---

## 7. Renderer Type Surface (`src/renderer/src/env.d.ts`)

```typescript
interface ToolCallPayload {
  tool: string
  args: Record<string, unknown>
}

interface ChatDonePayload {
  text: string
  toolCall: ToolCallPayload | null
}

type TaskStatus = 'pending' | 'working' | 'done' | 'error'

interface TaskUpdatePayload {
  id: string
  label: string
  status: TaskStatus
  detail?: string
}

interface OpenUIApi {
  hide: () => void
  quit: () => void
  chat: (message: string, tier: 'free' | 'pro' | 'enterprise') => Promise<void>
  clearHistory: () => void
  onChunk:          (cb: (chunk: string) => void)              => () => void
  onToolCall:       (cb: (tool: ToolCallPayload) => void)      => () => void
  onDone:           (cb: (result: ChatDonePayload) => void)    => () => void
  onError:          (cb: (error: string) => void)              => () => void
  onTask:           (cb: (task: TaskUpdatePayload) => void)    => () => void
  onTaskReset:      (cb: () => void)                           => () => void
  // Phase 5 — voice input
  transcribeAndChat: (audio: ArrayBuffer, mimeType: string, tier: 'free' | 'pro' | 'enterprise') => Promise<void>
  onTranscript:     (cb: (text: string) => void)               => () => void
}

declare global {
  interface Window { openui: OpenUIApi }
}
```

---

## 8. Phase 3 + 5 — UI Integration (Complete)

| UI element | File | Status |
|---|---|---|
| `.input-strip` | `AssistantPopup.tsx` | **Done** — live `<input>` calling `window.openui.chat()` on Enter |
| `#caption-text` | `AssistantPopup.tsx` | **Done** — GSAP demo typewriter until first interaction, then imperative updates for voice states + streaming `onChunk` |
| `#sound-bars` | `AssistantPopup.tsx` | **Done** — random GSAP animation at rest; `AnalyserNode` rAF loop drives real audio levels during recording |
| `#mic-orb` | `AssistantPopup.tsx` | **Done** — toggle recording on click; turns red with stop icon while recording; disabled while busy |
| `.chip` buttons | `AssistantPopup.tsx` | **Done** — fire predefined prompts via `window.openui.chat()` |
| `#transcript-bubble` | `AssistantPopup.tsx` | **Done** — hidden until transcript available; shows user's spoken/typed input while agent streams its response |
| `#workflow-complete` | `TaskListPopup.tsx` | **Done** — conditional render driven by React state |
| `#task-popup` rows | `TaskListPopup.tsx` | **Done** — live rows from `onTask`/`onTaskReset`, spinner + banner |

### Phase 5: Voice input state machine

`AssistantPopup` drives a `VoiceState` type through five states:

```
idle  ──── mic click ───────────→  recording
             (getUserMedia, AnalyserNode rAF loop, MediaRecorder)

recording ─ mic click (stop) ──→  transcribing
             (rAF cancelled, stream closed, recorder.stop())

transcribing ← openui:voice:transcript fires → processing
             (Whisper done; transcript shown in #transcript-bubble;
              caption cleared for streaming)

processing ─ openui:chat:done fires ──────→  done
             (onChunk streamed tokens into #caption-text)

done / idle ─ mic click or text Enter ──→  recording / processing
```

**GSAP / React caption coordination:**

`#caption-text` is intentionally an **empty div with a ref** — its content is never set by JSX/React state. Two writers compete for it:

- `useAssistantAnimations` (demo typewriter at t=1.6 s after mount)
- `AssistantPopup` (imperative `captionRef.current.textContent = …`)

A shared `captionLockedRef: MutableRefObject<boolean>` (created in `App.tsx`, passed to both) acts as a mutex: once `AssistantPopup` sets it to `true`, the typewriter's `step()` function returns early and stops scheduling itself.

**Real-time audio bars:**

A shared `recordingRef: MutableRefObject<boolean>` coordinates bar animation:

- `false` → `useAssistantAnimations` stochastic tick owns the bars (random GSAP tweens every 150–240 ms)
- `true` → tick schedules itself but skips new tweens; `AssistantPopup`'s `requestAnimationFrame` loop reads `AnalyserNode.getByteFrequencyData` and sets `bar.style.height` directly at 60 fps

---

## 9. Phase 5 — Voice Input (`src/main/voice.ts`)

### Overview

Voice input adds a push-to-talk microphone flow to the assistant. Audio is captured in the renderer, transcribed by OpenAI Whisper in the main process, and then routed straight into `handleChat()` in `agent.ts`.

### Transcription backend

```
AssistantPopup (renderer)
  │
  ├─ navigator.mediaDevices.getUserMedia({ audio: true })
  ├─ AudioContext → AnalyserNode → rAF loop → real-time bar heights
  ├─ MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' })
  │   └─ ondataavailable → push chunks
  │   └─ onstop → Blob → ArrayBuffer
  │
  └─ ipcRenderer.invoke('openui:voice', { audio: Uint8Array, mimeType, tier })
        │
        └─ registerVoiceIPC (main, voice.ts)
              │
              ├─ Buffer.from(uint8Array)
              ├─ openai.audio.transcriptions.create({
              │     file: await toFile(buffer, 'recording.webm', { type }),
              │     model: 'whisper-1'
              │  })   ← requires OPENAI_API_KEY
              │
              ├─ win.webContents.send('openui:voice:transcript', transcript)
              │     └─ renderer: setTranscript(text), transition → processing
              │
              └─ handleChat(win, transcript, tier)
                    └─ agent loop streams chunks → done (same as text path)
```

### Environment variable

| Variable | Required for |
|---|---|
| `OPENAI_API_KEY` | Whisper transcription (all tiers — voice input always routes through OpenAI's speech API regardless of chat tier) |

> If `OPENAI_API_KEY` is absent, clicking the mic and sending audio will emit an `openui:chat:error` with an explanatory message rather than crashing.

### Audio format

`MediaRecorder` produces `audio/webm;codecs=opus` by default in Chromium (Electron's renderer engine). The file is passed to Whisper as `recording.webm` via `openai`'s `toFile()` helper — no temp files are written to disk.

---

## 10. Security notes

> A full pre-release security audit and its remediation are documented in [`SECURITY_AUDIT.md`](./SECURITY_AUDIT.md).

### Trust boundary: LLM tool calls

The model's output is **untrusted** — it can be steered by indirect prompt injection (e.g. a malicious filename returned by `search_files`, or text read by `read_screen`). Every path from model output to an OS action is therefore validated:

- **Schema validation (`validateArgs` in `executeTool`).** Tool arguments must be a plain object; required keys must be present; each field must match its declared JSON type (`string`/`number`/`object`) and `enum`. A nested object can never reach a tool where a string is expected (e.g. `open_app`).
- **AppleScript injection is closed.** Tools no longer use `node-osascript`'s variable injection (it wraps strings in quotes with **no escaping**). Scripts are built with every dynamic value passed through `asStringLiteral()` (escapes `\` and `"`). `open_app` also allowlists the app name; `control_calendar` accepts only string detail fields.
- **No shell for `search_files`.** It uses `execFile('mdfind', [query])` (no shell), so shell metacharacters in the query are inert.
- **Tool execution is only ever triggered by an explicit user request** flowing through the IPC → agent loop chain. `executeTool` is never invoked speculatively.

### Other notes

- **macOS-only tools call `assertMac()`** and return a safe error string on other platforms rather than crashing.
- `read_screen` on macOS requires the user to grant **Screen Recording** permission (System Settings → Privacy & Security → Screen Recording). Without it, captures return blank images silently — the tool result will be empty but will not crash. On pro/enterprise it uploads a full-screen screenshot to Anthropic (a privacy consideration to surface in the consent flow).
- The `ANTHROPIC_API_KEY` used by `read_screen` (pro/enterprise) is the same key used for the main pro-tier conversation; no additional credential is needed.
- **Secrets** are read from `process.env` in the **main process only** and never exposed to the renderer. `.env` is git-ignored; see `.env.example` for the full list of variables.

---

## 11. Phase 6 — macOS Permission Hardening (`src/main/permissions.ts`)

### Overview

Phase 6 prevents tool crashes caused by missing OS permissions and guides the user to grant them through an in-app modal rather than a cryptic error.

### Permission utility (`src/main/permissions.ts`)

Uses Electron's built-in `systemPreferences` API (no additional native package needed):

| Function | API used | Purpose |
|---|---|---|
| `checkAccessibility(): boolean` | `systemPreferences.isTrustedAccessibilityClient(false)` | Check AX without prompting; returns `true` on non-macOS |
| `checkMicrophone(): string` | `systemPreferences.getMediaAccessStatus('microphone')` | Returns `'authorized'` / `'denied'` / `'not-determined'` |
| `openSettingsPane(permission)` | `shell.openExternal(url)` | Deep-link to the correct System Settings pane |

### Permission check flow for nut.js tools

```
agent.ts: executeTool('move_mouse', args, { tier })
  │
  └── tools.ts: move_mouse()
        ├── checkAccessibility() → false?
        │     └── return { ok: false, error: 'Tool execution failed: Missing OS permissions…',
        │                   permissionDenied: 'accessibility' }
        └── otherwise: nut.mouse.setPosition(…) wrapped in try/catch
              └── on throw: return { ok: false, error: 'Tool execution failed: …' }
```

Back in `agent.ts`, after every `executeTool` call:
```typescript
if (result.permissionDenied) {
  emit(win, 'openui:permission:denied', result.permissionDenied)
}
```

The LLM always receives a structured `TOOL RESULT [tool] error: Tool execution failed: Missing OS permissions…` so it can explain the issue to the user in plain language.

### Microphone check (renderer side)

`AssistantPopup` calls `navigator.mediaDevices.getUserMedia({ audio: true })`. If the browser returns an error (permission denied or hardware unavailable), the new `onPermissionNeeded` prop is called, which sets state in `App.tsx` and shows `PermissionModal` for the microphone pane.

### New IPC channels

| Channel | Direction | Payload | Purpose |
|---|---|---|---|
| `openui:permission:denied` | Main → Renderer | `'accessibility' \| 'microphone'` | Trigger the in-app permission modal |
| `openui:permission:open-settings` | Renderer → Main | `'accessibility' \| 'microphone'` | Deep-link to System Settings |

### `PermissionModal` component (`src/renderer/src/components/PermissionModal.tsx`)

Renders a blurred card overlay with:
- Context-appropriate title and message (Accessibility vs. Microphone)
- **Open System Settings** button → calls `window.openui.openSettings(permission)` → IPC → `openSettingsPane()` → `shell.openExternal()`
- **Not now** dismiss button

`App.tsx` subscribes to `onPermissionDenied` (once, on mount) and stores the permission string in React state. The modal unmounts when the user dismisses it. `Escape` also closes the modal (before hiding the window).

### Unhandled-rejection fixes

| Location | Issue | Fix |
|---|---|---|
| `AssistantPopup.tsx` — `handleMicClick` stop path | `audioCtxRef.current?.close()` returned a Promise not awaited | Added `.catch(() => {})` |
| `AssistantPopup.tsx` — cleanup `useEffect` | Same `close()` call on unmount | Added `.catch(() => {})` |
| `AssistantPopup.tsx` — `recorder.onstop` | `blob.arrayBuffer()` was outside the try/catch; rejection would be unhandled | Wrapped entire `onstop` body in one try/catch |

---

## 12. Database Schema (`src/main/database/db.ts`)

SQLite is managed by `better-sqlite3` (lazy-loaded; falls back to in-memory Maps when the native build is absent). The database file lives at `app.getPath('userData')/openui.db`.

```sql
CREATE TABLE users (
  id           TEXT PRIMARY KEY,          -- UUID from Supabase, or 'anonymous'
  email        TEXT NOT NULL DEFAULT '',
  name         TEXT NOT NULL DEFAULT '',
  avatar_url   TEXT NOT NULL DEFAULT '',
  auth_token   TEXT NOT NULL DEFAULT '',  -- Supabase access token
  tier         TEXT NOT NULL DEFAULT 'free',
  tier_cached_at INTEGER NOT NULL DEFAULT 0, -- Unix ms; used by subscriptionSync TTL
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE conversations (
  id         TEXT PRIMARY KEY,            -- crypto.randomUUID()
  user_id    TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT 'New conversation',
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX idx_conversations_user ON conversations(user_id, created_at DESC);

CREATE TABLE messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  role            TEXT NOT NULL,          -- 'user' | 'assistant'
  content         TEXT NOT NULL,
  created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX idx_messages_conv ON messages(conversation_id, created_at);
```

**Key behaviours:**
- `better-sqlite3` is lazy-`require()`d at first use — the bundle typechecks and builds even before `npm run electron-rebuild`. A missing native build falls back to in-memory Maps silently.
- Messages are persisted after every agent turn (both user and assistant). Conversations are created on the first message of a new session and linked by UUID.
- The anonymous user (`id = 'anonymous'`) is stored in the `users` table and never sent to Supabase.

**Installation note:** run `npm install better-sqlite3 && npx electron-rebuild` on the macOS build host after install.

---

## 13. Auth Flow

### Overview

OpenUI uses Supabase Auth (Google OAuth) for sign-in. Auth state is stored locally in SQLite; the renderer holds it in `AuthContext`. Once signed in, chat works immediately via the cloud proxy — every tier, no local model required (see §4, "Model router — cloud-first").

```
User clicks "Sign in"
  │
  └─ window.openui.login()
       └─ ipcRenderer.send('openui:login')
            └─ main: shell.openExternal(supabase/auth/v1/authorize?provider=google&redirect_to=openui://auth/callback)
                 │
                 └─ System browser opens Google OAuth
                       │ user approves
                       └─ Google redirects → Supabase → openui://auth/callback?access_token=…
                              │
                              └─ macOS routes the URL to this app (app.setAsDefaultProtocolClient('openui'))
                                   └─ app.on('open-url', url)
                                        ├─ fetch supabase/auth/v1/user with access_token
                                        ├─ getTierForUser(userId) — queries subscriptions table
                                        ├─ setCurrentUser(user) — persists to SQLite
                                        └─ win.webContents.send('openui:auth-success', user)
                                              └─ AuthContext: setUser(u) → re-render AuthButton + SubscriptionStatus
```

**Cloud-only path:**
```
handleChat() — every tier is metered, every turn goes through our backend
  └─ callCloudProxy (our keys via chat-proxy) → the app just works, capped per tier
```

### IPC channels added in Phase 7

| Channel | Direction | Payload | Purpose |
|---|---|---|---|
| `openui:login` | Renderer → Main | *(none)* | Open Google OAuth in system browser |
| `openui:logout` | Renderer → Main | *(none)* | Clear session; emit `openui:auth-logout` |
| `openui:checkout` | Renderer → Main (invoke) | `priceId: string` | Open Stripe Checkout in browser |
| `openui:manage-subscription` | Renderer → Main | *(none)* | Open Stripe portal in browser |
| `openui:get-current-user` | Renderer → Main (invoke) | *(none)* | Returns `User \| null` |
| `openui:auth-success` | Main → Renderer | `User` | User signed in (OAuth or anonymous) |
| `openui:auth-logout` | Main → Renderer | *(none)* | User signed out |
| `openui:tier-changed` | Main → Renderer | `Tier` | Subscription tier updated |
| `openui:tier-upgrade-needed` | Main → Renderer | `TierUpgradePayload` | Show upgrade modal |
| `openui:get-conversations` | Renderer → Main (invoke) | *(none)* | Returns `ConversationSummary[]` |
| `openui:load-conversation` | Renderer → Main (invoke) | `conversationId: string` | Returns message array |

---

## 14. Subscription Gating Flow

### Model routing (authoritative, server-side)

The IPC `tier` field from the renderer is treated as a hint only — the main process always resolves the canonical tier from SQLite (or Supabase when the cache is stale). This prevents tier spoofing.

```
handleChat(win, userMessage, clientTier)
  │
  ├─ 1. clampTierToEntitlement(clientTier, getCurrentUserId())
  │       └─ caps the untrusted renderer tier to the signed-in user's entitlement
  │          (no-op for local dev with no signed-in user)
  │
  ├─ 2. getTierForUser(userId)
  │       ├─ id='anonymous' → 'free'  (never hits network)
  │       ├─ cache fresh (< 24 h) → cached tier from SQLite
  │       └─ cache stale → fetch supabase/rest/v1/subscriptions (5 s timeout)
  │                           ├─ success → update SQLite cache, return fresh tier
  │                           └─ network error → return stale SQLite tier  (offline safe)
  │
  ├─ 3. clientTier ≠ userTier AND clientTier ≠ 'free'?
  │       └─ isModelAllowedForTier(requestedModel, userTier) === false?
  │             └─ emit('openui:tier-upgrade-needed', { requestedModel, currentTier, requiredTier })
  │                   └─ AuthContext → setUpgradePayload → <TierUpgradeModal> renders
  │
  └─ 4. callModel(win, userTier, history)   ← uses AUTHORITATIVE userTier
```

### Tool gating (`src/main/tools.ts`)

```typescript
export const TIER_TOOL_REQUIREMENTS: Partial<Record<string, Tier>> = {
  read_screen_cloud_vision: 'pro'  // logical gate; read_screen branches internally
}
```

`executeTool` checks this table before dispatching. When a tool is gated, it returns `{ ok: false, error: '…requires pro subscription…' }` which the LLM reads and reformulates as plain English for the user.

`read_screen` additionally appends an upgrade hint to its free-tier OCR output so the LLM can proactively suggest upgrading if OCR quality is insufficient.

### Voice transcription gating (`src/main/voice.ts`)

| Tier | Transcription backend |
|---|---|
| `free` + `WHISPER_CPP_PATH` set | Local `whisper.cpp` binary (no cloud call) |
| `free` + no `WHISPER_CPP_PATH` | Error: actionable upgrade/setup message |
| `pro` / `enterprise` | OpenAI Whisper API (`whisper-1`) |

---

## 15. Stripe + Supabase Edge Functions Architecture

```
Subscription lifecycle
  │
  ├─ SIGN UP
  │   User signs in with Google → Supabase creates auth.users row
  │   Default tier: 'free' (no subscription row yet)
  │
  ├─ CHECKOUT
  │   window.openui.checkout(priceId)
  │     └─ main: shell.openExternal(supabase/functions/v1/create-checkout?price_id=…&user_id=…)
  │              └─ Edge Function: Stripe.checkout.sessions.create()
  │                   → redirect to stripe.com hosted checkout page
  │                   → on success: Stripe webhook fires to supabase/functions/v1/stripe-webhook
  │                        └─ Edge Function: upsert subscriptions(user_id, tier='pro')
  │                             → subscriptionSync.getTierForUser() picks it up next call
  │
  ├─ PORTAL
  │   window.openui.manageSubscription()
  │     └─ main: shell.openExternal(supabase/functions/v1/billing-portal?user_id=…)
  │              └─ Edge Function: Stripe.billingPortal.sessions.create()
  │                   → user cancels / changes plan → webhook fires again → tier updated in DB
  │
  └─ OFFLINE FALLBACK
      subscriptionSync.getTierForUser() — if Supabase is unreachable:
        ├─ cache age < 24 h → return cached SQLite tier (no network)
        └─ cache age > 24 h → return stale cached tier + log warning
                               (never locks user out; worst case = stale tier label)
```

### Required Edge Functions (deploy to Supabase)

| Function | Trigger | Action |
|---|---|---|
| `create-checkout` | HTTP GET | Creates Stripe Checkout session, redirects user |
| `billing-portal` | HTTP GET | Creates Stripe Customer Portal session, redirects user |
| `stripe-webhook` | Stripe webhook POST | Handles `checkout.session.completed`, `customer.subscription.updated/deleted`; upserts `subscriptions` table |

### Environment variables (Phase 7)

| Variable | Required for |
|---|---|
| `SUPABASE_URL` | Auth, tier sync, checkout, portal |
| `SUPABASE_ANON_KEY` | Auth API headers |
| `STRIPE_PRO_PRICE_ID` | Pro checkout button |
| `STRIPE_ENTERPRISE_PRICE_ID` | Enterprise checkout button |
| `WHISPER_CPP_PATH` | Free-tier local voice transcription |
| `OPENAI_API_KEY` | Whisper API (pro/enterprise voice) |

---

## 16. Build CI — TypeScript type-checking

`electron-vite build` uses esbuild, which transpiles TypeScript but **does not** type-check. Type errors only surface during `npm run typecheck` (`tsc --noEmit`). Add `npm run typecheck` as a CI step before the build to catch this class of bug:

```yaml
# .github/workflows/build.yml (example)
- run: npm run typecheck
- run: npm run build
```

The `typecheck` script already exists in `package.json`; it just needs to be wired into the CI pipeline.

---

## 17. Telemetry & Privacy (Sub-Phase 4)

OpenUI ships an **opt-in** anonymous analytics layer built on PostHog. It is
designed for macOS App Store guidelines and GDPR compliance: nothing is
collected — and the PostHog client is never even initialised — until the user
explicitly grants consent.

### Module map (`src/main/telemetry/`)

| File | Responsibility |
|---|---|
| `events.ts` | Single source of truth for event names + property shapes (`Events` / `EVENTS`). |
| `posthog.ts` | PostHog client lifecycle: consent-gated init, identify, capture, opt-out, shutdown. |
| `consent.ts` | Consent state machine (`ConsentStatus`), persisted to the `settings` table; local pending-event queue. |
| `index.ts` | `trackEvent()` wrapper — never throws; no-ops when telemetry is disabled. |

### What data IS collected (only after opt-in)

- App opens, closes, crashes, and version / auto-update events
- Feature usage — which tools run, which models / tiers are selected, voice & vision usage
- Performance metrics — response latency, tool execution time, token counts
- Subscription tier, OS platform, and app version
- A random anonymous device id (`<userData>/.telemetry-id`), replaced by the
  Supabase user id only after sign-in (`identifyUser`)

See `events.ts` for the exhaustive list of event names and their property shapes.

### What is NEVER collected

- Chat messages or voice recordings (only lengths / counts, never content)
- File contents or file paths
- Screenshots, screen contents, or OCR text
- Personal data beyond the post-login user id
- API keys or any secret from `process.env`

While consent is UNKNOWN or DENIED there is **no network egress** from the
telemetry layer at all: the PostHog client object is `null`, so `trackEvent()`
is a zero-cost no-op.

### Consent flow

```
First launch
  app.whenReady → initDatabase() → await initTelemetry()
        │
        └─ getConsentStatus() === GRANTED ?  ── no ──▶ PostHog stays OFF (client = null)
                  │ yes
                  └─▶ startClient()  (PostHog online)

Renderer mount (App.tsx)
  getConsentStatus() === 'unknown' ?  ── yes ──▶ <ConsentModal/>
        │
        ├─ "Allow Analytics" ─▶ openui:grant-consent
        │      main: grantConsent() → enableTelemetryAfterConsent() (client online,
        │            flush pending) → trackEvent(TELEMETRY_OPT_IN) → openui:consent-updated
        │
        └─ "Skip" ──────────▶ openui:deny-consent
               main: (client active ? trackEvent(TELEMETRY_OPT_OUT) : recordPendingEvent(…))
                     → denyConsent() → shutdownTelemetry() → openui:consent-updated
```

`ConsentModal` is **non-blocking** and **non-manipulative**: "Allow Analytics"
and "Skip" are the same size and visual weight (no dark pattern). "Skip" persists
a permanent `DENIED` (`telemetry_consent` in the `settings` table), so the prompt
never reappears on later launches — but the choice is always reversible from
Settings. Dismissing with "Skip" lets the user start using the app immediately.

Because PostHog is not initialised on a first launch, `TELEMETRY_OPT_IN` is
literally the first event a consenting user ever sends. `TELEMETRY_OPT_OUT` is
the LAST event before shutdown; if telemetry was never started (the user pressed
"Skip"), the opt-out is stashed locally (`telemetry_pending_events`) and
batch-sent only if they later opt back in.

### Changing the choice later (Settings)

`AssistantPopup`'s header has a gear button that opens `SettingsModal`, which
hosts the **Anonymous Usage Analytics** switch ("Help us improve OpenUI by
sharing anonymous usage data. No personal data is ever collected."):

- Toggle **ON** → `grantConsent()` → PostHog initialised → `TELEMETRY_OPT_IN`.
- Toggle **OFF** → `TELEMETRY_OPT_OUT` (last event) → `denyConsent()` → PostHog
  shut down and flushed.

The switch reads its initial state from `getConsentStatus()` and stays in sync
via the `openui:consent-updated` push.

### Consent state (persisted in the `settings` table)

| Key | Values | Meaning |
|---|---|---|
| `telemetry_consent` | `unknown` \| `granted` \| `denied` | Authoritative consent status. |
| `telemetry_opt_out` | `true` \| `false` | Low-level mirror kept for `setTelemetryOptOut`. |
| `telemetry_pending_events` | `string[]` | Events recorded while disabled; batch-sent on next opt-in. |

### IPC channels (Sub-Phase 4C)

| Channel | Direction | Payload | Purpose |
|---|---|---|---|
| `openui:grant-consent` | Renderer → Main (invoke) | *(none)* | Opt in; init PostHog; emit `TELEMETRY_OPT_IN`. |
| `openui:deny-consent` | Renderer → Main (invoke) | *(none)* | Opt out; emit `TELEMETRY_OPT_OUT`; shut PostHog down. |
| `openui:get-consent-status` | Renderer → Main (invoke) | *(none)* | Returns the current `ConsentStatus`. |
| `openui:consent-updated` | Main → Renderer | `ConsentStatus` | Consent changed; keeps modal / toggle in sync. |
| `openui:set-telemetry-opt-out` | Renderer → Main (invoke) | `boolean` | Low-level opt-out (Sub-Phase 4A). |
| `openui:get-telemetry-status` | Renderer → Main (invoke) | *(none)* | Returns whether the client is active. |

### PostHog integration details

- **Package:** `posthog-node`. Host defaults to `https://us.i.posthog.com`
  (override `POSTHOG_HOST`); requires `POSTHOG_API_KEY` — with no key, telemetry
  is a permanent no-op regardless of consent.
- **Batching:** `flushAt: 20`, `flushInterval: 10000` ms. `shutdownTelemetry()`
  flushes on `before-quit`.
- **Identity:** anonymous device id until `identifyUser(userId)` runs after auth;
  `resetTelemetryIdentity()` returns to the device id on logout.
- **Safety:** the `trackEvent()` wrapper in `telemetry/index.ts` swallows all
  errors so analytics can never disrupt a user-facing flow.

### How to opt out

- **In-app:** Settings (gear icon) → turn **Anonymous Usage Analytics** off.
  This is available at any time, before or after the first-launch prompt.
- **At first launch:** press **Skip** in the consent prompt.
- **By configuration:** unset `POSTHOG_API_KEY` to disable telemetry build-wide.

### Environment variables

| Variable | Default | Used by |
|---|---|---|
| `POSTHOG_API_KEY` | *(unset — disables telemetry entirely)* | `initTelemetry`, `enableTelemetryAfterConsent` |
| `POSTHOG_HOST` | `https://us.i.posthog.com` | PostHog client |


---

## Phase 10 — GitHub PR Review (`src/main/github.ts`)

### Goal

Let the CTO use case run end-to-end from the chat UI: say **"Review my PRs"** and OpenUI fetches every open pull request in the specified repository, analyses each diff with Claude Sonnet, and posts a structured review comment directly on GitHub.

### Module: `src/main/github.ts`

A standalone tool module (lazy-load + `ToolResult` pattern, same as Playwright/tesseract) that exports:

| Export | Kind | Description |
|---|---|---|
| `list_open_prs` | `async function` | Fetches up to 30 open PRs sorted by most-recently-updated |
| `get_pr_diff` | `async function` | Returns the raw unified diff, capped at 24 000 characters |
| `post_pr_comment` | `async function` | Posts a markdown comment on the PR via the GitHub issues API |
| `githubToolSchemas` | `ToolSchema[]` | JSON schemas for the three tools; spread into `toolSchemas` in `tools.ts` |
| `githubRegistry` | `Record<string, Executor>` | Executor map; spread into the main `registry` in `tools.ts` |

`@octokit/rest` is loaded lazily — absent package surfaces as `{ ok: false, error: "…install @octokit/rest…" }`, not a crash.

### Agent trigger (`agent.ts`)

```typescript
const PR_REVIEW_RE = /\breview\b.*\bprs?\b|\bprs?\b.*\breview|\bpull\s+request/i
```

When matched, `handleChat` applies two overrides:

| Normal session | PR review session |
|---|---|
| Tier from UI (`free` / `pro` / `enterprise`) | Always `'pro'` (Claude Sonnet) |
| `SYSTEM_PROMPT` (general assistant) | `PR_REVIEW_SYSTEM_PROMPT` (strict reviewer mandate) |
| `MAX_TOOL_TURNS = 8` | `maxTurns = 32` (list + diff×N + comment×N) |

### `PR_REVIEW_SYSTEM_PROMPT` format

Each posted comment follows this template:

```
## OpenUI Automated Code Review
**Decision: [APPROVE / REQUEST CHANGES / COMMENT ONLY]**
### Bugs
### Security Issues
### Architecture
### Verdict
```

### Security notes

- Repo names validated against `REPO_RE = /^[\w.-]+\/[\w.-]+$/`.
- Diff capped at 24 000 chars to limit prompt-injection surface.
- Comment capped at 65 536 chars (GitHub's hard limit).
- Only posts comments — never merges, closes, or labels PRs.
- `GITHUB_TOKEN` stays in the main process; never crosses the contextBridge.

### Setup

```
npm install   # picks up @octokit/rest
GITHUB_TOKEN=ghp_…    # repo read + write:discussion scope
GITHUB_REPO=owner/repo  # optional default repo
```

---

## 18. Action Recorder & Macros

The Action Recorder lets users record mouse movements, clicks, and keyboard input and replay them as named macros.

### Architecture

| Layer | File | Responsibility |
|-------|------|----------------|
| Main | `src/main/recorder.ts` | State machine, mouse polling, nut-js playback, JSON persistence |
| IPC | `src/main/index.ts` | 9 `ipcMain.handle` channels under `openui:recorder:*` |
| Preload | `src/preload/index.ts` | Exposes recorder API on `window.openui` via `contextBridge` |
| Renderer | `src/renderer/src/components/RecorderUI.tsx` | React UI with recording indicator and macro list |

### Recording

`@nut-tree-fork/nut-js` v4 is an output-only library (no global input event hooks). Recording is therefore implemented via polling:

- `mouse.getPosition()` is called every 50 ms inside `startRecording()`.
- Position changes above an 8-pixel threshold produce a `mousemove` action.
- `screen.getActiveWindow()` attaches the foreground window title to each event.
- Click and keypress actions can be injected at any time via `recorderRecordClick()` / `recorderRecordKeypress()` (called from the UI).

### IPC Channels

| Channel | Direction | Description |
|---------|-----------|-------------|
| `openui:recorder:start` | invoke | Begin polling and reset action buffer |
| `openui:recorder:stop` | invoke | Stop polling; return captured `RecorderAction[]` |
| `openui:recorder:play` | invoke | Replay an action array via nut-js |
| `openui:recorder:record-click` | invoke | Inject a click at `(x, y)` into the current recording |
| `openui:recorder:record-keypress` | invoke | Inject a text-type event into the current recording |
| `openui:recorder:get-macros` | invoke | Load all macros from `macros.json` |
| `openui:recorder:save-macro` | invoke | Persist a named macro to `macros.json` |
| `openui:recorder:delete-macro` | invoke | Remove a named macro from `macros.json` |
| `openui:recorder:is-recording` | invoke | Query recording state |

### Persistence

Macros are stored in `{userData}/macros.json` as a JSON array of `Macro` objects. Writes are synchronous (no SQLite — intentionally standalone).

### Playback

`playRecording(actions)` replays actions in order using nut-js:
- `mousemove` → `mouse.setPosition()`
- `mouseclick` → `mouse.setPosition()` + `mouse.click(Button.LEFT|RIGHT)`
- `keypress` → `keyboard.type(text)`
- Inter-action timing is replayed from recorded `timestamp` offsets, clamped to 2 s per gap.
