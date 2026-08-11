#!/usr/bin/env python3
"""train_qlora.py — 4-bit QLoRA trainer for OpenUI's local tool-calling model.

Why this exists alongside train_lora.py: that script loads the base model in
bfloat16. For its own default base (Qwen2.5-Coder-7B-Instruct) that is ~15 GB of
weights, so on the 8 GB card OpenUI actually targets it can never have run. This
one loads in 4-bit (nf4 + double quant) and trains LoRA adapters on top.

Measured on the target hardware (RTX 4060 Laptop, 8 GB) — see docs:
  7B  QLoRA: OOM. Even lean (r8, q+v only, no fp32 upcast, paged 8-bit optimizer)
             it fits only to seq_len 512, which truncates the training label.
  3B  QLoRA: see --probe output; this is the largest base that trains usefully.

Deliberate departures from a stock QLoRA recipe, each one bought VRAM:
  * no prepare_model_for_kbit_training — its fp32 upcast of norms/embeddings
    cost 2.03 GB, the entire remaining budget on this card;
  * PagedAdamW8bit instead of fp32 AdamW;
  * gradient checkpointing on, use_cache off.

Trains only on the ASSISTANT tokens (completion-only masking). Training on the
prompt as well would spend most of the gradient budget teaching the model to
reproduce its own system prompt, which is not the behaviour we want to change.

Exit codes: 0 ok, 2 bad input, 3 missing deps, 1 anything else.
"""

import argparse
import json
import math
import os
import sys
import time


def eprint(*a):
    print(*a, file=sys.stderr, flush=True)


def load_rows(path):
    rows = []
    with open(path, encoding="utf-8") as fh:
        for n, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError as err:
                eprint(f"skipping line {n}: {err}")
                continue
            msgs = rec.get("messages")
            if not isinstance(msgs, list) or len(msgs) < 2:
                continue
            if msgs[-1].get("role") != "assistant":
                continue
            rows.append(rec)
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="Qwen/Qwen2.5-Coder-3B-Instruct")
    ap.add_argument("--data", required=True)
    ap.add_argument("--eval-data", default=None)
    ap.add_argument("--out", required=True)
    ap.add_argument("--epochs", type=float, default=2.0)
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--rank", type=int, default=16)
    ap.add_argument("--max-seq-len", type=int, default=2048)
    ap.add_argument("--batch", type=int, default=1)
    ap.add_argument("--grad-accum", type=int, default=8)
    ap.add_argument("--max-steps", type=int, default=-1)
    ap.add_argument("--targets", nargs="*",
                    default=["q_proj", "k_proj", "v_proj", "o_proj",
                             "gate_proj", "up_proj", "down_proj"])
    ap.add_argument("--smoke", action="store_true")
    args = ap.parse_args()

    rows = load_rows(args.data)
    if len(rows) < 8:
        eprint(f"not enough usable rows ({len(rows)}); need >= 8")
        sys.exit(2)
    if args.smoke:
        rows = rows[:32]

    try:
        import torch
        from datasets import Dataset
        from peft import LoraConfig, get_peft_model
        from transformers import (AutoModelForCausalLM, AutoTokenizer,
                                  BitsAndBytesConfig, Trainer, TrainingArguments)
    except ImportError as err:
        eprint(f"missing Python dependencies: {err}\n"
               "install: pip install torch transformers peft datasets bitsandbytes accelerate")
        sys.exit(3)

    if not torch.cuda.is_available():
        eprint("CUDA is not available — refusing to run a 4-bit QLoRA job on CPU")
        sys.exit(1)

    tok = AutoTokenizer.from_pretrained(args.base)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token

    print(f"loading {args.base} in 4-bit …", flush=True)
    bnb = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4",
                             bnb_4bit_use_double_quant=True,
                             bnb_4bit_compute_dtype=torch.bfloat16)
    model = AutoModelForCausalLM.from_pretrained(
        args.base, quantization_config=bnb, device_map={"": 0}, dtype=torch.bfloat16)
    model.config.use_cache = False
    model.gradient_checkpointing_enable()
    model.enable_input_require_grads()

    model = get_peft_model(model, LoraConfig(
        r=args.rank, lora_alpha=2 * args.rank, lora_dropout=0.05, bias="none",
        task_type="CAUSAL_LM", target_modules=args.targets))
    model.print_trainable_parameters()

    IGNORE = -100

    def render(rec):
        """Tokenise the chat and mask everything that is not an assistant turn.

        Built turn-by-turn with the model's own chat template so the mask lines
        up with real token boundaries — slicing on decoded string offsets goes
        subtly wrong the moment a template adds or moves a control token.
        """
        msgs = rec["messages"]
        input_ids, labels = [], []
        for i, m in enumerate(msgs):
            # Render to TEXT and tokenise separately. apply_chat_template(
            # tokenize=True) returns a tokenizers.Encoding in transformers 5.x,
            # which Arrow cannot store and whose length is not a token count.
            # apply_chat_template also refuses an empty conversation, so the
            # i == 0 prefix is the empty string rather than a template call.
            prefix_text = ("" if i == 0 else
                           tok.apply_chat_template(
                               msgs[:i], tokenize=False,
                               add_generation_prompt=(m["role"] == "assistant")))
            full_text = tok.apply_chat_template(msgs[:i + 1], tokenize=False,
                                                add_generation_prompt=False)
            prefix_ids = (tok(prefix_text, add_special_tokens=False)["input_ids"]
                          if prefix_text else [])
            full_ids = tok(full_text, add_special_tokens=False)["input_ids"]

            # Guard the string-offset assumption: if the template is not a clean
            # prefix at the token level, fall back to appending this turn alone
            # rather than silently mislabelling a misaligned slice.
            if full_ids[:len(prefix_ids)] != prefix_ids:
                turn_text = full_text[len(prefix_text):]
                seg = tok(turn_text, add_special_tokens=False)["input_ids"]
            else:
                seg = full_ids[len(prefix_ids):]
            if not seg:
                continue
            input_ids.extend(seg)
            labels.extend(seg if m["role"] == "assistant" else [IGNORE] * len(seg))

        # Truncate from the LEFT: the assistant turn we are training on is at the
        # end, so cutting the head keeps the label intact. Right-truncation would
        # silently drop the very tokens the loss is computed on.
        if len(input_ids) > args.max_seq_len:
            input_ids = input_ids[-args.max_seq_len:]
            labels = labels[-args.max_seq_len:]
        return {"input_ids": input_ids, "labels": labels,
                "attention_mask": [1] * len(input_ids)}

    ds = Dataset.from_list(rows).map(render, remove_columns=list(rows[0].keys()))
    kept = sum(1 for r in ds if any(l != IGNORE for l in r["labels"]))
    print(f"{len(ds)} examples, {kept} with a trainable label", flush=True)
    if kept == 0:
        eprint("every example lost its label to truncation — raise --max-seq-len")
        sys.exit(2)

    eval_ds = None
    if args.eval_data and os.path.exists(args.eval_data):
        er = load_rows(args.eval_data)
        if er:
            eval_ds = Dataset.from_list(er).map(render, remove_columns=list(er[0].keys()))
            print(f"holdout: {len(eval_ds)} examples", flush=True)

    def collate(batch):
        n = max(len(b["input_ids"]) for b in batch)
        pad = tok.pad_token_id
        out = {"input_ids": [], "labels": [], "attention_mask": []}
        for b in batch:
            d = n - len(b["input_ids"])
            out["input_ids"].append(b["input_ids"] + [pad] * d)
            out["labels"].append(b["labels"] + [IGNORE] * d)
            out["attention_mask"].append(b["attention_mask"] + [0] * d)
        return {k: torch.tensor(v, dtype=torch.long) for k, v in out.items()}

    targs = TrainingArguments(
        output_dir=args.out + "-work",
        num_train_epochs=args.epochs,
        max_steps=args.max_steps,
        learning_rate=args.lr,
        per_device_train_batch_size=args.batch,
        gradient_accumulation_steps=args.grad_accum,
        # transformers 5.x dropped warmup_ratio; warmup_steps is the survivor.
        warmup_steps=max(5, int(0.03 * max(args.max_steps, 100))),
        lr_scheduler_type="cosine",
        logging_steps=5,
        save_strategy="no",
        report_to=[],
        bf16=True,
        optim="paged_adamw_8bit",
        gradient_checkpointing=True,
        eval_strategy="steps" if eval_ds is not None else "no",
        eval_steps=25 if eval_ds is not None else None,
        per_device_eval_batch_size=1,
    )

    trainer = Trainer(model=model, args=targs, train_dataset=ds,
                      eval_dataset=eval_ds, data_collator=collate)
    t0 = time.time()
    result = trainer.train()
    dt = time.time() - t0

    model.save_pretrained(args.out)
    tok.save_pretrained(args.out)

    hist = [h for h in trainer.state.log_history if "loss" in h]
    summary = {
        "ok": True, "base": args.base, "rows": len(rows), "trainable_label_rows": kept,
        "epochs": args.epochs, "rank": args.rank, "max_seq_len": args.max_seq_len,
        "steps": result.global_step, "train_seconds": round(dt, 1),
        "final_loss": hist[-1]["loss"] if hist else None,
        "first_loss": hist[0]["loss"] if hist else None,
        "loss_curve": [{"step": h.get("step"), "loss": h.get("loss")} for h in hist],
        "eval_curve": [{"step": h.get("step"), "eval_loss": h.get("eval_loss")}
                       for h in trainer.state.log_history if "eval_loss" in h],
        "peak_vram_gb": round(torch.cuda.max_memory_allocated() / 1024 ** 3, 2),
        "adapter": args.out,
    }
    json.dump(summary, open(os.path.join(args.out, "train_summary.json"), "w"), indent=2)
    print(json.dumps({k: v for k, v in summary.items()
                      if k not in ("loss_curve", "eval_curve")}), flush=True)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as err:
        eprint(f"training failed: {type(err).__name__}: {err}")
        sys.exit(1)
