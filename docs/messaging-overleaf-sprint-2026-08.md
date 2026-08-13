# Messaging surfaces + Overleaf — sprint report (2026-08)

Scope: WhatsApp, Telegram, Slack, a new Overleaf/LaTeX browser capability, and
the outstanding Figma/Calendar gaps.

**Headline: 3 of 5 surfaces are solid on code and measurement, none of the four
credential-gated surfaces got a live end-to-end run, because this environment has
no Slack/Telegram/Figma/Google credentials and no Overleaf session.** That is
stated per-surface below rather than smoothed over. Every "verified" claim here
names the thing that was actually observed.

Suite at end of sprint: **1623 passing / 87 files**, typecheck clean, lint clean,
`npm run build` succeeds.

---

## Scoring

| Surface | Verdict | What that means |
| --- | --- | --- |
| WhatsApp | **Solid** | Bug fixed and measured on a busy screen with a sentinel + vacuity control |
| Telegram | **Rough but real** | Real API, real bug found and fixed, guarded by non-vacuous tests; no live round-trip |
| Slack | **Rough but real** | Same; no live post/read |
| Overleaf | **Rough but real (prototype)** | Login/refusal path verified against the live site; the typing path is **unverified** |
| Figma | **Not there** | Still never run with a real token |
| Calendar | **Rough but real** | Backend fix confirmed merged; two further real bugs fixed in the Google path |

---

## WhatsApp — solid

The window-scoped capture fix is present in this working copy
(`captureWhatsAppWindowPng`, tools.ts) and its verification methodology is the
right one: a **deliberately busy screen**, an always-on-top window moving every
5s carrying a sentinel token, plus a **vacuity control** proving the crop was not
simply blank. Whole screen 617 spurious sender candidates / sentinel accepted 18
times; WhatsApp chat-list column 10 / **sentinel 0**.

The read path also carries the wrong-chat guard: `readWhatsAppChatText` resolves
the contact through `resolveWhatsAppContact` (verify-before-selecting) instead of
typing into search and blindly pressing Down+Enter. Confirmed in code, not just
in the doc. 37 tests pass.

**Not done:** the two-phone live draft test. No second phone here. This is the
one open item and it is the difference between "solid" and "proven end to end".

---

## Telegram — rough but real

Audited against the official Bot API. It was already in good shape (real Bot API,
strict token regex that blocks path injection, non-destructive reads). Three real
findings, all fixed:

1. **`getUpdates` returned the OLDEST updates, not the newest.** The spec: with no
   offset, getUpdates returns "updates starting with the earliest unconfirmed
   update". Both read tools promise *recent* activity, so on a bot with a queue
   longer than 100 they returned stale data and could not see the message just
   sent. Fixed with a negative offset (`offset: -100`), the documented way to read
   the tail, which is still non-destructive. **This is the one that would have
   broken a live demo** — it reads correct on an idle bot and wrong on an active one.
2. **No request timeout.** A dead socket left the promise pending forever and hung
   the agent loop with nothing to report. Now 20s, failing loudly.
3. **No conversation threading.** Added `reply_to_message_id` → `reply_parameters`
   (Telegram deprecated the flat field), and `read_telegram_messages` now prints
   message ids — without them there was no way to obtain one, so the model could
   read a thread but never reply into it.

35 tests. The offset guard was proven non-vacuous: reverting the fix fails
exactly those 3 tests.

**Not done:** live send/receive round-trip. Needs a BotFather token (~2 minutes to
create; see the demo script).

---

## Slack — rough but real

Audited against the Slack Web API. Also already decent (Bearer header not URL,
sensible scope errors, `send_slack_message` correctly in
`STATE_CHANGING_TOOLS` + `DESTRUCTIVE_TOOLS`). Two real findings, fixed:

1. **`conversations.list` was not paginated.** It is cursor-paginated and does not
   promise to return `limit` results in one page, so a channel on page 2 resolved
   to *"no channel named #x found"* — a confidently wrong answer that sends the
   user hunting for a typo that is not there, and blocks posting to a channel that
   genuinely exists. Now follows `next_cursor`, capped at 10 pages, and when the
   cap is hit it says **"I ran out of pages"** rather than "it does not exist".
2. **No request timeout** — same fix as Telegram.

11 tests, pagination guard proven non-vacuous.

**Not done:** live post to a real test channel and read-back. Needs a workspace token.

---

## Overleaf — rough but real (prototype)

New capability, built **on** the existing CDP stack rather than beside it:
`connect_browser` already attaches to the user's real Chrome profile, so their
Overleaf session is simply already there. Four tools: `overleaf_open_project`,
`overleaf_write_latex`, `overleaf_read_latex`, `overleaf_recompile`.

### The safety boundary

- **No login tool exists.** No sign-in path, no password argument, no
  "log in for the user" fallback. If the session is not authenticated every tool
  stops and tells the user to log in themselves. The refusal text explicitly tells
  the model *not* to go hunting for a password field.
- **No share / publish / submit tool exists at all.** Not gated — absent. A gate
  can be approved by a user who did not read the prompt; a tool that does not
  exist cannot be reached. There is a test asserting no such tool appears, so it
  cannot be quietly widened later.
- `overleaf_write_latex` and `overleaf_recompile` are in `STATE_CHANGING_TOOLS`,
  so both always confirm before running.

### What was actually verified against the real site

Checked live on www.overleaf.com while logged out, and it found a genuine trap:

- `meta[name="ol-user_id"]` **is present on the logged-out login page**, with a
  null content attribute; `ol-usersEmail` is present with `content=""`. **Testing
  that the tag exists reports "logged in" on the login page** — the flow would
  march on into an editor that is not there.
- Requesting `/project` while logged out redirects to `/login?` (observed).

So login detection requires a **non-empty** user meta **and** a non-auth URL —
both, not either. That is grounded in observation, not assumption, and there is a
regression test pinning the exact logged-out signature.

### The honest gap

**The typing path has not been run against a real Overleaf project.** No account
or session is available here. `overleaf_write_latex` targets CodeMirror 6's own
public DOM contract (`.cm-content`) rather than Overleaf's build-generated class
names, and uses `keyboard.insertText()` (which dispatches the `beforeinput` event
CM6 listens on) rather than `fill()`, which does not drive a contenteditable —
those are deliberate robustness choices, but they are **reasoned, not measured**.

Per the sprint's own rule — *a flaky new capability is worse for a pitch than
three solid ones* — **Overleaf should not be the centrepiece of the demo** until
someone runs it against a real project. What *is* demoable today is its refusal
path, which is genuinely verified (see below).

25 tests.

---

## Figma — not there

Still never exercised with a real token, and none is available here. Nothing
changed this sprint. Saying so plainly rather than claiming it works.

## Calendar — rough but real

The backend-selection fix **is merged** in this copy: the `!hasLocalCalendar`
clause at tools.ts:2366 means a plain "schedule a meeting tomorrow at 3pm" on a
Windows box with no desktop Outlook now uses Google instead of dying on
`REGDB_E_CLASSNOTREG`.

Re-verifying the never-exercised Google path found two more real bugs, both fixed:

1. **A rejected access token was never evicted.** `cachedToken` only refreshes at
   its nominal expiry, so a token Google rejected early (revoked, password change,
   scope change) poisoned every later call — the calendar stayed broken until the
   app restarted. Now retries once on a 401 with a fresh token, capped at one so a
   genuinely dead credential surfaces as an error instead of looping.
2. **No request timeout and no response-stream error handler** — either could
   leave `control_calendar` pending forever.

13 tests; the 401-recovery guard proven non-vacuous.

**Not done:** live Google Calendar create/list. Needs OAuth credentials.

---

## Demo script — built from what is real

Ordered strongest-first. Items 1–2 need no setup; 3–4 need a token you can make
in a couple of minutes.

**1. WhatsApp draft detection (strongest — this one is measured).**
Show the busy-screen A/B from `docs/post-v7.2.0-fixes-2026-08.md`: whole-screen
capture accepted a sentinel token from an unrelated window as a WhatsApp sender
18 times; window-scoped accepted it **zero** times. The story is *"we found our
own verification was wrong, and re-ran it against a screen that could actually
expose the bug."* That lands better with an engineering audience than a feature tour.

**2. Overleaf safety boundary (no account needed — demo the refusal).**
With the browser connected but not signed in to Overleaf, ask it to write a
document into an Overleaf project. It stops and says it will not sign in on the
user's behalf. Then show that there is **no** share/publish/submit tool in the
surface at all. This demos judgment, and it is fully verified today.
*Do not* demo live typing into a project unless you have first run it yourself
against a real project — that path is unverified.

**3. Telegram round-trip.** Create a bot with @BotFather, paste the token into
Settings → Telegram, message the bot from your own account, then have OpenUI list
chats, read the thread, and reply **in-thread**. Threading is new this sprint.

**4. Slack post + read-back.** Bot token with `chat:write`, `channels:read`,
`channels:history`; invite it to a test channel; post and read back.

**Not in the demo:** Figma (no token, never verified), Google Calendar live
(no credentials), Overleaf live typing (unverified).

---

## Open items, in priority order

1. Two-phone WhatsApp draft-path test — the last gap on the strongest surface.
2. Run Overleaf `write_latex` against a real project; confirm nothing
   auto-compiles or auto-submits. Until then it stays a prototype.
3. Figma with a real token.
4. Google Calendar create/list with real OAuth credentials.
