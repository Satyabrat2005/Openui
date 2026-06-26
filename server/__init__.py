# server package

"""
OpenUI Server — FastAPI-based with session management, connections, and tier enforcement.

Modules:
  main.py: FastAPI application entry point
  session.py: Session management (Redis + database)
  connections.py: Database connection pool
  tiers.py: TierGuard class for subscription tier enforcement
  queue.py: Priority queue with tier-based prioritization
  stripe_webhook.py: Stripe webhook handler for subscription updates
  router.py: TaskRouter — fast, synchronous request classification and dispatch
"""

try:
    from .tiers import TierGuard, TierId, PermissionError, TIERS
    from .queue import PriorityQueue, Task, TaskPriority
    _tier_exports = [
        "TierGuard",
        "TierId",
        "PermissionError",
        "TIERS",
        "PriorityQueue",
        "Task",
        "TaskPriority",
    ]
except ImportError:
    # Tier modules may not be imported in all contexts
    _tier_exports = []

try:
    from .router import TaskRouter, TaskType, Tier, RoutingDecision
    _router_exports = ["TaskRouter", "TaskType", "Tier", "RoutingDecision"]
except ImportError:
    _router_exports = []

__all__ = _tier_exports + _router_exports
