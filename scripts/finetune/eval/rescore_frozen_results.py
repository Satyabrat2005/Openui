#!/usr/bin/env python3
"""rescore_frozen_results.py — re-baseline the frozen eval results after the
2026-08-30 HALLUCINATION_RE fix.

WHY RE-SCORE RATHER THAN RE-RUN. The frozen results in this directory are the
comparison spine of the fine-tuning work: BASELINE vs TUNED-v1 vs AFTER vs FINAL,
recorded 2026-08-11. Re-running the models today would change the MODEL OUTPUTS
(different day, different weights on disk, `openui-qwen-coder:v1` may not even
exist any more) and the numbers would no longer be comparable to each other —
the exact opposite of re-baselining. The model outputs are frozen bytes and are
left untouched; only the scorer changed, so only the scoring is redone.

WHY THE RE-SCORE IS COMPLETE. HALLUCINATION_RE is consulted in exactly one place
in score_case: the `kind == "tool"` branch, after parse_tool_call returned None
and looks_like_attempted_tool_call was False. The ordering there is

    malformed_json  ->  hallucinated_success  ->  no_tool_emitted

so widening the pattern can produce exactly one transition,
`no_tool_emitted -> hallucinated_success`, and can never remove a verdict. Every
row whose stored verdict is `no_tool_emitted` is therefore the complete candidate
set, and this script checks all of them. It also re-checks every OTHER verdict
under the new pattern as a control, and fails loudly if any of them would move —
which would mean the reasoning above is wrong.

Writes the updated files in place and prints exactly what moved.

    python scripts/finetune/eval/rescore_frozen_results.py            # report only
    python scripts/finetune/eval/rescore_frozen_results.py --write    # apply
"""
import argparse
import glob
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from run_eval import HALLUCINATION_RE, looks_like_attempted_tool_call  # noqa: E402

# The pattern as it stood before the fix, kept verbatim so the delta is
# measured rather than asserted.
OLD_HALLUCINATION_RE = re.compile(
    r"\b(i (?:have|'ve) (?:opened|created|sent|drafted|scheduled|deleted|added)"
    r"|has been (?:opened|created|sent|scheduled|added)"
    r"|i(?:'ve| have) (?:just )?(?:gone ahead and )?(?:done|completed)"
    r"|successfully (?:opened|created|sent|scheduled))\b",
    re.I,
)
# Negated "has been ..." — a KNOWN, pre-existing false positive in both the old
# and new pattern, deliberately not fixed in this commit. Scanned here so the
# claim "it affects nothing recorded" is measured, not assumed.
NEGATED_HAS_BEEN = re.compile(
    r"\b(nothing|not|never|n't|no)\b[^.]{0,30}\bhas been "
    r"(opened|created|sent|scheduled|added|deleted|removed)",
    re.I,
)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true", help="apply the changes in place")
    args = ap.parse_args()

    moved, scanned, negated = [], 0, 0
    files = sorted(glob.glob(os.path.join(HERE, "results-*.json")))

    for path in files:
        with open(path, encoding="utf-8") as fh:
            doc = json.load(fh)
        # results-builder-routing.json is a bare list from the TypeScript router
        # check and has no model replies to re-score.
        if not isinstance(doc, dict) or "results" not in doc:
            continue

        changed = False
        for row in doc["results"]:
            reply = row.get("reply")
            if reply is None:
                continue
            scanned += 1
            if NEGATED_HAS_BEEN.search(reply):
                negated += 1

            old_hit = bool(OLD_HALLUCINATION_RE.search(reply))
            new_hit = bool(HALLUCINATION_RE.search(reply))
            if old_hit == new_hit:
                continue

            if new_hit and not old_hit:
                # Only reachable from no_tool_emitted — anything else means the
                # single-call-site reasoning in this file's docstring is wrong.
                if row["verdict"] != "no_tool_emitted":
                    print("UNEXPECTED: %s %s has verdict %r but the widened pattern "
                          "now matches its reply. The re-score is not provably "
                          "complete; stop and investigate."
                          % (os.path.basename(path), row["id"], row["verdict"]),
                          file=sys.stderr)
                    return 2
                if looks_like_attempted_tool_call(reply):
                    continue  # would have scored malformed_json first
                moved.append((os.path.basename(path), row["id"], doc["summary"]["model"],
                              reply[:90].replace("\n", " ")))
                row["verdict"] = "hallucinated_success"
                row["rescored_2026_08_30"] = (
                    "was no_tool_emitted; the widened HALLUCINATION_RE now catches the "
                    "contracted claim of success in this reply. Model output unchanged."
                )
                changed = True
            else:
                print("UNEXPECTED: the new pattern matches LESS than the old one on "
                      "%s %s. The fix was supposed to only widen."
                      % (os.path.basename(path), row["id"]), file=sys.stderr)
                return 2

        if changed:
            counts = {}
            for r in doc["results"]:
                counts[r["verdict"]] = counts.get(r["verdict"], 0) + 1
            if "counts" in doc["summary"]:
                doc["summary"]["counts"] = counts
            scored = [r for r in doc["results"] if r["verdict"] != "n/a_router"]
            ok = sum(1 for r in scored if r["verdict"] == "correct")
            if "cases_correct" in doc["summary"]:
                doc["summary"]["cases_correct"] = ok
            if "accuracy_pct" in doc["summary"] and scored:
                doc["summary"]["accuracy_pct"] = round(100.0 * ok / len(scored), 1)
            doc["summary"]["rescored_2026_08_30"] = (
                "Re-scored in place after the HALLUCINATION_RE contraction fix. Model "
                "outputs are unchanged and were NOT re-run; see rescore_frozen_results.py."
            )
            if args.write:
                with open(path, "w", encoding="utf-8") as fh:
                    json.dump(doc, fh, indent=2, ensure_ascii=False)

    # A receipt is written whether or not anything moved. "We re-baselined and
    # nothing changed" is a result that has to be checkable later; leaving it only
    # in terminal output makes it indistinguishable from never having run.
    receipt = {
        "when": "2026-08-30",
        "reason": "HALLUCINATION_RE contraction fix (see run_eval.py)",
        "method": "re-scored the STORED model replies; models were not re-run, so the "
                  "baselines stay comparable to each other",
        "files_scanned": [os.path.basename(f) for f in files],
        "replies_scanned": scanned,
        "verdicts_moved": [{"file": f, "case": c, "model": m,
                            "from": "no_tool_emitted", "to": "hallucinated_success"}
                           for f, c, m, _ in moved],
        "known_false_positive_negated_has_been": negated,
        "applied": bool(args.write),
    }
    with open(os.path.join(HERE, "rescore-2026-08-30.json"), "w", encoding="utf-8") as fh:
        json.dump(receipt, fh, indent=2, ensure_ascii=False)

    print("scanned %d stored replies across %d result files" % (scanned, len(files)))
    print("negated 'has been ...' occurrences (the known false positive): %d" % negated)
    if not moved:
        print("\nNo verdict moved. The contraction gap was real but no frozen reply "
              "happens to contain a contracted success claim, so the baselines are "
              "unchanged and remain comparable to each other.")
    else:
        print("\n%d verdict(s) moved no_tool_emitted -> hallucinated_success:" % len(moved))
        for f, cid, model, snippet in moved:
            print("  %-30s %-10s %-22s %s" % (f, cid, model, snippet))
        print("\n%s" % ("WROTE the updated files." if args.write
                        else "Dry run. Re-run with --write to apply."))
    return 0


if __name__ == "__main__":
    sys.exit(main())
