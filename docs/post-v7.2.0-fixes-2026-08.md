# Post-v7.2.0 fixes — 2026-08-13

Shipping v7.2.0 closed the distribution gap, and the installed-artifact smoke test
that proved packaging was fine also surfaced two defects that were live in the
release users were downloading. This phase fixes them. Everything below was
measured on this machine against real runs; no result here is inferred.

---

## 1. WhatsApp watcher: the detector OCR'd the whole screen

### The defect

`readWhatsAppUnreadSenders()` focused WhatsApp and then called
`captureScreenPng()` — the **entire display** — handing every 2–60 character line
on the desktop to the sender filter. A sender ENTERING that set is the trigger to
act, so arbitrary on-screen text could put a name in front of the allowlist
matcher and navigate the user's WhatsApp to the wrong contact's chat.

The v7.2.0 release notes told users to avoid the feature. That is a mitigation,
not a fix; the code stayed shipped and reachable.

### Why the previous "verified" reading was wrong

An earlier phase measured "0 drift across idle polls" and called detection
verified. That held **only because the screen was static**. Drift is a function of
what else is on screen, not of OCR jitter, so an idle desktop cannot exercise the
bug at all. Every measurement below therefore runs against a deliberately busy
screen.

### The fix

Capture WhatsApp's **own window**, via `desktopCapturer.getSources({types:['window']})`
— the same Electron API `captureScreenPng()` already uses — and select it with
`bestWindow()`, the existing fuzzy window matcher `open_app` uses. Then crop to
the chat-**list** column, because the open conversation in the right-hand pane
re-renders between polls and manufactures "new senders" out of its own text.

Two hazards this avoids, both real on this machine:

- **Coordinate spaces genuinely disagree.** The display is 1707×1067 DIP at
  `scaleFactor` 1.5 → 2561×1601 physical, but `captureScreenPng` returns a
  1728×1080 thumbnail. Screenshot-and-crop-to-window-bounds needs a scaling step
  that is silently wrong when it is wrong.
- **Occlusion.** A cropped screenshot of a covered window contains whatever is on
  top of it — the same bug in a new place. A window source does not.

Fails **closed**: when WhatsApp has no capturable window, callers report "could
not read" rather than falling back to the whole screen. (Measured: while
minimized, WhatsApp is absent from the window-source list entirely, which is why
the existing focus step still matters.)

### Measurement — 20 polls, 15s interval, deliberately busy screen

The noise was an **always-on-top window, moving every 5s, whose text changed every
second**, carrying a sentinel token that cannot occur in WhatsApp. That converts a
counting argument into a decisive one: any sentinel reported as a "sender" is
unambiguously desktop text.

| Capture method | Spurious new senders (19 diffs) | Sentinel accepted as a sender |
| --- | --- | --- |
| Whole screen (v7.2.0) | **617** (~32/poll) | **18** |
| WhatsApp window | 78 (~4/poll) | **0** |
| WhatsApp chat-list column (shipped) | **10** (~0.5/poll) | **0** |

The sentinel column is the result that matters: the noise window was *literally
covering part of WhatsApp* and the window-scoped capture never once saw it.

**Control against a vacuous reading:** a blank crop would also score zero. The
chat-list crop yields a stable **17–18 candidate lines every poll** (the real chat
list), while the whole screen fluctuates 27–41. The near-zero drift is signal
stability, not an empty image.

### Defence in depth on the read path

`openWhatsAppChatViaKeyboard` types into search and presses Down+Enter with **zero
verification of what it landed on**. If the search matched something else — or
nothing, leaving the previous conversation open — the composer would read a
different person's messages and draft against them. Same class of defect as the
whole-screen capture, one step further down the path.

`readWhatsAppChatText` now uses `resolveWhatsAppContact` — the
**verify-before-selecting** flow `send_whatsapp_message` already uses, which OCRs
the filtered search results and scores them, resolving only a clearly-best,
well-separated match — and then opens the *confirmed* string. It fails closed: an
ambiguous or unreadable result yields no draft rather than a guessed one. The
auto-reply read path is not the low-stakes case `open_whatsapp_chat` was built
for, so it belongs on the verified flow.

**A first attempt at this was wrong and the verification caught it.** The
original approach cropped the on-screen **conversation header** and checked it
named the intended contact. Measured against a real WhatsApp window, that crop
(`left: 0.28, top: 0, height: 0.13`) landed on WhatsApp's **title bar** — the
minimise/maximise/close buttons — not the conversation header. It returned one
7-character line matching no chat name, and had it shipped, `openChatMatches`
would have rejected **every** legitimate chat, silently disabling drafting
altogether while looking like a safety feature.

Two lessons kept here deliberately: pixel geometry was the wrong tool for a
check that must not fail closed by accident; and the sidebar-width assumption in
that same attempt was also off (the sidebar ends at ~38% of window width, not
28%) — which is why the chat-list crop is validated by content (a stable 17–18
real lines per poll) rather than by an assumed layout.

---

## 2. Builder reliability: it really is a coin flip, and we found why

### Method

18 trials, one fresh app launch each, all prompts **distinct** (`deriveProjectSlug`
keys the project folder off the user's message, so a repeated prompt inherits the
previous run's files and the result is meaningless). Project folders were deleted
between the two arms so "files created" means what it says.

An Ollama capture **proxy** recorded the full model response for every turn. This
was the missing diagnostic: when the builder decides a reply was "JSON but not a
tool call" it *withholds the text from the UI*, so the exact bytes that failed to
parse never reach the event transcript.

> A first attempt lost 12 of 18 trials to a harness bug, not a builder bug: OpenUI
> is a **tray app** that survives `app.close()`, so the surviving instance held
> Electron's single-instance lock and the next launch quit immediately. The driver
> now kills the tray between every trial. Results below are from clean runs.

### Baseline — merged main (`a0abee5`), 18 trials

| Outcome | Count |
| --- | --- |
| success | **9 (50.0%)** |
| give_up | 8 (44.4%) |
| malformed_abort | 1 (5.6%) |

**50% — the "coin flip" is confirmed, with a real sample.**

### The dominant failure: static-site verification

**6 of the 8 GIVE UPs produced files first.** Reading their stated reasons, they
converge on one thing — the model finished a static site, tried to verify it, and
had nowhere to go:

- *"there is no `package.json` file in the workspace, and no build or development
  scripts defined"*
- *"the project is a [static site] … does not involve running any automated tests"*
- *"'http-server' command was not found"* — it invented npm scaffolding to have
  something to verify, and the scaffolding broke
- *"the JSON format of your `package.json` is incorrect"* — same, one step later

`npm test` exits 1 for a static site no matter what, that surfaced as
`TESTS FAILED`, VerifyGate never saw a pass, and since no amount of editing makes
a non-existent suite go green the model spent its nudges and quit **on work that
was already complete**. This is the same defect as §3 below: the two steps turned
out to be one bug.

Only 2 of 8 give_ups were unrelated (0 tools, model never started).

### Two further gaps, found by re-running the trials against the first fix

Re-measuring is what exposed these; neither was visible from the baseline alone.

1. **`run_script` had the identical hole.** A static site with no `package.json`
   got a hard failure from `run_script "dev"`, sending the model looking for a
   build system that will never exist. It now reports `SCRIPT SKIPPED` on the same
   "nothing to run" terms as `run_tests` — but still **fails** when scripts exist
   and the model merely named the wrong one, or when `package.json` is malformed.

2. **The gate honoured `GIVE UP` unconditionally, even when it had just watched
   the build succeed.** Observed live: write `index.html` → `open_in_browser` →
   `list_files` (which IS the website profile's verifier, and passes) → *"GIVE UP:
   there are no tests or scripts to run"*. Reported as a failed build. A second
   shape had the model **recite the profile's own guidance** — *"calling
   `list_files` counts as verification for a static site"* — and then give up
   instead of calling it.

   A `GIVE UP:` is now **challenged once** before it is honoured, on two grounds:
   `contradicted` (a verifier passed against the tree as it stands) and `untested`
   (files were written but nothing was ever verified, so the give-up is a guess).
   A run that never touched the tree is **not** challenged — "I can't do this" is
   a real answer when nothing was built. The challenge costs one turn, never
   invents a pass, and a repeated give-up is honoured, so a genuinely broken build
   still terminates.

   This deliberately changes a contract `verifyGate.test.ts` asserted ("honours
   GIVE UP even with unverified work outstanding"); that test is updated and
   annotated rather than deleted.

### Result — same 18 prompts, same machine, same model

| | baseline (`a0abee5`) | fixed |
| --- | --- | --- |
| success | **9 (50.0%)** | **17 (94.4%)** |
| give_up | 8 (44.4%) | 1 (5.6%) |
| malformed_abort | 1 (5.6%) | 0 |

**8 trials improved, 0 regressed.** Median wall-clock 33s, 138 tool calls across
the run.

**The one remaining failure is understood and is the conservative direction.**
Trial 5 built an npm-scaffolded pricing page, ran `run_script` and `list_files`
(verified), then called `run_tests`; `package.json` had scripts but no `test`, so
that is a real failure by the rules above (it steers to `run_script`) and it
un-verified the tree. The gate challenged the subsequent GIVE UP twice, the model
insisted, and the run ended red rather than claiming a pass nobody observed. That
is the gate working as designed. Chasing it would mean tuning against a single
sample, which the earlier phase already showed this harness cannot resolve
(±1 case ≈ 2.8 points).

### The secondary failure: invalid JSON escapes (the third sibling to #162's two)

Across 67 captured turns, **4 of 4** `malformed_abort` turns were a single error,
at the same byte offset, repeated because the model re-emits identical content on
retry. `qwen2.5-coder:7b` asked for a webpack config emitted:

```json
{"tool":"write_file","args":{"content":"... test: /\.js$/, ... test: /\.scss$/ ..."}}
```

Those are JavaScript **regex literals**, and `\.` is not a JSON escape. `JSON.parse`
fails with *"Bad escaped character"*, the tool call is dropped, and the build burns
its malformed-retry budget and aborts having written nothing. Windows paths
(`C:\Users\…`) break identically.

`repairLooseJson` already fixed raw control characters but not invalid escapes.
It now doubles a backslash that does not begin a legal JSON escape — the
meaning-preserving repair, since a backslash the model did not intend as an escape
*is* a literal backslash. `\uXY` is treated as invalid too; `\u0041` is not.

**Verified against the real capture**: replaying all 67 recorded turns through the
patched parser takes MALFORMED from **4 → 0**, with those turns now parsing as
genuine `write_file` calls (known-tool count 52 → 56). It only ever runs as a
second attempt after a strict parse has failed, so valid JSON is never rewritten.

---

## 3. False "GIVE UP" on test-less static builds

Fixed as part of §2, since it turned out to *be* the dominant builder failure.

`runTests()` now classifies the no-suite cases **before** invoking npm:

- **No `package.json`** → `skipped`, with a message pointing at `list_files` (the
  verifier a static site can actually satisfy) instead of demanding a
  `package.json` the site does not need.
- **No `test` script, or npm-init's `echo "Error: no test specified" && exit 1`
  placeholder, and nothing else runnable** → `skipped`.
- **No `test` script but another script exists** → still a **failure**, naming
  `run_script` and the available script. A site with a build step should be built,
  not waved through.
- **Unparseable `package.json`** → unchanged; stays on the npm path so #162's
  verbose re-run still produces an actionable `EJSONPARSE`.

`run_tests` reports this as a third marker, `TESTS SKIPPED`, which the **website**
profile maps to a pass — the bar that profile already accepts for a static site is
`list_files` ("the files exist"), and "there is nothing to test" is not a weaker
claim. **Only** `website` opts in; on `node`, a missing test script stays a real
gap the model is told to close by writing one.

Measured npm behaviour this rests on: with no `test` script, `npm test --silent`
exits 1 having printed **nothing at all**.

---

## 4. Queue

- **PR #164** — already **merged** (`3a205cd`, 2026-08-12T16:25Z, by Satyabrat2005).
  The brief listed it as open and unmerged; that was stale. Nothing to do.
- **Telemetry** — root cause sharpened by direct probe. It is the **path**, not the
  hostname:

  | URL posted to | Result |
  | --- | --- |
  | `https://us.i.posthog.com/batch/` | **200** `{"status":"Ok"}` |
  | `https://us.posthog.com/batch/` | 200 `{"status":"Ok"}` |
  | `https://us.posthog.com/project/12345/batch/` | **403** |

  Fixed in two places: the `VITE_POSTHOG_HOST` repo secret now holds the ingest
  host, and `normalizePostHogHost()` strips a URL path and maps the known
  app-hostnames to their ingest hosts, so a copy-pasted project URL can never
  silently disable telemetry again — in any deployment, not just this repo's CI.
  A self-hosted host is passed through untouched.

  **Not verified end-to-end**: landing one real event needs a build carrying the
  real project API key, which is a write-only secret unavailable locally.
- **Linux packaging** — confirmed absent from `electron-builder` config entirely;
  the release matrix is macOS + Windows across 4 arches. Asked, and the answer was
  **out of scope**: documented here, no build config touched. Linux is unbuilt and
  untested.

---

## Reproducing

Scripts are archived in this session's scratchpad, not committed (they hardcode
absolute paths and drive the user's real WhatsApp):

- `__probe-busy.cjs` — the sentinel A/B capture comparison
- `trials.cjs` — the N-trial builder harness
- `ollama-capture-proxy.cjs` — transparent proxy recording every `/api/chat` turn
- `__diagnose.test.ts` — replays captured turns through the real parser
