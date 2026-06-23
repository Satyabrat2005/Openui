"""
OpenUI Agent - The main agent loop.
Takes user commands, calls LLM, executes tools, loops until done.
Supports autonomous mode with task planning, execution, and real-time screen awareness.
"""

import json
import time
from typing import Optional, Callable

from rich.console import Console
from rich.panel import Panel
from rich.text import Text

from models.prompts import build_system_prompt, TOOL_SCHEMAS
from core.memory import ConversationMemory, Message
from core.router import ModelRouter
from tools.registry import ToolRegistry
from core.vision_loop import VisionLoop
from core.task_planner import TaskPlanner
from core.task_executor import TaskExecutor

console = Console()


class Agent:
    """Main OpenUI agent that orchestrates LLM, tools, vision, and planning."""

    def __init__(self, config, tool_registry: ToolRegistry, router: ModelRouter):
        self.config = config
        self.tools = tool_registry
        self.router = router
        self.memory = ConversationMemory(max_context_tokens=config.agent_max_context_tokens)
        self._running = False
        self._on_speak: Optional[Callable] = None
        self.on_status_update: Optional[Callable[[str], None]] = None

        # Build system prompt
        from core.helpers import get_platform, get_screen_resolution, get_active_window_title
        platform = get_platform()
        resolution = f"{get_screen_resolution()[0]}x{get_screen_resolution()[1]}"
        active_win = get_active_window_title()
        system_text = build_system_prompt(platform, resolution, active_win)
        self.memory.system_message = Message(role="system", content=system_text)

        # Initialize vision loop, planner, and executor
        self.vision_loop = VisionLoop(config, router)
        self.task_planner = TaskPlanner(config, router)
        self.task_executor = TaskExecutor(config, tool_registry, router, self.vision_loop, self.task_planner)

        # Start background vision loop
        try:
            self.vision_loop.start()
        except Exception as e:
            print(f"[Agent] Failed to start VisionLoop: {e}")

    def set_speak_callback(self, callback: Callable):
        """Set a callback for TTS output."""
        self._on_speak = callback

    def _notify_status(self, text: str):
        """Invoke status update callback if set."""
        if self.on_status_update:
            try:
                self.on_status_update(text)
            except Exception:
                pass

    def process_command(self, user_input: str) -> str:
        """Process a user command through the planning/execution pipeline or the standard loop."""
        if not user_input.strip():
            return ""

        # Determine if this command is action-oriented (requires planning/execution)
        is_action = any(
            keyword in user_input.lower()
            for keyword in [
                "schedule", "book", "meeting", "attend", "click", "type",
                "open", "run", "do", "solve", "generate", "write", "go to"
            ]
        )

        if is_action:
            console.print(f"\n[bold cyan]Goal:[/] {user_input}")
            self._notify_status(f"Goal: {user_input}\nStatus: Analyzing current screen state...")
            
            # Get current screen state description
            screen_state = ""
            try:
                screen_state = self.vision_loop.get_state().summary()
            except Exception:
                pass

            # Create plan
            self._notify_status(f"Goal: {user_input}\nStatus: Planning steps autonomously...")
            plan = self.task_planner.create_plan(user_input, screen_state)

            # Define progress callback
            def on_step_complete(step, p):
                progress_text = f"Goal: {p.goal}\nProgress: {p.progress}\n\n"
                for s in p.steps:
                    status_symbol = "[ ]"
                    if s.status.value == "completed":
                        status_symbol = "[✓]"
                    elif s.status.value == "failed":
                        status_symbol = "[✗]"
                    elif s.status.value == "in_progress":
                        status_symbol = "[▶]"
                    elif s.status.value == "cancelled":
                        status_symbol = "[ー]"
                    progress_text += f"{status_symbol} {s.description}\n"
                self._notify_status(progress_text)

            # Setup callbacks
            self.task_executor.set_callbacks(
                on_step_complete=on_step_complete,
                on_plan_complete=lambda p, success: self._notify_status(p.summary)
            )

            # Notify initial plan before executing
            on_step_complete(None, plan)

            # Execute plan
            console.print("[dim]Executing plan autonomously...[/dim]")
            self.task_executor.execute_plan(plan, blocking=True)

            final_response = plan.summary
        else:
            # Fall back to standard conversational chat loop
            self.memory.add_user(user_input)

            if self.config.agent_verbose:
                console.print(f"\n[bold cyan]You:[/] {user_input}")

            max_iterations = self.config.agent_max_tool_iterations
            iteration = 0
            final_response = ""

            while iteration < max_iterations:
                iteration += 1

                messages = self.memory.get_messages()
                response = self.router.chat(
                    messages=messages,
                    tools=TOOL_SCHEMAS,
                )

                if response.finish_reason == "error":
                    final_response = response.content
                    self.memory.add_assistant(final_response)
                    break

                if not response.tool_calls:
                    final_response = response.content
                    self.memory.add_assistant(final_response)
                    break

                self.memory.add_assistant(
                    content=response.content,
                    tool_calls=response.tool_calls,
                )

                if self.config.agent_verbose:
                    tool_names = [tc["function"]["name"] for tc in response.tool_calls]
                    console.print(f"[yellow]Tool calls (iter {iteration}):[/] {', '.join(tool_names)}")

                for tool_call in response.tool_calls:
                    fn_name = tool_call["function"]["name"]
                    fn_args_raw = tool_call["function"]["arguments"]
                    tool_call_id = tool_call["id"]

                    try:
                        fn_args = json.loads(fn_args_raw) if isinstance(fn_args_raw, str) else fn_args_raw
                    except json.JSONDecodeError:
                        fn_args = {}
                        error_msg = f"Failed to parse tool arguments: {fn_args_raw}"
                        self.memory.add_tool_result(fn_name, tool_call_id, f"ERROR: {error_msg}")
                        continue

                    result = self._execute_tool(fn_name, fn_args)

                    if self.config.agent_verbose:
                        result_preview = result[:200].replace("\n", " ")
                        console.print(f"[dim]  {fn_name} → {result_preview}[/dim]")

                    self.memory.add_tool_result(fn_name, tool_call_id, result)

            if response.usage:
                console.print(
                    f"[dim]Tokens: {response.usage.get('total_tokens', '?')} | "
                    f"Latency: {response.latency_ms}ms | Iterations: {iteration}[/dim]"
                )

        # Print final response
        if final_response:
            console.print(Panel(
                Text(final_response),
                title="[bold green]OpenUI[/bold green]",
                border_style="green",
            ))

        # Speak response if enabled
        if final_response and self._on_speak and self.config.agent_auto_speak:
            self._on_speak(final_response)

        return final_response

    def _execute_tool(self, tool_name: str, args: dict) -> str:
        """Execute a tool by name with given arguments."""
        tool = self.tools.get(tool_name)
        if not tool:
            return f"ERROR: Unknown tool '{tool_name}'. Available tools: {self.tools.list_names()}"

        try:
            return tool.execute(args)
        except Exception as e:
            return f"ERROR executing {tool_name}: {type(e).__name__}: {e}"

    def reset(self):
        """Clear conversation history."""
        self.memory.clear()
        console.print("[yellow]Conversation cleared.[/yellow]")

    def shutdown(self):
        """Stop background threads."""
        try:
            self.vision_loop.stop()
        except Exception:
            pass
