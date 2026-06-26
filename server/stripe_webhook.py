"""
stripe_webhook.py — Handle Stripe subscription events.

Receives Stripe webhooks (signature verified), maps prices to tiers,
and updates user subscriptions in Supabase + Redis cache.

Deploy as: POST /webhooks/stripe

Environment variables required:
  STRIPE_SECRET_KEY: Stripe secret API key
  STRIPE_WEBHOOK_SIGNING_SECRET: Stripe webhook signing secret
  STRIPE_PRO_PRICE_ID: Stripe price id for Pro tier
  STRIPE_ENTERPRISE_PRICE_ID: Stripe price id for Enterprise tier
"""

import os
import json
from typing import Optional, Dict, Any
import hashlib
import hmac
from datetime import datetime, timezone

import stripe
from supabase import create_client, Client
import redis

from tiers import TierId, TierGuard


# Initialize clients
stripe.api_key = os.getenv("STRIPE_SECRET_KEY")
WEBHOOK_SECRET = os.getenv("STRIPE_WEBHOOK_SIGNING_SECRET", "")

supabase = create_client(
    os.getenv("SUPABASE_URL", ""),
    os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
)

try:
    redis_client = redis.from_url(os.getenv("REDIS_URL", "redis://localhost:6379"))
    redis_client.ping()
except Exception:
    redis_client = None

tier_guard = TierGuard(redis_client=redis_client, supabase_client=supabase)


def verify_stripe_signature(payload: str, signature: str) -> bool:
    """
    Verify the Stripe webhook signature.

    Args:
        payload: Raw request body as string
        signature: Value of stripe-signature header

    Returns:
        True if signature is valid, False otherwise
    """
    if not WEBHOOK_SECRET or not signature:
        return False

    try:
        event = stripe.Webhook.construct_event(payload, signature, WEBHOOK_SECRET)
        return bool(event)
    except (ValueError, stripe.error.SignatureVerificationError):
        return False


def tier_for_price_id(price_id: Optional[str]) -> TierId:
    """
    Map a Stripe price ID to an OpenUI tier.

    Args:
        price_id: Stripe price id (e.g., "price_...")

    Returns:
        TierId (Free, Pro, or Enterprise)
    """
    pro_price = os.getenv("STRIPE_PRO_PRICE_ID")
    enterprise_price = os.getenv("STRIPE_ENTERPRISE_PRICE_ID")

    if price_id == pro_price:
        return TierId.PRO
    if price_id == enterprise_price:
        return TierId.ENTERPRISE
    return TierId.FREE


def get_user_id_from_subscription(subscription: Dict[str, Any]) -> Optional[str]:
    """
    Extract Supabase user ID from a Stripe subscription.

    Priority:
    1. subscription.metadata.supabaseUserId
    2. customer.metadata.supabaseUserId (fetch customer if needed)

    Args:
        subscription: Stripe subscription object

    Returns:
        Supabase user ID or None
    """
    # Check subscription metadata
    user_id = subscription.get("metadata", {}).get("supabaseUserId")
    if user_id:
        return user_id

    # Fall back to customer metadata
    customer_id = subscription.get("customer")
    if customer_id:
        try:
            customer = stripe.Customer.retrieve(customer_id)
            user_id = customer.get("metadata", {}).get("supabaseUserId")
            if user_id:
                return user_id
        except stripe.error.StripeError as e:
            print(f"[Stripe] Failed to retrieve customer {customer_id}: {e}")

    return None


def apply_tier_to_user(user_id: str, tier: TierId, stripe_customer_id: str) -> None:
    """
    Update a user's tier in Supabase and cache in Redis.

    Args:
        user_id: Supabase user ID
        tier: New tier (Free, Pro, or Enterprise)
        stripe_customer_id: Stripe customer ID for reference
    """
    try:
        # Update Supabase auth user metadata
        supabase.auth.admin.update_user_by_id(
            user_id,
            {
                "app_metadata": {
                    "tier": tier.value,
                    "stripeCustomerId": stripe_customer_id,
                    "updatedAt": datetime.now(timezone.utc).isoformat()
                }
            }
        )

        # Invalidate Redis cache so it re-syncs
        tier_guard._set_cached_tier(user_id, tier)

        print(f"[Stripe] Applied tier {tier.value} to user {user_id}")
    except Exception as e:
        print(f"[Stripe] Failed to apply tier to {user_id}: {e}")


def handle_checkout_session_completed(event: Dict[str, Any]) -> None:
    """
    Handle checkout.session.completed event.

    User completed a checkout → retrieve subscription and apply tier.
    """
    session = event.get("data", {}).get("object", {})
    user_id = session.get("metadata", {}).get("supabaseUserId")
    customer_id = session.get("customer")

    if not user_id:
        print("[Stripe] checkout.session.completed: no supabaseUserId in metadata")
        return

    subscription_id = session.get("subscription")
    if not subscription_id:
        print("[Stripe] checkout.session.completed: no subscription in session")
        return

    try:
        subscription = stripe.Subscription.retrieve(subscription_id)
        price_id = subscription.get("items", {}).get("data", [{}])[0].get("price", {}).get("id")
        tier = tier_for_price_id(price_id)
        apply_tier_to_user(user_id, tier, customer_id or "unknown")
    except stripe.error.StripeError as e:
        print(f"[Stripe] Failed to retrieve subscription {subscription_id}: {e}")


def handle_subscription_created(event: Dict[str, Any]) -> None:
    """Handle customer.subscription.created event."""
    subscription = event.get("data", {}).get("object", {})
    user_id = get_user_id_from_subscription(subscription)
    customer_id = subscription.get("customer")

    if not user_id:
        print("[Stripe] subscription.created: could not resolve user id")
        return

    price_id = subscription.get("items", {}).get("data", [{}])[0].get("price", {}).get("id")
    tier = tier_for_price_id(price_id)
    apply_tier_to_user(user_id, tier, customer_id or "unknown")


def handle_subscription_updated(event: Dict[str, Any]) -> None:
    """Handle customer.subscription.updated event (price change, renewal, etc.)."""
    subscription = event.get("data", {}).get("object", {})
    user_id = get_user_id_from_subscription(subscription)
    customer_id = subscription.get("customer")

    if not user_id:
        print("[Stripe] subscription.updated: could not resolve user id")
        return

    # Check if subscription is still active
    status = subscription.get("status")  # active, past_due, canceled, etc.
    if status not in ("active", "past_due"):
        # Downgrade to Free
        apply_tier_to_user(user_id, TierId.FREE, customer_id or "unknown")
        return

    price_id = subscription.get("items", {}).get("data", [{}])[0].get("price", {}).get("id")
    tier = tier_for_price_id(price_id)
    apply_tier_to_user(user_id, tier, customer_id or "unknown")


def handle_subscription_deleted(event: Dict[str, Any]) -> None:
    """Handle customer.subscription.deleted event (downgrade to Free)."""
    subscription = event.get("data", {}).get("object", {})
    user_id = get_user_id_from_subscription(subscription)
    customer_id = subscription.get("customer")

    if not user_id:
        print("[Stripe] subscription.deleted: could not resolve user id")
        return

    apply_tier_to_user(user_id, TierId.FREE, customer_id or "unknown")


def handle_webhook(payload: str, signature: str) -> tuple[int, Dict[str, Any]]:
    """
    Main webhook handler. Verifies signature and dispatches to event handlers.

    Args:
        payload: Raw request body as string
        signature: stripe-signature header value

    Returns:
        (status_code, response_dict) tuple
    """
    if not verify_stripe_signature(payload, signature):
        return (400, {"error": "Invalid signature"})

    try:
        event = stripe.Webhook.construct_event(payload, signature, WEBHOOK_SECRET)
    except ValueError:
        return (400, {"error": "Invalid payload"})
    except stripe.error.SignatureVerificationError:
        return (400, {"error": "Invalid signature"})

    event_type = event.get("type", "")

    try:
        if event_type == "checkout.session.completed":
            handle_checkout_session_completed(event)
        elif event_type == "customer.subscription.created":
            handle_subscription_created(event)
        elif event_type == "customer.subscription.updated":
            handle_subscription_updated(event)
        elif event_type == "customer.subscription.deleted":
            handle_subscription_deleted(event)
        else:
            print(f"[Stripe] Unhandled event type: {event_type}")

        return (200, {"ok": True})
    except Exception as e:
        print(f"[Stripe] Error handling {event_type}: {e}")
        return (500, {"error": str(e)})


# Flask/FastAPI integration example:
#
# from flask import Flask, request
# app = Flask(__name__)
#
# @app.post("/webhooks/stripe")
# def stripe_webhook():
#     status, response = handle_webhook(
#         request.get_data(as_text=True),
#         request.headers.get("stripe-signature", "")
#     )
#     return response, status
