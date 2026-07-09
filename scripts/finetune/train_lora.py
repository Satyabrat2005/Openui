#!/usr/bin/env python3
"""train_lora.py — LoRA fine-tuning sidecar for OpenUI (Task 4).

Invoked by src/main/finetune/pipeline.ts with a JSONL dataset of the user's own
quality-scored trajectories ({"messages": [{"role", "content"}, ...]} per line).
Trains a small LoRA adapter on the given HuggingFace base model and writes it
with save_pretrained() to --out, where the pipeline builds it into a versioned
Ollama model (FROM <base> / ADAPTER ./adapter).

Honest scope: this adapts a small LOCAL model to one user's workflows. It is a
personalisation mechanism, not an attempt to compete with frontier cloud models.

Exit codes: 0 ok, 2 bad input, 3 missing Python dependencies, 1 anything else.
"""

import argparse
import json
import sys


def eprint(*args):
    print(*args, file=sys.stderr, flush=True)


def load_dataset_rows(path):
    rows = []
    with open(path, "r", encoding="utf-8") as fh:
        for line_no, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError as err:
                eprint(f"skipping line {line_no}: {err}")
                continue
            msgs = rec.get("messages")
            if not isinstance(msgs, list) or len(msgs) < 2:
                continue
            # Chat templates only know system/user/assistant; fold tool output
            # into user turns (it is context the assistant replied to).
            cleaned = []
            for m in msgs:
                role = m.get("role")
                content = (m.get("content") or "").strip()
                if not content:
                    continue
                if role not in ("system", "user", "assistant"):
                    role = "user"
                cleaned.append({"role": role, "content": content})
            if len(cleaned) >= 2 and cleaned[-1]["role"] == "assistant":
                rows.append({"messages": cleaned})
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", required=True, help="HuggingFace model id of the base model")
    parser.add_argument("--data", required=True, help="training JSONL ({'messages': [...]} rows)")
    parser.add_argument("--out", required=True, help="output directory for the LoRA adapter")
    parser.add_argument("--epochs", type=float, default=1.0)
    parser.add_argument("--lr", type=float, default=2e-4)
    parser.add_argument("--rank", type=int, default=8)
    parser.add_argument("--max-seq-len", type=int, default=2048)
    parser.add_argument("--smoke", action="store_true", help="tiny run to validate the pipeline")
    args = parser.parse_args()

    rows = load_dataset_rows(args.data)
    if len(rows) < 8:
        eprint(f"not enough usable training rows ({len(rows)}); need at least 8")
        sys.exit(2)
    if args.smoke:
        rows = rows[:8]

    try:
        import torch
        from datasets import Dataset
        from peft import LoraConfig, get_peft_model
        from transformers import (
            AutoModelForCausalLM,
            AutoTokenizer,
            DataCollatorForLanguageModeling,
            Trainer,
            TrainingArguments,
        )
    except ImportError as err:
        eprint(
            "missing Python dependencies for LoRA training: "
            f"{err}\ninstall with: pip install torch transformers peft datasets"
        )
        sys.exit(3)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"loading {args.base} on {device} …", flush=True)
    tokenizer = AutoTokenizer.from_pretrained(args.base)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    model = AutoModelForCausalLM.from_pretrained(
        args.base,
        torch_dtype=torch.bfloat16 if device == "cuda" else torch.float32,
        device_map="auto" if device == "cuda" else None,
    )

    lora = LoraConfig(
        r=args.rank,
        lora_alpha=2 * args.rank,
        lora_dropout=0.05,
        bias="none",
        task_type="CAUSAL_LM",
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj"],
    )
    model = get_peft_model(model, lora)
    model.print_trainable_parameters()

    def render(row):
        text = tokenizer.apply_chat_template(row["messages"], tokenize=False)
        ids = tokenizer(
            text, truncation=True, max_length=args.max_seq_len, return_tensors=None
        )
        return {"input_ids": ids["input_ids"], "attention_mask": ids["attention_mask"]}

    dataset = Dataset.from_list(rows).map(render, remove_columns=["messages"])

    training_args = TrainingArguments(
        output_dir=args.out + "-work",
        num_train_epochs=0.05 if args.smoke else args.epochs,
        learning_rate=args.lr,
        per_device_train_batch_size=1,
        gradient_accumulation_steps=8,
        logging_steps=5,
        save_strategy="no",
        report_to=[],
        bf16=device == "cuda",
    )
    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=dataset,
        data_collator=DataCollatorForLanguageModeling(tokenizer, mlm=False),
    )
    trainer.train()

    model.save_pretrained(args.out)
    tokenizer.save_pretrained(args.out)
    print(json.dumps({"ok": True, "rows": len(rows), "adapter": args.out}), flush=True)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as err:  # surfaced by the pipeline as a failed run
        eprint(f"training failed: {err}")
        sys.exit(1)
