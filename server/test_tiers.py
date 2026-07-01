"""
test_tiers.py — Unit tests for TierGuard and queue.

Run with: pytest test_tiers.py -v

Note: These tests use in-memory Redis (fakeredis) and mocked Supabase.
For integration testing, use real Redis/Supabase and set environment variables.
"""

import unittest
from unittest.mock import Mock, MagicMock, patch
import time
from tiers import TierGuard, TierId, PermissionError, TIERS
from queue import PriorityQueue, Task, TaskPriority

try:
    import fakeredis
    REDIS_AVAILABLE = True
except ImportError:
    REDIS_AVAILABLE = False
    print("Note: Install 'fakeredis' for full test suite: pip install fakeredis")


class TestTierDefinitions(unittest.TestCase):
    """Test tier definitions match pricing.ts."""

    def test_free_tier(self):
        """Free tier definition."""
        free = TIERS[TierId.FREE]
        self.assertEqual(free.daily_chat_limit, 5)
        self.assertEqual(free.monthly_voice_limit_minutes, 120)
        self.assertEqual(free.max_browser_tabs, 1)
        self.assertFalse(free.has_terminal)
        self.assertFalse(free.has_ppt_excel)
        self.assertFalse(free.priority_queue)
        self.assertFalse(free.dedicated_slot)

    def test_pro_tier(self):
        """Pro tier definition."""
        pro = TIERS[TierId.PRO]
        self.assertEqual(pro.daily_chat_limit, 500)
        self.assertEqual(pro.monthly_voice_limit_minutes, 600)
        self.assertEqual(pro.max_browser_tabs, 3)
        self.assertFalse(pro.has_terminal)
        self.assertTrue(pro.has_ppt_excel)
        self.assertTrue(pro.has_email)
        self.assertTrue(pro.priority_queue)
        self.assertFalse(pro.dedicated_slot)

    def test_enterprise_tier(self):
        """Enterprise tier definition."""
        enterprise = TIERS[TierId.ENTERPRISE]
        self.assertEqual(enterprise.daily_chat_limit, float('inf'))
        self.assertEqual(enterprise.monthly_voice_limit_minutes, float('inf'))
        self.assertEqual(enterprise.max_browser_tabs, 10)
        self.assertTrue(enterprise.has_terminal)
        self.assertTrue(enterprise.has_ppt_excel)
        self.assertTrue(enterprise.has_email)
        self.assertTrue(enterprise.priority_queue)
        self.assertTrue(enterprise.dedicated_slot)


class TestTierGuard(unittest.TestCase):
    """Test TierGuard permission checking."""

    def setUp(self):
        """Set up test fixtures."""
        self.tier_guard = TierGuard()  # No Redis/Supabase

    def test_permission_allowed_for_tier(self):
        """Check permission doesn't raise for allowed action."""
        try:
            self.tier_guard.check_permission("user-1", "use_email", tier_override=TierId.PRO)
        except PermissionError:
            self.fail("check_permission raised PermissionError unexpectedly")

    def test_permission_denied_for_tier(self):
        """Check permission raises for disallowed action."""
        with self.assertRaises(PermissionError) as ctx:
            self.tier_guard.check_permission("user-1", "use_terminal", tier_override=TierId.FREE)
        self.assertEqual(ctx.exception.allowed_from, TierId.ENTERPRISE)

    def test_ppt_requires_pro(self):
        """PPT tool requires Pro tier."""
        with self.assertRaises(PermissionError):
            self.tier_guard.check_permission("user-1", "use_ppt", tier_override=TierId.FREE)

        # Should work for Pro
        self.tier_guard.check_permission("user-1", "use_ppt", tier_override=TierId.PRO)

    def test_terminal_requires_enterprise(self):
        """Terminal requires Enterprise tier."""
        with self.assertRaises(PermissionError):
            self.tier_guard.check_permission("user-1", "use_terminal", tier_override=TierId.PRO)

        # Should work for Enterprise
        self.tier_guard.check_permission("user-1", "use_terminal", tier_override=TierId.ENTERPRISE)

    def test_browser_tab_limits(self):
        """Check browser tab limits per tier."""
        # Free: 1 tab
        with self.assertRaises(PermissionError):
            self.tier_guard.check_browser_tab_limit("user-1", 2)

        # Pro: 3 tabs
        try:
            self.tier_guard.check_browser_tab_limit("user-1", 3)
        except PermissionError:
            self.fail("Pro tier should allow 3 tabs")

        # Enterprise: 10 tabs
        try:
            self.tier_guard.check_browser_tab_limit("user-1", 10)
        except PermissionError:
            self.fail("Enterprise tier should allow 10 tabs")

    def test_model_allowed(self):
        """Check model access per tier — cloud-only, no local/Ollama bypass."""
        # Free: no GPT-4o
        self.assertFalse(self.tier_guard.is_model_allowed("user-1", "gpt-4o"))

        # Free: no local models either — there is no local routing path
        self.assertFalse(self.tier_guard.is_model_allowed("user-1", "llama3:8b"))

        # Pro: allows GPT-4o
        # (This uses tier override, so we patch get_tier)
        with patch.object(self.tier_guard, 'get_tier', return_value=TierId.PRO):
            self.assertTrue(self.tier_guard.is_model_allowed("user-1", "gpt-4o"))

    def test_daily_limits_exceeded(self):
        """Check daily usage limits."""
        # Free: 5 chat/day
        self.tier_guard.check_daily_limit("user-1", "chat", 4)  # OK
        with self.assertRaises(PermissionError):
            self.tier_guard.check_daily_limit("user-1", "chat", 5)  # Exceeded

        # Pro: 500 chat/day
        with patch.object(self.tier_guard, 'get_tier', return_value=TierId.PRO):
            self.tier_guard.check_daily_limit("user-1", "chat", 500)  # OK (but at limit)
            with self.assertRaises(PermissionError):
                self.tier_guard.check_daily_limit("user-1", "chat", 501)  # Exceeded

        # Enterprise: unlimited
        with patch.object(self.tier_guard, 'get_tier', return_value=TierId.ENTERPRISE):
            self.tier_guard.check_daily_limit("user-1", "chat", 999999)  # OK

    def test_monthly_voice_limit_exceeded(self):
        """Check monthly voice-minute limits."""
        # Free: 120 min/month
        self.tier_guard.check_monthly_voice_limit("user-1", 119)  # OK
        with self.assertRaises(PermissionError):
            self.tier_guard.check_monthly_voice_limit("user-1", 120)  # Exceeded

        # Enterprise: unlimited
        with patch.object(self.tier_guard, 'get_tier', return_value=TierId.ENTERPRISE):
            self.tier_guard.check_monthly_voice_limit("user-1", 999999)  # OK


@unittest.skipUnless(REDIS_AVAILABLE, "fakeredis not installed")
class TestPriorityQueue(unittest.TestCase):
    """Test priority queue with tier-based prioritization."""

    def setUp(self):
        """Set up test fixtures."""
        self.redis = fakeredis.FakeStrictRedis()
        self.queue = PriorityQueue(self.redis)

    def test_enqueue_free_task(self):
        """Enqueue a Free tier task."""
        task_id = self.queue.enqueue("user-1", "chat")
        self.assertIsNotNone(task_id)

        task = self.queue.get_task(task_id)
        self.assertEqual(task.tier, TierId.FREE)
        self.assertEqual(task.action, "chat")
        self.assertEqual(task.priority, TaskPriority.LOW)

    def test_enqueue_pro_task(self):
        """Enqueue a Pro tier task."""
        with patch.object(self.queue.tier_guard, 'get_tier', return_value=TierId.PRO):
            task_id = self.queue.enqueue("user-2", "vision")
        task = self.queue.get_task(task_id)
        self.assertEqual(task.tier, TierId.PRO)
        self.assertEqual(task.priority, TaskPriority.NORMAL)

    def test_enqueue_enterprise_task(self):
        """Enqueue an Enterprise tier task (dedicated slot)."""
        with patch.object(self.queue.tier_guard, 'get_tier', return_value=TierId.ENTERPRISE):
            task_id = self.queue.enqueue("user-3", "analysis")
        task = self.queue.get_task(task_id)
        self.assertEqual(task.tier, TierId.ENTERPRISE)
        self.assertEqual(task.priority, TaskPriority.HIGH)

    def test_dequeue_order(self):
        """Pro tasks dequeue before Free tasks (priority)."""
        free_id = self.queue.enqueue("user-1", "chat")
        time.sleep(0.01)  # Ensure different timestamps

        with patch.object(self.queue.tier_guard, 'get_tier', return_value=TierId.PRO):
            pro_id = self.queue.enqueue("user-2", "chat")

        # Dequeue should get Pro task first (higher priority)
        task = self.queue.dequeue()
        self.assertEqual(task.id, pro_id)

        # Next dequeue gets Free task
        task = self.queue.dequeue()
        self.assertEqual(task.id, free_id)

    def test_enterprise_dedicated_slot(self):
        """Enterprise tasks use dedicated slot, not queue."""
        with patch.object(self.queue.tier_guard, 'get_tier', return_value=TierId.ENTERPRISE):
            enterprise_id = self.queue.enqueue("user-3", "compute")

        # Enterprise task should be in dedicated slot
        slot_task_id = self.redis.hget("enterprise:slot", "task_id")
        self.assertEqual(slot_task_id.decode('utf-8'), enterprise_id)

    def test_mark_started_and_completed(self):
        """Mark task as started and completed."""
        task_id = self.queue.enqueue("user-1", "chat")

        self.queue.mark_started(task_id)
        task = self.queue.get_task(task_id)
        self.assertIsNotNone(task.started_at)

        self.queue.mark_completed(task_id)
        task = self.queue.get_task(task_id)
        self.assertIsNone(task)  # Should be deleted

    def test_queue_status(self):
        """Get queue status."""
        free_id = self.queue.enqueue("user-1", "chat")
        with patch.object(self.queue.tier_guard, 'get_tier', return_value=TierId.PRO):
            pro_id = self.queue.enqueue("user-2", "chat")

        status = self.queue.get_queue_status()
        self.assertEqual(status["queue_size"], 2)
        self.assertEqual(status["by_tier"]["free"], 1)
        self.assertEqual(status["by_tier"]["pro"], 1)


class TestPermissionError(unittest.TestCase):
    """Test PermissionError serialization."""

    def test_error_to_dict(self):
        """Convert PermissionError to JSON-serializable dict."""
        error = PermissionError(
            "GPT-4o requires Pro subscription",
            allowed_from=TierId.PRO,
            upgrade_url="https://openui.com/pricing"
        )
        error_dict = error.to_dict()

        self.assertEqual(error_dict["error"], "GPT-4o requires Pro subscription")
        self.assertEqual(error_dict["allowed_from"], "pro")
        self.assertEqual(error_dict["upgrade_url"], "https://openui.com/pricing")


if __name__ == "__main__":
    unittest.main()
