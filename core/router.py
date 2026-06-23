"""
Model Router - Handles communication with LLM backends.
Supports Ollama (local) and OpenAI-compatible APIs.
"""

import json
import time
from typing import List, Dict, Optional, Any, AsyncIterator
from dataclasses import dataclass

from openai import OpenAI, APIError, APITimeoutError


@dataclass
class LLMResponse:
    """Wrapper for LLM response."""
    content: str
    tool_calls: Optional[List[Dict]] = None
    finish_reason: str = "stop"
    usage: Optional[Dict] = None
    latency_ms: float = 0.0


class ModelRouter:
    """Routes requests to the configured LLM backend."""

    def __init__(self, config):
        """
        Args:
            config: OpenUI Config object
        """
        self.config = config
        self.model_name = config.model_name
        self.client = OpenAI(
            base_url=config.model_base_url,
            api_key=config.model_api_key,
            timeout=config.model_timeout,
        )
        # Test connection
        self._test_connection()

    def _test_connection(self):
        """Verify the LLM backend is reachable."""
        try:
            resp = self.client.models.list()
            model_names = [m.id for m in resp.data] if resp.data else []
            if self.model_name not in model_names:
                print(f"[Router] Warning: model '{self.model_name}' not found in available models: {model_names[:5]}")
            else:
                print(f"[Router] Connected to {self.config.model_provider} — model: {self.model_name}")
        except Exception as e:
            print(f"[Router] Warning: Could not verify model connection: {e}")
            print(f"[Router] Make sure Ollama is running: ollama serve")
            print(f"[Router] And model is pulled: ollama pull {self.model_name}")

    def chat(
        self,
        messages: List[Dict],
        tools: Optional[List[Dict]] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
    ) -> LLMResponse:
        """Send a chat completion request.

        Args:
            messages: List of OpenAI-format messages
            tools: Optional tool/function schemas
            temperature: Override config temperature
            max_tokens: Override config max_tokens

        Returns:
            LLMResponse with content and optional tool_calls
        """
        kwargs = {
            "model": self.model_name,
            "messages": messages,
            "temperature": temperature or self.config.model_temperature,
            "max_tokens": max_tokens or self.config.model_max_tokens,
        }
        if tools:
            kwargs["tools"] = tools
            kwargs["tool_choice"] = "auto"

        start = time.time()
        try:
            response = self.client.chat.completions.create(**kwargs)
            latency = (time.time() - start) * 1000

            choice = response.choices[0]
            content = choice.message.content or ""
            tool_calls = None

            if choice.message.tool_calls:
                tool_calls = []
                for tc in choice.message.tool_calls:
                    tool_calls.append({
                        "id": tc.id,
                        "type": "function",
                        "function": {
                            "name": tc.function.name,
                            "arguments": tc.function.arguments,
                        }
                    })

            usage = None
            if response.usage:
                usage = {
                    "prompt_tokens": response.usage.prompt_tokens,
                    "completion_tokens": response.usage.completion_tokens,
                    "total_tokens": response.usage.total_tokens,
                }

            return LLMResponse(
                content=content,
                tool_calls=tool_calls,
                finish_reason=choice.finish_reason or "stop",
                usage=usage,
                latency_ms=round(latency, 1),
            )

        except APITimeoutError:
            return LLMResponse(
                content="Error: LLM request timed out. The model may be busy or the request too complex.",
                finish_reason="error",
            )
        except APIError as e:
            return LLMResponse(
                content=f"Error from LLM API: {e}",
                finish_reason="error",
            )
        except Exception as e:
            return LLMResponse(
                content=f"Unexpected error: {e}",
                finish_reason="error",
            )

    def describe_image(self, image_b64: str, prompt: str = "Describe what you see on this screen in detail.") -> str:
        """Send a screenshot to a vision model for description.

        Args:
            image_b64: Base64-encoded PNG image
            prompt: What to ask about the image

        Returns:
            Model's description of the image
        """
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:image/png;base64,{image_b64}"}
                    }
                ]
            }
        ]

        # Use vision model if different from main model
        model = self.config.vision_model or self.model_name

        start = time.time()
        try:
            response = self.client.chat.completions.create(
                model=model,
                messages=messages,
                max_tokens=1000,
                temperature=0.1,
            )
            latency = (time.time() - start) * 1000
            result = response.choices[0].message.content or ""
            print(f"[Router] Vision description ({round(latency)}ms): {result[:100]}...")
            return result
        except Exception as e:
            print(f"[Router] Vision error: {e}")
            return f"Error analyzing image: {e}"

    def switch_model(self, model_name: str):
        """Switch to a different model at runtime."""
        self.model_name = model_name
        print(f"[Router] Switched to model: {model_name}")
