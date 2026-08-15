# Splen benchmark — messaging & calendar automation

Compares Splen (the local OpenUI agent) against general assistants on the tasks
Splen is actually built for. **Three numbers, reported separately: latency, cost
per action, accuracy.** There is no composite score, deliberately — a single
headline number is where a benchmark stops being checkable.

Everything needed to reproduce it is in this directory.

## Running it

```bash
npx vitest run --config scripts/benchmark/vitest.gen.config.ts   # 1. build per-case prompts
python scripts/benchmark/validate_taskset.py                     # 2. check the set is answerable
python scripts/benchmark/run_benchmark.py --systems splen        # 3. run
```

Add providers as you have keys for them:

```bash
python scripts/benchmark/run_benchmark.py --systems splen,gpt,claude,gemini
```

`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` select which comparison
systems can run; Splen needs `ollama serve` up. A provider with no key is
reported as **not run** — never estimated, never simulated, never dropped from
the results file.

## What makes the comparison fair

Four properties, each of which cost something to keep:

**One scorer.** Accuracy is decided by `score_case()` imported from
`scripts/finetune/eval/run_eval.py` — the same function that scores every local
model run in this project. It is *imported, never reimplemented*, so no system
can be advantaged by a scoring tweak.

**One prompt per case, byte-identical across systems.** The app builds a
different tool surface per request (`src/main/toolGroups.ts`), so a single
shared prompt would not be the prompt any real turn sees. `generate_prompts.test.ts`
calls the app's own `buildDefaultSystemPrompt(selectToolGroups(text))` and writes
one prompt per case; every system is handed the same bytes. Giving the
comparison models a different — or absent — tool surface would manufacture a win.

**Replies are parsed, never executed.** The set contains "send an email to my
manager" and "message Ashu on WhatsApp". We score the decision, not the
consequence. Nothing here can message a real person.

**Cost is measured tokens × verified list price.** Providers whose `pricing.json`
entry is not marked `verified` are reported as *"cost: not verified"* with the
page to check, rather than given a number from memory. Prices change more often
than this harness does.

## Comparison set

GPT, Claude and Gemini — general assistants that could plausibly do this job.

**GitHub Copilot and Cursor are deliberately excluded.** They are coding
assistants with no messaging or calendar automation surface; scoring them on
"send a WhatsApp message" would pad the comparison rather than measure anything.

## The task set

`taskset.json` — 20 cases:

| Bucket | n | Provenance |
|---|---|---|
| gmail | 6 | reused from the frozen `evalset.json` (2026-08-11) |
| calendar | 5 | reused |
| whatsapp | 2 | reused |
| slack / telegram / whatsapp-group | 5 | new — the frozen set had no Slack or Telegram coverage |
| memory | 2 | new — cross-channel recall, scored separately |

**Headline accuracy is the 18 core cases.** The 2 `memory` cases are reported
apart from it: they measure the Day-1 memory feature rather than raw model skill.
Every system is handed the same memory block in its prompt, so what they measure
is "can this model use provided context", not "does this product have memory" —
the latter is a capability claim, and it does not belong in an accuracy number.

## Two properties that took real work — don't break them

**1. Prompts are GENERATED from the app's own builder, not hand-written.** A
hand-maintained prompt drifts the moment a tool is added or regrouped, which is
the exact class of bug this measurement exists to catch.

This differs from the fine-tuning harness's `capture_prompts.cjs`, which drives
the packaged Electron app and captures what crosses the wire. That also picks up
runtime state — a refiner-stored prompt, connected MCP servers, the few-shot
block. Calling the builder directly reflects a **fresh install with no tokens, no
MCP and no learned prompt**. That is the right baseline for a published
benchmark, because it is the state a reader can reproduce — but it is not
identical to a long-lived install.

**2. The invalid-escape repair is part of the measurement, not a fudge.** The
shipped parser (`src/main/toolCallParser.ts`) treats a backslash that does not
begin a legal JSON escape as a literal backslash, so a model that writes
`tomorrow.\ Please` (meaning `\n`, dropping the `n`) still produces a working
tool call in the real app. `run_eval.py`'s repair does not do this, so it scored
a call the product would have executed as `malformed_json`.

`run_benchmark.py::repair_invalid_escapes` closes that gap, applied identically
to every system's reply. It is implemented here rather than by editing
`run_eval.py` so the frozen fine-tuning baselines stay comparable to each other.

It was found the honest way: the same case flipped verdict between two identical
runs. Before the fix, accuracy varied 15–16/18 run to run; after it, two
consecutive runs agreed on every one of the 20 cases.

## Reading the numbers

**Accuracy reproduces exactly; latency does not.** With `temperature=0, seed=0`
two consecutive runs agreed on every case. Latency is wall-clock on one machine
and moves with thermal state, VRAM pressure, and whether the model was already
resident — medians across runs have differed by ~30% with identical verdicts.
Treat accuracy as exact and latency as indicative. The first call after
`ollama serve` starts also pays model-load cost; it is included, because a user
pays it too.

**Cost per action for Splen is a real zero, not a placeholder.** It runs a local
model on the user's own hardware — there is no per-token charge. The electricity
and the up-front GPU are real costs, but they are not per-action and are not what
an API bill measures.

**Single-turn scoring is pessimistic for every system.** Each case is scored on
the FIRST action. A model that asks a clarifying question, or runs a legitimate
discovery call before acting, scores wrong even though the full trajectory would
have succeeded. This penalises cautious models specifically. It applies equally
to every system, so the comparison stays fair — but the absolute numbers
understate real-world behaviour, and should not be quoted as task success rates.

## Files

| file | what it is |
|---|---|
| `taskset.json` | the 20 cases, with provenance per case |
| `run_benchmark.py` | the runner; imports the shared scorer |
| `generate_prompts.test.ts` | builds per-case prompts from the app's own builder |
| `vitest.gen.config.ts` | config for the generator (kept out of the unit suite) |
| `validate_taskset.py` | checks every expectation against the real tool schemas |
| `pricing.json` | list prices, each with `verified` + `as_of` + source |
| `prompts/` | generated; one system prompt per case + a manifest |
| `results-*.json` | recorded runs, including every raw reply |

Re-run `validate_taskset.py` after any change to the task set or the tool
surface — it catches cases that assert the wrong argument names, which would
score a correct model as wrong.
