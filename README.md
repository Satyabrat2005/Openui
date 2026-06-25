# OpenUI

**A local-first AI desktop assistant — your personal JARVIS, running on your machine.**

OpenUI is a cross-platform desktop app (macOS and Windows) built with Electron, React, and TypeScript. It provides a voice- and text-driven interface to a multi-tier AI backend: **free** (Ollama — fully local, no data leaves your machine), **pro** (Claude via Anthropic API), or **enterprise** (GLM). The assistant can control your desktop, search files, manage your calendar, read the screen, and more — all through natural conversation.

---

## Project Vision

OpenUI aims to be the open-source equivalent of a personal AI assistant that runs *on your machine*, not in someone's cloud. The free tier routes every prompt through a locally-hosted Ollama model — nothing touches an external server. Pro and enterprise tiers optionally use cloud APIs for more capable models, while keeping the entire tool-execution layer (keyboard/mouse control, file access, screen reading) local at all times.

---

## Prerequisites

| Requirement | macOS | Windows |
|---|---|---|
| **OS Version** | macOS 12+ (Monterey) | Windows 10+ |
| **Node.js** | v18+ | v18+ |
| **npm** | 10+ (bundled with Node.js) | 10+ (bundled with Node.js) |
| **Ollama** *(free tier)* | Required — [ollama.com](https://ollama.com); run `ollama pull llama3:8b` after install | Required — [ollama.com](https://ollama.com); run `ollama pull llama3:8b` after install |
| **Anthropic API key** *(pro tier)* | Set `ANTHROPIC_API_KEY` in your environment | Set `ANTHROPIC_API_KEY` in your environment |
| **OpenAI API key** *(voice input)* | Set `OPENAI_API_KEY` — Whisper handles speech-to-text | Set `OPENAI_API_KEY` — Whisper handles speech-to-text |
| **Accessibility Permissions** | System Settings → Privacy & Security → Accessibility | Not required for current feature set |
| **Microphone Permissions** | System Settings → Privacy & Security → Microphone | Windows Settings → Privacy → Microphone |

> **Apple Silicon (M1/M2/M3/M4):** fully supported. The release DMG ships both `arm64` and `x64` slices.

---

## Platform Permissions

OpenUI uses OS-level APIs that require explicit user consent on macOS. The app shows in-app guidance modals on first use.

### macOS

#### Accessibility — required for mouse / keyboard control

**System Settings → Privacy & Security → Accessibility → enable OpenUI**

Required for the `move_mouse`, `left_click`, and `type_text` tools. Without this, those tools return an error that the assistant reports in plain language rather than crashing.

#### Microphone — required for voice input

**System Settings → Privacy & Security → Microphone → enable OpenUI**

Required to use the push-to-talk mic button. Text-based chat works without it.

#### Screen Recording — required for `read_screen`

**System Settings → Privacy & Security → Screen Recording → enable OpenUI**

Required for the `read_screen` tool, which captures the display for Claude Vision (pro/enterprise) or Tesseract OCR (free). Without it, captures return a blank image — the tool reports an empty result rather than crashing.

> After granting any permission you may need to restart the app for it to take effect.

### Windows

No Accessibility-equivalent permission is required for the current feature set. Microphone access is managed through **Windows Settings → Privacy → Microphone**.

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

## Installation

### macOS

```bash
git clone https://github.com/Satyabrat2005/Openui.git
cd Openui
npm install
npm run dev
```

### Windows

```bash
git clone https://github.com/Satyabrat2005/Openui.git
cd Openui
npm install
run.bat
```

`run.bat` is a convenience wrapper that runs the same `electron-vite dev` command used on macOS — it sets up the environment and launches the app in watch mode without needing to type the full npm command in PowerShell or CMD.

---

## Development

### Type-check only

```sh
npm run typecheck
```

### Preview the production build locally

```sh
npm run build      # compile TypeScript → out/
npm run preview    # launch the compiled app
```

`electron-vite` starts in watch mode — the renderer hot-reloads on file changes. The Electron window opens automatically. Click the tray (menu-bar) icon to toggle it.

---

## Building for Distribution

OpenUI ships two installer targets: a **Windows** `.exe` (NSIS) and a **macOS** `.dmg`. Each must be built on its own OS — cross-compiling native modules is not supported.

### App icons

The application icons are generated by a built-in script — no external art or image tooling is required:

```sh
npm run icons
```

This writes `resources/icon.ico` (Windows) and a 1024×1024 `resources/icon.png` source using only Node's standard library, plus `resources/icon.icns` (macOS) when the optional `png2icons` dev-dependency is installed. The same script runs automatically on `postinstall`, so a fresh `npm install` produces the icons before any build. To use your own branding, drop a 1024×1024 PNG at `resources/icon.png` and adapt `scripts/convert-icon.js` to convert it with png2icons instead of synthesising the default orb.

### Windows Build

> **Windows required.** Native modules (e.g. nut.js) ship platform-specific binaries that must be present for the Windows target. Build on a Windows machine, or use the `windows-latest` GitHub Actions runner.

```sh
npm run build:win
```

This runs `electron-vite build` then `electron-builder --win`, producing an NSIS installer at:

```
dist/OpenUI.Setup.0.1.0.exe
```

The installer is **interactive** (not one-click): the user can change the install directory, and a Start-menu / desktop shortcut named **OpenUI** is created. The uninstaller appears in *Apps & features* as **OpenUI**.

To validate packaging without producing the full installer (faster — skips NSIS), run a directory build:

```sh
npx electron-builder --win --dir   # outputs dist/win-unpacked/OpenUI.exe
```

> **Platform tools:** the cross-platform features (chat, voice input, screen reading, and nut.js mouse/keyboard control) work on Windows. The macOS-specific tools — `open_app`, `search_files`, `control_calendar` — return a graceful "unsupported platform" error on Windows rather than crashing.

### macOS Build

```sh
npm run build:mac
```

Runs `electron-vite build` then `electron-builder --mac`, producing a `.dmg` installer under `dist/`. Both `arm64` (Apple Silicon) and `x64` (Intel) slices are included.

> **Note:** The macOS DMG must be built on a macOS host — `electron-builder --mac` calls macOS-only toolchain commands and cannot run on Windows or Linux.

### Output

```
dist/
├── OpenUI.Setup.0.1.0.exe        # Windows NSIS installer (x64 + ia32)
├── win-unpacked/                 # Unpacked Windows app
├── OpenUI-0.1.0-arm64.dmg        # Apple Silicon installer (macOS)
├── OpenUI-0.1.0-x64.dmg          # Intel installer (macOS)
└── mac-arm64/                    # Unpacked macOS app bundle
```

---

## Cross-Platform Notes

- **Database storage:** The app uses `app.getPath('userData')` for all database and config files. Electron resolves this to the correct OS-specific directory automatically (`~/Library/Application Support/OpenUI` on macOS, `%APPDATA%\OpenUI` on Windows).

- **Deep linking (`openui://`):** The protocol is registered on both platforms, but the mechanism differs. On macOS the main process listens for the `open-url` event; on Windows it intercepts the URL via the `second-instance` event and parses `process.argv`.

- **Accessibility / automation:** macOS requires explicit Accessibility permission for mouse and keyboard automation tools (`move_mouse`, `left_click`, `type_text`). Windows does not require an equivalent permission for the current feature set.

- **Auth window chrome:** The authentication window is frameless on macOS (native title bar hidden) and uses a standard OS frame on Windows for better compatibility with Windows window management conventions.

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

---

## License

MIT
