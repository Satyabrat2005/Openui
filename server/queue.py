"""
queue.py — Priority task queue with tier-based prioritization.

Implements a queue where:
- Pro/Enterprise tasks jump ahead of Free tasks
- Enterprise tasks have a dedicated slot (never queued)
- Pro tasks are prioritized over Free tasks in fairness

Uses Redis sorted sets for efficient priority sorting.
"""

import time
import uuid
from enum import Enum
from typing import Optional, Dict, Any, List
from dataclasses import dataclass, asdict
import json

import redis

from tiers import TierId, TierGuard


class TaskPriority(str, Enum):
    """Task execution priority."""
    LOW = "low"          # Free tier
    NORMAL = "normal"    # Pro tier
    HIGH = "high"        # Enterprise tier


@dataclass
class Task:
    """A queued task with metadata."""
    id: str  # Unique task ID
    user_id: str
    tier: TierId
    action: str  # e.g., "chat", "voice", "analyze_screen"
    priority: TaskPriority
    created_at: float  # Unix timestamp
    started_at: Optional[float] = None  # When task started executing
    data: Dict[str, Any] = None  # Task-specific data

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dict for serialization."""
        return {
            "id": self.id,
            "user_id": self.user_id,
            "tier": self.tier.value,
            "action": self.action,
            "priority": self.priority.value,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "data": self.data or {}
        }


class PriorityQueue:
    """
    Task queue with tier-based prioritization.

    Rules:
    - Enterprise tasks: dedicated slot (stored separately, never queued)
    - Pro tasks: sorted before Free tasks
    - Free tasks: sorted FIFO (by timestamp)

    Uses Redis:
    - pending:{tier}:queue - sorted set of pending task IDs (score = timestamp)
    - task:{id} - task data JSON
    - enterprise:slot - currently executing Enterprise task (or null)
    """

    def __init__(self, redis_client: redis.Redis):
        """Initialize queue with Redis client."""
        self.redis = redis_client
        self.tier_guard = TierGuard(redis_client=redis_client)

    def enqueue(
        self,
        user_id: str,
        action: str,
        tier: Optional[TierId] = None,
        data: Optional[Dict[str, Any]] = None
    ) -> str:
        """
        Add a task to the queue.

        Args:
            user_id: User ID (determines tier if not provided)
            action: Action to perform
            tier: Tier override (if not provided, fetched from user)
            data: Task-specific data

        Returns:
            Task ID
        """
        if tier is None:
            tier = self.tier_guard.get_tier(user_id)

        # Determine priority from tier
        if tier == TierId.FREE:
            priority = TaskPriority.LOW
        elif tier == TierId.PRO:
            priority = TaskPriority.NORMAL
        else:  # ENTERPRISE
            priority = TaskPriority.HIGH

        task_id = str(uuid.uuid4())
        now = time.time()

        task = Task(
            id=task_id,
            user_id=user_id,
            tier=tier,
            action=action,
            priority=priority,
            created_at=now,
            data=data or {}
        )

        # Enterprise: use dedicated slot (skip queue)
        if tier == TierId.ENTERPRISE:
            # Store in dedicated slot (will be handled by executor)
            self.redis.hset(f"enterprise:slot", mapping={"task_id": task_id, "data": json.dumps(task.to_dict())})
            print(f"[Queue] Assigned Enterprise task {task_id} to dedicated slot")
        else:
            # Store task data
            self.redis.set(f"task:{task_id}", json.dumps(task.to_dict()))

            # Add to pending queue (sorted by priority, then FIFO)
            # Score: (tier_rank * large_number) + timestamp
            # Pro (1) sorts before Free (0), newer tasks come after older
            tier_rank = 1 if tier == TierId.PRO else 0
            score = tier_rank * 1_000_000 + now
            self.redis.zadd("pending:queue", {task_id: score})
            print(f"[Queue] Enqueued {tier.value} task {task_id} with priority {priority.value}")

        return task_id

    def dequeue(self) -> Optional[Task]:
        """
        Get the next task to execute (highest priority).

        Returns:
            Task with lowest score (highest priority) or None if queue empty
        """
        # Check Enterprise dedicated slot first
        enterprise_task_id = self.redis.hget("enterprise:slot", "task_id")
        if enterprise_task_id:
            task_id = enterprise_task_id.decode('utf-8')
            task_data = self.redis.hget("enterprise:slot", "data")
            if task_data:
                task_dict = json.loads(task_data)
                task = self._deserialize_task(task_dict)
                return task

        # Otherwise, get highest-priority task from queue
        # ZRANGE with LIMIT gives us the first (lowest score) item
        results = self.redis.zrange("pending:queue", 0, 0)
        if not results:
            return None

        task_id = results[0].decode('utf-8')
        task_data = self.redis.get(f"task:{task_id}")
        if not task_data:
            # Task was deleted; skip it
            self.redis.zrem("pending:queue", task_id)
            return self.dequeue()  # Try next

        task_dict = json.loads(task_data)
        task = self._deserialize_task(task_dict)
        return task

    def mark_started(self, task_id: str) -> None:
        """Mark task as started (began execution)."""
        task_data = self.redis.get(f"task:{task_id}")
        if task_data:
            task_dict = json.loads(task_data)
            task_dict["started_at"] = time.time()
            self.redis.set(f"task:{task_id}", json.dumps(task_dict))

        # Store in "executing" set (for monitoring)
        self.redis.hset("executing:tasks", task_id, time.time())

    def mark_completed(self, task_id: str) -> None:
        """Mark task as completed and remove from queue."""
        # Remove from pending queue
        self.redis.zrem("pending:queue", task_id)

        # Remove from executing set
        self.redis.hdel("executing:tasks", task_id)

        # Check if it was Enterprise task
        if self.redis.hget("enterprise:slot", "task_id") == task_id.encode():
            self.redis.delete("enterprise:slot")

        # Clean up task data (optionally keep in archive)
        self.redis.delete(f"task:{task_id}")
        print(f"[Queue] Completed task {task_id}")

    def mark_failed(self, task_id: str, error: str) -> None:
        """Mark task as failed (could be retried later)."""
        task_data = self.redis.get(f"task:{task_id}")
        if task_data:
            task_dict = json.loads(task_data)
            task_dict["error"] = error
            task_dict["failed_at"] = time.time()
            self.redis.set(f"task:{task_id}:failed", json.dumps(task_dict), ex=86400)  # 24hr TTL

        self.mark_completed(task_id)
        print(f"[Queue] Failed task {task_id}: {error}")

    def get_queue_status(self) -> Dict[str, Any]:
        """Get current queue status (for monitoring)."""
        queue_size = self.redis.zcard("pending:queue")

        # Count by tier
        all_tasks = self.redis.zrange("pending:queue", 0, -1)
        tier_counts = {"free": 0, "pro": 0}
        for task_id in all_tasks:
            task_data = self.redis.get(f"task:{task_id.decode()}")
            if task_data:
                task_dict = json.loads(task_data)
                tier = task_dict.get("tier", "free")
                tier_counts[tier] = tier_counts.get(tier, 0) + 1

        # Executing tasks
        executing = self.redis.hlen("executing:tasks")

        # Enterprise slot
        has_enterprise = bool(self.redis.hget("enterprise:slot", "task_id"))

        return {
            "queue_size": queue_size,
            "executing": executing,
            "has_enterprise_slot": has_enterprise,
            "by_tier": tier_counts
        }

    def get_task(self, task_id: str) -> Optional[Task]:
        """Get a task by ID (if it exists in queue or executing)."""
        # Check pending queue
        task_data = self.redis.get(f"task:{task_id}")
        if task_data:
            return self._deserialize_task(json.loads(task_data))

        # Check Enterprise slot
        if self.redis.hget("enterprise:slot", "task_id") == task_id.encode():
            task_data = self.redis.hget("enterprise:slot", "data")
            if task_data:
                return self._deserialize_task(json.loads(task_data))

        # Check failed tasks
        task_data = self.redis.get(f"task:{task_id}:failed")
        if task_data:
            return self._deserialize_task(json.loads(task_data))

        return None

    @staticmethod
    def _deserialize_task(task_dict: Dict[str, Any]) -> Task:
        """Convert dict to Task object."""
        return Task(
            id=task_dict["id"],
            user_id=task_dict["user_id"],
            tier=TierId(task_dict["tier"]),
            action=task_dict["action"],
            priority=TaskPriority(task_dict["priority"]),
            created_at=task_dict["created_at"],
            started_at=task_dict.get("started_at"),
            data=task_dict.get("data", {})
        )


# Example usage with executor:
#
# queue = PriorityQueue(redis_client)
#
# # Enqueue tasks
# task1_id = queue.enqueue("user-free", "chat", data={"message": "..."})
# task2_id = queue.enqueue("user-pro", "chat", data={"message": "..."})
# task3_id = queue.enqueue("user-enterprise", "vision", data={"image": "..."})
#
# # Execute
# while True:
#     task = queue.dequeue()
#     if not task:
#         time.sleep(0.1)
#         continue
#
#     queue.mark_started(task.id)
#     try:
#         result = execute_task(task)
#         queue.mark_completed(task.id)
#     except Exception as e:
#         queue.mark_failed(task.id, str(e))
