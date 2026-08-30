# Failure analysis — 2026-08-30

Steps 1–3 of fine-tune prep: pull the real failure cases out of the benchmark
output, find out why they fail by ablation, and collect training examples only
for the causes that survive that scrutiny.

Full write-up: [`docs/finetune-prep-2026-08-30.md`](../../../docs/finetune-prep-2026-08-30.md).

## Order of operations

```bash
python scripts/finetune/failure-analysis/dossier.py
```
Reads `scripts/benchmark/results-bigday-splen.json`, `taskset.json` and
`prompts/<id>.txt` and writes `failure-dossier.json` — the three cases verbatim,
plus how each one scored across all seven recorded runs. Nothing is retyped from
notes.

```bash
python scripts/finetune/failure-analysis/probe.py    # [A]-[D] reproduce + first ablations
python scripts/finetune/failure-analysis/probe2.py   # [E]-[G] the safety-relevant edges
python scripts/finetune/failure-analysis/probe3.py   # [H][I] schema wording, both directions
python scripts/finetune/failure-analysis/probe4.py   # [J]-[L] one variable at a time
python scripts/finetune/failure-analysis/probe5.py   # [M][N] can a prompt fix do it?
```
Each probe changes exactly one thing against the shipped prompt and is scored by
the imported benchmark scorer at the benchmark's decode settings. The rule: no
cause is written down until an experiment separates it from the alternatives.

```bash
npx vitest run --config scripts/finetune/failure-analysis/vitest.gen.config.ts
python scripts/finetune/failure-analysis/collect.py
```
The generator builds prompts through the app's own `buildDefaultSystemPrompt` +
`selectToolGroups` + `renderMemoryBlock`; `collect.py` runs each candidate at
three seeds and keeps only those that reproduce in at least two.

## What came out

| pattern | collected |
|---|---|
| P1 — prose confirmation instead of the tool call | 3 |
| P2 — speculative search instead of "I have no record" | 9 |
| P3 — tool-group name emitted as a tool | 5 |

26 candidates in, 17 out, none unstable.

`mail-03` was **rejected as a training target**: the ablations show the model is
behaving correctly (it refuses to guess an unknown recipient address) and the
taskset's expectation is what is wrong. Training toward it would teach the model
to fabricate recipients.

## Two things that will bite the next person

**`scripts/benchmark/prompts/` is stale.** It was generated 2026-08-15 and the
builder has changed since (the `inbox` group, 2026-08-17). On the original
`tg-01` turn the stale prompt fails 3/3 seeds and the fresh one passes 3/3 — an
80-character unrelated addition flips the case. Regenerate before comparing
anything.

**Classify by what happened, not by which list the turn was written on.** Six
candidates reproduced a different pattern than the one they were written for.
The first version of `collect.py` dropped them, which under-counted P3 fivefold.
