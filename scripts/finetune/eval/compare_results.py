#!/usr/bin/env python3
"""compare_results.py — side-by-side diff of two eval runs, per case.

Totals alone can hide a wash: a model that fixes three cases and breaks three
others shows an unchanged headline number while behaving quite differently. This
prints the per-case transitions so regressions cannot be averaged away.

Usage:
  python compare_results.py results-BASELINE-coder3b.json results-TUNED-v1.json
"""
import json
import os
import sys


def load(p):
    d = json.load(open(p, encoding="utf-8"))
    return d["summary"], {r["id"]: r for r in d["results"]}


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    a_sum, a = load(sys.argv[1])
    b_sum, b = load(sys.argv[2])

    print("=" * 78)
    print(f"{'':22s} {'BEFORE':>26s}   {'AFTER':>26s}")
    print(f"{'model':22s} {a_sum['model']:>26s}   {b_sum['model']:>26s}")
    print(f"{'label':22s} {a_sum['label']:>26s}   {b_sum['label']:>26s}")
    print("=" * 78)

    cats = sorted(set(a_sum["counts"]) | set(b_sum["counts"]))
    for c in cats:
        av, bv = a_sum["counts"].get(c, 0), b_sum["counts"].get(c, 0)
        d = bv - av
        arrow = "" if d == 0 else (f"  ({d:+d})")
        print(f"  {c:24s} {av:3d}  ->  {bv:3d}{arrow}")

    print(f"\n  {'accuracy':24s} {a_sum['accuracy_pct']:5.1f}%  ->  "
          f"{b_sum['accuracy_pct']:5.1f}%   "
          f"({b_sum['accuracy_pct'] - a_sum['accuracy_pct']:+.1f} pts)")
    print(f"  {'median latency':24s} {a_sum['median_latency_s']:5.2f}s  ->  "
          f"{b_sum['median_latency_s']:5.2f}s")

    fixed, broken, same_bad = [], [], []
    for cid in sorted(set(a) | set(b)):
        ra, rb = a.get(cid), b.get(cid)
        if not ra or not rb or ra["verdict"] == "n/a_router":
            continue
        va, vb = ra["verdict"], rb["verdict"]
        if va == vb:
            if va != "correct":
                same_bad.append((cid, va))
            continue
        if vb == "correct":
            fixed.append((cid, va, ra["prompt"]))
        elif va == "correct":
            broken.append((cid, vb, ra["prompt"]))
        else:
            same_bad.append((cid, f"{va}->{vb}"))

    print(f"\nFIXED by fine-tuning ({len(fixed)}):")
    for cid, was, p in fixed:
        print(f"  + {cid:9s} was {was:18s} | {p[:52]}")
    print(f"\nBROKEN by fine-tuning ({len(broken)}):")
    for cid, now, p in broken:
        print(f"  - {cid:9s} now {now:18s} | {p[:52]}")
    print(f"\nstill wrong in both ({len(same_bad)}):")
    for cid, v in same_bad:
        print(f"    {cid:9s} {v}")

    net = len(fixed) - len(broken)
    print(f"\nNET: {net:+d} cases  ({len(fixed)} fixed, {len(broken)} broken)")
    if net <= 0:
        print("This is not an improvement. Do not ship it.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
