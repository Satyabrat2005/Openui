# Local-model eval harness

Scores a local Ollama model against OpenUI's frozen 44-case eval set. The same
code scores every baseline and every candidate — **if you change the scoring,
re-run the baselines too.** A delta measured against a moved goalpost is not a
delta.

## Two properties that took real work — don't break them

**1. The system prompt is CAPTURED from the running app, never reconstructed.**
The prompt depends on runtime state a test cannot see: GitHub/Figma token
presence, the refiner's stored prompt, connected MCP servers, the few-shot block.
A reconstruction drifts the moment a tool is added — which is the exact class of
bug this harness exists to catch.

**2. Replies are PARSED, never executed.** The set deliberately contains "send an
email to my manager" and "message Ashu on WhatsApp". We score the decision, not
the consequence.

`temperature=0, seed=0` gives a measured noise floor of 0/44 on *verdicts*. Note
that verdicts reproduce exactly but **latency does not** — treat accuracy as exact
and latency as indicative. Sensitivity to the prompt is a different thing from
noise: a single added line of prompt prose has been measured to move the score by
one case, so do not tune prose against this set.

## Running it

The app builds a **different tool surface per request** (see
`src/main/toolGroups.ts`), so a single replayed prompt is no longer faithful. Capture
one prompt per case:

```bash
node ollama-capture-proxy.cjs 11435 http://127.0.0.1:11434 --stub
```

```bash
node capture_prompts.cjs ./captured-prompts
```

```bash
python run_eval.py --model qwen3.5:latest --label my-run --prompt-dir ./captured-prompts
```

`--stub` is not optional for this. It answers `/api/chat` locally with plain
prose, so the model never returns a tool call and the agent loop ends each turn
without acting. **Never drive the eval set through the app against a real model** —
it would send real messages to real people.

Compare two runs:

```bash
python compare_results.py results-BASELINE-qwen3.5.json results-my-run.json
```

Validate the eval set after any tool-surface change (it catches cases that assert
the wrong argument names, which scores a correct model as wrong):

```bash
python validate_evalset.py
```

## Two traps that produce confident wrong answers

**Conversation contamination.** If the 44 cases run in one thread, each prompt
carries the previous cases' user turns, `history` grows, and an active build
session makes later cases match `isBuildFollowUp` — so prompts become a function
of case *order*. `capture_prompts.cjs` calls `clearHistory()` before every case.
Keep it that way.

**Tool-surface parity with the baseline you're comparing against.** GitHub/Figma
schemas are injected on token *presence*. The 2026-08 baselines were captured with
a GitHub token and no Figma token (124 tools = 133 − 9 Figma). Capture without one
and all five `gh-*` cases have no GitHub tool in the prompt at all, scoring as
regressions that have nothing to do with what you changed. `capture_prompts.cjs`
sets a placeholder `GITHUB_TOKEN` for this reason; it is never used, because
replies are only parsed.

## Files

| file | what it is |
|---|---|
| `evalset.json` | the frozen 44 cases (9 router-decided, 35 model-scored) |
| `run_eval.py` | the scorer; mirrors `src/main/toolCallParser.ts` |
| `capture_prompts.cjs` | drives the real app to capture per-case prompts |
| `ollama-capture-proxy.cjs` | transparent Ollama proxy; `--stub` makes capture safe |
| `system_prompt.txt` | the single full-surface prompt (pre-shrink baselines) |
| `captures.jsonl` | raw capture log (`captures-baseline.jsonl` is preserved) |
| `compare_results.py` | verdict-level diff between two result files |
| `validate_evalset.py` | checks expectations against the real tool schemas |
| `results-*.json` | recorded runs — see `docs/prompt-shrink-phase-2026-08.md` |

⚠ Windows' filesystem is case-insensitive, so `results-baseline-x.json` and
`results-BASELINE-x.json` are the same file.
