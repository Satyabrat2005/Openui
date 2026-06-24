# OpenUI Supabase Edge Functions

These functions are the **only** place the Stripe **secret key** and the Supabase
**service-role key** ever live. The Electron app holds neither — it uses only the
Supabase **anon** key and calls these functions via `supabase.functions.invoke`.

They run on Deno (not Node), so they import from URLs (`deno.land`, `esm.sh`) and
are intentionally **excluded** from the Electron TypeScript build
(`tsconfig.json` only includes `src/`).

## Functions

| Function             | Called by            | Purpose                                                            |
| -------------------- | -------------------- | ------------------------------------------------------------------ |
| `create-checkout`    | App (checkout.ts)    | Create a Stripe Checkout Session, return its hosted URL.            |
| `customer-portal`    | App (checkout.ts)    | Return a Stripe Billing Portal URL (manage/cancel/invoices).       |
| `check-subscription` | App (subscriptionSync) | Return live `{ tier, status, currentPeriodEnd, customerId }`.    |
| `stripe-webhook`     | **Stripe**           | On subscription events, write `app_metadata.tier` (authoritative). |

## Secrets

Set these on the Supabase project (never in the app's `.env`):

```bash
supabase secrets set \
  STRIPE_SECRET_KEY=sk_live_... \
  STRIPE_WEBHOOK_SIGNING_SECRET=whsec_... \
  STRIPE_PRO_PRICE_ID=price_... \
  STRIPE_ENTERPRISE_PRICE_ID=price_...
# SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided to functions automatically.
```

## Deploy

```bash
supabase functions deploy create-checkout
supabase functions deploy customer-portal
supabase functions deploy check-subscription
# Stripe calls the webhook directly, so JWT verification must be disabled —
# the Stripe signature authenticates the request instead.
supabase functions deploy stripe-webhook --no-verify-jwt
```

Then register the webhook endpoint in the Stripe dashboard
(`https://<project-ref>.functions.supabase.co/stripe-webhook`) for the events:
`checkout.session.completed`, `customer.subscription.created`,
`customer.subscription.updated`, `customer.subscription.deleted`.

## Security notes

- The webhook **verifies the Stripe signature** (`constructEventAsync`) before
  trusting any payload — it never trusts the request body alone.
- `app_metadata.tier` is the source of truth. The app's local SQLite cache is
  treated as untrusted and is only honoured for ≤ 24h when Supabase is offline.
