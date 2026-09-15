#!/usr/bin/env python3
"""package_splen4b.py — turn Qwen3.5-4B (+ a Splen LoRA) into an Ollama model.

Why not build_ollama_model.py: that script writes `FROM <ollama base>` +
`ADAPTER`, and needs the base in Ollama's store. Splen-4B is merged instead:

  1. merge the LoRA into the bf16 Hugging Face weights on the CPU (skipped with
     --no-adapter, which packages the untrained base as the comparison point);
  2. convert to GGUF with llama.cpp's converter (text model only - the base
     checkpoint is a vision-language model, and the app sends no images);
  3. `ollama create -q q4_K_M` with the SAME renderer, parser and sampling
     parameters as the app's current model, so it is asked exactly as the app
     asks, plus a LICENSE carrying the base's Apache-2.0 text and the Splen
     attribution (docs/SPLEN-V3-PLAN.md A3).

    python scripts/finetune/package_splen4b.py --base <hf snapshot> --adapter <dir> --tag splen:4b-run1
    python scripts/finetune/package_splen4b.py --base <hf snapshot> --no-adapter --tag splen-base:4b
"""
import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SAME_AS = "qwen3.5:latest"  # the model the app calls today; renderer/parser/params copied from it

NOTICE = """Splen is OpenUI's texting assistant model: a fine-tuned derivative of
Qwen3.5-4B (Copyright Alibaba Cloud / Qwen team), used under the Apache License,
Version 2.0. Modifications Copyright OpenUI. It is not endorsed by the Qwen team.
The unmodified base licence follows.

"""
# --no-adapter packages the untrained base for comparison; it is not Splen.
BASE_NOTICE = """Unmodified Qwen3.5-4B (Copyright Alibaba Cloud / Qwen team), converted to GGUF
by OpenUI for evaluation only, under the Apache License, Version 2.0.

"""


def run(cmd, **kw):
    print("$ " + " ".join('"%s"' % c if " " in c else c for c in cmd), flush=True)
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", **kw)
    out = (proc.stdout or "") + (proc.stderr or "")
    if proc.returncode != 0:
        print(out[-4000:], file=sys.stderr)
        raise SystemExit("command failed (exit %d)" % proc.returncode)
    return out


def app_model_settings():
    """RENDERER / PARSER / PARAMETER lines of the model the app uses today."""
    mf = run(["ollama", "show", SAME_AS, "--modelfile"])
    keep = [l for l in mf.splitlines() if re.match(r"^(RENDERER|PARSER|PARAMETER) ", l)]
    if not any(l.startswith("RENDERER") for l in keep) or not any(l.startswith("PARSER") for l in keep):
        raise SystemExit("%s has no RENDERER/PARSER lines; think:false would not be honoured" % SAME_AS)
    return keep


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True, help="Hugging Face snapshot dir of Qwen/Qwen3.5-4B")
    ap.add_argument("--adapter", default=None)
    ap.add_argument("--no-adapter", action="store_true")
    ap.add_argument("--tag", required=True)
    ap.add_argument("--quant", default="q4_K_M")
    ap.add_argument("--llamacpp", default=os.environ.get("LLAMACPP_DIR",
                                                          os.path.join(os.path.expanduser("~"), "Downloads", "llama.cpp")))
    ap.add_argument("--work", default=None, help="staging dir (needs ~9 GB free per model)")
    ap.add_argument("--keep", action="store_true")
    args = ap.parse_args()
    if bool(args.adapter) == bool(args.no_adapter):
        raise SystemExit("pass exactly one of --adapter or --no-adapter")

    sys.path.insert(0, HERE)
    from licence_guard import require, subject_for_base
    require(subject_for_base(args.base))
    converter = os.path.join(args.llamacpp, "convert_hf_to_gguf.py")
    if not os.path.isfile(converter):
        raise SystemExit("llama.cpp converter not found at %s" % converter)
    settings = app_model_settings()

    work = args.work or tempfile.mkdtemp(prefix="splen4b-pkg-")
    os.makedirs(work, exist_ok=True)
    src = args.base
    try:
        if args.adapter:
            import torch
            from peft import PeftModel
            from transformers import AutoModelForCausalLM, AutoTokenizer
            print("merging %s into the bf16 base on the CPU ..." % args.adapter, flush=True)
            model = AutoModelForCausalLM.from_pretrained(args.base, dtype=torch.bfloat16, device_map="cpu",
                                                         low_cpu_mem_usage=True)
            model = PeftModel.from_pretrained(model, args.adapter).merge_and_unload()
            src = os.path.join(work, "merged")
            model.save_pretrained(src, safe_serialization=True, max_shard_size="2GB")
            AutoTokenizer.from_pretrained(args.base).save_pretrained(src)
            for f in ("chat_template.jinja", "LICENSE"):
                if os.path.isfile(os.path.join(args.base, f)):
                    shutil.copy(os.path.join(args.base, f), src)
            del model

        gguf = os.path.join(work, "model.f16.gguf")
        # f16, not bf16: `ollama create --quantize` quantises from F16/F32 sources.
        run([sys.executable, converter, src, "--outtype", "f16", "--outfile", gguf])

        licence = open(os.path.join(args.base, "LICENSE"), encoding="utf-8").read()
        with open(os.path.join(work, "Modelfile"), "w", encoding="utf-8", newline="\n") as fh:
            fh.write("FROM ./model.f16.gguf\n")
            fh.write("\n".join(settings) + "\n")
            notice = NOTICE if args.adapter else BASE_NOTICE
            fh.write('LICENSE """%s%s"""\n' % (notice, licence.replace('"""', "'''")))
        print(run(["ollama", "create", args.tag, "-q", args.quant, "-f", "Modelfile"], cwd=work)[-1500:])
        print("OK - %s created" % args.tag)
    finally:
        if args.keep:
            print("staging dir kept: %s" % work)
        else:
            shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
