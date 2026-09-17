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


def stream_merge(base, adapter, out, shard_bytes=1_500_000_000):
    """W' = W + (alpha/r) * B @ A, one tensor at a time.

    from_pretrained + merge_and_unload holds the whole bf16 model (~9 GB) in
    RAM; with the laptop's other apps open only 4.7 GB was free. This reads one
    base tensor, merges its LoRA pair if it has one, and writes ~1.5 GB shards,
    so peak RAM is one shard. It also makes the key mapping explicit: training
    loaded the checkpoint as Qwen3_5ForCausalLM (model.layers.N...), while the
    files on disk are Qwen3_5ForConditionalGeneration (model.language_model...).
    Every LoRA pair must land on a base tensor, or the merge fails.
    """
    import json as _json

    import torch
    from safetensors import safe_open
    from safetensors.torch import save_file

    cfg = _json.load(open(os.path.join(adapter, "adapter_config.json"), encoding="utf-8"))
    if cfg.get("use_dora") or cfg.get("use_rslora"):
        raise SystemExit("stream_merge handles plain LoRA only")
    scale = cfg["lora_alpha"] / cfg["r"]
    pairs = {}
    with safe_open(os.path.join(adapter, "adapter_model.safetensors"), "pt") as fa:
        for k in fa.keys():
            m = re.match(r"^base_model\.model\.model\.layers\.(\d+)\.(.+)\.lora_([AB])\.weight$", k)
            if not m:
                raise SystemExit("unexpected adapter tensor %s" % k)
            base_key = "model.language_model.layers.%s.%s.weight" % (m.group(1), m.group(2))
            pairs.setdefault(base_key, {})[m.group(3)] = fa.get_tensor(k)

    os.makedirs(out, exist_ok=True)
    index = _json.load(open(os.path.join(base, "model.safetensors.index.json"), encoding="utf-8"))
    weight_map, buf, buf_bytes, shard_no, merged = {}, {}, 0, 0, 0

    def flush():
        nonlocal buf, buf_bytes, shard_no
        if not buf:
            return
        shard_no += 1
        name = "model-%05d.safetensors" % shard_no
        save_file(buf, os.path.join(out, name), metadata={"format": "pt"})
        for k in buf:
            weight_map[k] = name
        buf, buf_bytes = {}, 0

    for shard in sorted(set(index["weight_map"].values())):
        with safe_open(os.path.join(base, shard), "pt") as fb:
            for k in fb.keys():
                t = fb.get_tensor(k)
                if k in pairs:
                    p = pairs.pop(k)
                    delta = (p["B"].float() @ p["A"].float()) * scale
                    if delta.shape != t.shape:
                        raise SystemExit("shape mismatch on %s: %s vs %s" % (k, tuple(delta.shape), tuple(t.shape)))
                    t = (t.float() + delta).to(t.dtype)
                    merged += 1
                buf[k] = t.contiguous()
                buf_bytes += t.numel() * t.element_size()
                if buf_bytes >= shard_bytes:
                    flush()
    flush()
    if pairs:
        raise SystemExit("%d LoRA pairs matched no base tensor, e.g. %s" % (len(pairs), next(iter(pairs))))
    total = sum(os.path.getsize(os.path.join(out, f)) for f in set(weight_map.values()))
    _json.dump({"metadata": {"total_size": total}, "weight_map": weight_map},
               open(os.path.join(out, "model.safetensors.index.json"), "w", encoding="utf-8"), indent=1)
    for f in os.listdir(base):
        if not f.endswith(".safetensors") and f != "model.safetensors.index.json":
            shutil.copy(os.path.join(base, f), out)
    print("merged %d LoRA pairs (scale %.2f) into %d shards" % (merged, scale, shard_no), flush=True)


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
            src = os.path.join(work, "merged")
            stream_merge(args.base, args.adapter, src)

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
