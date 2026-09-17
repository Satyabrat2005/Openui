#!/usr/bin/env python3
"""train_splen4b.py — QLoRA for Splen-4B on corpus v3, on an 8 GB card.

Why not train_qlora.py: that trainer was built for v1/v2's compact ~1.4k-token
prompts. Corpus v3 carries the app's REAL prompt (median ~4.4k tokens, up to
~11k), and three things change at that length:

  * Logits. Qwen3.5 has a 248,320-token vocabulary. A full logits tensor at 6k
    tokens is ~3 GB in bf16 and ~6 GB once the loss upcasts it - more than the
    card. Only the final assistant reply is a label, so the model is asked for
    logits over those positions alone (logits_to_keep).
  * Labels. Only the final reply is trained. The earlier assistant turn in a row
    (the read call the renderer wrote) is context, not behaviour to learn.
  * Thinking. The app calls the model with think:false; Qwen3.5's template then
    puts an empty <think></think> block before the reply. That block is prompt,
    so the label starts after it.

Rows longer than --max-seq-len are DROPPED and counted, never left-truncated:
cutting the head of a row cuts the system prompt's rules, which is the train /
serve skew this corpus exists to remove.

    # how long a row fits, and how fast (writes nothing)
    python scripts/finetune/train_splen4b.py --base Qwen/Qwen3.5-4B --data <train.jsonl> --probe 4096,6144,8192
    # train
    python scripts/finetune/train_splen4b.py --base Qwen/Qwen3.5-4B --data <train.jsonl> --eval-data <holdout.jsonl> --out <dir>

Exit codes: 0 ok, 2 bad input, 3 missing deps, 1 anything else.
"""
import argparse
import json
import os
import sys
import time

IGNORE = -100


def eprint(*a):
    print(*a, file=sys.stderr, flush=True)


def load_rows(path):
    rows = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                rec = json.loads(line)
                if rec.get("messages") and rec["messages"][-1].get("role") == "assistant":
                    rows.append(rec)
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--data", required=True)
    ap.add_argument("--eval-data", default=None)
    ap.add_argument("--out", default=None)
    ap.add_argument("--epochs", type=float, default=1.0)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--rank", type=int, default=16)
    ap.add_argument("--max-seq-len", type=int, default=8192)
    ap.add_argument("--grad-accum", type=int, default=8)
    ap.add_argument("--max-steps", type=int, default=-1)
    ap.add_argument("--save-steps", type=int, default=40)
    ap.add_argument("--eval-steps", type=int, default=80)
    ap.add_argument("--eval-subset", type=int, default=24)
    ap.add_argument("--resume", action="store_true")
    ap.add_argument("--probe", default=None)
    args = ap.parse_args()

    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from licence_guard import require, subject_for_base
    base_licence = require(subject_for_base(args.base))

    try:
        import torch
        from peft import LoraConfig, get_peft_model
        from transformers import (AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig, Trainer,
                                  TrainingArguments)
    except ImportError as err:
        eprint("missing Python dependencies: %s" % err)
        sys.exit(3)
    if not torch.cuda.is_available():
        eprint("CUDA is not available")
        sys.exit(1)

    # ATTENTION KERNEL - measured on the RTX 4060 (Windows), 2026-09-14.
    # Windows PyTorch ships no flash attention. The memory-efficient SDPA kernel
    # does handle Qwen3.5's head_dim 256 (+0.24 GB at 4k tokens), but not
    # enable_gqa, which transformers passes whenever the mask is None - so every
    # full-attention layer silently took the O(n^2) math kernel: 8.2 GB and 60 s
    # per 4k-token step (spilling into system RAM) against 5.3 GB and 12 s with
    # this. Repeat k/v instead, and disable math so a fallback fails loudly.
    import transformers.integrations.sdpa_attention as sdpa_integration
    sdpa_integration.use_gqa_in_sdpa = lambda *a, **k: False
    torch.backends.cuda.enable_math_sdp(False)
    torch.backends.cuda.enable_flash_sdp(False)
    from transformers.utils import is_flash_linear_attention_available
    if not is_flash_linear_attention_available():
        # Without fla's Triton kernels the gated-delta-rule layers fall back to a
        # Python loop that keeps float32 copies per chunk (pip install
        # triton-windows flash-linear-attention on Windows).
        eprint("WARNING: flash-linear-attention not available - linear-attention layers use the slow fallback")

    tok = AutoTokenizer.from_pretrained(args.base)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token

    def render(rec):
        """Token ids with labels on the final assistant reply only, rendered with
        enable_thinking=False so the empty think block is prompt, not label."""
        msgs = rec["messages"]
        prompt = tok.apply_chat_template(msgs[:-1], tokenize=False, add_generation_prompt=True, enable_thinking=False)
        full = tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=False, enable_thinking=False)
        if not full.startswith(prompt):
            raise ValueError("%s: template is not a clean prefix" % rec.get("id"))
        p_ids = tok(prompt, add_special_tokens=False)["input_ids"]
        r_ids = tok(full[len(prompt):], add_special_tokens=False)["input_ids"]
        return p_ids + r_ids, [IGNORE] * len(p_ids) + r_ids

    rows = load_rows(args.data)
    encoded, dropped = [], []
    for r in rows:
        ids, labels = render(r)
        (encoded if len(ids) <= args.max_seq_len or args.probe else dropped).append(
            (r.get("id"), ids, labels) if len(ids) <= args.max_seq_len or args.probe else (r.get("id"), len(ids)))
    lengths = sorted(len(e[1]) for e in encoded)
    print("rows %d, kept %d, dropped over %d tokens: %d; tokens p50 %d p90 %d max %d" % (
        len(rows), len(encoded), args.max_seq_len, len(dropped),
        lengths[len(lengths) // 2], lengths[int(len(lengths) * 0.9)], lengths[-1]), flush=True)

    if sys.platform == "win32" and not args.probe:
        # Run 1 (2026-09-14) was killed 4 minutes in when the laptop idle-slept.
        # ES_CONTINUOUS | ES_SYSTEM_REQUIRED: a per-process request, released
        # when this process exits; it changes no power settings. A closed lid
        # still sleeps.
        import ctypes
        ctypes.windll.kernel32.SetThreadExecutionState(0x80000000 | 0x00000001)
    card_free_gb = torch.cuda.mem_get_info()[0] / 1024 ** 3  # before our weights: what the desktop leaves us
    print("loading %s in 4-bit ... (%.2f GB free on the card)" % (args.base, card_free_gb), flush=True)
    t_load = time.time()
    bnb = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_use_double_quant=True,
                             bnb_4bit_compute_dtype=torch.bfloat16)
    model = AutoModelForCausalLM.from_pretrained(args.base, quantization_config=bnb, device_map={"": 0},
                                                 dtype=torch.bfloat16)
    print("loaded %s in %.0fs; VRAM after load %.2f GB" % (
        type(model).__name__, time.time() - t_load, torch.cuda.memory_allocated() / 1024 ** 3), flush=True)
    model.config.use_cache = False
    model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    model.enable_input_require_grads()
    model = get_peft_model(model, LoraConfig(r=args.rank, lora_alpha=2 * args.rank, lora_dropout=0.05, bias="none",
                                             task_type="CAUSAL_LM", target_modules="all-linear"))
    model.print_trainable_parameters()

    def loss_on_reply(mdl, input_ids, labels):
        """Cross-entropy over the reply only, asking the model for logits over
        the reply's positions instead of the whole 248k-vocab sequence."""
        first = int((labels[0] != IGNORE).nonzero()[0])
        keep = input_ids.shape[1] - first + 1
        out = mdl(input_ids=input_ids, attention_mask=torch.ones_like(input_ids), logits_to_keep=keep)
        logits = out.logits[:, :-1, :].float()
        target = labels[:, first:]
        return torch.nn.functional.cross_entropy(logits.reshape(-1, logits.shape[-1]), target.reshape(-1),
                                                 ignore_index=IGNORE)

    if args.probe:
        # Gradient checkpointing only runs in training mode; a freshly loaded model
        # is in eval mode, and the first probe measured ~20 MB/token of activations
        # because of it. The Trainer switches modes itself; the probe must too.
        model.train()
        opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=1e-5)
        longest = max(encoded, key=lambda e: len(e[1]))
        results = []
        for L in [int(x) for x in args.probe.split(",")]:
            ids, labels = longest[1], longest[2]
            if len(ids) < L:  # repeat the row's prompt part in front to reach L; memory, not meaning, is measured
                pad = [i for i, l in zip(ids, labels) if l == IGNORE]
                need = L - len(ids)
                ids = (pad * (need // len(pad) + 1))[:need] + ids
                labels = [IGNORE] * need + labels
            ids, labels = ids[-L:], labels[-L:]
            x = torch.tensor([ids], device="cuda")
            y = torch.tensor([labels], device="cuda")
            torch.cuda.empty_cache()
            torch.cuda.reset_peak_memory_stats()
            row = {"seq": L}
            try:
                times = []
                for _ in range(2):
                    t0 = time.time()
                    loss = loss_on_reply(model, x, y)
                    loss.backward()
                    opt.step()
                    opt.zero_grad(set_to_none=True)
                    torch.cuda.synchronize()
                    times.append(time.time() - t0)
                free_gb = torch.cuda.mem_get_info()[1] / 1024 ** 3
                reserved = torch.cuda.max_memory_reserved() / 1024 ** 3
                row.update(ok=True, loss=round(float(loss), 3), sec_per_step=round(times[-1], 1),
                           peak_alloc_gb=round(torch.cuda.max_memory_allocated() / 1024 ** 3, 2),
                           peak_reserved_gb=round(reserved, 2),
                           # Windows does not OOM past the card: it spills into shared
                           # system RAM and a step takes 5-30x longer. Flag it.
                           fits_on_card=bool(reserved < 0.97 * card_free_gb))
            except torch.cuda.OutOfMemoryError as err:
                row.update(ok=False, error="OOM: %s" % str(err)[:120])
                opt.zero_grad(set_to_none=True)
            print("PROBE " + json.dumps(row), flush=True)
            results.append(row)
        print("PROBE_DONE " + json.dumps(results), flush=True)
        return

    if not args.out:
        eprint("--out is required to train")
        sys.exit(2)
    if dropped:
        with open(os.path.join(os.path.dirname(args.data), "dropped-over-%d.txt" % args.max_seq_len), "w") as fh:
            fh.write("\n".join("%s %d" % d for d in dropped) + "\n")

    class Rows(torch.utils.data.Dataset):
        def __init__(self, items):
            self.items = items

        def __len__(self):
            return len(self.items)

        def __getitem__(self, i):
            return {"input_ids": self.items[i][1], "labels": self.items[i][2]}

    eval_items = None
    if args.eval_data:
        er = load_rows(args.eval_data)
        er = [e for e in ((r.get("id"),) + render(r) for r in er) if len(e[1]) <= args.max_seq_len]
        eval_items = er[:: max(1, len(er) // args.eval_subset)][: args.eval_subset]

    def collate(batch):
        b = batch[0]  # batch size 1: rows differ by thousands of tokens, padding would waste the card
        return {"input_ids": torch.tensor([b["input_ids"]]), "labels": torch.tensor([b["labels"]])}

    class ReplyLossTrainer(Trainer):
        def compute_loss(self, mdl, inputs, return_outputs=False, num_items_in_batch=None):
            loss = loss_on_reply(mdl, inputs["input_ids"], inputs["labels"])
            return (loss, None) if return_outputs else loss

        def prediction_step(self, mdl, inputs, prediction_loss_only, ignore_keys=None):
            with torch.no_grad():
                loss = loss_on_reply(mdl, inputs["input_ids"].to(mdl.device), inputs["labels"].to(mdl.device))
            return loss.detach(), None, None

    targs = TrainingArguments(
        output_dir=args.out + "-work", num_train_epochs=args.epochs, max_steps=args.max_steps, learning_rate=args.lr,
        per_device_train_batch_size=1, gradient_accumulation_steps=args.grad_accum, warmup_steps=10,
        lr_scheduler_type="cosine", logging_steps=5, save_strategy="steps", save_steps=args.save_steps,
        save_total_limit=None,  # every checkpoint is kept: selection is by the gate, never by loss
        report_to=[], bf16=True, optim="paged_adamw_8bit", gradient_checkpointing=True,
        gradient_checkpointing_kwargs={"use_reentrant": False},
        eval_strategy="steps" if eval_items else "no", eval_steps=args.eval_steps if eval_items else None,
        per_device_eval_batch_size=1, remove_unused_columns=False, dataloader_pin_memory=False)
    from transformers import TrainerCallback

    class ReleaseCache(TrainerCallback):
        """Run 2 grew to 7.2 GB reserved by step 28 (rows differ by thousands of
        tokens, so cached blocks fragment) and spilled into system RAM: 55 s ->
        210 s per step. Releasing the cache after each optimizer step keeps the
        reservation near the real peak."""

        def on_step_end(self, *a, **k):
            torch.cuda.empty_cache()

        def on_evaluate(self, *a, **k):
            torch.cuda.empty_cache()

    trainer = ReplyLossTrainer(model=model, args=targs, train_dataset=Rows(encoded),
                               eval_dataset=Rows(eval_items) if eval_items else None, data_collator=collate,
                               callbacks=[ReleaseCache()])

    resume = None
    work = args.out + "-work"
    if args.resume and os.path.isdir(work):
        ck = sorted((d for d in os.listdir(work) if d.startswith("checkpoint-")), key=lambda d: int(d.split("-")[-1]))
        resume = os.path.join(work, ck[-1]) if ck else None
    t0 = time.time()
    result = trainer.train(resume_from_checkpoint=resume)
    model.save_pretrained(args.out)
    tok.save_pretrained(args.out)
    hist = trainer.state.log_history
    meta_path = args.data + ".meta.json"
    summary = {
        "ok": True, "base": args.base, "base_licence": base_licence, "rows": len(rows), "kept": len(encoded),
        "dropped_over_max_seq": len(dropped), "max_seq_len": args.max_seq_len, "epochs": args.epochs, "lr": args.lr,
        "rank": args.rank, "steps": result.global_step, "train_seconds": round(time.time() - t0),
        "loss_curve": [{"step": h["step"], "loss": h["loss"]} for h in hist if "loss" in h],
        "eval_curve": [{"step": h["step"], "eval_loss": h["eval_loss"]} for h in hist if "eval_loss" in h],
        "peak_vram_gb": round(torch.cuda.max_memory_allocated() / 1024 ** 3, 2),
        "corpus": json.load(open(meta_path, encoding="utf-8")) if os.path.isfile(meta_path) else None,
    }
    json.dump(summary, open(os.path.join(args.out, "train_summary.json"), "w"), indent=2)
    print(json.dumps({k: v for k, v in summary.items() if k not in ("loss_curve", "eval_curve")}), flush=True)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as err:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        eprint("training failed: %s: %s" % (type(err).__name__, err))
        sys.exit(1)
