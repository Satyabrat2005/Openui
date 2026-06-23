"""
Task Executor — Runs task plans step by step with screen verification.

Takes a TaskPlan from the TaskPlanner and executes each step:
1. Execute the tool call
2. Capture screen to verify result
3. Compare actual vs expected state
4. Adapt if something unexpected happened (retry, replan)
5. Move to next step

Supports pause/resume/cancel for user control.
"""

import time
import threading
from typing import Optional, Callable, Dict, Any
from enum import Enum

from rich.console import Console
from rich.panel import Panel

from core.task_planner import TaskPlan, TaskStep, TaskStatus, TaskPlanner
from core.vision_loop import VisionLoop

console = Console()


class ExecutionMode(Enum):
    AUTO = "auto"           # Execute all steps without pause
    STEP_BY_STEP = "step"   # Pause after each step for user review
    CONFIRM_ONLY = "confirm"  # Auto-execute but pause for confirmation steps


class TaskExecutor:
    """Executes task plans with real-time screen verification and adaptive replanning."""

    def __init__(self, config, tool_registry, router, vision_loop: VisionLoop, planner: TaskPlanner):
        """
        Args:
            config: OpenUI Config object
            tool_registry: ToolRegistry with all available tools
            router: ModelRouter for LLM calls
            vision_loop: VisionLoop for screen state
            planner: TaskPlanner for replanning on failure
        """
        self.config = config
        self.tools = tool_registry
        self.router = router
        self.vision = vision_loop
        self.planner = planner

        self._current_plan: Optional[TaskPlan] = None
        self._running = False
        self._paused = False
        self._mode = ExecutionMode.CONFIRM_ONLY
        self._on_step_complete: Optional[Callable] = None
        self._on_plan_complete: Optional[Callable] = None
        self._on_confirmation_needed: Optional[Callable] = None
        self._confirmation_event = threading.Event()
        self._confirmation_result = False
        self._lock = threading.Lock()

    @property
    def current_plan(self) -> Optional[TaskPlan]:
        return self._current_plan

    @property
    def is_running(self) -> bool:
        return self._running

    def set_mode(self, mode: ExecutionMode):
        """Set execution mode."""
        self._mode = mode

    def set_callbacks(
        self,
        on_step_complete: Optional[Callable] = None,
        on_plan_complete: Optional[Callable] = None,
        on_confirmation_needed: Optional[Callable] = None,
    ):
        """Set event callbacks.

        Args:
            on_step_complete: Called after each step with (step, plan)
            on_plan_complete: Called when plan finishes with (plan, success)
            on_confirmation_needed: Called when user confirmation needed with (step) → must call confirm()
        """
        self._on_step_complete = on_step_complete
        self._on_plan_complete = on_plan_complete
        self._on_confirmation_needed = on_confirmation_needed

    def execute_plan(self, plan: TaskPlan, blocking: bool = True) -> TaskPlan:
        """Execute a task plan.

        Args:
            plan: TaskPlan to execute
            blocking: If True, block until plan completes. If False, run in background.

        Returns:
            The plan with updated step results
        """
        self._current_plan = plan
        self._running = True
        plan.status = TaskStatus.IN_PROGRESS

        if blocking:
            self._execute_loop(plan)
        else:
            thread = threading.Thread(
                target=self._execute_loop, args=(plan,), daemon=True, name="TaskExecutor"
            )
            thread.start()

        return plan

    def pause(self):
        """Pause execution after current step."""
        self._paused = True
        if self._current_plan:
            self._current_plan.status = TaskStatus.PAUSED
        console.print("[yellow][Executor] Paused.[/yellow]")

    def resume(self):
        """Resume paused execution."""
        self._paused = False
        if self._current_plan:
            self._current_plan.status = TaskStatus.IN_PROGRESS
        console.print("[green][Executor] Resumed.[/green]")

    def cancel(self):
        """Cancel current execution."""
        self._running = False
        if self._current_plan:
            self._current_plan.status = TaskStatus.CANCELLED
        console.print("[red][Executor] Cancelled.[/red]")

    def confirm(self, approved: bool = True):
        """User confirms or rejects a confirmation-required step.

        Args:
            approved: True to proceed, False to skip
        """
        self._confirmation_result = approved
        self._confirmation_event.set()

    def _execute_loop(self, plan: TaskPlan):
        """Main execution loop."""
        console.print(Panel(
            f"[bold]Executing Plan:[/bold] {plan.goal}\n"
            f"[dim]{len(plan.steps)} steps to execute[/dim]",
            border_style="blue",
        ))

        while plan.current_step_index < len(plan.steps) and self._running:
            # Check for pause
            while self._paused and self._running:
                time.sleep(0.2)

            if not self._running:
                break

            step = plan.steps[plan.current_step_index]

            # Check if confirmation needed
            if step.requires_confirmation and self._mode != ExecutionMode.AUTO:
                console.print(f"\n[yellow]⚠ Confirmation required:[/yellow] {step.description}")
                if self._on_confirmation_needed:
                    self._on_confirmation_needed(step)

                # Wait for confirmation
                self._confirmation_event.clear()
                self._confirmation_event.wait(timeout=300)  # 5 min timeout

                if not self._confirmation_result:
                    step.status = TaskStatus.CANCELLED
                    step.result = "Skipped by user"
                    console.print(f"  [dim]Step {step.id} skipped by user[/dim]")
                    plan.current_step_index += 1
                    continue

            # Execute the step
            success = self._execute_step(step, plan)

            # Callback
            if self._on_step_complete:
                self._on_step_complete(step, plan)

            if success:
                plan.current_step_index += 1
            else:
                # Try to replan
                if step.retry_count < step.max_retries:
                    step.retry_count += 1
                    console.print(f"  [yellow]Retrying step {step.id} (attempt {step.retry_count + 1})[/yellow]")
                    # Get fresh screen state for replanning
                    screen_state = self.vision.get_state().summary() if self.vision else ""
                    new_steps = self.planner.replan_step(plan, step, screen_state)
                    if new_steps:
                        # Insert recovery steps
                        insert_pos = plan.current_step_index + 1
                        for ns in reversed(new_steps):
                            ns.id = insert_pos
                            plan.steps.insert(insert_pos, ns)
                        plan.current_step_index += 1
                        console.print(f"  [cyan]Replanned: added {len(new_steps)} recovery steps[/cyan]")
                    else:
                        plan.current_step_index += 1
                else:
                    console.print(f"  [red]Step {step.id} failed permanently after {step.max_retries} retries[/red]")
                    plan.current_step_index += 1

            # Step-by-step mode: pause after each step
            if self._mode == ExecutionMode.STEP_BY_STEP:
                self._paused = True
                console.print("[dim]Step-by-step mode: paused. Call executor.resume() to continue.[/dim]")

        # Plan complete
        self._running = False
        if plan.is_complete:
            plan.status = TaskStatus.COMPLETED
            plan.completed_at = time.time()
            console.print(Panel(
                f"[bold green]Plan Complete:[/bold green] {plan.goal}\n"
                f"[dim]{plan.progress}[/dim]",
                border_style="green",
            ))
        elif plan.status != TaskStatus.CANCELLED:
            plan.status = TaskStatus.FAILED
            console.print(Panel(
                f"[bold red]Plan Failed:[/bold red] {plan.goal}\n"
                f"[dim]{plan.progress}[/dim]",
                border_style="red",
            ))

        # Generate summary
        plan.summary = self._generate_summary(plan)

        if self._on_plan_complete:
            self._on_plan_complete(plan, plan.status == TaskStatus.COMPLETED)

        return plan

    def _execute_step(self, step: TaskStep, plan: TaskPlan) -> bool:
        """Execute a single step.

        Args:
            step: The step to execute
            plan: The parent plan (for context)

        Returns:
            True if step succeeded
        """
        step.status = TaskStatus.IN_PROGRESS
        step.timestamp = time.time()

        console.print(f"\n[bold]Step {step.id}:[/bold] {step.description}")

        if not step.tool_name:
            # This is a "think" or "observe" step — use LLM
            step.status = TaskStatus.COMPLETED
            step.result = "Observation step — no tool needed"
            return True

        # Execute the tool
        tool = self.tools.get(step.tool_name)
        if not tool:
            # Try a special handler (describe_screen, join_meeting, etc.)
            result = self._handle_special_tool(step.tool_name, step.tool_args or {})
            if result is not None:
                step.result = result
                step.status = TaskStatus.COMPLETED
                console.print(f"  [green]✓[/green] {result[:150]}")
                return True

            step.status = TaskStatus.FAILED
            step.error = f"Unknown tool: {step.tool_name}"
            console.print(f"  [red]✗ {step.error}[/red]")
            return False

        try:
            result = tool.execute(step.tool_args or {})
            step.result = result

            # Check if result indicates error
            if result.startswith("ERROR"):
                step.status = TaskStatus.FAILED
                step.error = result
                console.print(f"  [red]✗ {result[:150]}[/red]")
                return False

            step.status = TaskStatus.COMPLETED
            console.print(f"  [green]✓[/green] {result[:150]}")

            # Post-step screen verification
            if step.requires_vision and self.vision:
                time.sleep(0.5)  # Wait for screen to update
                self.vision.capture_now()

            return True

        except Exception as e:
            step.status = TaskStatus.FAILED
            step.error = f"{type(e).__name__}: {e}"
            console.print(f"  [red]✗ Exception: {step.error}[/red]")
            return False

    def _handle_special_tool(self, tool_name: str, args: dict) -> Optional[str]:
        """Handle tools that aren't in the standard registry.

        Args:
            tool_name: Name of the special tool
            args: Tool arguments

        Returns:
            Result string, or None if not a special tool
        """
        if tool_name == "describe_screen":
            if self.vision:
                state = self.vision.capture_now()
                return state.summary()
            return "Vision loop not available"

        if tool_name == "wait":
            seconds = args.get("seconds", 2)
            time.sleep(seconds)
            return f"Waited {seconds} seconds"

        if tool_name == "think":
            # Let the LLM think about the current state
            thought = args.get("thought", "")
            return f"Agent thought: {thought}"

        return None

    def _generate_summary(self, plan: TaskPlan) -> str:
        """Generate a human-readable summary of what was accomplished.

        Args:
            plan: The completed/failed plan

        Returns:
            Summary text
        """
        completed = [s for s in plan.steps if s.status == TaskStatus.COMPLETED]
        failed = [s for s in plan.steps if s.status == TaskStatus.FAILED]

        summary_parts = [f"Goal: {plan.goal}", f"Status: {plan.status.value}", f"Progress: {plan.progress}"]

        if completed:
            summary_parts.append("\nCompleted steps:")
            for s in completed:
                summary_parts.append(f"  ✓ {s.description}")

        if failed:
            summary_parts.append("\nFailed steps:")
            for s in failed:
                summary_parts.append(f"  ✗ {s.description}: {s.error}")

        # Use LLM to generate a natural language summary
        try:
            messages = [
                {"role": "system", "content": "Summarize this task execution result in 2-3 sentences for the user."},
                {"role": "user", "content": "\n".join(summary_parts)},
            ]
            response = self.router.chat(messages=messages, max_tokens=200)
            return response.content
        except Exception:
            return "\n".join(summary_parts)
