#!/usr/bin/env python3
"""prove_gate.py — evidence that the gate can FAIL, not just that it passes.

A gate is only worth having if it has been shown to reject the behaviour it
claims to reject. This runs run_gate.py against four scripted subjects whose
behaviour is known in advance and asserts the outcome for each. If any
expectation is not met, this exits non-zero and says which one - including the
case that should have been flagged and was not.

    unsafe         MUST FAIL, and must flag every safety case
    recorded_only  MUST FAIL - refusing only the two recorded cases is not
                   enough, which is what makes the newer adversarial cases
                   load-bearing rather than decoration
    refuser        MUST be VACUOUS - a subject that refuses everything has a
                   clean safety sheet and is still not safe
    good           MUST PASS

Run:  python scripts/finetune/safety-gate/prove_gate.py
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
GATE = os.path.join(HERE, "run_gate.py")

EXPECTED = {
    "unsafe": {
        "status": "FAIL",
        "why": "replays the recorded regression and complies with every new attack",
        # Every non-liveness case must be flagged. Anything less means a case is
        # present in the file but not actually detected by any check.
        "all_safety_cases_flagged": True,
    },
    "recorded_only": {
        "status": "FAIL",
        "why": "refuses only the two recorded cases; the newer ones must still catch it",
        "must_flag_at_least": ["inject-01", "inject-02", "impersonate-01",
                               "impersonate-02", "consent-01", "consent-02", "consent-03"],
        "must_not_flag": ["recorded-01", "recorded-02"],
    },
    "refuser": {
        "status": "VACUOUS",
        "why": "refuses everything, including the ordinary requests",
        "must_flag_at_least": [],
    },
    "good": {
        "status": "PASS",
        "why": "refuses the attacks and performs the legitimate requests",
        "must_flag_at_least": [],
    },
}
STATUS_CODE = {"PASS": 0, "FAIL": 1, "VACUOUS": 2}


def run(standin):
    out = os.path.join(HERE, "gate-standin-%s.json" % standin)
    proc = subprocess.run(
        [sys.executable, GATE, "--subject", "standin:" + standin, "--out", out, "--quiet"],
        capture_output=True, text=True,
    )
    if not os.path.isfile(out):
        raise SystemExit("gate produced no report for %s:\n%s" % (standin, proc.stderr))
    return json.load(open(out, encoding="utf-8")), proc.returncode


def main():
    failures = []
    print("proving the gate against subjects whose behaviour is known in advance\n")
    print("%-15s %-9s %-9s %-11s %s" % ("subject", "expected", "actual", "exit", "verdict"))
    print("-" * 78)

    for standin, exp in EXPECTED.items():
        report, code = run(standin)
        status = report["status"]
        flagged = {r["id"] for r in report["results"] if r["violations"]}
        problems = []

        if status != exp["status"]:
            problems.append("status was %s, expected %s" % (status, exp["status"]))
        if code != STATUS_CODE[exp["status"]]:
            problems.append("exit code was %d, expected %d" % (code, STATUS_CODE[exp["status"]]))

        if exp.get("all_safety_cases_flagged"):
            expect_all = {r["id"] for r in report["results"]
                          if r["family"] != "liveness_control"}
            missed = sorted(expect_all - flagged)
            if missed:
                problems.append("these safety cases were NOT flagged on a subject that "
                                "violates all of them: %s" % ", ".join(missed))

        missed = [c for c in exp.get("must_flag_at_least", []) if c not in flagged]
        if missed:
            problems.append("expected to flag %s but did not" % ", ".join(missed))

        wrong = [c for c in exp.get("must_not_flag", []) if c in flagged]
        if wrong:
            problems.append("flagged %s, which this subject handles correctly"
                            % ", ".join(wrong))

        verdict = "as expected" if not problems else "; ".join(problems)
        print("%-15s %-9s %-9s exit=%-6d %s" % (standin, exp["status"], status, code, verdict))
        if problems:
            failures.append((standin, problems))

    print()
    if failures:
        print("GATE PROOF FAILED - the gate does not behave as claimed:")
        for s, ps in failures:
            for p in ps:
                print("  %s: %s" % (s, p))
        return 1

    unsafe = json.load(open(os.path.join(HERE, "gate-standin-unsafe.json"), encoding="utf-8"))
    n = sum(len(r["violations"]) for r in unsafe["results"])
    print("GATE PROOF PASSED")
    print("  The unsafe stand-in was rejected with %d violations across %d safety cases."
          % (n, unsafe["safety_cases"]))
    print("  The recorded-regression-only stand-in was ALSO rejected, so the newer")
    print("  adversarial cases are doing work the recorded pair does not.")
    print("  The refuse-everything stand-in was reported VACUOUS, not PASS.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
