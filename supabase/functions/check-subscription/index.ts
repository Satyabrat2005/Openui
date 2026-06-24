// check-subscription — Supabase Edge Function (Deno runtime).
//
// Returns the user's live subscription state straight from Stripe, used by the
// Electron app's periodic sync to cross-check the tier and learn the current
// period end (so it knows how long a paid tier is valid). The Stripe secret key
// stays server-side.
//
// Deploy:  supabase functions deploy check-subscription
// Secrets: STRIPE_SECRET_KEY, STRIPE_PRO_PRICE_ID, STRIPE_ENTERPRISE_PRICE_ID,
//          SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// Response: { tier, status, currentPeriodEnd, customerId }
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

function tierForPriceId(priceId: string | undefined): 'free' | 'pro' | 'enterprise' {
  if (priceId && priceId === Deno.env.get('STRIPE_PRO_PRICE_ID')) return 'pro'
  if (priceId && priceId === Deno.env.get('STRIPE_ENTERPRISE_PRICE_ID')) return 'enterprise'
  return 'free'
}

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
    const { userId } = await req.json()
    if (!userId) return json({ error: 'userId is required.' }, 400)

    // Resolve the Stripe customer: prefer the id stamped on the user by the
    // webhook, else fall back to a lookup by email.
    const { data } = await supabase.auth.admin.getUserById(userId)
    let customerId = data.user?.app_metadata?.stripeCustomerId as string | undefined
    if (!customerId && data.user?.email) {
      const list = await stripe.customers.list({ email: data.user.email, limit: 1 })
      customerId = list.data[0]?.id
    }
    if (!customerId) {
      return json({ tier: 'free', status: null, currentPeriodEnd: null, customerId: null })
    }

    const subs = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 10 })
    const active = subs.data.find((s) => s.status === 'active' || s.status === 'trialing')
    const sub = active ?? subs.data[0]
    if (!sub) {
      return json({ tier: 'free', status: null, currentPeriodEnd: null, customerId })
    }

    const priceId = sub.items.data[0]?.price.id
    const tier = active ? tierForPriceId(priceId) : 'free'

    return json({
      tier,
      status: sub.status,
      currentPeriodEnd: sub.current_period_end, // epoch seconds
      customerId
    })
  } catch (err) {
    console.error('check-subscription error:', err)
    return json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500)
  }
})
