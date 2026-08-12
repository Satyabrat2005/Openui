# Builder verification on merged main (2026-08-12)

The verification PR #161 shipped without. #161 rewrote the builder's own routing
path — `BUILD_RE`'s noun list, the "keep building the site" fallthrough, and the
follow-up/resume routing with its `C:\Windows\System32` guard — and the run that
would have proven those changes safe was lost across a session boundary. Nobody
had confirmed the builder still worked at all on merged main.

Everything below came from driving the **real Electron app** (playwright
`_electron`, main→renderer event stream captured to disk incrementally), against
a working copy verified byte-identical to merged main: 347 of 348 blobs match
`fe021cb`, the only difference being `.gitignore` (a line-ending artifact, not
runtime code).

**Result: #161 did NOT regress the builder. Two pre-existing bugs did — one of
them severe enough to produce an empty project folder — and both are fixed here.**

---

## What was run

| Stage | Prompt | Cold start? |
|---|---|---|
| 1 | `build a small html landing page for a coffee shop called Bean There` | yes — every Ollama process killed first, `/api/ps` unreachable at boot |
| 2 | `add a contact section` | same warm app process as stage 1 (the follow-up window needs it) |
| 3 | `build a multi-page website for a bookshop with at least 10 separate files: …` | model warm, to isolate the loop-guard path from engine-start variance |

Results were appended to disk as each stage completed, never buffered to the end
— the previous attempt was lost to a monitor timeout with no partial record.

---

## Stage 1 — cold start and a small build: PASS

- Cold start worked: the app emitted "Local AI engine is not running — starting
  Ollama…", pulled/verified `qwen2.5-coder:7b` with real progress events, and
  reached `ready`.
- `/api/ps` afterwards: `qwen2.5-coder:7b ctx=16384 vram=5212/5212MB` — fully
  resident, so `CODING_NUM_CTX` really applies at runtime.
- Routing correct: `BUILD_RE` matched, project folder `bean-there`, sandboxed.
- Completed in 142 s, 38 tool calls, real files written.

**But** 24 of those turns were a `edit_file:test.js` → `run_tests` loop that never
went green. See "Bug 2".

## Stage 2 — incremental follow-up: PASS (this is the #161 claim under test)

`add a contact section` produced the task line

```
Continuing project: bean-there    →  C:\Users\…\OpenUI Projects\bean-there
```

— i.e. the **resume** path, not a fresh slug and not a new folder — and the model
called `edit_file` first, as the resume prompt instructs. `index.html` grew
1345 → 1461 bytes and contains `<div class="contact"><h2>Contact Us</h2>`.

This is exactly the behaviour #158 added and #161 rewrote. It works.

## Stage 3 — 10+ file build: FAILED on merged main, now fixed

On merged main this "completed" in 21 s having made **zero tool calls** and
written **zero files**, leaving an empty `multi-page-website` folder. Root cause
in Bug 1. After the fix, the identical prompt produces:

| | merged main | with this PR |
|---|---|---|
| tool calls | 0 | 14 |
| files written | 0 | 12 |
| duration | 21 s | 79 s |
| loop behaviour | n/a | clean — 11 × `write_file`, `install_dependencies`, `run_script`, `open_in_browser` |

All ten requested files are present (`index.html`, `about.html`,
`catalogue.html`, `contact.html`, `styles.css`, `main.js`, `data.js`,
`README.md`, `404.html`, `sitemap.xml`), plus `package.json`. No rewrite loop and
no `run_tests` thrash.

---

## Bug 1 — an unclosed tool call silently threw the whole build away

`qwen2.5-coder:7b` streamed this (verbatim, from the captured event stream):

```json
{
  "tool": "write_file",
  "args": {
    "path": "package.json",
    "content": "…"
}
```

`args` is closed; the **outer object never is**. `extractFirstJsonObject` returns
null for an unbalanced object — commented "likely a still-streaming fragment" —
so `parseToolCall` returned null, the turn parsed as prose, and no tool ran. The
zero-tool guard fired twice ("Replied as if done, but no file has been written")
and then the build finished, reporting success with nothing on disk.

The "still streaming" premise does not hold at the point of parsing: every caller
(`agent.ts`, `autonomous.ts`, `codingSubagents.ts`, `subagents.ts`) parses the
**completed** response returned by `await callModel(...)`. An unbalanced object
there means the model stopped emitting braces, not that more text is coming.

**Fix:** `closeUnbalancedJsonObject` + a last-resort pass 3 in `parseToolCall`.
Two deliberate guards:

- it **requires a known tool name**, so a guess at structure can never invent a
  call out of prose;
- it **refuses to recover a response that ends inside an unterminated string**.
  That case is genuinely truncated, and closing it would hand `write_file` a
  half-written `content` — silently truncating a real file is worse than dropping
  the call.

This reverses a behaviour `agent.test.ts` previously asserted ("executes no tool
when the JSON is unbalanced"). That test is updated, and paired with a new one
covering the truncation refusal, so the safety half stays under test.

## Bug 2 — `npm test --silent` hid the reason for every test failure

`runTests` ran `npm test --silent`. `--silent` sets npm's loglevel to silent,
which suppresses **npm's own errors** as well as the noise it is there to remove.
When npm fails before reaching the test script, stdout and stderr are both empty
and the only feedback reaching the model is execFile's generic

```
TESTS FAILED
Command failed: npm.cmd test --silent
```

In stage 1 the model wrote a `package.json` missing its closing brace. npm could
never run. With no cause to act on, the model guessed, and spent 12 consecutive
`edit_file` / `run_tests` cycles rewriting a `test.js` that was correct the whole
time. Reproduced directly:

```
$ npm test --silent      # (nothing at all)
$ npm test
npm error code EJSONPARSE
npm error JSON.parse Invalid package.json: Expected ',' or '}' … at position 92
```

**Fix:** on the failure path only, and only when nothing was captured, re-run
without `--silent` to recover the diagnostics. A normal failing suite (which
prints its own output) is untouched.

Neither bug is a #161 regression — `sandbox.ts` was last modified 2026-07-13, and
the parser's unbalanced-object behaviour predates it.

---

## Coverage added

- `toolCallParser.test.ts` — 12 tests: brace closing, the multi-brace case, the
  live byte sequence, the mid-string refusal, known-tool gating, and that
  balanced parsing is untouched.
- `sandbox.test.ts` — 3 tests: the real npm error surfaces, a plain failing suite
  still reports its own output, a passing suite still passes.
- `agent.test.ts` — the updated contract plus the truncation-refusal companion.

Suite: 85 files, **1544 passed**, 1 skipped, verified in a clean clone of merged
main with lint and typecheck clean.

---

## Still open

- The model writes malformed JSON often enough to matter (a `package.json` with a
  missing brace in stage 1, a tool call with a missing brace in stage 3). Both
  are now *survivable*, but the underlying output quality is what it is on a 7B.
- Stage 1's build still spent most of its turns on a self-invented `test.js`.
  With Bug 2 fixed the model can now see why the run fails, but whether it
  recovers gracefully has not been re-measured end-to-end.
