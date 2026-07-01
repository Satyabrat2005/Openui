"""Tests for server.router.TaskRouter — classification, tier gating, dispatch.

Stdlib unittest (no pytest dependency). Run with:  python -m unittest server.test_router
"""

import time
import unittest

from server.router import TaskRouter, TaskType, Tier, RoutingDecision


class ClassifyTests(unittest.TestCase):
    def setUp(self):
        self.router = TaskRouter()

    def test_code_keywords(self):
        for msg in [
            "Please write code for a fibonacci generator",
            "debug this for me",
            "refactor my function",
            "implement a binary search algorithm",
            "give me a python script",
            "write some javascript",
            "fix bug in the parser",
            "create a class for the user model",
        ]:
            self.assertEqual(self.router.classify(msg).task_type, TaskType.CODE, msg)

    def test_code_block_is_code(self):
        msg = "what does this do?\n```\nprint('hi')\n```"
        self.assertEqual(self.router.classify(msg).task_type, TaskType.CODE)

    def test_tool_keywords(self):
        for msg in [
            "open chrome and go to website example.com",
            "click the submit button",
            "take a screenshot",
            "navigate to the dashboard",
            "search google for cats",
            "download the report",
            "fill form with my details",
        ]:
            self.assertEqual(self.router.classify(msg).task_type, TaskType.TOOL, msg)

    def test_general_default(self):
        for msg in [
            "summarize this article",
            "make me a PPT about quarterly results",
            "draft an email to my boss",
            "what's on my calendar tomorrow?",
            "analyze these sales numbers",
        ]:
            self.assertEqual(self.router.classify(msg).task_type, TaskType.GENERAL, msg)

    def test_no_false_positive_on_substrings(self):
        # "class" must not fire on "classify"; "open" must not fire on "opened".
        self.assertEqual(self.router.classify("classify this document").task_type, TaskType.GENERAL)
        self.assertEqual(self.router.classify("the store opened early").task_type, TaskType.GENERAL)

    def test_code_wins_tie_with_tool(self):
        # Has both a code signal ("python script") and a tool signal ("open chrome").
        d = self.router.classify("write a python script to open chrome")
        self.assertEqual(d.task_type, TaskType.CODE)

    def test_agent_names(self):
        self.assertEqual(self.router.classify("write code").agent, "code")
        self.assertEqual(self.router.classify("click here").agent, "tool")
        self.assertEqual(self.router.classify("summarize this").agent, "general")

    def test_classification_under_10ms(self):
        msg = "write a python function to open chrome and click the button " * 5
        # warm compile caches
        self.router.classify(msg)
        start = time.perf_counter()
        for _ in range(1000):
            self.router.classify(msg)
        avg_ms = (time.perf_counter() - start) / 1000 * 1000
        self.assertLess(avg_ms, 10.0, f"avg classify {avg_ms:.4f}ms exceeds 10ms budget")


class TierGatingTests(unittest.TestCase):
    def setUp(self):
        self.router = TaskRouter()

    def test_free_code_is_rate_limited_not_local(self):
        d = self.router.classify("write code")
        self.router.apply_tier(d, Tier.FREE)
        self.assertTrue(d.allowed)
        self.assertTrue(d.rate_limited)

    def test_free_general_is_rate_limited(self):
        d = self.router.classify("summarize this")
        self.router.apply_tier(d, Tier.FREE)
        self.assertTrue(d.allowed)
        self.assertTrue(d.rate_limited)

    def test_free_tool_is_locked(self):
        d = self.router.classify("open chrome")
        self.router.apply_tier(d, Tier.FREE)
        self.assertFalse(d.allowed)
        self.assertIsNotNone(d.denial_reason)

    def test_pro_gets_priority_all_tasks(self):
        for msg in ["write code", "open chrome", "summarize this"]:
            d = self.router.classify(msg)
            self.router.apply_tier(d, Tier.PRO)
            self.assertTrue(d.allowed, msg)
            self.assertTrue(d.priority, msg)

    def test_enterprise_unlocks_everything(self):
        d = self.router.classify("open chrome")
        self.router.apply_tier(d, Tier.ENTERPRISE)
        self.assertTrue(d.allowed)
        self.assertTrue(d.priority)
        self.assertTrue(d.dedicated_slot)
        self.assertTrue(d.github_unlocked)

    def test_unknown_tier_coerces_to_free(self):
        d = self.router.route("open chrome", tier="hacker-elite")
        self.assertEqual(d.tier, Tier.FREE)
        self.assertFalse(d.allowed)  # tool locked on (coerced) free


class RouteAndEmitTests(unittest.TestCase):
    def test_emits_routing_event_before_dispatch(self):
        events = []
        order = []

        def emit(ev):
            events.append(ev)
            order.append("emit")

        def code_handler(message, history, decision):
            order.append("dispatch")
            return "handled"

        router = TaskRouter(emit=emit, agents={"code": code_handler})
        decision = router.route("write code", tier=Tier.PRO)

        self.assertEqual(events, [{"type": "routing", "agent": "code", "reason": decision.reason}])
        self.assertEqual(order, ["emit", "dispatch"])  # emit strictly before execution

    def test_denied_task_emits_but_does_not_dispatch(self):
        events = []
        dispatched = []

        router = TaskRouter(
            emit=events.append,
            agents={"tool": lambda m, h, d: dispatched.append(m)},
        )
        decision = router.route("open chrome", tier=Tier.FREE)

        self.assertFalse(decision.allowed)
        self.assertEqual(len(events), 1)        # routing event still emitted
        self.assertEqual(dispatched, [])        # but the agent never runs

    def test_broken_emit_does_not_crash_route(self):
        def bad_emit(ev):
            raise RuntimeError("socket closed")

        router = TaskRouter(emit=bad_emit)
        d = router.route("summarize this", tier=Tier.PRO)  # must not raise
        self.assertIsInstance(d, RoutingDecision)


if __name__ == "__main__":
    unittest.main(verbosity=2)
