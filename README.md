# OpenUI

**A local-first AI desktop assistant — your personal JARVIS, running on your Mac.**

OpenUI is a macOS menu-bar app built with Electron, React, and TypeScript. It provides a voice- and text-driven interface to a multi-tier AI backend: **free** (Ollama — fully local, no data leaves your machine), **pro** (Claude via Anthropic API), or **enterprise** (GLM). The assistant can control your desktop, search files, manage your calendar, read the screen, and more — all through natural conversation.

---

## Project Vision

OpenUI aims to be the open-source equivalent of a personal AI assistant that runs *on your machine*, not in someone's cloud. The free tier routes every prompt through a locally-hosted Ollama model — nothing touches an external server. Pro and enterprise tiers optionally use cloud APIs for more capable models, while keeping the entire tool-execution layer (keyboard/mouse control, file access, screen reading) local at all times.

---

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| **macOS** | 13 Ventura or later | macOS 14 Sonoma+ recommended; Accessibility API is most stable on Sonoma+ |
| **Node.js** | 20 LTS or later | [nodejs.org](https://nodejs.org) |
| **npm** | 10+ | Bundled with Node.js |
| **Ollama** *(free tier)* | Latest | [ollama.com](https://ollama.com) — after install, run: `ollama pull llama3:8b` |
| **Anthropic API key** *(pro tier)* | — | Set `ANTHROPIC_API_KEY` in your environment |
| **OpenAI API key** *(voice input)* | — | Set `OPENAI_API_KEY` — Whisper handles speech-to-text on all tiers |

> **Apple Silicon (M1/M2/M3/M4):** fully supported. The release DMG ships both `arm64` and `x64` slices.

---

## macOS Permissions

OpenUI uses OS-level APIs that require explicit user consent. The app shows in-app guidance modals on first use, but here is what to expect:

### Accessibility — required for mouse / keyboard control

**System Settings → Privacy & Security → Accessibility → enable OpenUI**

Required for the `move_mouse`, `left_click`, and `type_text` tools. Without this, those tools return an error that the assistant reports in plain language rather than crashing.

### Microphone — required for voice input

**System Settings → Privacy & Security → Microphone → enable OpenUI**

Required to use the push-to-talk mic button. Text-based chat works without it.

### Screen Recording — required for `read_screen`

**System Settings → Privacy & Security → Screen Recording → enable OpenUI**

Required for the `read_screen` tool, which captures the display for Claude Vision (pro/enterprise) or Tesseract OCR (free). Without it, captures return a blank image — the tool reports an empty result rather than crashing.

> After granting any permission you may need to restart the app for it to take effect.

---

## Environment Variables

Create a `.env` file at the project root (or export these in your shell before running):

```sh
# Required for pro-tier chat and read_screen on pro/enterprise
ANTHROPIC_API_KEY=sk-ant-...

# Required for voice input (Whisper) on any chat tier
OPENAI_API_KEY=sk-...

# Optional — Ollama overrides (free tier defaults)
OLLAMA_HOST=http://127.0.0.1:11434
OLLAMA_MODEL=llama3:8b

# Optional — GLM / enterprise tier overrides
GLM_BASE_URL=http://127.0.0.1:8080/v1
GLM_API_KEY=no-key
GLM_MODEL=glm-4
```

---

## Development

### Install dependencies

```sh
npm install
```

### Start in dev mode

```sh
npm run dev
```

`electron-vite` starts in watch mode — the renderer hot-reloads on file changes. The Electron window opens automatically. Click the tray (menu-bar) icon to toggle it.

### Type-check only

```sh
npm run typecheck
```

### Preview the production build locally

```sh
npm run build      # compile TypeScript → out/
npm run preview    # launch the compiled app
```

---

## Building for Distribution

> **macOS required.** `electron-builder --mac` calls macOS-only toolchain commands to create the DMG. You cannot build the DMG from Windows or Linux.

### App icon

Place a 1024×1024 `icon.icns` at `resources/icon.icns` before building. Without it, electron-builder uses the default Electron icon.

To generate an `.icns` from a PNG on macOS:

```sh
mkdir MyIcon.iconset
sips -z 1024 1024 icon.png --out MyIcon.iconset/icon_512x2.png
iconutil -c icns MyIcon.iconset -o resources/icon.icns
```

### Build a macOS DMG

```sh
npm run build:mac
```

This runs `electron-vite build` then `electron-builder --mac`, producing a `.dmg` installer under `dist/`. Both `arm64` (Apple Silicon) and `x64` (Intel) slices are included.

### Output

```
dist/
├── OpenUI-0.1.0-arm64.dmg   # Apple Silicon installer
├── OpenUI-0.1.0-x64.dmg     # Intel installer
└── mac-arm64/               # Unpacked app bundle
```

---

## Project Structure

```
src/
├── main/
│   ├── index.ts           # Electron main — tray, window, IPC bootstrap
│   ├── agent.ts           # LLM router (Ollama / Anthropic / GLM) + agentic tool loop
│   ├── voice.ts           # Whisper transcription IPC handler
│   ├── tools.ts           # OS automation tools (AppleScript, nut.js, desktopCapturer)
│   └── permissions.ts     # macOS permission checks + System Settings deep-links
├── preload/
│   └── index.ts           # contextBridge — exposes window.openui to renderer
└── renderer/
    └── src/
        ├── App.tsx
        ├── components/
        │   ├── AssistantPopup.tsx    # Chat UI, mic button, streaming transcript
        │   ├── TaskListPopup.tsx     # Live tool-execution status rows
        │   └── PermissionModal.tsx   # In-app permission guidance modal
        └── hooks/
            └── useAssistantAnimations.ts  # GSAP entrance + audio-bar animations
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full technical reference.

---

## Troubleshooting

### Electron binary won't install

On some setups `npm install` does not leave a working Electron binary — e.g. when npm's `allow-scripts` policy gates Electron's postinstall, or `extract-zip` aborts mid-extraction. The symptom is a missing `node_modules/electron/path.txt`. The zip downloads to the cache fine; extract it manually.

On Windows (PowerShell):

```powershell
$ver  = (Get-Content node_modules\electron\package.json | ConvertFrom-Json).version
$zip  = Get-ChildItem "$env:LOCALAPPDATA\electron\Cache" -Recurse -Filter "electron-v$ver-win32-x64.zip" | Select-Object -First 1
$dist = "node_modules\electron\dist"
Remove-Item -Recurse -Force $dist -ErrorAction SilentlyContinue
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory($zip.FullName, $dist)
Set-Content node_modules\electron\path.txt "electron.exe" -NoNewline
```

If the cache is empty, run `node node_modules\electron\install.js` first to download the zip.

---

## License

MIT
