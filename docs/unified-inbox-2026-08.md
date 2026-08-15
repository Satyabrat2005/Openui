# Unified inbox — cross-channel summary and follow-up (2026-08)

What shipped, what is actually verified, and what is not. Discord was explicitly
out of scope for this phase and no part of it was touched.

## What was built

Three layers, in dependency order. The first is the reason the other two work.

### 1. Contact identity (`src/main/contacts.ts`, migration `003_contacts`)

One canonical person, many per-channel handles:

| Channel  | What identifies a person | Carries their name? |
|----------|--------------------------|---------------------|
| WhatsApp | chat name (`Ashu`)       | yes                 |
| Slack    | user id (`U024BE7LH`)    | yes, via `users.list` |
| Telegram | numeric chat_id (`123456789`) | **no** |
| Gmail    | email address            | **no** |

The rule is deliberately asymmetric:

- **WhatsApp and Slack** resolve by display name with no setup, because their own
  listings carry the name. `handleForChannel` falls back to the contact's display
  name for exactly these two.
- **Telegram and Gmail** require an explicit one-time link ("this Telegram chat is
  Ashu"), and there is **no fallback**. A chat_id of "Ashu" is not merely useless,
  it is actively misleading: it reads an imaginary chat and reports nothing found,
  which is indistinguishable from "he hasn't messaged you".

Ambiguity is a distinct outcome, not a tie-break. Two people called "Ashu" returns
`ambiguous` and the caller asks. `UNIQUE(channel, handle_key)` means one handle has
at most one owner, so a re-link is a move rather than a second claimant.

Tools: `link_contact`, `list_contacts`, `unlink_contact`. Local database only —
**not** behind the feature gate below, and not HITL-gated (writing down a name the
user just said is not a state change worth a confirmation dialog).

### 2. `summarize_inbox` (`src/main/inboxSummary.ts`)

Read-only. Calls the read paths the four channel modules already own — the same
`getUpdates`, `conversations.history`, Gmail search and WhatsApp OCR — and returns
**structured JSON**, not prose. The model composes the summary from it.

Three structured readers were added alongside the existing formatted ones, rather
than re-parsing human-readable tool output that would break silently the first time
its wording changed:

- `telegram.ts → readTelegramInbox()` — same non-destructive tail read.
- `slack.ts → readSlackInbox()` — member channels (capped at 5, 10 messages each),
  plus a `users.list` lookup that maps user ids to display names. That lookup is
  what makes Slack a name-bearing channel; it degrades to raw ids if the token
  lacks `users:read`.
- `gmail.ts → findEmailThread(query, maxResults)` — now also returns `from` and
  `snippet`, which the summary needs and a reply-to-thread lookup did not.

Every channel reports its own status: `ok`, `not_connected`, `no_handle`, `error`,
`not_requested`. `no_handle` only exists because of layer 1 — the channel works
fine, this person just has no handle on it — and it is reported with "this is NOT
evidence they sent nothing". A channel that failed must never contribute silence
that reads as an answer. WhatsApp is additionally marked `confidence:
"best-effort"` because its read is OCR.

### 3. `send_summary_email` (`src/main/inboxSummary.ts`)

In `STATE_CHANGING_TOOLS` **and** `DESTRUCTIVE_TOOLS`, exactly like `send_email`:
one confirmation per call, never auto-run under any autonomy mode. The
confirmation dialog shows the resolved recipient, the subject and the opening of
the body.

It never invents a recipient. An email address passes through; a contact name
resolves through layer 1; a known person with **no linked address** returns a
refusal that says to ask the user which address to use. There is deliberately no
"use the only address we know" fallback — a test asserts the refusal text does not
even contain the other contact's address.

## What is verified, and how

Full suite **1757 passing / 92 files**, typecheck clean, lint clean, `npm run
build` succeeds. 69 new tests (28 identity, 33 summary/send, 8 routing).

Non-vacuity was proven by **mutation** — each rule was inverted and the right
tests went red:

| Mutation | Result |
|---|---|
| `NAME_BEARING_CHANNELS` widened to all four channels (i.e. guess a Telegram id from a name) | 8 red, including "cannot see the message before the link" and both refusal tests |
| `isUnifiedInboxEnabled` defaults on | exactly the 3 gate tests red |
| `resolveRecipient` falls back to any known email | exactly the 2 "never guess a recipient" tests red |

Both files were diffed against pre-mutation copies afterwards and are byte-identical.

The load-bearing test is `contacts.test.ts → the Telegram gap`: one real
getUpdates-shaped message, one query, failing to match before the link and matching
after, with nothing else changed between the two halves. `inboxSummary.test.ts`
repeats it end-to-end across four channels.

**A real bug the tests caught:** the Telegram handle validator accepted a bare
`Ashu` as a chat id, because the `@username` pattern made the `@` optional —
precisely the mistake the validation exists to catch, since the link would store
fine and then silently match nothing forever. `telegram.ts`'s own `isValidChatId`
requires the `@`; the validator now does too.

**A real routing gap the tests caught:** the trigger for teaching an identity was
verb-shaped (`link this chat…`), so the phrasing the feature is actually specified
with — "the telegram chat 123456789 is Ashu" — matched nothing and loaded the wrong
surface. Identity-teaching is phrased as a *statement*, not a command; the trigger
now covers `… belongs to …` and `<chat|handle|id|email> … is …`.

## What is NOT verified

**No channel read has ever run against a real account in this environment.** There
is no Slack workspace, no Telegram bot token, no Gmail OAuth grant and no
signed-in WhatsApp here. Specifically unproven against live services:

- `readSlackInbox` — the `users.list` name mapping, the member-channel filter, and
  the per-channel history calls, including behaviour under Slack's tier-2 rate
  limits on a workspace with many channels.
- `readTelegramInbox` — the getUpdates tail read is the same call the existing
  (also live-unverified) read tools make.
- The Gmail queries `is:unread newer_than:7d` and `from:<addr> newer_than:30d`,
  and whether `snippet` is populated as expected on a metadata-format fetch.
- `send_summary_email`'s actual delivery. The send path is stubbed in tests; the
  MIME/API layer underneath it is `sendGmailMessage`, which is shared with
  `send_email` and equally live-unverified.
- The WhatsApp person-scoped read reuses `readWhatsAppChatText`, whose OCR
  imprecision is already documented in `docs/post-v7.2.0-fixes-2026-08.md`.
- The **Settings toggle itself was not exercised in a running app.** It is a
  verbatim copy of the adjacent "Local calendar automation" row's pattern and it
  typechecks and builds, but nobody clicked it here.

## The gate

Because of the above, the whole read-and-send surface ships **off by default**,
the same treatment `local_calendar_backend_enabled` got and for the same reason:
"thoroughly tested against fakes" is not "known to work", and the failure modes
here are reading the wrong person's messages into a summary or mailing a private
summary to the wrong address.

- Setting: `unified_inbox_enabled`, absent/undefined ⇒ **false**.
- UI: Settings → "Unified inbox", next to the calendar toggle.
- Gated: `summarize_inbox`, `send_summary_email`. The gate is the **first**
  statement in both, before any channel is touched — a test asserts no reader is
  called at all while it is off. (The calendar gate shipped once with the check
  placed after an unconditional platform return and was dead code on macOS; the
  lesson was to put a cross-cutting gate above every branch, not merely before the
  one you happen to be reading.)
- **Not** gated: `link_contact` / `list_contacts` / `unlink_contact`. They only
  write to the local database, they are fully covered by tests, and teaching the
  app who your contacts are is useful with the rest switched off.

## Answers to the three questions asked

- **Which channels the summary reliably pulls from:** all four, structurally —
  and each one reports its own status, so an unavailable channel is visible rather
  than silent. Reliability against live accounts is unproven for all four (above).
- **Does identity linking work across all of them:** yes for all four, but
  asymmetrically by design. WhatsApp and Slack need no link; Telegram and Gmail
  require one and refuse to guess without it. Slack's name matching depends on
  `users:read`; without that scope it needs an explicit user-id link like Telegram.
- **Is the email-out action properly gated:** yes — HITL-confirmed per call, in
  `DESTRUCTIVE_TOOLS` so no autonomy mode can auto-run it, behind the off-by-
  default feature gate, and it refuses rather than guesses when the recipient
  cannot be resolved to a known address.
