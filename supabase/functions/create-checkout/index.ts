// create-checkout — Supabase Edge Function (Deno runtime).
//
// Creates a Stripe Checkout Session for a subscription and returns its hosted
// URL. This is where the Stripe SECRET key lives — never in the Electron app.
//
// Deploy:  supabase functions deploy create-checkout
// Secrets: supabase secrets set STRIPE_SECRET_KEY=sk_live_...
//
// Improvements over a bare session.create():
//   • CORS preflight handling.
//   • Reuses an existing Stripe customer for the email, else creates one tagged
//     with the Supabase user id.
//   • Stamps `supabaseUserId` on BOTH the session metadata AND the subscription
//     (via subscription_data.metadata) so later customer.subscription.* webhook
//     events can be mapped back to the user.
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import Stripe from 'https://esm.sh/stripe@14.0.0?target=deno'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2024-06-20'
})

const SUCCESS_URL =
  Deno.env.get('APP_SUCCESS_URL') ?? 'openui://payment-success?session_id={CHECKOUT_SESSION_ID}'
const CANCEL_URL = Deno.env.get('APP_CANCEL_URL') ?? 'openui://payment-cancelled'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const { userId, priceId, email } = await req.json()
    if (!userId || !priceId) {
      return json({ error: 'userId and priceId are required.' }, 400)
    }

    // Create or retrieve the Stripe customer for this user.
    let customerId: string | undefined
    if (email) {
      const existing = await stripe.customers.list({ email, limit: 1 })
      customerId = existing.data[0]?.id
    }
    if (!customerId) {
      const customer = await stripe.customers.create({
        email,
        metadata: { supabaseUserId: userId }
      })
      customerId = customer.id
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: SUCCESS_URL,
      cancel_url: CANCEL_URL,
      metadata: { supabaseUserId: userId },
      // Propagate the user id onto the subscription so subscription.* webhooks
      // can resolve the user without a session lookup.
      subscription_data: { metadata: { supabaseUserId: userId } }
    })

    return json({ url: session.url })
  } catch (err) {
    console.error('create-checkout error:', err)
    return json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500)
  }
})
