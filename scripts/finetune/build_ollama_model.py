#!/usr/bin/env python3
"""build_ollama_model.py — turn a trained LoRA adapter into a served Ollama tag.

Uses the SAME Modelfile shape the shipped pipeline writes
(src/main/finetune/pipeline.ts):

    FROM <base ollama model>
    ADAPTER <adapter.gguf>

so the fine-tuned model is served through the identical code path as the stock
one — same ensureOllamaRunning, same resolveNumCtx sizing, same agent loop. A
separate inference stack would measure something the app never runs.

THE ADAPTER MUST BE GGUF. This script used to write `ADAPTER ./adapter`, pointing
at the peft save_pretrained() directory. Ollama rejects that — reproduced on
0.31.2 with a real trained adapter:

    Error: no Modelfile or safetensors files found

which is doubly confusing because adapter_model.safetensors IS in that directory.
So the conversion below is not optional polish; without it `ollama create` fails
and the training run is wasted. Conversion uses llama.cpp's
convert_lora_to_gguf.py: clone https://github.com/ggerganov/llama.cpp and pass
--llamacpp (or set LLAMACPP_DIR).

Note the base tags must correspond: an adapter trained on
Qwen/Qwen2.5-Coder-3B-Instruct goes on ollama's qwen2.5-coder:3b. Ollama applies
the adapter above the quantised base, which is why a LoRA trained in 4-bit nf4
can serve on a Q4_K_M base.

Usage:
  python build_ollama_model.py --adapter <dir> --base qwen2.5-coder:3b --tag openui-qwen-coder:v1
"""
import argparse
import os
import shutil
import subprocess
import sys
import tempfile


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--adapter", required=True)
    ap.add_argument("--base", default="qwen2.5-coder:3b")
    ap.add_argument("--tag", required=True)
    ap.add_argument("--keep", action="store_true", help="keep the staging dir")
    ap.add_argument(
        "--llamacpp",
        default=os.environ.get("LLAMACPP_DIR"),
        help="path to a llama.cpp checkout (for convert_lora_to_gguf.py); "
             "defaults to $LLAMACPP_DIR",
    )
    args = ap.parse_args()

    adapter = os.path.abspath(args.adapter)
    if not os.path.isdir(adapter):
        print(f"adapter dir not found: {adapter}", file=sys.stderr)
        return 2
    have = os.listdir(adapter)
    if not any(f.endswith(".safetensors") for f in have):
        print(f"no .safetensors in {adapter} (found: {have})", file=sys.stderr)
        return 2

    # Locate the converter before doing any work, so a missing checkout is a
    # one-line error rather than a failure after copying gigabytes around.
    if not args.llamacpp:
        print(
            "ERROR: --llamacpp (or $LLAMACPP_DIR) is required.\n"
            "Ollama cannot load a peft adapter DIRECTORY; it needs a single GGUF file.\n"
            "Clone https://github.com/ggerganov/llama.cpp and pass its path.",
            file=sys.stderr,
        )
        return 2
    converter = os.path.join(args.llamacpp, "convert_lora_to_gguf.py")
    if not os.path.isfile(converter):
        print(f"convert_lora_to_gguf.py not found in {args.llamacpp}", file=sys.stderr)
        return 2

    work = tempfile.mkdtemp(prefix="openui-ollama-")
    dst = os.path.join(work, "adapter")
    shutil.copytree(adapter, dst)
    # The trainer also drops a summary and a -work checkpoint dir in there, which
    # are not adapter files and confuse the converter.
    for junk in ("train_summary.json",):
        p = os.path.join(dst, junk)
        if os.path.exists(p):
            os.remove(p)

    gguf = os.path.join(work, "adapter.gguf")
    print(f"converting adapter -> GGUF via {converter} ...", flush=True)
    conv = subprocess.run(
        [sys.executable, converter, dst, "--outfile", gguf, "--outtype", "f16"],
        capture_output=True, text=True,
    )
    print(((conv.stdout or "") + (conv.stderr or "")).strip()[-2000:])
    if conv.returncode != 0 or not os.path.isfile(gguf):
        print(f"\nLoRA->GGUF conversion FAILED (exit {conv.returncode})", file=sys.stderr)
        print(f"staging dir kept for inspection: {work}", file=sys.stderr)
        return 1

    modelfile = os.path.join(work, "Modelfile")
    with open(modelfile, "w", encoding="utf-8") as fh:
        fh.write(f"FROM {args.base}\nADAPTER ./adapter.gguf\n")

    print(f"building {args.tag} from {args.base} + {adapter} …", flush=True)
    proc = subprocess.run(["ollama", "create", args.tag, "-f", "Modelfile"],
                          cwd=work, capture_output=True, text=True)
    out = (proc.stdout or "") + (proc.stderr or "")
    print(out.strip()[-3000:])
    if proc.returncode != 0:
        print(f"\nollama create FAILED (exit {proc.returncode})", file=sys.stderr)
        print(f"staging dir kept for inspection: {work}", file=sys.stderr)
        return 1

    print(f"\nOK — {args.tag} created")
    if args.keep:
        print("staging dir:", work)
    else:
        shutil.rmtree(work, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
