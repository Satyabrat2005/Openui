"""
app.py — Flask server for OpenUI subscription tier enforcement.

Endpoints:
  POST /webhooks/stripe — Stripe webhook handler
  GET /tiers — List all tier definitions
  GET /user/<user_id>/tier — Get user's current tier
  POST /user/<user_id>/check-permission — Check action permission

Example run:
  pip install flask stripe supabase redis
  python app.py
"""

import os
import json
from functools import wraps
from typing import Any, Dict, Tuple

from flask import Flask, request, jsonify
import redis

from tiers import TierGuard, TierId, PermissionError, TIERS
from stripe_webhook import handle_webhook
from queue import PriorityQueue


app = Flask(__name__)

# Initialize clients
try:
    redis_client = redis.from_url(os.getenv("REDIS_URL", "redis://localhost:6379"))
    redis_client.ping()
except Exception as e:
    print(f"[App] Redis unavailable: {e} (continuing without cache)")
    redis_client = None

tier_guard = TierGuard(
    redis_client=redis_client,
    supabase_url=os.getenv("SUPABASE_URL"),
    supabase_key=os.getenv("SUPABASE_SERVICE_ROLE_KEY")
)

priority_queue = PriorityQueue(redis_client) if redis_client else None


def require_bearer_token(f):
    """Require a valid Bearer token in Authorization header."""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        auth_header = request.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            return jsonify({"error": "Missing or invalid Authorization header"}), 401

        token = auth_header[7:]  # Strip "Bearer "
        # TODO: Verify token is valid (validate Supabase JWT)
        # For now, just check it exists
        if not token:
            return jsonify({"error": "Invalid token"}), 401

        return f(*args, **kwargs)
    return decorated_function


# ─────────────────────────────────────────────────────────────────────────────
# Tier Management Endpoints
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/tiers")
def list_tiers() -> Tuple[Dict[str, Any], int]:
    """Get all tier definitions."""
    return jsonify(tier_guard.get_all_tiers()), 200


@app.get("/user/<user_id>/tier")
@require_bearer_token
def get_user_tier(user_id: str) -> Tuple[Dict[str, Any], int]:
    """Get a user's current subscription tier."""
    try:
        tier = tier_guard.get_tier(user_id)
        tier_def = tier_guard.get_tier_definition(tier)

        return jsonify({
            "user_id": user_id,
            "tier": tier.value,
            "tier_name": tier_def.name,
            "tier_price_usd": tier_def.price_usd
        }), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.post("/user/<user_id>/check-permission")
@require_bearer_token
def check_permission(user_id: str) -> Tuple[Dict[str, Any], int]:
    """
    Check if user has permission for an action.

    Request body:
    {
      "action": "use_gpt4o" | "use_ppt" | "use_terminal" | etc.
    }
    """
    try:
        data = request.get_json() or {}
        action = data.get("action", "").strip()

        if not action:
            return jsonify({"error": "Missing 'action' field"}), 400

        # Will raise PermissionError if not allowed
        tier_guard.check_permission(user_id, action)

        return jsonify({
            "allowed": True,
            "user_id": user_id,
            "action": action
        }), 200

    except PermissionError as e:
        return jsonify(e.to_dict()), 403
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.post("/user/<user_id>/check-browser-tabs")
@require_bearer_token
def check_browser_tabs(user_id: str) -> Tuple[Dict[str, Any], int]:
    """
    Check if user can open N browser tabs.

    Request body:
    {
      "num_tabs": 5
    }
    """
    try:
        data = request.get_json() or {}
        num_tabs = data.get("num_tabs", 0)

        if not isinstance(num_tabs, int) or num_tabs <= 0:
            return jsonify({"error": "num_tabs must be a positive integer"}), 400

        tier_guard.check_browser_tab_limit(user_id, num_tabs)

        return jsonify({
            "allowed": True,
            "user_id": user_id,
            "num_tabs": num_tabs
        }), 200

    except PermissionError as e:
        return jsonify(e.to_dict()), 403
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.post("/user/<user_id>/check-model")
@require_bearer_token
def check_model(user_id: str) -> Tuple[Dict[str, Any], int]:
    """
    Check if user can use a specific model.

    Request body:
    {
      "model": "claude-3-5-sonnet" | "gpt-4o" | "llama3:8b"
    }
    """
    try:
        data = request.get_json() or {}
        model = data.get("model", "").strip()

        if not model:
            return jsonify({"error": "Missing 'model' field"}), 400

        allowed = tier_guard.is_model_allowed(user_id, model)

        if not allowed:
            tier = tier_guard.get_tier(user_id)
            return jsonify({
                "allowed": False,
                "user_id": user_id,
                "model": model,
                "current_tier": tier.value,
                "error": f"Model {model} not available for {tier.value} tier"
            }), 403

        return jsonify({
            "allowed": True,
            "user_id": user_id,
            "model": model
        }), 200

    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ─────────────────────────────────────────────────────────────────────────────
# Task Queue Endpoints
# ─────────────────────────────────────────────────────────────────────────────

@app.post("/queue/enqueue")
@require_bearer_token
def enqueue_task() -> Tuple[Dict[str, Any], int]:
    """
    Add a task to the priority queue.

    Request body:
    {
      "user_id": "...",
      "action": "chat" | "vision" | etc.,
      "data": {...}
    }
    """
    if not priority_queue:
        return jsonify({"error": "Queue service unavailable"}), 503

    try:
        data = request.get_json() or {}
        user_id = data.get("user_id", "").strip()
        action = data.get("action", "").strip()
        task_data = data.get("data", {})

        if not user_id or not action:
            return jsonify({"error": "Missing user_id or action"}), 400

        task_id = priority_queue.enqueue(user_id, action, data=task_data)

        return jsonify({
            "task_id": task_id,
            "user_id": user_id,
            "action": action
        }), 201

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.get("/queue/status")
def get_queue_status() -> Tuple[Dict[str, Any], int]:
    """Get current queue status (pending, executing, by tier)."""
    if not priority_queue:
        return jsonify({"error": "Queue service unavailable"}), 503

    try:
        status = priority_queue.get_queue_status()
        return jsonify(status), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.get("/queue/task/<task_id>")
def get_task_status(task_id: str) -> Tuple[Dict[str, Any], int]:
    """Get status of a specific task."""
    if not priority_queue:
        return jsonify({"error": "Queue service unavailable"}), 503

    try:
        task = priority_queue.get_task(task_id)
        if not task:
            return jsonify({"error": f"Task {task_id} not found"}), 404

        return jsonify(task.to_dict()), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ─────────────────────────────────────────────────────────────────────────────
# Stripe Webhook
# ─────────────────────────────────────────────────────────────────────────────

@app.post("/webhooks/stripe")
def stripe_webhook() -> Tuple[Dict[str, Any], int]:
    """
    Stripe webhook endpoint.

    Verifies Stripe signature and handles subscription events.
    No authentication required (Stripe signature is the auth).
    """
    payload = request.get_data(as_text=True)
    signature = request.headers.get("stripe-signature", "")

    status, response = handle_webhook(payload, signature)
    return jsonify(response), status


# ─────────────────────────────────────────────────────────────────────────────
# Health & Info
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/health")
def health_check() -> Tuple[Dict[str, str], int]:
    """Health check endpoint."""
    return jsonify({"status": "ok"}), 200


@app.get("/info")
def app_info() -> Tuple[Dict[str, Any], int]:
    """Server info."""
    return jsonify({
        "name": "OpenUI Tier Enforcement Server",
        "version": "1.0.0",
        "features": ["tier-guard", "priority-queue", "stripe-webhooks"],
        "redis_available": redis_client is not None,
        "queue_available": priority_queue is not None
    }), 200


# ─────────────────────────────────────────────────────────────────────────────
# Error Handlers
# ─────────────────────────────────────────────────────────────────────────────

@app.errorhandler(404)
def not_found(error) -> Tuple[Dict[str, str], int]:
    """Handle 404 Not Found."""
    return jsonify({"error": "Not found"}), 404


@app.errorhandler(500)
def server_error(error) -> Tuple[Dict[str, str], int]:
    """Handle 500 Server Error."""
    return jsonify({"error": "Internal server error"}), 500


if __name__ == "__main__":
    debug = os.getenv("DEBUG", "false").lower() == "true"
    port = int(os.getenv("PORT", 5000))

    print(f"[App] Starting OpenUI Tier Enforcement Server (debug={debug}, port={port})")
    print(f"[App] Redis available: {redis_client is not None}")
    print(f"[App] Queue available: {priority_queue is not None}")

    app.run(host="0.0.0.0", port=port, debug=debug)
