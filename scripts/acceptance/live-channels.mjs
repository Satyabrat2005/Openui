/**
 * live-channels.mjs — does each channel actually work against a REAL account?
 *
 * WHY THIS EXISTS. Slack, Telegram, Gmail, Calendar, the unified inbox and
 * broadcast are the product, and every one of them has only ever run against a
 * mock. Pagination, rate-limit handling, token refresh and the 2000-member
 * ceiling have never touched a real workspace. That is the largest untested area
 * in OpenUI and no amount of unit testing closes it.
 *
 * WHY IT IS A SEPARATE HARNESS FROM THE APP. "Does our Slack pagination work"
 * and "does the model route the request to Slack" are two different questions,
 * and answering them together is how you get a useless result — a failure tells
 * you nothing about which half broke. This drives the channel modules DIRECTLY,
 * with no model in the loop. Routing is covered by toolGroups.test.ts; the app
 * end-to-end is the manual runbook's job.
 *
 * WHY IT RUNS UNDER PLAIN NODE. Every channel module resolves its credential
 * from the environment as well as from the database, and the database read is
 * lazy-required inside a try/catch — so with tokens in the environment these
 * modules work with no Electron, no better-sqlite3 and no app profile. That is
 * what makes this runnable in a terminal and in CI.
 *
 * READS ONLY, BY DEFAULT. Nothing here sends a message, writes a calendar event
 * or marks anything read unless you pass --send with an explicit destination.
 * A verification script that messages real people as a side effect of being run
 * is a script nobody should run twice.
 *
 * THE FLAG IS REQUIRED. `--experimental-strip-types` lets Node import the app's
 * own .ts modules directly, so this harness tests the SAME source the app ships
 * rather than a compiled copy that can drift from it. Node 22.6+ only, and it is
 * type-stripping rather than compilation — which is fine here because these
 * modules carry annotations and nothing that needs emit.
 *
 *   # what is configured, and does each read path work
 *   node --experimental-strip-types scripts/acceptance/live-channels.mjs
 *
 *   # also send ONE message to a destination you name (asks nothing, sends once)
 *   node --experimental-strip-types scripts/acceptance/live-channels.mjs \
 *     --send --slack-channel "#bot-test"
 *
 * Credentials, via environment only (never passed as arguments — arguments show
 * up in shell history and in the process list):
 *   SLACK_TOKEN
 *   TELEGRAM_BOT_TOKEN
 *   GOOGLE_OAUTH_CLIENT_ID  GOOGLE_OAUTH_CLIENT_SECRET
 *   GMAIL_REFRESH_TOKEN
 *   GOOGLE_CALENDAR_REFRESH_TOKEN
 *
 * TRAP worth knowing before you start: the precedence is NOT the same for every
 * channel. Slack and Gmail read the environment FIRST and the pasted Settings
 * value second; Telegram reads Settings first. So a stale SLACK_TOKEN left in a
 * shell will silently shadow a token freshly pasted into the app, while the same
 * mistake with Telegram will not. If a channel behaves as though your new token
 * did not take, check the environment before you check the code.
 */
// Fail with the fix rather than a stack trace: without the flag, the first
// `import('…/slack.ts')` throws ERR_UNKNOWN_FILE_EXTENSION from deep inside the
// loader, which says nothing about what to do.
if (!process.execArgv.some((a) => a.includes('strip-types')) && !process.env.NODE_OPTIONS?.includes('strip-types')) {
  console.error(
    'This harness imports the app\'s TypeScript directly. Re-run it as:\n\n' +
      '  node --experimental-strip-types scripts/acceptance/live-channels.mjs\n'
  )
  process.exit(2)
}

// The app is bundled, so its source uses extensionless relative imports that
// Node's ESM loader will not resolve. See ts-resolve-hook.mjs.
const { register } = await import('node:module')
// import.meta.url is ALREADY a file: URL — passing it through pathToFileURL
// double-wraps it into file:///…/file:/C:/… and the hook silently fails to load.
register('./ts-resolve-hook.mjs', import.meta.url)

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const opt = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

const DO_SEND = flag('--send')
const SLACK_CHANNEL = opt('--slack-channel')
const TELEGRAM_CHAT = opt('--telegram-chat')

const results = []
const record = (channel, step, ok, detail) => {
  results.push({ channel, step, ok, detail })
  const mark = ok === null ? 'SKIP' : ok ? 'PASS' : 'FAIL'
  console.log(`  [${mark}] ${channel} — ${step}${detail ? ': ' + detail : ''}`)
}

/**
 * Describe a credential without ever printing it.
 *
 * A verification log gets pasted into issues and chat windows, so it must be
 * safe to share. Length and a four-character tail are enough to tell two tokens
 * apart and to spot an obviously truncated paste.
 */
const shape = (v) => (!v ? 'absent' : `present (${v.length} chars, ends …${v.slice(-4)})`)

async function main() {
  console.log('\nLIVE CHANNEL ACCEPTANCE')
  console.log(`mode   : ${DO_SEND ? 'READ + SEND (will send real messages)' : 'READ ONLY'}`)
  console.log(`started: ${new Date().toISOString()}\n`)

  console.log('credentials in the environment:')
  for (const k of [
    'SLACK_TOKEN',
    'TELEGRAM_BOT_TOKEN',
    'GOOGLE_OAUTH_CLIENT_ID',
    'GOOGLE_OAUTH_CLIENT_SECRET',
    'GMAIL_REFRESH_TOKEN',
    'GOOGLE_CALENDAR_REFRESH_TOKEN'
  ]) {
    console.log(`  ${k.padEnd(30)} ${shape(process.env[k])}`)
  }
  console.log('')

  await checkSlack()
  await checkTelegram()
  await checkGmail()
  await checkCalendar()

  const failed = results.filter((r) => r.ok === false)
  const skipped = results.filter((r) => r.ok === null)
  const passed = results.filter((r) => r.ok === true)

  console.log(`\n=== ${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped ===`)
  if (skipped.length) {
    console.log('\nNOT VERIFIED (no credential — this is not a pass):')
    for (const s of skipped) console.log(`  - ${s.channel}: ${s.step}`)
  }
  if (failed.length) {
    console.log('\nFAILURES:')
    for (const f of failed) console.log(`  - ${f.channel} / ${f.step}: ${f.detail ?? ''}`)
  }
  // A run where everything was SKIPPED must not look like success — that is
  // exactly the vacuous green this project has been caught by before. A run
  // with failures is not vacuous: it tested something and found it broken, and
  // must exit 1 so the distinction survives into CI.
  if (passed.length === 0 && failed.length === 0) {
    console.log('\nNOTHING WAS ACTUALLY TESTED. Set at least one credential above.')
    process.exit(2)
  }
  process.exit(failed.length ? 1 : 0)
}

async function checkSlack() {
  const mod = await import('../../src/main/slack.ts')
  if (!mod.getSlackToken()) {
    record('slack', 'read inbox', null, 'no SLACK_TOKEN')
    return
  }
  try {
    const r = await mod.readSlackInbox({ limit: 5 })

    // CHECK ok FIRST. A first draft of this harness read only channelsRead.length
    // and scored an invalid_auth response as a PASS with "0 channels read" —
    // precisely the vacuous green it exists to prevent, and a good reminder that
    // a probe reporting success on a bad credential is worse than no probe.
    // readSlackInbox itself is correct here: it returns ok:false rather than an
    // empty inbox, and it deliberately refuses to present an all-channels-failed
    // read as a quiet workspace (#171).
    if (r?.ok === false) {
      record('slack', 'read inbox', false, String(r.error).slice(0, 200))
      return
    }

    // The interesting part is NOT "did it return" — it is whether each channel
    // reported its own status honestly. A throttled channel used to vanish from
    // the result entirely, which looked identical to a quiet workspace (#171).
    const read = r?.channelsRead?.length ?? 0
    const skippedCh = r?.skipped?.length ?? 0
    record('slack', 'read inbox', true, `${read} channels read, ${skippedCh} skipped, truncated=${r?.truncated}`)
    if (skippedCh) {
      console.log(`         skipped with reasons: ${JSON.stringify(r.skipped).slice(0, 200)}`)
    }
    // The 2000-member ceiling is a real documented limit; say whether this
    // workspace is near it rather than discovering it in production.
    if (typeof r?.memberCount === 'number') {
      record('slack', 'member map within the 2000 ceiling', r.memberCount < 2000, `${r.memberCount} members`)
    }
  } catch (err) {
    record('slack', 'read inbox', false, String(err).slice(0, 200))
  }

  if (DO_SEND && SLACK_CHANNEL) {
    try {
      const r = await mod.sendSlackMessage?.({
        channel: SLACK_CHANNEL,
        text: `OpenUI acceptance check ${new Date().toISOString()}`
      })
      record('slack', `send to ${SLACK_CHANNEL}`, r?.ok !== false, JSON.stringify(r ?? {}).slice(0, 160))
    } catch (err) {
      record('slack', `send to ${SLACK_CHANNEL}`, false, String(err).slice(0, 200))
    }
  } else if (DO_SEND) {
    record('slack', 'send', null, 'pass --slack-channel to send')
  }
}

async function checkTelegram() {
  const mod = await import('../../src/main/telegram.ts')
  if (!mod.getTelegramToken()) {
    record('telegram', 'list chats', null, 'no TELEGRAM_BOT_TOKEN')
    return
  }
  try {
    const r = await mod.list_telegram_chats()
    record('telegram', 'list chats', r?.ok !== false, String(r?.output ?? r?.error ?? '').slice(0, 200))
  } catch (err) {
    record('telegram', 'list chats', false, String(err).slice(0, 200))
  }

  try {
    // getUpdates has a tail bug history (#166): a long-polling consumer can eat
    // its own updates. Reading twice in a row is what exposes it — the second
    // read going empty when the first was not is the signature.
    const a = await mod.readTelegramInbox({ limit: 5 })
    const b = await mod.readTelegramInbox({ limit: 5 })
    const aN = a?.messages?.length ?? 0
    const bN = b?.messages?.length ?? 0
    record(
      'telegram',
      'two consecutive reads agree (getUpdates tail)',
      !(aN > 0 && bN === 0),
      `first=${aN} second=${bN}`
    )
  } catch (err) {
    record('telegram', 'two consecutive reads agree (getUpdates tail)', false, String(err).slice(0, 200))
  }

  if (DO_SEND && TELEGRAM_CHAT) {
    try {
      const r = await mod.send_telegram_message?.({
        chat_id: TELEGRAM_CHAT,
        message: `OpenUI acceptance check ${new Date().toISOString()}`
      })
      record('telegram', `send to ${TELEGRAM_CHAT}`, r?.ok !== false, JSON.stringify(r ?? {}).slice(0, 160))
    } catch (err) {
      record('telegram', `send to ${TELEGRAM_CHAT}`, false, String(err).slice(0, 200))
    }
  } else if (DO_SEND) {
    record('telegram', 'send', null, 'pass --telegram-chat to send')
  }
}

async function checkGmail() {
  const mod = await import('../../src/main/gmail.ts')
  if (!process.env.GMAIL_REFRESH_TOKEN || !process.env.GOOGLE_OAUTH_CLIENT_ID) {
    record('gmail', 'find a thread', null, 'no GMAIL_REFRESH_TOKEN / GOOGLE_OAUTH_CLIENT_ID')
    return
  }
  try {
    // A refresh-token exchange is the thing most likely to be quietly broken —
    // it is the only part that cannot be exercised without a real account.
    const r = await mod.findEmailThread('', 3)
    record('gmail', 'refresh token exchange + find a thread', r?.ok !== false, String(r?.error ?? 'ok').slice(0, 200))
  } catch (err) {
    record('gmail', 'refresh token exchange + find a thread', false, String(err).slice(0, 200))
  }
}

async function checkCalendar() {
  const mod = await import('../../src/main/googleCalendar.ts')
  if (!process.env.GOOGLE_CALENDAR_REFRESH_TOKEN || !process.env.GOOGLE_OAUTH_CLIENT_ID) {
    record('calendar', "list today's events", null, 'no GOOGLE_CALENDAR_REFRESH_TOKEN / client id')
    return
  }
  try {
    const r = await mod.googleListToday()
    record('calendar', "list today's events", r?.ok !== false, String(r?.error ?? 'ok').slice(0, 200))
  } catch (err) {
    record('calendar', "list today's events", false, String(err).slice(0, 200))
  }
}

main().catch((err) => {
  console.error('fatal:', err)
  process.exit(1)
})
