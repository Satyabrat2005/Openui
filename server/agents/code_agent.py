"""
CodeAgent — Coding-specialized agent that routes to Ollama.

Streams responses token-by-token over a WebSocket channel.
Falls back to claude-haiku-4-5-20251001 when Ollama is unreachable.

WebSocket message protocol:
  chunk:  { "type": "chunk", "delta": "..." }
  done:   { "type": "done", "model": "<name>", "latency_ms": N }
  error:  { "type": "error", "message": "..." }
"""

import os
import time
from typing import Any, Dict, List, Optional, Union

from openai import AsyncOpenAI, APIConnectionError, APIError, APITimeoutError
import anthropic


# ---------------------------------------------------------------------------
# Tier identifiers — intentionally mirroring server/tiers.py TierId values
# so callers may pass either the TierId enum or bare strings.
# ---------------------------------------------------------------------------
TIER_FREE = "free"
TIER_PRO = "pro"
TIER_ENTERPRISE = "enterprise"

# Type alias: accepts TierId enum instances or plain tier strings
TierLike = Union[str, Any]

CODE_SYSTEM_PROMPT = (
    "You are a coding assistant integrated into OpenUI. "
    "Write clean, idiomatic, well-structured code. "
    "Explain each change and why it is needed. "
    "Follow patterns and conventions already present in the codebase. "
    "Add comments only for non-obvious logic, edge cases, or important invariants — "
    "never describe what the code obviously does. "
    "Prefer small, focused changes over large rewrites. "
    "Always handle errors and edge cases. "
    "When debugging, identify the root cause before suggesting a fix."
)

# First model in each list is the tier default
_TIER_MODELS: Dict[str, List[str]] = {
    TIER_FREE:       ["llama3:8b", "codellama:7b"],
    TIER_PRO:        ["llama3:70b", "codellama:34b"],
    TIER_ENTERPRISE: ["llama3:70b", "codellama:34b"],
}

_FALLBACK_MODEL = "claude-haiku-4-5-20251001"


def _default_ollama_base_url() -> str:
    """OpenAI-compatible Ollama endpoint, derived from OLLAMA_HOST for parity
    with the rest of the app (src/main/agent.ts reads the same env var)."""
    host = os.environ.get("OLLAMA_HOST", "http://localhost:11434").rstrip("/")
    return f"{host}/v1"


_MODEL_TEMPERATURE = 0.1
_MODEL_MAX_TOKENS = 4096
_MODEL_TIMEOUT_SEC = 120


class CodeAgent:
    """
    Coding-specialized agent backed by Ollama with Anthropic cloud fallback.

    Tier-based model selection:
      free:       llama3:8b  /  codellama:7b
      pro:        llama3:70b /  codellama:34b
      enterprise: same + any model on a user-configured endpoint

    Usage::

        agent = CodeAgent(tier="free")
        await agent.stream(messages, websocket)

        # or with a TierId enum from server.tiers:
        from server.tiers import TierId
        agent = CodeAgent(tier=TierId.PRO)
    """

    def __init__(
        self,
        tier: TierLike,
        model: Optional[str] = None,
        custom_endpoint: Optional[str] = None,
    ) -> None:
        """
        Args:
            tier: Subscription tier — "free" / "pro" / "enterprise" or a TierId enum.
            model: Override the default model; must be in the tier's allowed list
                   (Enterprise accepts any model when custom_endpoint is provided).
            custom_endpoint: Custom Ollama-compatible base URL (Enterprise only).
        """
        # Normalise enum or string to a plain string key
        self.tier: str = str(tier.value if hasattr(tier, "value") else tier).lower()

        allowed = _TIER_MODELS.get(self.tier, _TIER_MODELS[TIER_FREE])
        if model and model in allowed:
            self.model = model
        elif model and self.tier == TIER_ENTERPRISE and custom_endpoint:
            # Enterprise with a custom endpoint may run any user-configured model
            self.model = model
        else:
            self.model = allowed[0]

        self.base_url = custom_endpoint or _default_ollama_base_url()
        self.temperature = _MODEL_TEMPERATURE
        self.max_tokens = _MODEL_MAX_TOKENS

        # Async client pointing at Ollama's OpenAI-compatible API (or the
        # Enterprise custom endpoint). Ollama ignores the api_key but the SDK
        # requires a non-empty value.
        self._async_client = AsyncOpenAI(
            base_url=self.base_url,
            api_key="ollama",
            timeout=float(_MODEL_TIMEOUT_SEC),
        )

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def stream(self, messages: List[Dict], websocket: Any) -> None:
        """
        Stream a chat completion over the WebSocket.

        Prepends the coding system prompt, streams from Ollama, and
        automatically falls back to Anthropic if Ollama is unreachable.

        Args:
            messages: Conversation history in OpenAI message format.
            websocket: Any object exposing ``async send_json(dict) -> None``.
        """
        full_messages = [
            {"role": "system", "content": CODE_SYSTEM_PROMPT},
            *messages,
        ]

        start = time.time()
        try:
            await self._stream_ollama(full_messages, websocket, start)
        except (APIConnectionError, APITimeoutError, APIError, OSError) as exc:
            print(f"[CodeAgent] Ollama unavailable ({type(exc).__name__}): {exc}")
            await websocket.send_json({
                "type": "error",
                "message": "Local AI offline. Falling back to cloud...",
            })
            await self._stream_anthropic_fallback(full_messages, websocket)
        except Exception as exc:
            # Catch-all: surface Ollama error then fall back so the client isn't left hanging
            print(f"[CodeAgent] Unexpected streaming error: {exc}")
            await websocket.send_json({
                "type": "error",
                "message": "Local AI offline. Falling back to cloud...",
            })
            await self._stream_anthropic_fallback(full_messages, websocket)

    def available_models(self) -> List[str]:
        """Return the Ollama models allowed for this agent's tier."""
        return list(_TIER_MODELS.get(self.tier, _TIER_MODELS[TIER_FREE]))

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    async def _stream_ollama(
        self,
        messages: List[Dict],
        websocket: Any,
        start: float,
    ) -> None:
        """Stream tokens from Ollama and emit chunk / done events."""
        response_stream = await self._async_client.chat.completions.create(
            model=self.model,
            messages=messages,
            temperature=self.temperature,
            max_tokens=self.max_tokens,
            stream=True,
        )

        async for chunk in response_stream:
            delta = chunk.choices[0].delta.content
            if delta:
                await websocket.send_json({"type": "chunk", "delta": delta})

        latency_ms = round((time.time() - start) * 1000)
        await websocket.send_json({
            "type": "done",
            "model": self.model,
            "latency_ms": latency_ms,
        })

    async def _stream_anthropic_fallback(
        self,
        messages: List[Dict],
        websocket: Any,
    ) -> None:
        """Fallback: stream from claude-haiku when Ollama is down."""
        api_key = os.environ.get("ANTHROPIC_API_KEY", "")
        if not api_key:
            await websocket.send_json({
                "type": "error",
                "message": "Cloud fallback unavailable: ANTHROPIC_API_KEY not set.",
            })
            return

        # Anthropic separates system text from the conversation history
        system_parts: List[str] = []
        user_messages: List[Dict] = []
        for msg in messages:
            if msg["role"] == "system":
                system_parts.append(msg["content"])
            else:
                user_messages.append(msg)

        system_text = "\n".join(system_parts).strip() or CODE_SYSTEM_PROMPT

        client = anthropic.AsyncAnthropic(api_key=api_key)
        start = time.time()

        try:
            async with client.messages.stream(
                model=_FALLBACK_MODEL,
                max_tokens=4096,
                system=system_text,
                messages=user_messages,
            ) as stream:
                async for text in stream.text_stream:
                    await websocket.send_json({"type": "chunk", "delta": text})

            latency_ms = round((time.time() - start) * 1000)
            await websocket.send_json({
                "type": "done",
                "model": _FALLBACK_MODEL,
                "latency_ms": latency_ms,
            })

        except Exception as exc:
            await websocket.send_json({
                "type": "error",
                "message": f"Cloud fallback also failed: {exc}",
            })
