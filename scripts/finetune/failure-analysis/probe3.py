#!/usr/bin/env python3
"""probe3.py — STEP 2 (final): is tg-01 a MODEL defect or a PROMPT defect?

wa-01 ("message Ashu on WhatsApp that I'll be 10 minutes late") is the same
shape as tg-01 — a confirmation-gated send with every argument present — and it
PASSES in every recorded run. The two schemas differ in exactly one way:

  whatsapp: "...ALWAYS asks the user to confirm before sending, since it
             messages another person; a confirmation prompt or a 'which chat did
             you mean?' picker will appear on screen - that is expected, wait
             for it."
  telegram: "This sends a real, un-sendable message and always asks for
             confirmation."

The whatsapp wording says the gate happens AFTER the call, on screen. The
telegram wording does not. If transplanting that clause onto the telegram schema
flips tg-01, the failure is a prompt defect and belongs in a prompt fix, not in
a training set — which is a materially different (and cheaper) conclusion.

Run both directions so the result cannot be read as a one-way fluke:
  1. telegram schema + whatsapp's downstream-gate clause  -> does tg-01 pass?
  2. whatsapp schema - its downstream-gate clause         -> does wa-01 break?
"""
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from probe import chat, load_prompt, MODEL  # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
BENCH = os.path.join(REPO, "scripts", "benchmark")
sys.path.insert(0, BENCH)
sys.path.insert(0, os.path.join(REPO, "scripts", "finetune", "eval"))
from run_eval import score_case  # noqa: E402
from run_benchmark import repair_invalid_escapes, known_tool_names  # noqa: E402

TG_WEAK = "This sends a real, un-sendable message and always asks for confirmation."
# Byte-for-byte the whatsapp clause, retargeted to telegram's noun.
TG_STRONG = (
    "This ALWAYS asks the user to confirm before sending, since it messages another "
    "person; a confirmation prompt will appear on screen — that is expected, wait for it."
)
WA_STRONG = (
    'This ALWAYS asks the user to confirm before sending, since it messages another '
    'person; a confirmation prompt or a "which chat did you mean?" picker will appear '
    'on screen — that is expected, wait for it.'
)
WA_WEAKENED = "This sends a real, un-sendable message and always asks for confirmation."


def run(label, case, system, user, note):
    reply, secs = chat(system, user)
    verdict, flags, call, how = score_case(
        case, repair_invalid_escapes(reply), known_tool_names(system)
    )
    row = {
        "probe": label, "note": note, "user_turn": user, "verdict": verdict,
        "flags": list(flags), "tool": (call or {}).get("tool"),
        "latency_s": secs, "reply": reply,
    }
    print("  %-36s %-18s tool=%-24s %5.1fs" % (label, verdict, row["tool"], secs))
    return row


def main():
    cases = {c["id"]: c for c in json.load(
        open(os.path.join(BENCH, "taskset.json"), encoding="utf-8"))["cases"]}
    rows = []

    tg_prompt = load_prompt("tg-01")
    wa_prompt = load_prompt("wa-01")
    assert TG_WEAK in tg_prompt, "telegram schema wording moved - update this probe"
    assert WA_STRONG in wa_prompt, "whatsapp schema wording moved - update this probe"

    print("\n[H] transplant the downstream-gate clause ONTO telegram")
    rows.append(run("tg-01:baseline", cases["tg-01"], tg_prompt, cases["tg-01"]["prompt"],
                    "control - shipped prompt"))
    rows.append(run("tg-01:gate-clause-added", cases["tg-01"],
                    tg_prompt.replace(TG_WEAK, TG_STRONG), cases["tg-01"]["prompt"],
                    "only change: telegram schema now says the gate appears on screen"))

    print("\n[I] remove that same clause FROM whatsapp (the reverse direction)")
    rows.append(run("wa-01:baseline", cases["wa-01"], wa_prompt, cases["wa-01"]["prompt"],
                    "control - shipped prompt, passes in every recorded run"))
    rows.append(run("wa-01:gate-clause-removed", cases["wa-01"],
                    wa_prompt.replace(WA_STRONG, WA_WEAKENED), cases["wa-01"]["prompt"],
                    "only change: whatsapp schema weakened to telegram's wording"))

    dest = os.path.join(HERE, "probe3-results.json")
    json.dump({"model": MODEL, "generated": time.strftime("%Y-%m-%dT%H:%M:%S"), "probes": rows},
              open(dest, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
    print("\nwrote %s" % dest)
    return 0


if __name__ == "__main__":
    sys.exit(main())
