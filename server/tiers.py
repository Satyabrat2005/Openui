"""
tiers.py — Subscription tier enforcement system.

Defines tier limits, enforces permissions, manages tier caching via Redis,
and validates user entitlements against Supabase.

TIER DEFINITIONS (match frontend/src/main/stripe/pricing.ts):
  Free:       20 chat/day, 20 voice/day, Ollama only, 1 browser tab, no terminal
  Pro:        500 chat/day, 200 voice/day, Claude Sonnet + GPT-4o, 3 browser tabs, priority queue
  Enterprise: Unlimited, all models, 10 browser tabs, terminal access, dedicated slot
"""

from dataclasses import dataclass
from enum import Enum
from typing import Optional, Dict, Any
import time
import json
from datetime import datetime, timedelta

import redis
from supabase import create_client, Client


class TierId(str, Enum):
    """Subscription tier identifier."""
    FREE = "free"
    PRO = "pro"
    ENTERPRISE = "enterprise"


class PermissionError(Exception):
    """Raised when a user lacks permission for an action."""

    def __init__(self, message: str, allowed_from: TierId, upgrade_url: str = ""):
        self.message = message
        self.allowed_from = allowed_from
        self.upgrade_url = upgrade_url or "https://openui.com/pricing"
        super().__init__(self.message)

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dict for JSON serialization."""
        return {
            "error": self.message,
            "allowed_from": self.allowed_from.value,
            "upgrade_url": self.upgrade_url
        }


@dataclass
class TierDefinition:
    """Definition of a subscription tier and its limits."""
    tier_id: TierId
    name: str
    price_usd: int
    daily_chat_limit: int
    daily_voice_limit: int
    models: Dict[str, list]  # {"cloud": [...], "local": [...]}
    max_browser_tabs: int
    has_terminal: bool
    has_ppt_excel: bool
    has_email: bool
    priority_queue: bool  # Pro/Enterprise skip Free users in queue
    dedicated_slot: bool  # Enterprise never queued


# Tier definitions (matching frontend pricing exactly)
TIERS: Dict[TierId, TierDefinition] = {
    TierId.FREE: TierDefinition(
        tier_id=TierId.FREE,
        name="Free",
        price_usd=0,
        daily_chat_limit=20,
        daily_voice_limit=20,
        models={
            "cloud": ["claude-3-5-haiku"],
            "local": ["llama3:8b", "phi3:mini"]
        },
        max_browser_tabs=1,
        has_terminal=False,
        has_ppt_excel=False,
        has_email=False,
        priority_queue=False,
        dedicated_slot=False
    ),
    TierId.PRO: TierDefinition(
        tier_id=TierId.PRO,
        name="Pro",
        price_usd=19,
        daily_chat_limit=500,
        daily_voice_limit=200,
        models={
            "cloud": ["claude-3-5-sonnet", "gpt-4o", "llama3:70b"],
            "local": ["llama3:8b", "phi3:mini"]
        },
        max_browser_tabs=3,
        has_terminal=False,
        has_ppt_excel=True,
        has_email=True,
        priority_queue=True,
        dedicated_slot=False
    ),
    TierId.ENTERPRISE: TierDefinition(
        tier_id=TierId.ENTERPRISE,
        name="Enterprise",
        price_usd=49,
        daily_chat_limit=float('inf'),
        daily_voice_limit=float('inf'),
        models={
            "cloud": ["glm-5.2", "claude-3-5-sonnet", "gpt-4o", "llama3:405b"],
            "local": ["llama3:8b", "phi3:mini"]
        },
        max_browser_tabs=10,
        has_terminal=True,
        has_ppt_excel=True,
        has_email=True,
        priority_queue=True,
        dedicated_slot=True
    )
}


class TierGuard:
    """
    Server-side subscription tier enforcement.

    Responsibilities:
    - Check user permissions for actions
    - Cache tier data in Redis (1hr TTL)
    - Sync with Supabase for authoritative tier
    - Enforce daily usage limits
    - Raise PermissionError when tier lacks capability
    """

    CACHE_TTL_SEC = 3600  # 1 hour
    LOCAL_MODEL_REGEX = r"^(llama|phi|mistral|qwen|gemma|codellama|deepseek|tinyllama)"

    def __init__(
        self,
        redis_client: Optional[redis.Redis] = None,
        supabase_client: Optional[Client] = None,
        supabase_url: Optional[str] = None,
        supabase_key: Optional[str] = None
    ):
        """
        Initialize TierGuard.

        Args:
            redis_client: Redis client for caching (uses redis:// env var by default)
            supabase_client: Supabase client (uses env vars by default)
            supabase_url: Supabase URL (SUPABASE_URL env var)
            supabase_key: Supabase service role key (SUPABASE_SERVICE_ROLE_KEY env var)
        """
        self.redis = redis_client
        self.supabase = supabase_client

        # Initialize Redis if not provided
        if not self.redis:
            try:
                self.redis = redis.from_url("redis://localhost:6379")
                self.redis.ping()
            except Exception:
                # Fall through to memory-only mode (no caching)
                self.redis = None

        # Initialize Supabase if not provided
        if not self.supabase and supabase_url and supabase_key:
            self.supabase = create_client(supabase_url, supabase_key)

    def _get_cached_tier(self, user_id: str) -> Optional[TierId]:
        """Get tier from Redis cache."""
        if not self.redis:
            return None
        try:
            key = f"tier:{user_id}"
            cached = self.redis.get(key)
            if cached:
                return TierId(cached.decode('utf-8'))
        except Exception:
            pass
        return None

    def _set_cached_tier(self, user_id: str, tier: TierId) -> None:
        """Cache tier in Redis for 1 hour."""
        if not self.redis:
            return
        try:
            key = f"tier:{user_id}"
            self.redis.setex(key, self.CACHE_TTL_SEC, tier.value)
        except Exception:
            pass

    def sync_tier_from_supabase(self, user_id: str) -> TierId:
        """
        Fetch authoritative tier from Supabase and cache it.

        Reads from Supabase auth.users.app_metadata.tier (written by
        stripe-webhook Edge Function). Falls back to 'free' if Supabase
        is unreachable or user has no subscription.

        Args:
            user_id: Supabase user ID

        Returns:
            User's current tier
        """
        if not self.supabase:
            return TierId.FREE

        try:
            # Fetch user from Supabase
            response = self.supabase.auth.admin.get_user_by_id(user_id)
            if response and hasattr(response, 'user') and response.user:
                tier_str = response.user.app_metadata.get('tier', 'free')
                tier = self._coerce_tier(tier_str)

                # Cache the tier
                self._set_cached_tier(user_id, tier)
                return tier
        except Exception as e:
            print(f"[TierGuard] Supabase sync failed for {user_id}: {e}")

        return TierId.FREE

    def get_tier(self, user_id: str) -> TierId:
        """
        Get user's current tier (cached or from Supabase).

        Priority:
        1. Check Redis cache (fresh = within 1hr)
        2. Sync from Supabase if cache miss
        3. Default to Free if unreachable

        Args:
            user_id: Supabase user ID

        Returns:
            User's current tier
        """
        # Try cache first
        cached = self._get_cached_tier(user_id)
        if cached:
            return cached

        # Sync from Supabase and cache
        return self.sync_tier_from_supabase(user_id)

    def check_permission(
        self,
        user_id: str,
        action: str,
        tier_override: Optional[TierId] = None
    ) -> None:
        """
        Check if user has permission for an action.

        Raises PermissionError if the user's tier doesn't support the action.

        Args:
            user_id: Supabase user ID
            action: Action to check (e.g., "use_ppt", "use_terminal", "use_gpt4o")
            tier_override: If provided, check this tier instead of fetching user's

        Raises:
            PermissionError: If action not allowed for user's tier
        """
        tier = tier_override or self.get_tier(user_id)
        tier_def = TIERS.get(tier)

        if not tier_def:
            raise PermissionError(
                f"Invalid tier: {tier}",
                allowed_from=TierId.FREE
            )

        # Check action permissions
        if action in ("use_ppt", "use_excel") and not tier_def.has_ppt_excel:
            raise PermissionError(
                f"PPT/Excel tools require Pro subscription",
                allowed_from=TierId.PRO
            )

        if action == "use_email" and not tier_def.has_email:
            raise PermissionError(
                f"Email tool requires Pro subscription",
                allowed_from=TierId.PRO
            )

        if action == "use_terminal" and not tier_def.has_terminal:
            raise PermissionError(
                f"Terminal access requires Enterprise subscription",
                allowed_from=TierId.ENTERPRISE
            )

        if action == "use_github" and tier == TierId.FREE:
            raise PermissionError(
                f"GitHub integration requires Pro subscription",
                allowed_from=TierId.PRO
            )

        if action == "use_figma" and tier == TierId.FREE:
            raise PermissionError(
                f"Figma integration requires Pro subscription",
                allowed_from=TierId.PRO
            )

    def check_browser_tab_limit(self, user_id: str, num_tabs: int) -> None:
        """
        Check if user can open num_tabs browser tabs.

        Args:
            user_id: Supabase user ID
            num_tabs: Number of tabs to open

        Raises:
            PermissionError: If tab count exceeds tier limit
        """
        tier = self.get_tier(user_id)
        tier_def = TIERS[tier]

        if num_tabs > tier_def.max_browser_tabs:
            raise PermissionError(
                f"Browser tab limit is {tier_def.max_browser_tabs} for {tier_def.name} tier",
                allowed_from=TierId.FREE if tier == TierId.FREE else (
                    TierId.PRO if tier == TierId.PRO else TierId.ENTERPRISE
                )
            )

    def is_model_allowed(self, user_id: str, model: str) -> bool:
        """
        Check if user can use a specific model.

        Rules:
        - Listed models in tier's models.cloud/local are always allowed
        - Free tier allows any local model that looks like Ollama (llama:, phi:, etc.)
        - Cloud models outside the tier's list are denied

        Args:
            user_id: Supabase user ID
            model: Model name (e.g., "claude-3-5-sonnet", "llama3:8b")

        Returns:
            True if model is allowed, False otherwise
        """
        tier = self.get_tier(user_id)
        tier_def = TIERS[tier]

        cloud_models = tier_def.models["cloud"]
        local_models = tier_def.models["local"]

        # Check explicit lists
        if model in cloud_models or model in local_models:
            return True

        # Free tier: allow any local Ollama model
        if tier == TierId.FREE:
            import re
            if re.match(self.LOCAL_MODEL_REGEX, model, re.IGNORECASE):
                return True
            if ":" in model:  # Local models use name:tag format
                return True

        return False

    def check_daily_limit(
        self,
        user_id: str,
        usage_type: str,  # "chat" or "voice"
        current_usage: int
    ) -> None:
        """
        Check if user has exceeded their daily limit.

        Args:
            user_id: Supabase user ID
            usage_type: "chat" or "voice"
            current_usage: Current day's usage count

        Raises:
            PermissionError: If daily limit exceeded
        """
        tier = self.get_tier(user_id)
        tier_def = TIERS[tier]

        if usage_type == "chat":
            limit = tier_def.daily_chat_limit
        elif usage_type == "voice":
            limit = tier_def.daily_voice_limit
        else:
            return

        if current_usage >= limit and limit != float('inf'):
            raise PermissionError(
                f"Daily {usage_type} limit ({int(limit)}) exceeded for {tier_def.name} tier",
                allowed_from=TierId.FREE
            )

    @staticmethod
    def _coerce_tier(value: Any) -> TierId:
        """Safely coerce any value to a TierId."""
        if value in ("pro", TierId.PRO.value):
            return TierId.PRO
        if value in ("enterprise", TierId.ENTERPRISE.value):
            return TierId.ENTERPRISE
        return TierId.FREE

    def get_tier_definition(self, tier: TierId) -> TierDefinition:
        """Get the full definition for a tier."""
        return TIERS.get(tier, TIERS[TierId.FREE])

    def get_all_tiers(self) -> Dict[str, Dict[str, Any]]:
        """Return all tier definitions as a dict (for API responses)."""
        return {
            tier_id.value: {
                "name": tier_def.name,
                "price_usd": tier_def.price_usd,
                "daily_chat_limit": int(tier_def.daily_chat_limit) if tier_def.daily_chat_limit != float('inf') else None,
                "daily_voice_limit": int(tier_def.daily_voice_limit) if tier_def.daily_voice_limit != float('inf') else None,
                "models": tier_def.models,
                "max_browser_tabs": tier_def.max_browser_tabs,
                "has_terminal": tier_def.has_terminal,
                "has_ppt_excel": tier_def.has_ppt_excel,
                "has_email": tier_def.has_email,
                "priority_queue": tier_def.priority_queue,
                "dedicated_slot": tier_def.dedicated_slot
            }
            for tier_id, tier_def in TIERS.items()
        }
