# Phase 6 — real use

Written 2026-09-12, after Phase 5 Step 1 shipped
([#183](https://github.com/Satyabrat2005/Openui/pull/183), merged).

Everything up to here has been engineering. This phase is the opposite: it is
about the two things no amount of further engineering can produce — **a release
users can install**, and **evidence the product works against a real account**.

---

## Where the project actually is

| | |
|---|---|
| Cross-channel texting agent, code complete | ✅ 1936 tests green |
| Packaged installer verified | ✅ 8/8 on a fresh profile |
| Credentials encrypted at rest | ✅ shipped |
| Coding surface removed | ✅ #183 merged |
| Usage limits + usage record | ✅ #182 merged |
| **Tagged so a user can install it** | ❌ latest release is **v7.2.0, 12 Aug** |
| **Ever run against a real account** | ❌ **zero channels** |
| Can accept payment | ❌ no Stripe price-id secrets |
| Installable on macOS | ❌ unsigned |

Twenty PRs have merged since the last release. **Users have seen none of them.**

---

## Step 1 — Tag v7.3.0 (owner, ~1 minute)

```bash
git checkout main && git pull
git tag v7.3.0 && git push origin v7.3.0
```

Nothing blocks this. `main` is green on three OSes, the packaged build was
smoke-tested on a clean profile, and the release preflight hard-fails only on
the two Supabase secrets, which are set. Detail in
`docs/RELEASE-v7.3.0-RUNBOOK.md`.

Ship **Windows-first, as an unsigned beta**. macOS stays unusable for
non-technical users until there is a signing certificate, and holding twenty
merged PRs hostage to a $99/yr purchase is the worse trade — just be honest
about it on the download page.

## Step 2 — Prove the channels work (the real gap)

**This is the whole phase.** Slack, Telegram, Gmail, Calendar, the unified
inbox and broadcast are the product, and every one of them has only ever run
against a mock. Pagination, rate-limit handling, token refresh and the
2000-member ceiling have never touched a real workspace.

### 2a. The integration probe — built, runs today

`scripts/acceptance/live-channels.mjs` drives the channel modules **directly**,
with no model in the loop:

```bash
node --experimental-strip-types scripts/acceptance/live-channels.mjs
```

Two questions — *"does our Slack pagination work"* and *"does the model route
this to Slack"* — are separated on purpose, because answering them together
means a failure tells you nothing about which half broke. Routing is already
covered by `toolGroups.test.ts`.

It reads only. Sends require `--send` **and** an explicit destination, because a
verification script that messages real people as a side effect is one nobody
runs twice.

Its exit codes are distinct, which matters more than it sounds:

| exit | meaning |
|---|---|
| 0 | something was really tested and passed |
| 1 | something was really tested and **failed** |
| 2 | **nothing was tested** — no credentials |

That last one exists because a probe with no credentials otherwise prints all
green, and this project has been caught by a vacuous pass before. It was worth
having: a first draft of the harness scored an `invalid_auth` Slack response as
a **PASS** with "0 channels read", and only a deliberate bad-token run exposed
it. `readSlackInbox` was right; the harness was wrong.

### 2b. What you have to supply

One real account per channel. Nothing else unblocks this.

| channel | what is needed | how long |
|---|---|---|
| Telegram | a bot token from @BotFather | 2 min |
| Slack | a bot token in any workspace (a scratch one is fine) | 10 min |
| Gmail | OAuth client + refresh token | 20 min |
| Calendar | same client, its own refresh token | 5 min |

Start with **Telegram and Slack** — they are the cheapest and they exercise the
two code paths with known historical bugs (the `getUpdates` tail, and Slack's
cursor pagination past the first 200 members).

### 2c. Then the app end to end

With credentials in place, run the same requests through the real app — the
probe proves the API calls work, not that the product does:

1. "summarise my inbox" across two connected channels
2. "is there anything from <person>" — cross-channel identity resolution
3. "tell <person> I'm running late" — a send, through the confirmation gate
4. "tell everyone I'm late" — must **ask who**, never resolve recipients itself
5. an unlinked Telegram/Gmail contact — must **ask**, never invent an address

Cases 4 and 5 matter most. They are the ones where a wrong answer messages the
wrong person, and they have only ever been checked against mocks.

## Step 3 — Fix what the pilot finds, then re-tag

Expect real findings here; that is the point of the step. Budget for a v7.3.1.

## Step 4 — Decide on money and signing

Neither is code, and both are yours:

- **Stripe price-id secrets.** Without them the upgrade button never renders, so
  a user who hits a Pro gate has no way to buy. Fine for a free beta, fatal if
  v7.3.0 is meant to earn.
- **Code signing.** Windows SmartScreen is survivable; macOS *"damaged and can't
  be opened"* is not. Apple Developer is $99/yr and the pipeline already
  consumes the five secrets — no code change when you have them.

---

## Explicitly not in this phase

The model work. It is real and it is planned in `docs/PHASE-5-PLAN.md` —
app-private encrypted storage, the licence endpoint, and a retrain on an
Apache-2.0 base — but it is a **differentiator, not a prerequisite**, and the
privacy promise does not depend on the weights being ours. A stock local model
is exactly as private.

Two reasons to keep it out of the critical path:

1. `openui-splen:v2` cannot ship regardless — its base is under a
   **non-commercial** licence, on top of the safety gate it already failed.
2. The last retrain failed. Budget for that happening again, and do not let a
   release wait on it.

The thing most likely to hurt this product is not a missing custom model. It is
shipping a messaging agent whose messaging has never touched a real inbox.
