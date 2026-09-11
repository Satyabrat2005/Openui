# Cutting v7.3.0 — runbook

Everything here is either done, or is a step only you can take. Written
2026-09-11 against `release/v7.3.0` (commit `5cb2685`).

---

## Done already

- **Release notes** for all 16 merged PRs written into `CHANGELOG.md`
  (14 of them had no entry). Includes a blunt *Known limitations* section.
- **`package.json` bumped to 7.3.0.** The workflow syncs this from the tag with
  `--allow-same-version`, so the bump is a no-op at build time — it just stops
  the committed version going stale the way 7.1.4 did.
- **Update channel audited.** No insecure feed override; default GitHub HTTPS;
  macOS correctly refuses to silently apply an unsigned update and diverts to
  the browser instead.
- **Release preflight checked.** It hard-fails only on `SUPABASE_URL` and
  `SUPABASE_ANON_KEY`, both of which are set. **A tag will not be rejected.**
  macOS signing is warn-not-fail, so an unsigned release still builds.

---

## Before you tag

### 1. Decide about payment — you currently cannot take money

`VITE_STRIPE_PRO_PRICE_ID` and `VITE_STRIPE_ENTERPRISE_PRICE_ID` are passed to
the build but are **not set as repository secrets**. The code degrades
gracefully rather than crashing:

```tsx
{tier.priceId && (<button onClick={() => window.openui.checkout(tier.priceId!)}>
```

No price ID means **the upgrade button never renders**. A user who hits a
Pro-gated tool is told they need Pro and then has no way to buy it.

- Shipping a **free beta**? Fine as-is — arguably better than a broken checkout.
- Want **revenue on day one**? Add both secrets at
  Settings → Secrets and variables → Actions, *before* tagging.

### 2. Decide about signing

Currently **zero signing secrets**. Consequences, stated plainly:

| platform | what a real user sees |
|---|---|
| Windows | SmartScreen warning; most users can click through |
| **macOS** | **"damaged and can't be opened"** — most users cannot get past this |

macOS needs five secrets (`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`) and an Apple Developer account
at $99/yr. The pipeline already consumes them and flips `OPENUI_MAC_SIGNED`
automatically — no code change needed when you have them.

**Recommendation: ship Windows-first as an unsigned beta.** Holding 16 PRs
hostage to a certificate purchase is the worse trade. Just be honest in the
download page that macOS is not yet usable for non-technical users.

---

## Tagging

```bash
git checkout main
git merge --ff-only release/v7.3.0     # after the PR is merged
git tag v7.3.0
git push origin v7.3.0
```

That triggers `.github/workflows/release.yml`, which syncs the version from the
tag, builds macOS + Windows, and publishes to GitHub Releases. Auto-update
reads the same feed.

## After the tag

1. **Watch the run.** `gh run watch` — the Windows and macOS jobs each retry up
   to 3 times before failing.
2. **Check the release body is not empty** and the download links resolve. Both
   were wrong on v7.2.0 and had to be fixed after the fact.
3. **Install the published artifact on a clean machine** — not the dev box.
4. **Connect one real account per channel** and run the acceptance path. This is
   the single largest untested area in the product: the Slack, Telegram, Gmail,
   Calendar, inbox and broadcast paths have only ever run against mocks.

---

## A local build failure you can ignore

Building the installer on this laptop fails at
`node-gyp rebuild hnswlib-node` with `C2666: 'Napi::Object::operator []':
overloaded functions have similar conversions`.

**This is a local MSVC toolchain issue, not a repo defect, and not a blocker.**
Proven by comparison: `hnswlib-node@3.0.0` and its nested
`node-addon-api@8.8.0` are pinned **identically at the `v7.2.0` tag**, which CI
built and shipped successfully on 2026-08-12. Nothing in the dependency graph
moved; the difference is the compiler on this machine versus the GitHub runner.

To package locally anyway, reuse an already-built addon and skip the rebuild:

```bash
cp -r ../Openui-main/node_modules/hnswlib-node/build node_modules/hnswlib-node/
npx electron-builder --win --publish never --config.npmRebuild=false
```

Two related traps, both hit during this work:

- `npm audit fix --omit=dev` **prunes devDependencies** from `node_modules` and
  breaks the local toolchain. `npm install` restores it.
- electron-builder's output is **heavily buffered**. A log that looks frozen at
  `searching for node modules` is usually working, not stalled — check whether
  `dist/win-unpacked/resources` is growing before killing anything.

## Build from the clean clone, never the working copy

`Downloads/Openui-main` carries a local-only `OPENUI_DEBUG_TOOLS` IPC handler
that runs **any tool at `tier: 'pro'` with `bypassHitl`**. It is absent from
`main` and from `v7.2.0`, and it must stay that way — packaging from the working
copy would ship a privilege escalation and a paid-tier bypass.
