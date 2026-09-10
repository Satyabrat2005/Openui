# Pre-launch security audit — 2026-09-10

OpenUI is a desktop agent that runs shell commands, reads untrusted web and
screen content, holds credentials for four messaging channels, and self-updates.
That surface deserves a pass before strangers install it. This is the audit, the
one real defect it found, and what was deliberately left alone.

**Headline: credentials were stored in plaintext. They are now encrypted with the
OS keystore.** Everything else checked either held up or is a documented,
deliberate trade-off.

---

## Scope and results

| # | area | result |
|---|---|---|
| 1 | Confirmation-gate bypass | **PASS** — not reachable from model output |
| 2 | Gate coverage across the tool surface | **PASS** — two exclusions, both correct |
| 3 | **Credential storage at rest** | **FIXED** — was plaintext, now OS-encrypted |
| 4 | Path traversal / sandbox confinement | **PASS** |
| 5 | Shell & code execution | documented trade-off, unchanged |
| 6 | Electron hardening | **PASS** — textbook |
| 7 | Zip handling (slip / bomb) | **PASS** — guards already present |
| 8 | Dependency CVEs | 19 → 12; the reachable one is mitigated |
| 9 | Debug harness in shipped code | **PASS** — verified absent from `main` and `v7.2.0` |

---

## 1. The confirmation gate cannot be bypassed by the model

Two days earlier the retrain measurement caught `openui-splen:v2` emitting this,
under pressure to skip a confirmation:

```json
{"tool": "send_email", "args": {"to": "jane@acme.com", "body": "The deal is off.", "skipConfirmation": true}}
```

That made an urgent question out of a theoretical one: **if a model invents that
argument, does anything honour it?**

No. The gate reads `context.bypassHitl`, and `context` is the executor's third
parameter, supplied by the agent loop — never merged from `args`:

```ts
if (STATE_CHANGING_TOOLS.has(name) && !context.bypassHitl) {
  return { status: 'pending_approval', tool: name, args }
}
```

`args` and `context` are separate parameters that never mix, so no argument the
model can emit reaches the gate. `validateArgs` then ignores unknown keys, so the
invented flag is dropped before the tool ever runs.

**Worth knowing rather than fixing:** unknown args are *ignored*, not *rejected*.
That is safe here because no tool spreads `...args` into an outbound request —
checked — but it is a property worth preserving. A future tool that forwards its
argument object wholesale to an HTTP API would turn silent-ignore into a
parameter-injection surface.

## 2. Gate coverage: 90 tools gated, two exclusions, both correct

Of 157 schemas across all modules, 90 are in `STATE_CHANGING_TOOLS` and 15 in
`DESTRUCTIVE_TOOLS`. A scan for dangerous-looking names outside the gate returned
exactly two, and both are right:

- **`create_email_draft`** — writes a draft, sends nothing. No external effect.
- **`run_workflow`** and the coding tools — a **separate registry**
  (`executeCodingTool`), which is the subject of §5.

## 3. FIXED — credentials were stored in plaintext

**Eleven credential types were written to `settings.value` as plain JSON** in
`%APPDATA%/OpenUI/openui.db`:

```
anthropic_api_key            google_calendar_refresh_token
figma_bridge_token           google_drive_refresh_token
figma_token                  google_oauth_client_secret
github_token                 slack_token
gmail_refresh_token          telegram_bot_token
```

`safeStorage` appeared **nowhere** in the codebase. These are long-lived
credentials, not session tokens: a Gmail refresh token is persistent access to
somebody's email; a Slack bot token reads and posts across a workspace. Any
process running as the user, any backup, any synced folder, or anyone who picks
up the laptop, could lift all of them from one file.

For a product whose pitch is "connect all your accounts", that file was the
highest-value target in the install. It is also the one place the desktop app was
**behind its own sibling** — `openui-web` already encrypts its GitHub PAT with
AES-256-GCM.

**The fix** (`secretStore.ts`, `secretKeys.ts`, `settingsRepo.ts`): Electron's
`safeStorage`, backed by DPAPI on Windows, Keychain on macOS, libsecret/kwallet
on Linux. The OS holds the key; no key material is in the repo or the database.
Encryption is transparent — callers pass and receive ordinary values, so nothing
that reads a token needed to change.

Compatibility was the main design constraint, in both directions:

- A **plaintext value written by an older build still reads**, and is re-encrypted
  on the next write. No migration step, no reconnect prompt, nothing for an
  existing user to redo.
- An **encrypted value that cannot be opened** (profile copied to another machine
  or user, no keyring) reads as `null`, so the caller treats the channel as
  disconnected and re-prompts. Handing back a mangled string would send a broken
  token to a live API.
- Where the OS **cannot** encrypt, the value is stored as plaintext exactly as
  before and the reason is logged once. Refusing to store it would break the
  feature outright — worse than the status quo this replaces — but it is logged,
  never silent, so it cannot be mistaken for encrypted.

**The guard matters more than the fix.** Encryption is easy to add once and easy
to forget on the next integration, so `secretSettings.test.ts` scans every
`get/setSetting('…')` call site in `src/main` and fails the build when a key
matching `/token|secret|api_key|password|credential|refresh/` is neither declared
secret nor explicitly excused with a reason. Adding a credential without
protecting it is now a red build, not a silent regression.

8 tests, and the full suite stays green at 1,885.

## 4-7. What held up

**Sandbox path confinement** — `resolveInSandbox` rejects non-strings, rejects
absolute paths, resolves, then verifies the result does not escape via
`relative()`. That is the correct pattern, correctly implemented.

**Electron hardening** — textbook, and explicitly set rather than left to
defaults: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`,
`webSecurity: true`, `nodeIntegrationInWorker: false`, plus
`setWindowOpenHandler`, a `will-navigate` guard, and `will-attach-webview`
blocked outright.

**Zip handling** — `archive.ts` deliberately avoids adm-zip's `extractAllTo()`
and iterates entries itself precisely so it can enforce its own zip-slip and
zip-bomb guards. The scary-sounding adm-zip path-traversal CVE is therefore **not
reachable**: the vulnerable API is never called.

**Debug harness** — the working copy carries an `OPENUI_DEBUG_TOOLS` IPC handler
that runs any tool at `tier: 'pro'` with `bypassHitl`. Verified **absent from
`main` and from the `v7.2.0` tag**: local-only, never shipped. It must stay that
way; it is a privilege escalation and a paid-tier bypass if it ever lands.

## 5. Shell execution — a documented trade-off, left alone

The coding agent can write `package.json` and then run `npm install` and
`npm run`, which executes whatever it wrote. That is arbitrary code execution by
construction.

It is not a finding, because `sandbox.ts` says so itself, up front:

> "This module therefore provides *containment*, not a security boundary against
> deliberately hostile code… For untrusted task sources, run OpenUI itself inside
> a container/VM."

The design is honest and the reasoning is sound — "write code and iterate on test
failures" cannot exist without running model-authored code. The containment that
*is* claimed (path confinement, static commands, wall-clock and output caps) was
checked and holds.

**One cheap hardening remains available and is not yet taken:** `npm install`
runs dependency **lifecycle scripts**, which is a different vector from running
the project's own test script — it executes code from a third-party package the
model chose. `--ignore-scripts` would close that half at almost no cost to the
feature. Deliberately left out of this PR to keep a security change from altering
builder behaviour; it wants its own change and its own builder regression run.

**The launch-facing question is not the code, it is the default.** The autonomous
runner's threat model assumes the operator has read that header. If it can be
pointed at third-party GitHub issues without the user being told to containerise
first, the documentation is doing work the product should be doing.

## 8. Dependencies: 19 → 12

Non-breaking fixes applied. Remaining 12 (3 high, 9 moderate) all need major
version bumps — `adm-zip`, `exceljs`, `pptxgenjs`, `image-size`, `uuid` — and are
DoS or resource-exhaustion issues in transitive dependencies, not remote code
execution. The one with a reachable-sounding title is mitigated by §7.

Deliberately not forced. `npm audit fix --force` across four major versions of
document-generation libraries, days before a launch, trades a real regression
risk against DoS bugs that require the user to open a hostile file locally. That
is the wrong trade this week; it is the right one early in the next cycle.

*(Method note: `npm audit fix --omit=dev` prunes devDependencies from
`node_modules` and breaks the local toolchain. `npm install` restores it.)*

---

## Verification

Typecheck, build, and the full suite (**1,885 passed**) all green after both the
encryption change and the dependency bumps.

## What this does not cover

- **No live-credential testing.** `%APPDATA%/OpenUI` holds no channel
  credentials, so the encrypted path has not been exercised against a real Slack
  or Gmail token — only against unit-level round-trips. First real connection
  after this lands is the acceptance test.
- **No penetration testing**, no fuzzing, no supply-chain review of the 1,300+
  transitive dependencies.
- **Update-channel integrity** was not audited. An unsigned update feed is an RCE
  vector and deserves its own pass — though it is moot until code signing exists,
  since an unsigned app has no integrity to protect.
