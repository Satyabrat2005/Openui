#!/usr/bin/env python3
"""licence_guard.py — refuse to train on, or package, weights we cannot sell.

WHY IT EXISTS. `openui-qwen-coder:v1` and `openui-splen:v2` were both built on
`qwen2.5-coder:3b`, which is published under the Qwen RESEARCH LICENSE
("Non-Commercial ... research or evaluation purposes only"), and the grant
extends that limit to derivative works. A LoRA is a derivative work. Nothing in
the pipeline looked: `build_ollama_model.py` writes `FROM <base>`, Ollama
inherits the base model's licence layer, and both tags have carried the research
licence in their own manifests ever since. It was found by reading the manifest
by hand, two retrains later.

This makes that check a precondition. It is deliberately a HARD failure: a
licence check that prints a warning and carries on is decoration.

WHAT IT READS — the licence text actually attached to the weights, never a
name. A model called "qwen-something" can be Apache (qwen2.5-coder:7b) or
research-only (qwen2.5-coder:3b); only the text says which.

  ollama:<tag>   the `.license` layer(s) in the local Ollama manifest, read
                 straight from disk — no daemon needed
  hf:<repo id>   LICENSE* and the README front-matter `license:` field of the
                 snapshot in the local Hugging Face cache (the same files the
                 trainer loads, so the check and the training cannot disagree)
  path:<dir>     a local model directory, same files

VERDICTS, with the non-commercial check evaluated FIRST so that a research
licence which happens to mention Apache somewhere can never be waved through:

  research   non-commercial / research-only terms found       -> REJECT
  apache     Apache License 2.0                               -> allow
  mit        MIT                                              -> allow
  unknown    no licence found, or text we do not recognise    -> REJECT

`unknown` is rejected on purpose. "We could not find a licence" is not
permission.

Usage:
    python scripts/finetune/licence_guard.py ollama:qwen3.5:latest
    python scripts/finetune/licence_guard.py hf:Qwen/Qwen2.5-1.5B-Instruct
    python scripts/finetune/licence_guard.py ollama:qwen3.5:latest --record

Exit codes: 0 allowed, 1 rejected, 3 could not read.

Research experiments on a non-commercial base remain possible — that is what the
licence permits — but only through an explicit `--allow-non-commercial`, and
`build_ollama_model.py` then forces the served tag to end in `-research` so the
artefact names what it is.
"""
import argparse
import glob
import hashlib
import json
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
PROVENANCE = os.path.join(HERE, "base-provenance.json")

ALLOWED = ("apache", "mit")

# Order matters: non-commercial terms are checked before anything permissive.
_RESEARCH_RE = re.compile(
    r"research\s+licen[cs]e|non[-\s]?commercial|research\s+or\s+evaluation\s+purposes\s+only"
    # Hugging Face front-matter names it rather than quoting it: license_name: qwen-research
    r"|^\s*licen[cs]e_name:\s*\S*research\S*\s*$",
    re.I | re.M,
)
_APACHE_RE = re.compile(r"apache\s+licen[cs]e,?\s*(version\s*)?2\.0|^\s*license:\s*apache-2\.0\s*$",
                        re.I | re.M)
_MIT_RE = re.compile(r"\bMIT\s+Licen[cs]e\b|^\s*license:\s*mit\s*$", re.I | re.M)


class LicenceError(Exception):
    """The licence text could not be located at all."""


def classify(text):
    """Return 'research', 'apache', 'mit' or 'unknown' for a licence text."""
    if not text or not text.strip():
        return "unknown"
    if _RESEARCH_RE.search(text):
        return "research"
    if _APACHE_RE.search(text):
        return "apache"
    if _MIT_RE.search(text):
        return "mit"
    return "unknown"


# ── readers ──────────────────────────────────────────────────────────────────

def ollama_models_dir():
    env = os.environ.get("OLLAMA_MODELS")
    if env:
        return env
    return os.path.join(os.path.expanduser("~"), ".ollama", "models")


def read_ollama(tag, models_dir=None):
    """(licence text, provenance dict) for an Ollama tag, read from disk."""
    models_dir = models_dir or ollama_models_dir()
    name, _, version = tag.partition(":")
    version = version or "latest"
    if "/" in name:
        ns, _, name = name.rpartition("/")
    else:
        ns = "library"
    manifest_path = os.path.join(models_dir, "manifests", "registry.ollama.ai", ns, name, version)
    if not os.path.isfile(manifest_path):
        raise LicenceError("no Ollama manifest for %s at %s" % (tag, manifest_path))
    manifest = json.load(open(manifest_path, encoding="utf-8"))
    layers = [l for l in manifest.get("layers", []) if str(l.get("mediaType", "")).endswith(".license")]
    texts, digests = [], []
    for layer in layers:
        blob = os.path.join(models_dir, "blobs", layer["digest"].replace(":", "-"))
        if not os.path.isfile(blob):
            raise LicenceError("licence blob %s for %s is missing" % (layer["digest"], tag))
        texts.append(open(blob, encoding="utf-8", errors="replace").read())
        digests.append(layer["digest"])
    model_layer = next((l["digest"] for l in manifest.get("layers", [])
                        if str(l.get("mediaType", "")).endswith(".model")), None)
    return "\n".join(texts), {
        "source": "ollama",
        "id": tag,
        "model_layer_digest": model_layer,
        "licence_layer_digests": digests,
    }


def _hf_snapshot_dir(repo_id):
    hub = os.environ.get("HF_HUB_CACHE") or os.path.join(
        os.environ.get("HF_HOME") or os.path.join(os.path.expanduser("~"), ".cache", "huggingface"),
        "hub",
    )
    repo_dir = os.path.join(hub, "models--" + repo_id.replace("/", "--"))
    snaps = sorted(glob.glob(os.path.join(repo_dir, "snapshots", "*")), key=os.path.getmtime)

    def has_licence_files(snap):
        return any(re.match(r"^(licen[cs]e|readme\.md)", f, re.I) for f in os.listdir(snap))

    # `from_pretrained` downloads weights, config and tokenizer — never LICENSE or
    # README. So a base that has already been trained on sits in the cache with
    # no licence evidence at all (measured: Qwen2.5-Coder-3B-Instruct, the v1/v2
    # base). And a first-ever run downloads inside the trainer, after this check.
    # Either way, fetch only the licence-bearing files — kilobytes — into the
    # same snapshot, so the check runs first and against the same repo.
    if (not snaps or not has_licence_files(snaps[-1])) and not os.environ.get("HF_HUB_OFFLINE"):
        try:
            from huggingface_hub import snapshot_download
            snapshot_download(repo_id, allow_patterns=["LICENSE*", "LICENCE*", "NOTICE*", "README.md"])
        except Exception:  # noqa: BLE001 - absence is reported below as unreadable
            pass
        snaps = sorted(glob.glob(os.path.join(repo_dir, "snapshots", "*")), key=os.path.getmtime)
    if not snaps:
        raise LicenceError(
            "%s is not in the local Hugging Face cache (%s). Download it first so the "
            "licence is checked against the exact files that will be trained." % (repo_id, repo_dir)
        )
    return snaps[-1]


def read_dir(path):
    """(licence text, provenance dict) for a model directory on disk."""
    if not os.path.isdir(path):
        raise LicenceError("model directory not found: %s" % path)
    texts, files = [], []
    for f in sorted(os.listdir(path)):
        if re.match(r"^(licen[cs]e|copying|notice)(\.|$)", f, re.I):
            texts.append(open(os.path.join(path, f), encoding="utf-8", errors="replace").read())
            files.append(f)
    readme = os.path.join(path, "README.md")
    if os.path.isfile(readme):
        head = open(readme, encoding="utf-8", errors="replace").read()
        m = re.match(r"^---\s*\n(.*?)\n---", head, re.S)
        if m:
            front = m.group(1)
            # license_name / license_link carry the research licence's name when
            # license: is "other", so they are part of the evidence too.
            kept = [ln for ln in front.splitlines() if re.match(r"^\s*licen[cs]e(_name|_link)?\s*:", ln, re.I)]
            if kept:
                texts.append("\n".join(kept))
                files.append("README.md front-matter")
    return "\n".join(texts), {"source": "dir", "id": path, "licence_files": files}


def subject_for_base(base):
    """Map a trainer's --base (a Hugging Face id or a local directory) to a subject."""
    return ("path:" + base) if os.path.isdir(base) else ("hf:" + base)


def read_subject(subject):
    kind, _, ident = subject.partition(":")
    if kind == "ollama":
        return read_ollama(ident)
    if kind == "hf":
        snap = _hf_snapshot_dir(ident)
        text, prov = read_dir(snap)
        prov.update({"source": "hf", "id": ident, "snapshot": os.path.basename(snap)})
        return text, prov
    if kind == "path":
        return read_dir(ident)
    raise LicenceError("subject must be ollama:<tag>, hf:<repo id> or path:<dir>, got %r" % subject)


# ── the check ────────────────────────────────────────────────────────────────

def check(subject, allow_non_commercial=False):
    """Returns (allowed: bool, verdict: str, text: str, provenance: dict)."""
    text, prov = read_subject(subject)
    verdict = classify(text)
    allowed = verdict in ALLOWED or (allow_non_commercial and verdict == "research")
    prov["verdict"] = verdict
    prov["licence_sha256"] = hashlib.sha256(text.encode("utf-8")).hexdigest() if text else None
    first = next((ln.strip() for ln in text.splitlines() if ln.strip()), "")
    prov["licence_first_line"] = first[:120]
    return allowed, verdict, text, prov


def require(subject, allow_non_commercial=False, out=sys.stderr):
    """Hard gate for other scripts. Returns the verdict or exits the process."""
    try:
        allowed, verdict, _, prov = check(subject, allow_non_commercial)
    except LicenceError as exc:
        print("LICENCE GUARD: could not read the licence for %s: %s" % (subject, exc), file=out)
        sys.exit(3)
    if not allowed:
        why = {
            "research": "is published under NON-COMMERCIAL terms (%s). Anything trained on it "
                        "inherits that limit. Pass --allow-non-commercial only for a research "
                        "experiment that will never ship." % prov["licence_first_line"],
            "unknown": "carries no licence text this guard recognises. Not finding a licence "
                       "is not permission.",
        }.get(verdict, "is not on the allowlist (%s)." % ", ".join(ALLOWED))
        print("LICENCE GUARD: REFUSED - %s %s" % (subject, why), file=out)
        sys.exit(1)
    if verdict == "research":
        print("LICENCE GUARD: %s is NON-COMMERCIAL; continuing only because "
              "--allow-non-commercial was given. The result must never ship." % subject, file=out)
    return verdict


def record(prov):
    data = {}
    if os.path.isfile(PROVENANCE):
        data = json.load(open(PROVENANCE, encoding="utf-8"))
    prov = dict(prov)
    prov["checked"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    data.setdefault("bases", {})[prov["id"]] = prov
    json.dump(data, open(PROVENANCE, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
    return PROVENANCE


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("subject", help="ollama:<tag> | hf:<repo id> | path:<dir>")
    ap.add_argument("--allow-non-commercial", action="store_true")
    ap.add_argument("--record", action="store_true", help="write the result to base-provenance.json")
    args = ap.parse_args(argv)
    try:
        allowed, verdict, _, prov = check(args.subject, args.allow_non_commercial)
    except LicenceError as exc:
        print("could not read licence: %s" % exc, file=sys.stderr)
        return 3
    print("%-8s %s  (%s)" % (verdict.upper(), args.subject, prov["licence_first_line"]))
    if args.record:
        print("recorded in %s" % record(prov))
    return 0 if allowed else 1


if __name__ == "__main__":
    sys.exit(main())
