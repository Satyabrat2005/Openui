# openui-browser

**The browser-first automation surface for OpenUI** — a web app whose UI is a
direct port of the desktop Run Console (`src/renderer/src/components/RunConsole.tsx`
in this repo), with the Electron IPC data layer swapped for REST/SSE. No install:
sign in and use it in the browser.

This lives as a folder in the desktop repo for review convenience; it is an
independent Node + Vite/React service (its own `package.json`), not part of the
Electron build. It authenticates against the **same Supabase project** as the
desktop app and calls the existing `chat-proxy` Edge Function unchanged.

## What it is / isn't
- **Is:** the portable ~half of OpenUI's surface — document/paper generation,
  GitHub (PAT), all behind the confirmation gate — rendered in the *same* Run
  Console UI as desktop (pixel-parity: `index.css` + IBM Plex fonts copied verbatim).
- **Isn't:** a fork of the Electron app or the marketing site. Permanently
  desktop-only and intentionally absent here: WhatsApp, `computer_use`, local
  filesystem, local git/sandbox, native app launching, the LIVE VIEW screen feed.

## Run locally
```bash
cd openui-browser
npm install
npm run dev:api      # Express backend on :8787 (DEV_STUB auth; Bearer dev:me)
npm run dev:web      # Vite dev server on :5173, proxies /api → :8787
# or: npm run build:web && npm start   # backend serves the built frontend on :8787
```

## Layout
- `web/` — Vite + React frontend. `components/RunConsole.tsx` is the ported console;
  `context/Web*Context.tsx` are the web data layer; `index.css` + `assets/fonts/`
  are copied verbatim from the desktop renderer.
- `src/` — Express backend: `/api/me`, `/api/connections`, `/api/workflows`,
  `/api/chat` (chat-proxy passthrough / dev echo), `/api/tool` (the confirmation gate).
- `docs/runconsole-web-port.md` — the IPC→web swap table and the getComputedStyle
  parity verification against the desktop-recorded values.

## Data-layer swap (desktop IPC → web)
`window.openui.chat` → `POST /api/chat` (SSE) · `onHitlRequest` → the `/api/tool`
confirmation gate → inline Approve/Deny · `getUser` → `GET /api/me` ·
`listWorkflows`/connections → REST · `captureScreenThumbnail` → removed (desktop-only).

## Safety gate
State-changing / destructive tools return `needsConfirmation` and do **not**
execute until a second request carries a single-use, args-bound token — the same
property the desktop `STATE_CHANGING_TOOLS`/`DESTRUCTIVE_TOOLS` enforce. The Run
Console's inline Approve/Deny callout is wired to it.
