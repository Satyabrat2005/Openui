#!/usr/bin/env python3
"""test_licence_guard.py — pins the licence guard's verdicts.

Plain asserts, no pytest, matching test_score_case.py. Exit 0 = all pass.

    python scripts/finetune/test_licence_guard.py

What is pinned, and why each matters:

  * a research licence is REJECTED even when its text also mentions Apache —
    the non-commercial check runs first, or a licence that cites Apache for a
    bundled component would be waved through;
  * a Hugging Face README with `license: other` + `license_name: qwen-research`
    (how the Qwen 3B repos declare it) is rejected;
  * no licence at all is REJECTED, not allowed — the failure mode of a guard
    written as "block known-bad" instead of "allow known-good";
  * the real Apache text shipped with a local Ollama model is NOT mistaken for a
    non-commercial one (a false positive here would push people to bypass it);
  * build_ollama_model.py and both trainers really call the guard — a guard
    nobody invokes is the state this file exists to prevent.
"""
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import licence_guard as lg  # noqa: E402

failures = []


def expect(name, cond, detail=""):
    if not cond:
        failures.append("%s %s" % (name, detail))


# ── classify ─────────────────────────────────────────────────────────────────
expect("empty is unknown", lg.classify("") == "unknown")
expect("unrecognised is unknown", lg.classify("All rights reserved.") == "unknown")
expect("apache", lg.classify("Apache License\nVersion 2.0, January 2004") == "apache")
expect("apache front-matter", lg.classify("license: apache-2.0") == "apache")
expect("mit", lg.classify("MIT License\n\nPermission is hereby granted, free of charge") == "mit")
expect("research", lg.classify("Qwen RESEARCH LICENSE AGREEMENT") == "research")
# Front-matter on its own line, with nothing after it that could spell "research licence"
# across a line break (the first version of the regex only caught it that way).
expect("license_name alone", lg.classify("license: other\nlicense_name: qwen-research") == "research")
expect("non-commercial phrasing", lg.classify("for Non-Commercial purposes only") == "research")
expect(
    "research wins over a mentioned Apache",
    lg.classify("Qwen RESEARCH LICENSE AGREEMENT\n... components under the Apache License, Version 2.0 ...")
    == "research",
)

# ── shared fixtures: the in-app port (src/main/finetune/licence.ts) reads these too
import json  # noqa: E402

_fx = json.load(open(os.path.join(HERE, "licence-fixtures.json"), encoding="utf-8"))["cases"]
expect("fixtures present", len(_fx) >= 8)
for _c in _fx:
    got = lg.classify(_c["text"])
    expect("fixture %r" % _c["text"][:40], got == _c["verdict"], "got %s want %s" % (got, _c["verdict"]))

# ── directory reader: how Hugging Face repos actually declare licences ───────
tmp = tempfile.mkdtemp(prefix="licguard-")
try:
    qwen3b = os.path.join(tmp, "qwen3b")
    os.makedirs(qwen3b)
    open(os.path.join(qwen3b, "README.md"), "w", encoding="utf-8").write(
        "---\nlicense: other\nlicense_name: qwen-research\n"
        "license_link: https://huggingface.co/Qwen/x/blob/main/LICENSE\n---\n# model\n"
    )
    text, _ = lg.read_dir(qwen3b)
    expect("hf other+qwen-research rejected", lg.classify(text) == "research", repr(text))

    apache_dir = os.path.join(tmp, "apache")
    os.makedirs(apache_dir)
    open(os.path.join(apache_dir, "LICENSE"), "w", encoding="utf-8").write(
        "                                 Apache License\n                           Version 2.0, January 2004\n"
    )
    ok, verdict, _, prov = lg.check("path:" + apache_dir)
    expect("apache dir allowed", ok and verdict == "apache", verdict)
    expect("provenance names the licence file", "LICENSE" in prov["licence_files"])
    expect("provenance hashes the text", bool(prov["licence_sha256"]))

    bare = os.path.join(tmp, "bare")
    os.makedirs(bare)
    ok, verdict, _, _ = lg.check("path:" + bare)
    expect("no licence REJECTED", not ok and verdict == "unknown", verdict)

    ok, _, _, _ = lg.check("path:" + qwen3b, allow_non_commercial=True)
    expect("research allowed only with explicit flag", ok)
    ok, _, _, _ = lg.check("path:" + qwen3b)
    expect("research refused without flag", not ok)

    # ── ollama reader against a fabricated store (no dependency on this machine)
    store = os.path.join(tmp, "ollama")
    man = os.path.join(store, "manifests", "registry.ollama.ai", "library", "fake", "1b")
    os.makedirs(os.path.dirname(man))
    os.makedirs(os.path.join(store, "blobs"))
    open(os.path.join(store, "blobs", "sha256-lic"), "w", encoding="utf-8").write(
        "Qwen RESEARCH LICENSE AGREEMENT"
    )
    import json
    json.dump({"layers": [
        {"mediaType": "application/vnd.ollama.image.model", "digest": "sha256:model"},
        {"mediaType": "application/vnd.ollama.image.license", "digest": "sha256:lic"},
    ]}, open(man, "w", encoding="utf-8"))
    text, prov = lg.read_ollama("fake:1b", models_dir=store)
    expect("ollama licence layer read", lg.classify(text) == "research")
    expect("ollama model digest recorded", prov["model_layer_digest"] == "sha256:model")
    try:
        lg.read_ollama("absent:1", models_dir=store)
        expect("missing manifest raises", False)
    except lg.LicenceError:
        pass
finally:
    shutil.rmtree(tmp, ignore_errors=True)

# ── real licence text on this machine, when present ──────────────────────────
for tag, want in (("qwen3.5:latest", "apache"), ("qwen2.5-coder:3b", "research")):
    try:
        text, _ = lg.read_ollama(tag)
    except lg.LicenceError:
        continue  # not installed here; the fabricated store above still ran
    expect("real %s" % tag, lg.classify(text) == want, lg.classify(text))

# ── the guard is actually wired in ───────────────────────────────────────────
for script in ("build_ollama_model.py", "train_qlora.py", "train_lora.py"):
    src = open(os.path.join(HERE, script), encoding="utf-8").read()
    expect("%s calls the guard" % script, "licence_guard" in src and "require(" in src)

if failures:
    print("FAIL (%d):" % len(failures))
    for f in failures:
        print("  -", f)
    sys.exit(1)
print("licence guard: all checks passed")
