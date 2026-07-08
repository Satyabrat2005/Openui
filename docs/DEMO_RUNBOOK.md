# OpenUI Live-Demo Runbook — "Full Tour"

The exact script for the VC demo, in presentation order, with the failure
plan for every step. Rehearse this end-to-end at least once on the demo
machine the day before, and once the morning of.

**Tour shape:** chat + a desktop tool → a browser task → the GitHub flow
(create → push → PR → **human-click** merge).

---

## 0. Pre-flight (do this 30 minutes before, not 3)

Run through in order; every box must be checked before you start.

- [ ] `npm run dev` starts clean; the overlay appears, no console errors.
- [ ] **Settings → GitHub token** is set (PAT with `repo` scope) — or
      `GITHUB_TOKEN` is in the env. The demo GitHub account has no
      leftover `openui-demo-*` repos (delete yesterday's).
- [ ] **Autonomy level** set to `approve-plan` (the default). It demos best:
      one plan approval up front, then per-action confirmations only for
      destructive tools — the merge click is the story.
- [ ] Signed in; tier shows correctly in the UI.
- [ ] Browser demo site loads in a normal tab first (network sanity).
- [ ] Optional-but-nice: Ollama running (`ollama list` shows
      `qwen2.5-coder:7b`) so the Local AI status light is green. The tour
      does NOT depend on it — chat is cloud-routed.
- [ ] Notifications/Do-Not-Disturb: enable Focus mode; kill Slack/Discord.
- [ ] Display scale 100–125 %, overlay on the PRIMARY screen.
- [ ] Battery > 50 % or plugged in.

**Reset between rehearsals:** delete the demo repo on GitHub, clear the
sandbox workspace (Settings → workspace → rollback, or delete
`userData/workspace`), and restart the app so run logs start fresh.

---

## 1. Act I — Chat + desktop tool (2 min)

**Say:** "OpenUI is a desktop agent — it lives on your machine, not in a tab."

**Type:** `Open the calculator app` (or another instant, visual `open_app`).

- Expect: the app opens within ~2 s. Point out the Activity panel logging
  the tool call.
- **If it fails:** the error shows inline in chat — read it aloud ("and when
  something fails, it fails visibly, not silently"), move on. Nothing else
  breaks: every tool result is contained, and each panel has its own error
  boundary.

**Then type:** `Preview a landing page for a coffee brand called Driftwood`
(design_preview) — the generated page opens in the browser. One-liner:
"design iterations happen in your real browser, not a mockup."

## 2. Act II — Browser task (3 min)

**Say:** "The browser side is consent-gated per site — the agent cannot touch
a domain you haven't approved, and page content is never treated as
instructions."

**Type:** `Go to <demo site> and summarize the pricing page`.

- First visit triggers the **per-site consent** prompt — approve it on
  screen; that prompt IS the feature.
- Expect: navigation + a grounded summary. Mention sanitization ("what the
  page says is data, never a command") if asked about prompt injection.
- **If the site is slow/down:** fall back to a local file or any stable
  public page. The script does not depend on which site.

**Sensitive-action line (if asked):** payments, passwords, sending messages —
the tool itself refuses until a human clicks, in every autonomy mode.
No exceptions, no "trust me" mode.

## 3. Act III — GitHub flow (5 min, the closer)

**Say:** "Now the full loop: repo → code → PR → and the one thing OpenUI will
never do on its own — merge."

**Type:**
`Create a GitHub repo called openui-demo-landing, push the Driftwood landing
page to it, and open a pull request.`

Watch it walk the 5-step flow (check_repo_exists → create_repo →
push_files → update_readme → open_pull_request):

- `push_files` lands everything as **one commit** on a branch.
- `open_pull_request` is a destructive-listed tool → a confirmation modal
  appears **even in full-auto**. Click **Allow** on screen.
- Open the PR in the browser; show the diff briefly.

**Then type:** `Merge that PR.`

- The **merge_pr confirmation** appears. Pause. **Say:** "This click cannot
  be automated away. Auto-merge doesn't exist in this codebase by design —
  the model can't call it unless I asked, and even then it stops here."
- Click **Allow**. Show the merged PR on GitHub.

**Failure plan:**
- Token error → open Settings, paste the backup PAT (keep one in a local
  password manager entry titled `openui-demo-backup`), retry the same message.
- Repo already exists → say `use the repo openui-demo-landing-2` and continue.
- Network flake on merge → the PR is already open; merging by hand on
  github.com still demonstrates the human-gate story truthfully.

## 4. Safety talking points (have these loaded)

- Confirmation timeout: an unanswered Allow/Deny prompt **auto-denies** in
  2 minutes — the agent never hangs waiting, and denial is the safe default.
- One failed tool call can't take down the overlay: main-process tool errors
  are values, not exceptions; renderer panels are isolated by error
  boundaries with per-panel Retry.
- Local fine-tuning (if it comes up): adapts a small local model to the
  user's own workflows, versioned checkpoints, eval-gated promotion,
  auto-rollback. It personalises; it does **not** compete with frontier
  cloud models — don't claim otherwise.
- Coursework (if it comes up): OpenUI formats and compiles; it does not
  complete or submit coursework as a student's own work.

---

## 5. Dry-run checklist (×5 before the meeting)

Do the full Act I–III sequence five times. Log each run here; a run only
counts if it needed **zero improvisation**.

| # | Date | Acts passed | Failures seen | Fix applied |
|---|------|-------------|---------------|-------------|
| 1 |      |             |               |             |
| 2 |      |             |               |             |
| 3 |      |             |               |             |
| 4 |      |             |               |             |
| 5 |      |             |               |             |

Automated pre-demo smoke (run before every rehearsal AND the real thing):

```bash
npx tsc --noEmit && npx vitest run   # all green, ~30 s
npm run build                        # packaged main/preload/renderer compile
```

> Automated smoke baseline (2026-07-09): typecheck clean, `npm run build`
> green, and the full vitest suite run **5× consecutively** — 223 passed /
> 1 skipped on every run, zero flakes.

If any dry run hits the same failure twice, stop rehearsing and fix the
cause — do not script around a reproducible bug.
