#!/usr/bin/env python3
"""prove_gate_v2.py — evidence that gate v2 can FAIL, case by case.

Runs run_gate_v2.py against every stand-in (standins_v2.py) over ALL cases and
asserts the outcome. Two assertions are stronger than v1's:

  * `unsafe` must flag EVERY safety case individually. With 110 of them, a
    count-based check ("it failed overall") would hide a dozen decorative cases.
  * `good` must pass EVERY case individually — a case whose correct answer is
    flagged would push real models to fail for doing the right thing.

Run:  python scripts/finetune/safety-gate/v2/prove_gate_v2.py
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
GATE = os.path.join(HERE, "run_gate_v2.py")
sys.path.insert(0, HERE)
from standins_v2 import CRITICAL, LEGACY_FAMILIES  # noqa: E402

EXPECT = {
    "unsafe": "FAIL",
    "good": "PASS",
    "refuser": "VACUOUS",
    "over_refuser": "VACUOUS",
    "legacy_only": "FAIL",
    "critical_leaker": "FAIL",
}
CODE = {"PASS": 0, "FAIL": 1, "VACUOUS": 2}


def run(name):
    out = os.path.join(HERE, "results", "standin-%s.json" % name)
    p = subprocess.run([sys.executable, GATE, "--subject", "standin:" + name, "--split", "all",
                        "--out", out, "--quiet"], capture_output=True, text=True)
    if p.returncode == 3 or not os.path.isfile(out):
        raise SystemExit("gate errored for %s:\n%s%s" % (name, p.stdout, p.stderr))
    return p.returncode, json.load(open(out, encoding="utf-8"))


def main():
    problems = []
    lines = []
    for name, want in EXPECT.items():
        code, rep = run(name)
        rows = rep["results_by_seed"][0]
        got = rep["status"]
        if got != want or code != CODE[want]:
            problems.append("%s: expected %s (exit %d), got %s (exit %d) - %s"
                            % (name, want, CODE[want], got, code, rep["reasons"] + rep["vacuous"]))
        safety = [r for r in rows if r["family"] != "liveness_control"]
        live = [r for r in rows if r["family"] == "liveness_control"]

        if name == "unsafe":
            missed = [r["id"] for r in safety if not r["violations"]]
            if missed:
                problems.append("unsafe: %d safety case(s) did NOT flag their own attack: %s"
                                % (len(missed), ", ".join(missed)))
        if name == "good":
            flagged = ["%s (%s)" % (r["id"], r["violations"][0]) for r in rows if r["violations"]]
            if flagged:
                problems.append("good: %d case(s) flagged a CORRECT reply: %s" % (len(flagged), "; ".join(flagged)))
        if name == "legacy_only":
            new = [r for r in safety if r["family"] not in LEGACY_FAMILIES and not r["id"].startswith("msg-web-")]
            missed = [r["id"] for r in new if not r["violations"]]
            if missed:
                problems.append("legacy_only: new-family cases not flagged: %s" % ", ".join(missed))
        if name == "critical_leaker":
            crit = [r for r in safety if r["family"] in CRITICAL]
            missed = [r["id"] for r in crit if not r["violations"]]
            if missed:
                problems.append("critical_leaker: critical cases not flagged: %s" % ", ".join(missed))

        lines.append("%-16s expected %-8s got %-8s  safety flagged %3d/%d  liveness passed %2d/%d"
                     % (name, want, got, sum(1 for r in safety if r["violations"]), len(safety),
                        sum(1 for r in live if not r["violations"]), len(live)))

    print("gate v2 proof\n" + "\n".join(lines))
    if problems:
        print("\nGATE V2 PROOF FAILED")
        for p in problems:
            print("  - " + p)
        return 1
    print("\nGATE V2 PROOF PASSED - every safety case catches its own attack, every correct reply passes.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
