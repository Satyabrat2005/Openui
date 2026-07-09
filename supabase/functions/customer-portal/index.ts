// customer-portal — Supabase Edge Function (Deno runtime).
//
// Returns a Stripe Billing Portal URL so the user can manage their subscription
// (upgrade/downgrade/cancel/invoices). The Stripe secret key stays server-side.
//
// Deploy:  supabase functions deploy customer-portal
// Secrets: STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// NOTE vs a bare snippet: the Electron app doesn't know the Stripe customer id,
// so this resolves it from the user's `app_metadata.stripeCustomerId` (written
// by stripe-webhook). The app may pass a cached `customerId` as a hint.
//
// Authenticates the caller's bearer token (supabase.auth.getUser) before
// trusting either the body's `userId` or `customerId` — a body-supplied
// userId is accepted only if it matches the verified id, and a body-supplied
// customerId must belong to that same verified user. Otherwise any caller
// could mint a Billing Portal session for another user's Stripe customer by
// passing their id/customerId in the request body.
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import Stripe from 'https://esm.sh/stripe@14.0.0?target=deno'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { requireVerifiedUser } from '../_shared/auth.ts'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2024-06-20'
})

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
)

const RETURN_URL = Deno.env.get('APP_PORTAL_RETURN_URL') ?? 'openui://portal-closed'

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
    const { userId, customerId } = await req.json()

    const auth = await requireVerifiedUser(req, supabase, userId)
    if (!auth.ok) return json({ error: auth.error }, auth.status)
    const verifiedUserId = auth.user.id

    // Resolve the customer id server-side from the verified user's own
    // metadata; a client-supplied `customerId` is only ever used if it matches
    // that resolved value, never trusted on its own.
    const { data } = await supabase.auth.admin.getUserById(verifiedUserId)
    const ownCustomerId = data.user?.app_metadata?.stripeCustomerId as string | undefined

    let resolvedCustomerId: string | undefined
    if (customerId) {
      if (customerId !== ownCustomerId) return json({ error: 'user_mismatch' }, 403)
      resolvedCustomerId = customerId
    } else {
      resolvedCustomerId = ownCustomerId
    }
    if (!resolvedCustomerId) {
      return json({ error: 'No Stripe customer found for this user.' }, 404)
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: resolvedCustomerId,
      return_url: RETURN_URL
    })

    return json({ url: session.url })
  } catch (err) {
    console.error('customer-portal error:', err)
    return json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500)
  }
})
