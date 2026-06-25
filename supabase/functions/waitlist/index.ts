// waitlist — Supabase Edge Function (Deno runtime).
//
// Server-side proxy for the website's "Join the waitlist" form. The browser
// posts only an email here; this function calls the Mailchimp API with the
// secret key so the key is NEVER shipped to the frontend.
//
// ── Required secrets (set on the Supabase project, NOT in the app's .env) ─────
//   MAILCHIMP_API_KEY       Mailchimp Dashboard → Account → Extras → API keys →
//                           "Create A Key". Looks like "abc123...-us1".
//   MAILCHIMP_SERVER_PREFIX  The data-centre prefix visible in your Mailchimp
//                           dashboard URL (e.g. "us1", "us2", "us21"). It's also
//                           the suffix after the dash in the API key.
//   MAILCHIMP_LIST_ID       Audience → Settings → "Unique ID for this audience".
//
//   supabase secrets set \
//     MAILCHIMP_API_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx-us1 \
//     MAILCHIMP_SERVER_PREFIX=us1 \
//     MAILCHIMP_LIST_ID=xxxxxxxxxx
//
// Deploy (the form is anonymous, so JWT verification must be off):
//   supabase functions deploy waitlist --no-verify-jwt
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'

const MAILCHIMP_API_KEY = Deno.env.get('MAILCHIMP_API_KEY')
const MAILCHIMP_SERVER_PREFIX = Deno.env.get('MAILCHIMP_SERVER_PREFIX') // e.g., "us1"
const MAILCHIMP_LIST_ID = Deno.env.get('MAILCHIMP_LIST_ID')

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
  })
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS })
  }

  // Fail loudly (in the logs) if the function was deployed without its secrets,
  // rather than sending Mailchimp a malformed request.
  if (!MAILCHIMP_API_KEY || !MAILCHIMP_SERVER_PREFIX || !MAILCHIMP_LIST_ID) {
    console.error('Waitlist misconfigured — missing Mailchimp secrets.')
    return json({ error: 'not_configured' }, 500)
  }

  try {
    const { email } = await req.json()

    // Validate email
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({ error: 'invalid_email' }, 400)
    }

    // Call Mailchimp API
    const mailchimpUrl = `https://${MAILCHIMP_SERVER_PREFIX}.api.mailchimp.com/3.0/lists/${MAILCHIMP_LIST_ID}/members`

    const mcResponse = await fetch(mailchimpUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `apikey ${MAILCHIMP_API_KEY}`
      },
      body: JSON.stringify({
        email_address: email.toLowerCase().trim(),
        status: 'subscribed',
        tags: ['openui-waitlist', 'website-signup'],
        merge_fields: {
          SOURCE: 'website',
          SIGNEDUP: new Date().toISOString().split('T')[0]
        }
      })
    })

    const mcData = await mcResponse.json()

    if (mcResponse.status === 400 && mcData.title === 'Member Exists') {
      return json({ error: 'already_subscribed' }, 200)
    }

    if (!mcResponse.ok) {
      console.error('Mailchimp error:', mcData)
      return json({ error: 'mailchimp_error' }, 500)
    }

    return json({ success: true }, 200)
  } catch (error) {
    console.error('Waitlist error:', error)
    return json({ error: 'internal_error' }, 500)
  }
})
