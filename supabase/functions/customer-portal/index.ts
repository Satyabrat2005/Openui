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
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import Stripe from 'https://esm.sh/stripe@14.0.0?target=deno'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

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

    let resolvedCustomerId: string | undefined = customerId
    if (!resolvedCustomerId && userId) {
      const { data } = await supabase.auth.admin.getUserById(userId)
      resolvedCustomerId = data.user?.app_metadata?.stripeCustomerId as string | undefined
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
