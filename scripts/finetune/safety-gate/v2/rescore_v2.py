#!/usr/bin/env python3
"""rescore_v2.py — re-grade saved gate v2 replies with the CURRENT grader.

Model replies are the expensive part of a gate run (~30 min per seed on the
shipped model); grading them is milliseconds. When the grader is corrected — as
it was during v2's own construction (typosquat matching, link_contact's
`channel`, "nothing was sent") — the right move is to re-score the saved
replies, never to re-run the model and silently mix two graders' verdicts.

Merges one or more single-seed result files into one multi-seed report and
applies the bar exactly as run_gate_v2.py does.

    python scripts/finetune/safety-gate/v2/rescore_v2.py \
        results/gate-v2-qwen3.5-latest-seed1.json results/gate-v2-qwen3.5-latest-seed2.json \
        --out results/gate-v2-qwen3.5-latest.json
"""
import argparse
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import run_gate_v2 as g  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--reference", default=None)
    ap.add_argument("--out", required=True)
    ap.add_argument("--original-cases", default=None,
                    help="the cases file the run used, when grading criteria have since been corrected")
    args = ap.parse_args()

    spec = g.load_spec()
    by_id = {c["id"]: c for c in spec["cases"]}
    known = set(json.load(open(os.path.join(HERE, "rendered.json"), encoding="utf-8"))["registeredTools"])

    seeds, seeds_rows, subject, changed = [], [], None, []
    revision_note = None
    for f in args.files:
        rep = json.load(open(f, encoding="utf-8"))
        # Same sealed cases: fine. Different sealed hash: only acceptable when the
        # model saw exactly the same thing (a grading correction), proven by the
        # stimulus hash of the case file the run actually used.
        current_stimulus = g.stimulus_hash(spec["cases"])
        if rep.get("sealed_sha256") != spec["sealed_sha256"] and rep.get("stimulus_sha256"):
            # The run recorded what the model saw; that is the whole question.
            if rep["stimulus_sha256"] != current_stimulus:
                print("REFUSED: %s answered different model inputs than the current cases - "
                      "re-run instead." % f, file=sys.stderr)
                return 3
            revision_note = "grading criteria revised since the run; model inputs identical (stimulus hash match)"
        elif rep.get("sealed_sha256") != spec["sealed_sha256"]:
            original = args.original_cases
            if not original:
                print("%s was graded against different sealed cases. If only grading criteria "
                      "changed, pass --original-cases <the cases file that run used>." % f, file=sys.stderr)
                return 3
            old = json.load(open(original, encoding="utf-8"))
            if old["sealed_sha256"] != rep.get("sealed_sha256"):
                print("--original-cases does not match the sealed hash recorded in %s" % f, file=sys.stderr)
                return 3
            if g.stimulus_hash(old["cases"]) != g.stimulus_hash(spec["cases"]):
                print("REFUSED: what the model sees changed between %s and the current cases. Saved "
                      "replies do not answer the current cases - re-run instead." % original, file=sys.stderr)
                return 3
            revision_note = "grading criteria revised since the run; model inputs identical (stimulus hash match)"
        subject = subject or rep["subject"]
        if rep["subject"] != subject:
            print("mixed subjects: %s vs %s" % (subject, rep["subject"]), file=sys.stderr)
            return 3
        for seed, rows in zip(rep["seeds"], rep["results_by_seed"]):
            new_rows = []
            for r in rows:
                # an unanswered case stays unanswered - never re-graded into a pass
                found = (r["violations"] if r.get("error")
                         else g.check_v2(by_id[r["id"]], r["reply"], known))
                if bool(found) != bool(r["violations"]):
                    changed.append("seed %d %s: %s -> %s" % (seed, r["id"], bool(r["violations"]), bool(found)))
                new_rows.append(dict(r, violations=found))
            seeds.append(seed)
            seeds_rows.append(new_rows)

    expected = sum(1 for c in spec["cases"])
    incomplete = [s for s, rows in zip(seeds, seeds_rows)
                  if len(rows) != expected or any(r.get("error") for r in rows)]
    reference = json.load(open(args.reference, encoding="utf-8")) if args.reference else None
    status, per_family, reasons, vacuous = g.summarise(spec, seeds_rows, reference)
    if incomplete:
        status = "PARTIAL"
    report = {
        "generated": time.strftime("%Y-%m-%dT%H:%M:%S"), "gate": "v2", "rescored": True,
        "subject": subject, "seeds": seeds, "split": "all", "sealed_sha256": spec["sealed_sha256"],
        "reference": args.reference, "status": status, "reasons": reasons, "vacuous": vacuous,
        "incomplete_seeds": incomplete, "revision": revision_note,
        "stimulus_sha256": g.stimulus_hash(spec["cases"]), "verdict_changes_from_original_grading": changed,
        "per_family": per_family, "results_by_seed": seeds_rows,
    }
    json.dump(report, open(args.out, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
    print("%-28s %5s  %s" % ("family", "cases", "violations per seed"))
    for f, d in per_family.items():
        if d["cases"]:
            print("%-28s %5d  %s%s" % (f, d["cases"], d["violations_by_seed"],
                                       " CRITICAL" if f in spec["critical_families"] else ""))
    print("\n%s  subject=%s  seeds=%s" % (status, subject, seeds))
    for r in reasons + vacuous:
        print("  - " + r)
    if changed:
        print("verdicts changed by re-scoring (%d):" % len(changed))
        for c in changed:
            print("  " + c)
    print("wrote %s" % args.out)
    return {"PASS": 0, "FAIL": 1, "VACUOUS": 2, "PARTIAL": 3}[status]


if __name__ == "__main__":
    sys.exit(main())
