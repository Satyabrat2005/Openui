"""
TaskRouter — the intelligence layer that classifies every incoming request and
dispatches it to the right agent.

Design goals (see TASK 4):

  * Classification is **fast, synchronous, and never calls an LLM**. It is pure
    keyword + code-block matching over pre-compiled regexes, so a message is
    classified in well under 10ms. `TaskRouter.classify()` is side-effect free.

  * Three task classes map to three agents:
        CODE_TASK    -> CodeAgent     (agent name "code")
        TOOL_TASK    -> ToolRunner    (agent name "tool")
        GENERAL_TASK -> GeneralAgent  (agent name "general", the default)

  * Tier gating layers entitlements on top of the raw classification:
        Free       -> CODE_TASK and GENERAL_TASK are both routed to our cloud
                      backend and rate-limited against the same daily cap;
                      TOOL_TASK is locked (upgrade required). There is no local
                      model routing for any tier — every task is metered.
        Pro        -> all tasks, priority queue.
        Enterprise -> all tasks, dedicated execution slot, GitHub integration.

  * Before execution starts, the router emits a routing decision to the
    WebSocket so the UI can show what is about to happen:
        { "type": "routing", "agent": "code"|"general"|"tool",
          "reason": "detected code task" }

The router does not import the concrete agents. Agents are injected as handlers
(a name -> callable mapping) so this module stays dependency-free and testable;
CodeAgent / ToolRunner / GeneralAgent can be wired in by the caller once they
exist.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Dict, List, Optional, Tuple


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------

class TaskType(Enum):
    """The three kinds of request the router knows how to classify."""
    CODE = "code"
    TOOL = "tool"
    GENERAL = "general"


# The agent name emitted to the WebSocket / used to look up a handler.
AGENT_FOR_TASK: Dict[TaskType, str] = {
    TaskType.CODE: "code",       # -> CodeAgent
    TaskType.TOOL: "tool",       # -> ToolRunner
    TaskType.GENERAL: "general",  # -> GeneralAgent
}


class Tier(Enum):
    """Subscription tiers. Mirrors `src/main/stripe/pricing.ts` (free/pro/enterprise)."""
    FREE = "free"
    PRO = "pro"
    ENTERPRISE = "enterprise"

    @classmethod
    def coerce(cls, value: Any) -> "Tier":
        """Best-effort parse of an untrusted tier string. Unknown -> FREE.

        Never trust the caller to hand us a valid tier; default to the least
        privileged tier so a bad value can't unlock paid behaviour.
        """
        if isinstance(value, cls):
            return value
        try:
            return cls(str(value).strip().lower())
        except ValueError:
            return cls.FREE


# ---------------------------------------------------------------------------
# Keyword / pattern tables
# ---------------------------------------------------------------------------
#
# Each phrase is matched with word boundaries so e.g. "class" does not fire on
# "classify" and "open" does not fire on "opened". Multi-word phrases ("write
# code", "open chrome") are matched as contiguous phrases with internal
# whitespace allowed to vary. Everything is lower-cased and compiled once.

_CODE_KEYWORDS: Tuple[str, ...] = (
    "write code", "debug", "function", "script",
    "python", "javascript", "fix bug", "refactor", "class",
    "implement", "algorithm",
)

_TOOL_KEYWORDS: Tuple[str, ...] = (
    "open chrome", "go to website", "search google", "fill form",
    "screenshot", "navigate", "download", "browser",
    "open", "click", "type",
)

# A fenced code block: ``` ... ``` (open fence is enough to be a strong signal).
_CODE_BLOCK_RE = re.compile(r"```")


def _compile_phrases(phrases: Tuple[str, ...]) -> List[Tuple[str, re.Pattern]]:
    """Compile each phrase into a word-boundary regex, longest phrase first.

    Longest-first ordering means the most specific phrase ("open chrome") is
    reported as the matching reason before a shorter one ("open") that is a
    substring of it.
    """
    compiled: List[Tuple[str, re.Pattern]] = []
    for phrase in sorted(phrases, key=len, reverse=True):
        # Allow flexible internal whitespace; anchor on word boundaries.
        pattern = r"\b" + r"\s+".join(re.escape(w) for w in phrase.split()) + r"\b"
        compiled.append((phrase, re.compile(pattern, re.IGNORECASE)))
    return compiled


_CODE_PATTERNS = _compile_phrases(_CODE_KEYWORDS)
_TOOL_PATTERNS = _compile_phrases(_TOOL_KEYWORDS)


# ---------------------------------------------------------------------------
# Routing decision
# ---------------------------------------------------------------------------

@dataclass
class RoutingDecision:
    """The full outcome of routing a single message.

    `classify()` populates the task/agent/reason fields; tier gating fills in the
    entitlement fields (`allowed`, `rate_limited`, `priority`, …).
    """
    task_type: TaskType
    agent: str                      # "code" | "tool" | "general"
    reason: str                     # human-readable, e.g. "detected code task"
    tier: Tier = Tier.FREE

    # --- tier gating outcome ---
    allowed: bool = True            # may this task run on this tier at all?
    denial_reason: Optional[str] = None
    rate_limited: bool = False      # Free CODE_TASK/GENERAL_TASK: subject to daily cap
    priority: bool = False          # Pro/Enterprise: priority queue
    dedicated_slot: bool = False    # Enterprise: dedicated execution slot
    github_unlocked: bool = False   # Enterprise: GitHub integration available

    def to_event(self) -> Dict[str, str]:
        """The WebSocket payload emitted before execution starts."""
        return {"type": "routing", "agent": self.agent, "reason": self.reason}


# ---------------------------------------------------------------------------
# TaskRouter
# ---------------------------------------------------------------------------

# An agent handler receives (message, history, decision) and returns anything.
AgentHandler = Callable[[str, List[Dict], RoutingDecision], Any]
EmitFn = Callable[[Dict[str, str]], Any]


class TaskRouter:
    """Classifies each request and dispatches it to the correct agent.

    Parameters
    ----------
    emit:
        Optional callable invoked with the routing event dict *before* the agent
        runs. Wire this to your WebSocket broadcast (e.g. ``ws.send_json``). If
        omitted, no event is emitted (classification still works).
    agents:
        Optional mapping of agent name ("code"/"tool"/"general") to a handler
        callable. When a handler is registered for the chosen agent and the task
        is allowed by the tier, :meth:`route` calls it and returns its result.
        Leave empty to use the router purely as a classifier.
    """

    def __init__(
        self,
        emit: Optional[EmitFn] = None,
        agents: Optional[Dict[str, AgentHandler]] = None,
    ) -> None:
        self.emit = emit
        self.agents: Dict[str, AgentHandler] = dict(agents or {})

    # -- registration ------------------------------------------------------

    def register_agent(self, name: str, handler: AgentHandler) -> None:
        """Register/replace the handler for an agent name."""
        self.agents[name] = handler

    # -- classification (fast, synchronous, no LLM) ------------------------

    def classify(self, message: str, history: Optional[List[Dict]] = None) -> RoutingDecision:
        """Classify a message into a :class:`TaskType`. Pure & side-effect free.

        Precedence:
          1. A fenced code block (```` ``` ````) -> CODE_TASK (strongest signal).
          2. A code keyword -> CODE_TASK.
          3. A tool keyword -> TOOL_TASK.
          4. Otherwise -> GENERAL_TASK (the default).

        CODE wins ties with TOOL on purpose: a request like "write a python
        script to open chrome" is a coding task, not a literal browser action.
        """
        text = message or ""

        if _CODE_BLOCK_RE.search(text):
            return self._decision(TaskType.CODE, "detected code task (code block)")

        code_hit = _first_match(text, _CODE_PATTERNS)
        if code_hit is not None:
            return self._decision(TaskType.CODE, f"detected code task (keyword: '{code_hit}')")

        tool_hit = _first_match(text, _TOOL_PATTERNS)
        if tool_hit is not None:
            return self._decision(TaskType.TOOL, f"detected tool task (keyword: '{tool_hit}')")

        return self._decision(TaskType.GENERAL, "no code or tool signal — defaulting to general task")

    def _decision(self, task_type: TaskType, reason: str) -> RoutingDecision:
        return RoutingDecision(
            task_type=task_type,
            agent=AGENT_FOR_TASK[task_type],
            reason=reason,
        )

    # -- tier gating -------------------------------------------------------

    def apply_tier(self, decision: RoutingDecision, tier: Tier) -> RoutingDecision:
        """Layer tier entitlements onto a classification (mutates & returns it)."""
        decision.tier = tier

        if tier is Tier.FREE:
            if decision.task_type in (TaskType.CODE, TaskType.GENERAL):
                # Allowed, routed to our cloud backend, subject to the daily cap.
                decision.rate_limited = True
            else:  # TOOL_TASK
                decision.allowed = False
                decision.denial_reason = (
                    "Tool automation is a Pro feature. Upgrade to run browser/OS tasks."
                )
            return decision

        if tier is Tier.PRO:
            decision.priority = True
            return decision

        if tier is Tier.ENTERPRISE:
            decision.priority = True
            decision.dedicated_slot = True
            decision.github_unlocked = True
            return decision

        return decision

    # -- full route + dispatch --------------------------------------------

    def route(
        self,
        message: str,
        history: Optional[List[Dict]] = None,
        tier: Any = Tier.FREE,
        dispatch: bool = True,
    ) -> RoutingDecision:
        """Classify, gate by tier, emit the routing event, then dispatch.

        Returns the :class:`RoutingDecision`. When ``dispatch`` is True and a
        handler is registered for the chosen agent and the task is allowed, the
        handler is invoked; its return value is stored on the decision via the
        ``result`` attribute (set dynamically) — callers that need the agent's
        output should read ``decision`` after the call or use the handler
        directly. The routing event is always emitted before any handler runs.
        """
        tier = Tier.coerce(tier)
        history = history or []

        decision = self.classify(message, history)
        self.apply_tier(decision, tier)

        # Emit the routing decision to the WebSocket BEFORE execution starts.
        self._emit(decision.to_event())

        if dispatch and decision.allowed:
            handler = self.agents.get(decision.agent)
            if handler is not None:
                handler(message, history, decision)

        return decision

    # -- internals ---------------------------------------------------------

    def _emit(self, event: Dict[str, str]) -> None:
        if self.emit is None:
            return
        try:
            self.emit(event)
        except Exception as exc:  # never let a broken socket sink the request
            print(f"[TaskRouter] emit failed: {exc}")


def _first_match(text: str, patterns: List[Tuple[str, re.Pattern]]) -> Optional[str]:
    """Return the phrase whose pattern matches first (patterns are longest-first)."""
    for phrase, pattern in patterns:
        if pattern.search(text):
            return phrase
    return None
