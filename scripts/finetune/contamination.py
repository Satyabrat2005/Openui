#!/usr/bin/env python3
"""contamination.py — keep evaluation and safety-gate text out of training data.

Split out of build_dataset.py so the guard can be imported and tested on its
own. build_dataset.py loads machine-local, gitignored prompt captures at import
time, so anything that imported the guard from there only worked on the machine
that had them — the sealing test passed on the author's laptop and crashed in a
clean checkout.

build_dataset.py re-exports these names unchanged.
"""
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
EVAL = os.path.join(HERE, "eval")


def norm(s):
    return re.sub(r"[^a-z0-9 ]+", " ", (s or "").lower()).strip()


def tokens(s):
    return set(norm(s).split())


def gate_texts():
    """(id, text) for every piece of text in both safety gates.

    Training on the gate is how a gate becomes a memorisation test. Gate v2 is
    split into `dev` (may inform how adversarial training rows are DESIGNED) and
    `sealed` (may never be seen) — but no gate text, of either split, may be
    copied into a training row. So the guard blocks all of it: prompts, the
    attacker's messages inside rendered reads, sender names, and follow-up turns.
    """
    gate = os.path.join(HERE, "safety-gate")
    out = []
    v1 = os.path.join(gate, "safety-cases.json")
    if os.path.isfile(v1):
        for c in json.load(open(v1, encoding="utf-8"))["cases"]:
            out.append((c["id"], c["prompt"]))
            out.extend((c["id"], t["content"]) for t in c.get("turns", []))
    v2 = os.path.join(gate, "v2", "cases.json")
    if not os.path.isfile(v2):
        # The sealed split is only sealed if this guard can see it. A missing file
        # is a broken checkout, not permission to build without the check.
        raise SystemExit("safety-gate/v2/cases.json is missing; refusing to build a corpus "
                         "that cannot be checked against the sealed safety gate")
    for c in json.load(open(v2, encoding="utf-8"))["cases"]:
        out.append((c["id"], c["prompt"]))
        read = c.get("read") or {}
        for m in read.get("incoming", []):
            for k in ("text", "sender", "subject"):
                if m.get(k):
                    out.append((c["id"], m[k]))
        if read.get("text"):
            out.append((c["id"], read["text"]))
        if read.get("output"):
            out.append((c["id"], read["output"]))
        for t in c.get("history", []) + c.get("followup", []):
            out.append((c["id"], t["content"]))
    return out


class EvalGuard:
    def __init__(self):
        ev = json.load(open(os.path.join(EVAL, "evalset.json"), encoding="utf-8"))
        texts = [(c["id"], c["prompt"]) for c in ev["cases"]] + gate_texts()
        self.exact = {norm(t) for _, t in texts}
        self.tok = [(cid, tokens(t)) for cid, t in texts]
        self.blocked = []

    def is_contaminated(self, text):
        n = norm(text)
        if n in self.exact:
            self.blocked.append((text, "exact"))
            return True
        t = tokens(text)
        if not t:
            return False
        for cid, et in self.tok:
            if not et:
                continue
            overlap = len(t & et) / len(t | et)       # Jaccard
            if overlap >= 0.75:
                self.blocked.append((text, f"near:{cid}:{overlap:.2f}"))
                return True
        return False
