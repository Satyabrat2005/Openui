#!/usr/bin/env python3
"""collect.py — STEP 3: turn candidate turns into REAL training examples.

A candidate becomes an example only if the real pipeline actually fails on it:
the prompt is the one the app's own builder produced (generate_pattern_prompts
.test.ts), the model is the one Splen ships on, the decode settings are the ones
run_benchmark uses, and the detector is specific to the pattern being collected.

Two rules this file follows, both of which cost examples:

  1. CLASSIFY BY WHAT HAPPENED, NOT BY WHICH LIST THE TURN WAS WRITTEN ON. A
     candidate written to provoke P2 that instead emitted a non-existent tool is
     a P3 reproduction and is filed as one. The first version of this script
     dropped those, which under-counted P3 by a factor of five.

  2. REQUIRE STABILITY ACROSS SEEDS. run_benchmark pins seed 0, so one run
     cannot distinguish a settled behaviour from a coin-flip sitting on the
     decode boundary. Each candidate is run at SEEDS and must reproduce the SAME
     pattern in at least MIN_HITS of them to be collected. Turns that flip are
     reported as unstable rather than quietly trained on — a fine-tune built on
     coin-flips cannot be evaluated honestly afterwards.

Output (all alongside this file):
  pattern-dataset.jsonl  — one line per collected example, in the same shape as
                           scripts/finetune/data/train.jsonl
  collection-report.json — every candidate at every seed, with the raw output
"""
import json
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
PROMPTS = os.path.join(HERE, "prompts")
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(REPO, "scripts", "benchmark"))
sys.path.insert(0, os.path.join(REPO, "scripts", "finetune", "eval"))
from probe import chat, MODEL  # noqa: E402
from run_eval import parse_tool_call  # noqa: E402
from run_benchmark import repair_invalid_escapes, known_tool_names  # noqa: E402

SEEDS = [0, 1, 2]
MIN_HITS = 2

# Prose that hands the decision back to the user instead of calling the tool.
ASKS_FOR_CONFIRMATION = re.compile(
    r"\b(confirm|confirmation|shall I|should I|would you like me to|do you want me to|"
    r"before (I|proceeding)|reply\s+\*{0,2}yes)\b",
    re.I,
)
# Prose that asks for an argument the user never supplied. Distinguished from a
# confirmation request because the two need opposite fixes — and because the
# mail-03 analysis showed asking for a missing recipient is CORRECT behaviour.
ASKS_FOR_MISSING_ARG = re.compile(
    r"\b(what is (your|the)|could you (please )?(provide|share|tell)|I('|)ll need|"
    r"I need (your|the|you to)|can'?t guess|which (address|chat|channel))\b",
    re.I,
)


def observed_pattern(case, reply, known):
    """What actually happened, named as one of the confirmed patterns (or None).

    Deliberately independent of case["pattern"] — see rule 1 in the docstring.
    """
    call, how = parse_tool_call(repair_invalid_escapes(reply), known)
    name = (call or {}).get("tool")
    real = bool(name) and name in known
    extra = {"tool_emitted": name, "tool_is_real": real, "parse_how": how}

    # A tool name the surface does not contain. This is P3 regardless of which
    # candidate list the turn came from.
    if name and not real:
        return "P3_group_name_as_tool", "emitted %r, not a tool on this surface" % name, extra

    if case["pattern"] == "P1_prose_confirmation":
        if real:
            return None, "emitted a real tool call (%s)" % name, extra
        if ASKS_FOR_CONFIRMATION.search(reply):
            return "P1_prose_confirmation", "no tool call; asked for confirmation in prose", extra
        if ASKS_FOR_MISSING_ARG.search(reply):
            return None, "asked for a missing argument - not the P1 defect", extra
        return None, "no tool call, but not the confirmation shape", extra

    # P2 / P3 candidates: both should answer in plain text.
    if real:
        return "P2_speculative_search", "emitted %s instead of saying there is no record" % name, extra
    return None, "answered in plain text, as expected", extra


def target_for(case, pattern):
    """The output the example teaches. Never derived from the model's output.

    P1 teaches the tool call built from the case's declared args. P2 and P3 both
    teach the plain-text honest answer, so a turn that lands in either pattern
    uses the same written target.
    """
    if pattern == "P1_prose_confirmation":
        return json.dumps({"tool": case["expect_tool"], "args": case["expect_args"]},
                          ensure_ascii=False)
    text = case.get("target_text")
    if not text:
        raise ValueError("%s reproduced %s but has no target_text" % (case["id"], pattern))
    return text


def main():
    spec = json.load(open(os.path.join(HERE, "pattern-cases.json"), encoding="utf-8"))
    manifest = {p["id"]: p for p in json.load(
        open(os.path.join(PROMPTS, "manifest.json"), encoding="utf-8"))["prompts"]}

    rows, dataset = [], []
    for case in spec["cases"]:
        system = open(os.path.join(PROMPTS, case["id"] + ".txt"), encoding="utf-8").read()
        known = known_tool_names(system)

        trials = []
        for seed in SEEDS:
            reply, secs = chat(system, case["prompt"], seed=seed)
            pat, why, extra = observed_pattern(case, reply, known)
            trials.append({"seed": seed, "observed_pattern": pat, "why": why,
                           "latency_s": secs, "reply": reply, **extra})

        hits = {}
        for t in trials:
            if t["observed_pattern"]:
                hits[t["observed_pattern"]] = hits.get(t["observed_pattern"], 0) + 1
        best = max(hits, key=hits.get) if hits else None
        n_hits = hits.get(best, 0)
        stable = best is not None and n_hits >= MIN_HITS
        unstable = best is not None and 0 < n_hits < MIN_HITS

        # A P1 example is only trainable if the tool it should call is actually
        # on the surface — otherwise it teaches calling a tool it was not given.
        surface_ok = True
        if best == "P1_prose_confirmation":
            surface_ok = case["expect_tool"] in known

        collect = stable and surface_ok
        row = {
            "id": case["id"],
            "candidate_pattern": case["pattern"],
            "observed_pattern": best,
            "hits": n_hits,
            "seeds": len(SEEDS),
            "stable": stable,
            "unstable": unstable,
            "collected": collect,
            "expected_tool_on_surface": surface_ok,
            "user_turn": case["prompt"],
            "groups": manifest[case["id"]]["groups"],
            "tool_count": len(manifest[case["id"]]["toolNames"]),
            "trials": trials,
        }
        rows.append(row)

        if collect:
            target = target_for(case, best)
            dataset.append({
                "source": "failure-analysis 2026-08-30",
                "kind": "tool_call" if best == "P1_prose_confirmation" else "chat",
                "pattern": best,
                "case_id": case["id"],
                "tool": case.get("expect_tool") if best == "P1_prose_confirmation" else None,
                "reproduced_at_seeds": [t["seed"] for t in trials
                                        if t["observed_pattern"] == best],
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": case["prompt"]},
                    {"role": "assistant", "content": target},
                ],
                # Kept so every example traces back to the failure it came from.
                "rejected_output": next(t["reply"] for t in trials
                                        if t["observed_pattern"] == best),
            })

        mark = "COLLECT" if collect else ("UNSTABLE" if unstable else "skip    ")
        print("  %-8s %-10s cand=%-22s obs=%-22s %d/%d"
              % (mark, case["id"], case["pattern"].split("_")[0],
                 (best or "-").split("_")[0], n_hits, len(SEEDS)))

    with open(os.path.join(HERE, "pattern-dataset.jsonl"), "w", encoding="utf-8") as fh:
        for d in dataset:
            fh.write(json.dumps(d, ensure_ascii=False) + "\n")

    counts = {}
    for r in rows:
        p = r["observed_pattern"]
        if not p:
            continue
        c = counts.setdefault(p, {"reproduced": 0, "collected": 0, "unstable": 0})
        c["reproduced"] += 1
        c["collected"] += int(r["collected"])
        c["unstable"] += int(r["unstable"])

    report = {
        "generated": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "model": MODEL,
        "seeds": SEEDS,
        "min_hits_to_collect": MIN_HITS,
        "prompt_source": "scripts/finetune/failure-analysis/generate_pattern_prompts.test.ts "
                         "(buildDefaultSystemPrompt + selectToolGroups + renderMemoryBlock)",
        "counts": counts,
        "candidates": rows,
    }
    json.dump(report, open(os.path.join(HERE, "collection-report.json"), "w", encoding="utf-8"),
              indent=2, ensure_ascii=False)

    print("\n%-26s %11s %10s %10s" % ("observed pattern", "reproduced", "collected", "unstable"))
    print("-" * 60)
    for p, c in sorted(counts.items()):
        print("%-26s %11d %10d %10d" % (p, c["reproduced"], c["collected"], c["unstable"]))
    print("\n%d candidates, %d collected examples" % (len(rows), len(dataset)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
