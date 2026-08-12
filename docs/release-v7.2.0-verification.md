# v7.2.0 — release + installed-artifact verification (2026-08-12)

Six PRs (#157–#162) of verified fixes had reached `main` and **none had reached a
user**: `v7.1.4` (2026-07-24) and the `v0.0.1-rc1` prerelease both predate #157.
This document records cutting v7.2.0 and — for the first time in this project —
verifying the **packaged installer a stranger actually downloads**, rather than a
source checkout.

## 1. `main` was current before tagging

`#162` was merged at 2026-08-12T10:54Z, so all six were in. Verified by ancestry
and by blob hash rather than assumed:

- All six merge commits are ancestors of `main`
  (`850ce64`, `ee2e627`, `9909abf`, `c9e46bf`, `fe021cb`, `cf59927`).
- Working copy vs `main`: **348 of 350 blobs identical**. The two differences are
  `.gitignore` (known, pre-existing) and `docs/builder-verification-2026-08.md`
  (added by #162, main-only). No code drift.

## 2. The release

`v7.2.0`, cut from `ef992bd`, published **2026-08-12T11:35:58Z**, `draft=false`,
`prerelease=false`, and it is the repo's `releases/latest`.

Green CI on the build step is not evidence the release published — checked
separately. Both matrix legs succeeded and **12 assets** are attached:

| asset | bytes |
|---|---|
| `OpenUI-Setup-7.2.0.exe` | 364,864,698 |
| `OpenUI-x64.dmg` / `OpenUI-arm64.dmg` | 232,166,841 / 227,455,640 |
| `OpenUI-7.2.0-mac.zip` / `OpenUI-7.2.0-arm64-mac.zip` | 232,560,287 / 227,824,779 |
| `latest.yml`, `latest-mac.yml` | 341 / 786 |
| 5 × `.blockmap` | — |

The updater feeds both advertise `version: 7.2.0` — the `.zip` files macOS
auto-update actually downloads are present, not just the `.dmg`.

**Scope note:** the release matrix is macOS + Windows. There is no Linux target
in `electron-builder` config, so "all three platforms" is not a thing this repo
can currently produce; what ships is 2 OSes across 4 architectures.

**Signing: unsigned on both platforms**, per the standing decision. Confirmed on
the real artifact — `Get-AuthenticodeSignature` returns `NotSigned`.

## 3. The installed artifact

Downloaded the published `.exe` and installed it fresh, with the machine's
existing `%APPDATA%\openui` moved aside so this was a genuine first run.

**Integrity.** The downloaded file's SHA-512 (base64) is
`d+QEAYLIXiNzTmJ1U5duYUFo2urDttal5XG7WxNxobqJ9o35V/xf1Z+8SiAc19ssf1Df7WO+21p9hWzUMa4QIA==`,
**matching `latest.yml` exactly**. This also validates the verification recipe in
`docs/INSTALL-WINDOWS-BETA.md` against a real release file.

**It is genuinely the new code**, not a stale bundle. `OpenUI.exe` reports
`FileVersion 7.2.0`; at runtime `app.getVersion() === '7.2.0'` with
`isPackaged === true` and `appPath` inside `resources\app.asar`. Markers for
every PR are present in the 270 MB asar:

| marker | PR | in asar |
|---|---|---|
| `compactBuilderHistory`, `ensureOllamaRunning` | #157 | yes |
| `Continuing project`, `EDIT_VERB_RE` | #158 | yes |
| `selectToolGroups` | #161 | yes |
| `closeUnbalancedJsonObject` | #162 | yes |

**Cold start works in the packaged build.** With every Ollama process killed and
port 11434 confirmed dead, the installed app emitted *"Local AI engine is not
running — starting Ollama…"*, started it, pulled/verified `qwen2.5-coder:7b`
(progress events through to `status: ready`), created a project folder, and the
update check correctly reported `update-not-available {version: 7.2.0}`. That
exercises #157's `ensureOllamaRunning` on the artifact, not on source.

### Is there a packaging bug? No.

The first build attempted on the installed app failed (2 tool calls, then
`GIVE UP`), which would have been alarming taken alone. It is not a packaging
defect: a **paired trial** — the same three prompts run against the installed
`.exe` and against a dev build of the *identical commit* — shows the same failure
modes on both sides.

| prompt | installed | dev |
|---|---|---|
| bakery landing page | 3 tools, completed (41s) | 11 tools, completed, with a rewrite loop (66s) |
| html calculator | **0 tools** — model returned JSON with no `tool` field ×3 | 4 tools, completed (55s) |
| photographer resume | 4 tools, files written, then `GIVE UP` | **0 tools**, `GIVE UP` (19s) |

Every failure mode observed on the installed build also occurs on the dev build,
and the dev build produced the single worst run in the set. **Nothing behaves
differently because it is packaged**, so the verification work done to date does
transfer to what users get.

### What the trial did surface (pre-existing, not a regression)

1. **Builder first-attempt reliability on a local 7B is roughly half.** Across 6
   runs: 2 clean successes, 1 success with a redundant `install_dependencies` /
   `edit_file` loop, 2 zero-tool runs, 1 give-up. Identical distribution in dev,
   so this is not introduced by the release — but it is the honest number for
   what a user experiences, and it is worse than any single-run demo suggests.
2. **A completed build can be reported as a failure.** In the photographer-resume
   run the installed app wrote `package.json` + `index.html` (643 b) and opened
   it in the browser — a materially correct static site — then the verification
   nudge forced `run_tests`, `npm test` failed with `Missing script: "test"`, and
   the turn ended in `GIVE UP`. The user is told the build failed while a working
   page sits in the project folder. Static-site builds should not be verified
   with `npm test`.

Neither is a release blocker and neither is fixed here — this phase ships what is
already verified rather than opening new work — but both are recorded so they are
not rediscovered as new.

## 4. Shipping-surface defects found and fixed

Checking what a stranger's download path actually looks like turned up three
things, all fixed in this change:

1. **The Windows download button linked to a URL that 404s.** The download dock
   in `docs/design/design.html` pointed at
   `releases/latest/download/OpenUI.Setup.exe`; the published asset is
   `OpenUI-Setup-<version>.exe`, so no such file has ever existed. Verified: that
   URL returns **404**, resolving to the right release and the wrong filename.
   The Mac button had already been given a "safe default that never 404s" with a
   comment explaining exactly this hazard — and the JS that repairs the Mac href
   from the API response **never set the Windows href at all**
   (`winBtn.setAttribute("href", …)` appeared nowhere), so the static URL was
   what every Windows visitor got even when the fetch succeeded. Both halves are
   now fixed and checked against the live API: the static fallback and the
   JS-resolved `browser_download_url` both return **200**.
   *Severity: latent — this repo publishes no Pages site, so it was not a live
   404 today. It would have become one the moment the page shipped.*
2. **`README.md` claimed releases are signed.** They are not, on either platform.
   Corrected, with pointers to the per-platform install docs.
3. **`docs/INSTALL-WINDOWS-BETA.md` referenced `OpenUI-Setup-7.1.4.exe`.** Updated
   to 7.2.0, made version-agnostic, and given the real published digest.

## 5. Still open

- **WhatsApp auto-reply drafting** — see the release notes' *Known limitations*.
  Detection is proven; the compose/draft path is recorded as unverified rather
  than quietly assumed to work.
- **Fine-tuning** — explicitly shelved, with reopen conditions, in
  `docs/finetune-track-decision-2026-08.md`.
