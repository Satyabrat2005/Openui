# Fine-tuning track: shelved (2026-08-12)

**Decision: shelved, not abandoned.** The eval harness, dataset builder, QLoRA
trainer and GGUF→Ollama build step stay in the repo (`scripts/finetune/`) and
stay useful on their own. What stops here is *training another adapter on this
machine* until one of the reopen conditions below is met.

This file exists so the track is not an implicit "later" that never gets
revisited. It records why, with numbers, and what would change the answer.

## The measurement that decides it

All figures are read out of the committed result files in
`scripts/finetune/eval/`, not from recollection. Every run scores 35 of 44 cases
(9 are unscored by construction), so **one case is worth 2.86 points**.

| result file | model | accuracy |
|---|---|---|
| `results-BASELINE-coder3b.json` | `qwen2.5-coder:3b` | **71.4%** |
| `results-TUNED-v1.json` | `openui-qwen-coder:v1` (the tuned 3B) | **68.6%** |
| `results-BASELINE-coder7b.json` | `qwen2.5-coder:7b` | 77.1% |
| `results-AFTER-coder7b.json` | `qwen2.5-coder:7b` | 74.3% |
| `results-BASELINE-qwen3.5.json` | `qwen3.5:latest` | 74.3% |
| `results-AFTER-qwen3.5.json` | `qwen3.5:latest` | **77.1%** |
| `results-FINAL-qwen3.5.json` | `qwen3.5:latest` | 74.3% |

Three things follow, and together they close the question:

1. **The only trainable model on this hardware is the 3B, and tuning it made it
   worse.** 71.4% → 68.6%, a one-case-plus regression, and the tuned adapter also
   lost the base model's refusal behaviour. 7B QLoRA OOMs on 8 GB — measured, not
   assumed.

2. **The bar is inside the harness's own noise.** `results-AFTER-qwen3.5` (77.1%)
   and `results-FINAL-qwen3.5` (74.3%) are *the same model in the same grouped
   mode*, differing only by one line of prompt prose (6,820 vs 6,898 tokens) and
   flipping by exactly one case. A "beat 77.1%" target is a ±2.86-point target
   measured on 35 cases. The 3B would need to gain **two clear cases** from
   71.4%, and even then the harness could not distinguish that from prose noise.

3. **The reason the last tune looked plausible no longer holds.** #160's case for
   fine-tuning rested on `qwen2.5-coder:7b` beating `qwen3.5`. That advantage
   **inverts** once the prompt fits in context (#161): it was an artifact of
   qwen3.5 spilling ~1.7 GB to CPU at `num_ctx` 32768. The prompt shrink already
   collected the win the fine-tune was chasing — 74.3% → 77.1% — for free.

## The known data defect, and why fixing it is not sufficient

The training set is 2,513 rows: 2,015 `tool_call`, 446 `no_tool`, rest misc. The
446 `no_tool` rows are only **8 distinct templates** repeated ~55× each (a
pleasantry, four hardware/ML explainers, a self-description, a haiku, and the
string `391.`) — **none of them refuses anything**. That fully explains the tuned
model losing its refusals, and it is a real, scoped, fixable defect.

But fixing it addresses the *safety* regression, not the *accuracy* one. Even a
perfectly-refusing 3B still has to clear a bar it starts 2 cases below, measured
by an instrument whose resolution is 1 case. Spending GPU hours to land inside
the error bars is not a result.

## Current environment state (verified 2026-08-12)

The training stack is gone from this machine and would need a full reinstall:

```
torch          2.11.0+cpu   (CUDA build absent; torch.cuda.is_available() == False)
peft           MISSING
transformers   MISSING
bitsandbytes   MISSING
datasets       MISSING
trl            MISSING
llama.cpp      MISSING
```

HF base weights are still cached (~29 GB). Reinstalling is mechanical — no money,
no new accounts — which is exactly why the decision has to rest on the numbers
above rather than on cost.

## What stays, and stays valuable

Nothing here is deleted. Independent of training, the repo keeps:

- **`scripts/finetune/eval/`** — the 44-case harness that captures the *real*
  system prompt from the running app rather than reconstructing it, with a
  measured **0/44 noise floor** at `temperature=0`. This is the instrument that
  measured the #161 prompt shrink and caught the coder7b inversion. It is the
  most reused thing the fine-tuning track produced.
- **`ollama-capture-proxy.cjs --stub`** — answers `/api/chat` locally with plain
  prose so the eval set (which deliberately contains "send an email to my
  manager" and "message X on WhatsApp") can be driven through the real app
  without sending anything to anyone.
- **`train_qlora.py`, `build_ollama_model.py`** — both now correct, including the
  GGUF conversion `ollama create` requires and the pre-flight in
  `fineTuneSkipReason()` that stops a doomed run burning the 2-hour budget.
- **`pipeline.ts`'s `maybeRunFineTune`** — still wired and still opt-in. Shelving
  the track does not disable it; it stays off by default, as it already was.

## Reopen conditions

Revisit when **any one** of these becomes true:

1. **More VRAM.** ≥16 GB makes 7B QLoRA fit, which moves training to the model
   size that actually performs well here instead of the one that fits.
2. **A bigger eval set.** At ~100+ scored cases one case is worth <1 point and a
   real 2–3 point gain becomes measurable. Until then the instrument cannot
   resolve success, so success cannot be claimed.
3. **A task the base models genuinely cannot do**, as opposed to routing accuracy
   they are already close on — e.g. a bespoke output format no prompt reliably
   produces. Fine-tuning earns its cost on capability gaps, not on percentage
   points inside the noise band.

Absent those, prompt-level work has a better measured return: #161 bought +2.8
points and an 8,000-token context reduction with no GPU hours at all.
