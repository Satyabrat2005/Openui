# Prompt-shrink phase — 2026-08

Four earlier sessions independently landed on the same conclusion: the system
prompt was too big for the hardware. This phase acted on it, then cleaned up what
it had been blocking. Everything below is measured on this machine (RTX-class
8 GB card, Windows 11, Ollama 0.31.2) unless it says otherwise.

**Headline:** the tool-schema payload is gone as a problem. The general-agent
prompt went from a fixed **15,059 tokens** to **3,909–6,821 tokens** depending on
the request, `num_ctx` from **32768 → 8192** on **33 of 35** model-scored eval
cases, and routing accuracy did **not** regress — `qwen3.5:latest` went **74.3% →
77.1%**. Six live routing bugs were found by driving the real app and fixed. The
default model was **not** switched, and the reason is a measurement, not a
preference.

---

## 1. Did the shrink work?

### Prompt size

Measured over the 35 model-scored eval cases (the 9 builder cases use a separate
coding prompt and `CODING_NUM_CTX`'s 16384 floor by design — see PR #157):

| | before | after |
|---|---|---|
| system prompt | 53,190 chars / **15,059 tok** (fixed) | 15,633–27,282 chars / **3,909–6,821 tok** (per request) |
| tool schemas in prompt | 124 of 133, every turn | 16–43, selected per turn |
| schema block share | 41,464 chars — **67.9%** of the prompt | varies with the surface |
| `num_ctx` (general agent) | **32768**, every turn | **8192** on **33 of 35** cases |

The two exceptions are `web-02` ("go to github.com in my browser" — browser +
github) and `safe-02` (a prompt-injection case that legitimately names a web page
*and* email), both at 16384. Nothing needs 32768 any more.

The 133 general tools are partitioned into 22 surface groups
(`src/main/toolGroups.ts`). A regex first pass over the user's own words picks the
groups a turn plausibly needs; only those schemas — plus a 16-tool always-on core
— reach the prompt. The prose workflow blocks are gated the same way, which
matters because they were the other ~32% of the payload.

No model call is involved in the classification. It has to be much cheaper than
the generation it trims, or it defeats its own purpose.

### VRAM residency — the point of all this

`qwen3.5:latest` measured via `/api/ps` during a real turn:

| | `num_ctx` | resident |
|---|---|---|
| before (recorded in the fine-tune phase) | 32768 | **73%** (~1.66 GB on CPU) |
| after | 8192 | **86%** — 5,272 MB of 6,139 MB (~867 MB on CPU) |

About 800 MB moved from CPU back into VRAM purely by not needing a 32k window.

### Routing accuracy — the real test of the hypothesis

44-case eval set, `temperature=0, seed=0`, replies parsed and never executed.
9 cases are router-decided; 35 are model-scored.

| model | before (full prompt) | after (grouped) |
|---|---|---|
| `qwen3.5:latest` (shipped default) | 74.3% (26/35) | **77.1% (27/35)** |
| `qwen2.5-coder:7b` | 77.1% (27/35) | 74.3% (26/35) |

So the shrink **did not** cost accuracy, and for the shipped default it gained a
case. It did not transform accuracy either — the "model is drowning in irrelevant
tool definitions" hypothesis is, at this scale, worth about one case.

**The two models are within noise of each other.** Adding a single clarifying
line to the prompt (an `open_app` vs `open_folder_in_editor` disambiguation) was
enough to swap them — `qwen3.5` 77.1→74.3 and `coder:7b` 74.3→77.1. A 1-case /
2.8-point gap that inverts on one line of prose is not an accuracy difference.
That line was measured, found to be net-negative, and removed.

### Fidelity of the measurement

The eval replays prompts **captured from the running Electron app**, never
reconstructed — the prompt depends on runtime state (token presence, the
refiner's stored prompt, MCP servers, the few-shot block) that a test cannot see.
Because the app now builds a *different* prompt per request, the harness gained
`--prompt-dir` for per-case prompts, and `ollama-capture-proxy.cjs` gained
`--stub`: it answers `/api/chat` locally with plain prose so the eval set's "send
an email to my manager" and "message Ashu on WhatsApp" prompts can be driven
through the real app **without sending anything to anyone**.

Two things had to be corrected before the comparison was fair, and both are worth
recording because either would have produced a confident wrong answer:

1. **Conversation contamination.** The first capture ran all 44 messages in one
   thread, so each prompt carried the previous cases' context and an active build
   session. Prompts became a function of case *order*. Fixed by
   `clearHistory()` before every case.
2. **Token parity.** The #160 baseline prompt was captured on a session that had
   a GitHub token (124 tools = 133 − 9 Figma). Without one, all five `gh-*` cases
   have no GitHub tool in the prompt at all and scored as "regressions" that had
   nothing to do with the shrink. The capture now sets a placeholder
   `GITHUB_TOKEN` to match — never used, since the eval only parses replies.

---

## 2. Default model: NOT switched

`DEFAULT_GENERAL_MODEL` stays `qwen3.5:latest`; `DEFAULT_CODE_MODEL` stays
`qwen2.5-coder:7b`.

The fine-tune phase recommended switching to `coder:7b` on a +2.8-point routing
win. **That advantage does not survive the prompt shrink — it inverts.** It was
an artifact of the oversized prompt: `qwen3.5` was spilling ~1.7 GB to the CPU at
`num_ctx` 32768, and the shrink is what fixed that. With the prompt fitting,
`qwen3.5` scores one case higher, and as noted the gap is not robust in either
direction.

What is robust is latency: `coder:7b` is consistently ~2.4× faster (median 3.03 s
vs 7.42 s on the grouped prompts; 1.19 s vs 4.76 s on the old ones). Latency does
not reproduce exactly between runs, so treat it as indicative.

That leaves one real argument for unifying on `coder:7b` that accuracy does not
settle: with two different models, chat turns and builder turns cannot both stay
resident on an 8 GB card, so switching surfaces evicts and reloads. See the
builder verification below for whether that cost is worth a model change; it is
the open question this phase did not close.

---

## 3. Live routing bugs found by driving the real app

Six, all confirmed against the running Electron app rather than reasoned about.
Each has a regression test.

| # | Bug | Effect | Fix |
|---|---|---|---|
| 1 | `PR_REVIEW_RE` matched a bare "pull request" | "list the open pull requests" and "open a pull request" both entered PR-**review** mode, which forces pro tier and whose mandate is to comment on *every* open PR. A read-only request would write to GitHub; `open_pull_request` isn't even in review mode's 3-tool prompt. | require review intent |
| 2 | `DESIGNER_RE` matched "design review" | A meeting called **"Design Review"** entered Figma designer mode — pro tier, Figma-only toolset, no `control_calendar`, so the request became unanswerable. | require the word "figma" |
| 3 | `looksLikeBuildFollowUp` ignored real paths | With a build session warm, "make a folder called invoices in my **Documents**" and "delete everything in **C:\Windows\System32**" were routed into the sandbox as project edits. | reject named filesystem locations |
| 4 | "keep building the site" reached neither router | `BUILD_RE` wants a build verb + software noun and its list had "website" but not bare "site"; `EDIT_VERB_RE` wants a *leading* edit verb and "keep" isn't one. The phrasing the step-limit message tells users to send fell through to general chat. | `looksLikeBuildContinuation` |
| 5 | `BUILD_RE` had no bare `page`/`html` | "build an html page" — about the most literal build request there is — went to general chat. | added `page`, `html`, `css`, `site` |
| 6 | `control_calendar` "auto" ignored backend availability | On Windows without classic desktop Outlook, a plain "schedule a meeting at 3pm" went to Outlook COM and died with `REGDB_E_CLASSNOTREG` **even with Google Calendar connected**, because `auto` only considered Google when invites/Meet were requested. | see §4 |

Also fixed, and it was blocking work: `agent.ts` contained a **raw NUL byte** in a
template literal, so ripgrep classified the whole file as binary and silently
stopped searching it. Replaced with a `\u0000` escape — byte-identical at runtime,
plain ASCII on disk.

---

## 4. Gmail and Calendar — the diagnosis was wrong

The phase brief carried these as *routing* bugs ("Gmail routes to
`read_clipboard`", "Calendar routes to Outlook COM instead of Google"). Measured
against the eval, at the model level they are not:

| case | before | after |
|---|---|---|
| all 5 `cal-*` | `control_calendar` ✓ | `control_calendar` ✓ |
| 5 of 6 `mail-*` | correct | correct |
| `mail-01` "draft an email…" | `send_email` ✗ | `create_email_draft` ✓ |
| `mail-03` "email my manager" | right tool, no `to` | right tool, no `to` |

- **Gmail → `read_clipboard`** was a *truncation* artifact of the pre-#159 prompt
  (13.3k tokens against a fixed 8192 window; Ollama drops the middle, where the
  tool instructions live). #159's `num_ctx` sizing already fixed it; the shrink
  keeps it fixed with headroom instead of a 32k window.
- **Calendar** is not a routing bug at all — the model calls `control_calendar`
  correctly every time. The bug was *inside* the tool's backend selection, and it
  is bug 6 above. `auto` now prefers Google when there is genuinely no local
  backend, detected by a cheap registry probe for the `Outlook.Application`
  ProgID (verified absent on this machine, and instantiating the COM object here
  throws exactly `REGDB_E_CLASSNOTREG`). When neither backend exists the error
  now names Google Calendar as the fix instead of returning a raw HRESULT.
- **`mail-03`** emits `send_email` with `to: ""` because it cannot know who "my
  manager" is. Asking the user would be *correct* behaviour; the eval scores it
  as a miss. That is an eval-set limitation, not a model bug.

---

## 5. Script cleanup

**`train_lora.py` — deprecated, not deleted.** It loads the base in bf16
(~15 GB for its own default 7B base) against an 8 GB target, so it could only ever
OOM, and only *after* downloading the whole base model. It now refuses to run
unless given `--allow-bf16`, and says what to use instead. Kept rather than
deleted because bf16 LoRA is right on large-VRAM hardware and this working copy is
not under version control, so a deletion would be unrecoverable.

**`pipeline.ts` adapter path — LIVE, and it could never have worked.** The
scheduler really does call `maybeRunFineTune()` in the shipped app (opt-in gated).
Two defects made success impossible:

1. it invoked the deprecated bf16 `train_lora.py` → now `train_qlora.py`;
2. it wrote `ADAPTER ./adapter`, a peft `save_pretrained()` **directory**.
   Reproduced on Ollama 0.31.2 against a real trained adapter recovered from a
   previous run:

   ```
   Error: no Modelfile or safetensors files found
   ```

   — doubly misleading, because `adapter_model.safetensors` *is* in that
   directory. Ollama needs a single **GGUF** file. So every pass that got that far
   discarded hours of training at the final step.

The fix converts the adapter with llama.cpp's `convert_lora_to_gguf.py` and
**pre-flights the converter in `fineTuneSkipReason()`** — i.e. before the two-hour
training budget is spent, not after. `build_ollama_model.py` had the identical
directory-adapter bug and now converts too.

Not claimed: a full training run was **not** executed end to end. The fine-tune
phase already established that 7B QLoRA OOMs on this card and that the tuned 3B
regressed safety, and this phase's non-goals rule out another attempt. What is
verified is that the guaranteed-failure paths are gone and the precondition fails
fast with an accurate reason.

---

## 6. First-run fixes

**Model label.** `RunConsole.tsx` rendered the literal string `llama-3.3-70b`
while the app has only ever run qwen models. It now shows the model the backend
reports for the turn (`onChatModel` + `labelForModel`, the same contract
`LocalAIStatus.tsx` uses) and a neutral "Local AI" before any turn has run — never
a fabricated name. `OnboardingWizard.tsx` had the same string plus "ready · 0
setup"; both were untrue, since a local engine needs Ollama and a multi-gigabyte
model.

**Missing-model download, with real progress.** The app had **no** `/api/pull`
call anywhere: a user with Ollama installed but nothing pulled hit a raw 404 and
had to work out on their own that a terminal and a multi-gigabyte download were
required. `src/main/ollamaPull.ts` now downloads the model on the first turn and
streams progress to a bar above the composer. Details that matter:

- Phases Ollama reports without byte counts ("pulling manifest", "verifying
  sha256 digest") report `percent: null` and render as status text with an
  indeterminate fill. A 0%-width bar is exactly what reads as a hang.
- Concurrent callers (chat, planner, refiner) share one download.
- A stream that ends without `success` is an error, not a usable model.
- The model pool cache is invalidated on success, or the turn that triggered the
  pull would still see the model as missing.

**`run.bat` / `run.sh`.** Both claimed Ollama was *optional* and that runs were
"cloud-first", then pulled `llama3:8b`. All three statements were false: the cloud
tier ships off, the app has never used `llama3:8b`, and with no local model
nothing works. They now require Ollama, report what is installed, and pull
nothing — the app does that itself, with progress.

**Code signing — scoped, not completed.** Confirmed via `gh secret list`: the repo
has exactly four secrets (`SUPABASE_*`, `VITE_POSTHOG_*`) and no signing config,
so every installer is unsigned. The *pipeline* is cert-ready (macOS
`hardenedRuntime`, entitlements, an `afterSign` notarize hook that degrades to
ad-hoc signing, and documented secret names).

The blocker is certificates, and the documented Windows route **no longer
exists**:

- Since 1 June 2023 the CA/Browser Forum requires code-signing private keys on
  FIPS 140-2 Level 2 / CC EAL4+ hardware, and CAs stopped issuing downloadable
  `.pfx` files (DigiCert: April 2023). A new OV/EV certificate arrives on a
  hardware token or cloud HSM — there is nothing to base64 into `WIN_CSC_LINK`,
  and a USB token cannot be attached to a GitHub-hosted runner. From 15 Feb 2026
  these certificates are 1-year only.
- **Recommended: Azure Trusted Signing** (now "Azure Artifact Signing"), ~$9.99
  /month Basic, signs in CI with no hardware, open to individual developers and to
  organisations under 3 years old. Needs a custom electron-builder `sign` hook
  rather than `WIN_CSC_LINK`.
- Alternative: a cloud-HSM certificate (DigiCert KeyLocker / SSL.com eSigner /
  Certum), roughly $250–600/year.
- macOS is unchanged and cheap: Apple Developer Program $99/year, `.p12` export
  still works.
- Either way, OV signing does not grant instant SmartScreen trust — reputation
  accrues with download volume. Only EV is immediate.

`release.yml`'s comment block has been corrected in place, because following it as
written would waste money on a certificate that cannot be used in this pipeline.

---

## 7. What is still open

- **WhatsApp auto-reply with a real inbound message: NOT verified.** WhatsApp
  Desktop is installed (`5319275A.WhatsAppDesktop_2.2630.102.0`), and the feature
  is deliberately draft-only — the watcher composes a suggestion and a human
  clicks to send. Verifying detection end to end requires a real inbound message
  from an allowlisted contact, which needs a second person; manufacturing one by
  messaging a real phone is not something to do for a test. The pure decision core
  (allowlist matching, rate limits, fail-closed defaults) is unit-tested; the
  screenshot→OCR detection path against a live window remains unexercised.
- **Unifying on one model** to avoid chat↔builder VRAM eviction on an 8 GB card —
  the one argument for a default change that accuracy doesn't settle.
- **`mail-03`-style eval cases** score a correct "ask the user" as a miss.
- The repo working copy is **not a git repository**, so nothing here is a commit,
  branch, or PR. `Downloads/OpenUI` (the clone used in earlier sessions) no longer
  exists.

## Test suite

85 files, **1522 passed**, 1 skipped — up from 80 files / 1392 passed. Typecheck
and lint clean. New: `toolGroups.test.ts` (58), `promptSize.test.ts` (26),
`ollamaPull.test.ts` (15), `finetune/pipeline.test.ts` (8),
`calendarBackend.test.ts` (8), plus RunConsole model-chip/pull-bar tests and the
routing regressions in `agent.test.ts`.

One test was found to be **vacuous**: `agent.test.ts`'s "the real general-agent
system prompt fits in the window it gets" builds its prompt from a *single* stub
schema, because that file mocks `./tools`. The guard written specifically to catch
tool-surface growth could never fire. The real guard now lives in
`promptSize.test.ts`, which imports the genuine 133-tool registry.
