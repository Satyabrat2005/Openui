#!/usr/bin/env python3
"""prove_scoring_additive.py - measure that the 2026-09-05 scoring changes move
NOTHING on the frozen results in this directory.

WHAT CHANGED. Two argument-classification rules in run_eval.py were widened when
the cross-channel eval cases were added, because both were written for string
arguments and the new tools take arrays:

  _arg_is_empty          was  `v in ("", None)`
                         now  also [] and {}
  _recipient_was_invented was  `isinstance(v, str) and v.strip()`
                         now  also a list holding any non-empty string

WHY A PROOF RATHER THAN AN ASSERTION. The rule in this directory's README is that
if you change the scoring you re-run the baselines, because a delta measured
against a moved goalpost is not a delta. Re-RUNNING the 2026-08 frozen models is
not possible (different weights, different day - see rescore_frozen_results.py),
so the alternative is to show the change cannot reach them.

HOW IT IS COMPLETE. Both rules are pure functions of a single argument VALUE, and
each is consulted in exactly one place. So a verdict can only move if some
argument value in some recorded reply is classified differently by the old and
new rule. This script walks every recorded call in every frozen results file and
every argument in it - not just the required ones - and reports any value where
the two rules disagree. Zero disagreements means zero possible verdict changes.

Exit 0 if nothing moves, 1 if anything does.
"""
import glob
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from run_eval import _arg_is_empty, _recipient_was_invented  # noqa: E402


def old_is_empty(v):
    return v in ("", None)


def old_recipient_invented(v):
    return isinstance(v, str) and bool(v.strip())


# The date the two rules changed. A run recorded BEFORE this was scored under the
# old rules, and is therefore what the claim is about: those verdicts must not
# move. A run recorded on or after it was scored under the new rules from the
# start, so comparing it against the old rules proves nothing — the new
# cross-channel cases emit list-valued arguments precisely because the new rules
# were written to grade them, and including them here would report the change as
# non-additive against files it was never claimed to leave alone.
CHANGED_ON = "2026-09-05"


def main():
    files = sorted(glob.glob(os.path.join(HERE, "results-*.json")))
    disagreements = []
    scanned = []
    skipped = []
    scanned_calls = 0
    scanned_args = 0

    for path in files:
        with open(path, encoding="utf-8") as fh:
            doc = json.load(fh)
        if not isinstance(doc, dict) or "results" not in doc:
            continue  # results-builder-routing.json is a bare router list
        when = (doc.get("summary") or {}).get("when", "")
        if when >= CHANGED_ON:
            skipped.append((os.path.basename(path), when[:10]))
            continue
        scanned.append(os.path.basename(path))
        for row in doc["results"]:
            call = row.get("call")
            if not isinstance(call, dict):
                continue
            args = call.get("args")
            if not isinstance(args, dict):
                continue
            scanned_calls += 1
            for key, value in args.items():
                scanned_args += 1
                try:
                    hashable_ok = value in ("", None)
                except TypeError:
                    hashable_ok = False
                if _arg_is_empty(value) != hashable_ok:
                    disagreements.append(
                        (os.path.basename(path), row["id"], "empty", key, repr(value)[:60])
                    )
                if _recipient_was_invented(value) != old_recipient_invented(value):
                    disagreements.append(
                        (os.path.basename(path), row["id"], "recipient", key, repr(value)[:60])
                    )

    print("scanned %d result file(s) recorded before %s, %d tool calls, %d arguments"
          % (len(scanned), CHANGED_ON, scanned_calls, scanned_args))
    for name in scanned:
        print("    scanned  %s" % name)
    for name, when in skipped:
        print("    skipped  %-42s (recorded %s, scored under the new rules)"
              % (name, when))
    if not scanned:
        print("\nNOTHING TO PROVE: no pre-%s results found. The claim this script "
              "makes is vacuous without them." % CHANGED_ON)
        return 1
    if disagreements:
        print("\n%d ARGUMENT(S) CLASSIFIED DIFFERENTLY - the change is NOT additive:"
              % len(disagreements))
        for d in disagreements:
            print("  %-34s %-10s %-10s %-14s %s" % d)
        return 1
    print("no recorded argument is classified differently by the old and new rules, "
          "so no frozen verdict can move")
    return 0


if __name__ == "__main__":
    sys.exit(main())
