// stripe-webhook — Supabase Edge Function (Deno runtime).
//
// Receives Stripe webhook events, verifies the signature, maps the subscription
// price to a tier, and writes that tier into the user's Supabase
// `app_metadata` (the authoritative source the Electron app verifies against).
//
// Deploy:  supabase functions deploy stripe-webhook --no-verify-jwt
//          (Stripe calls this directly, so JWT verification must be OFF; the
//           Stripe signature is what authenticates the request.)
// Secrets: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SIGNING_SECRET,
//          STRIPE_PRO_PRICE_ID, STRIPE_ENTERPRISE_PRICE_ID,
//          SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// NOTE vs a naive implementation: Deno's runtime requires the ASYNC signature
// verifier `constructEventAsync` (the sync `constructEvent` uses Node crypto and
// throws here). We also resolve the user id from the subscription/customer
// metadata, and for checkout.session.completed we retrieve the subscription to
// learn its price.
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

const WEBHOOK_SECRET = Deno.env.get('STRIPE_WEBHOOK_SIGNING_SECRET') ?? ''

/** Map a Stripe price id to an OpenUI tier. */
function tierForPriceId(priceId: string | undefined): 'free' | 'pro' | 'enterprise' {
  if (priceId && priceId === Deno.env.get('STRIPE_PRO_PRICE_ID')) return 'pro'
  if (priceId && priceId === Deno.env.get('STRIPE_ENTERPRISE_PRICE_ID')) return 'enterprise'
  return 'free'
}

/** Resolve the Supabase user id from a subscription, falling back to the customer. */
// deno-lint-ignore no-explicit-any
async function resolveUserId(subscription: any): Promise<string | undefined> {
  let userId: string | undefined = subscription?.metadata?.supabaseUserId
  if (!userId && subscription?.customer) {
    const customerId =
      typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id
    const customer = await stripe.customers.retrieve(customerId)
    // deno-lint-ignore no-explicit-any
    if (customer && !(customer as any).deleted) {
      // deno-lint-ignore no-explicit-any
      userId = (customer as any).metadata?.supabaseUserId
    }
  }
  return userId
}

async function applyTier(
  userId: string,
  tier: 'free' | 'pro' | 'enterprise',
  // deno-lint-ignore no-explicit-any
  customer: any
): Promise<void> {
  const stripeCustomerId = typeof customer === 'string' ? customer : customer?.id
  await supabase.auth.admin.updateUserById(userId, {
    app_metadata: { tier, stripeCustomerId }
  })
}

serve(async (req) => {
  const signature = req.headers.get('stripe-signature')
  const body = await req.text()
  if (!signature) return new Response('Missing stripe-signature', { status: 400 })

  let event: Stripe.Event
  try {
    event = await stripe.webhooks.constructEventAsync(body, signature, WEBHOOK_SECRET)
  } catch (err) {
    console.error('Webhook signature verification failed:', err)
    return new Response('Invalid signature', { status: 400 })
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        // deno-lint-ignore no-explicit-any
        const session = event.data.object as any
        const userId = session.metadata?.supabaseUserId
        if (userId && session.subscription) {
          const subscription = await stripe.subscriptions.retrieve(session.subscription)
          const priceId = subscription.items.data[0]?.price.id
          await applyTier(userId, tierForPriceId(priceId), session.customer)
        }
        break
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        // deno-lint-ignore no-explicit-any
        const subscription = event.data.object as any
        const userId = await resolveUserId(subscription)
        const priceId = subscription.items?.data?.[0]?.price?.id
        // An incomplete/unpaid subscription should not unlock a paid tier.
        const isActive = subscription.status === 'active' || subscription.status === 'trialing'
        const tier = isActive ? tierForPriceId(priceId) : 'free'
        if (userId) await applyTier(userId, tier, subscription.customer)
        break
      }

      case 'customer.subscription.deleted': {
        // deno-lint-ignore no-explicit-any
        const subscription = event.data.object as any
        const userId = await resolveUserId(subscription)
        if (userId) await applyTier(userId, 'free', subscription.customer)
        break
      }
    }
  } catch (err) {
    console.error('Webhook handler error:', err)
    return new Response('Handler error', { status: 500 })
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })
})
