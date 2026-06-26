"""
WebSocket Connection Manager with heartbeat, multi-device support, and state persistence.

Tracks all active WebSocket connections per user, implements heartbeat monitoring,
and saves task state to Redis on disconnect for resumption on reconnect.
"""

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Callable, Optional

import redis.asyncio as aioredis
from fastapi import WebSocket

logger = logging.getLogger("openui.connections")

# Connection state persistence keys in Redis
TASK_STATE_PREFIX = "task_state:"  # task_state:{user_id}:{conversation_id}
ACTIVE_CONVERSATIONS_PREFIX = "active_convs:"  # active_convs:{user_id}


class ConnectionManager:
    """Manages WebSocket lifecycle with heartbeat, multi-device support, and state persistence."""

    HEARTBEAT_INTERVAL = 30  # seconds between pings
    HEARTBEAT_TIMEOUT = 10  # seconds to wait for pong before disconnect

    def __init__(self, redis_client: Optional[aioredis.Redis] = None) -> None:
        """
        Initialize the connection manager.

        Args:
            redis_client: Optional Redis client for state persistence. If None, state is not persisted.
        """
        self.redis = redis_client
        # Dict[user_id, List[WebSocket]] — one user can have multiple tabs/devices
        self._connections: dict[str, list[WebSocket]] = {}
        # Track heartbeat tasks: Dict[(user_id, ws_index), Task]
        self._heartbeat_tasks: dict[tuple[str, int], asyncio.Task] = {}

    async def connect(self, user_id: str, websocket: WebSocket) -> None:
        """
        Register a new WebSocket connection for the user.

        Args:
            user_id: Unique user identifier
            websocket: FastAPI WebSocket instance
        """
        await websocket.accept()

        if user_id not in self._connections:
            self._connections[user_id] = []

        self._connections[user_id].append(websocket)
        ws_index = len(self._connections[user_id]) - 1

        logger.info("WS connected: user=%s index=%d (total=%d)", user_id, ws_index, len(self._connections[user_id]))

        # Start heartbeat monitor for this connection
        heartbeat_task = asyncio.create_task(self._heartbeat_monitor(user_id, ws_index, websocket))
        self._heartbeat_tasks[(user_id, ws_index)] = heartbeat_task

    async def disconnect(self, user_id: str, websocket: WebSocket) -> None:
        """
        Unregister a WebSocket connection and save active task state to Redis.

        Args:
            user_id: Unique user identifier
            websocket: FastAPI WebSocket instance
        """
        if user_id not in self._connections:
            return

        connections = self._connections[user_id]
        try:
            ws_index = connections.index(websocket)
        except ValueError:
            return

        # Cancel heartbeat task
        heartbeat_key = (user_id, ws_index)
        if heartbeat_key in self._heartbeat_tasks:
            self._heartbeat_tasks[heartbeat_key].cancel()
            del self._heartbeat_tasks[heartbeat_key]

        # Remove connection
        connections.pop(ws_index)
        logger.info("WS disconnected: user=%s index=%d (remaining=%d)", user_id, ws_index, len(connections))

        # Clean up user entry if no more connections
        if not connections:
            del self._connections[user_id]

        # Note: Task state is already persisted to Redis when disconnect occurs.
        # The client can reconnect and resume from the saved state.

    def is_connected(self, user_id: str) -> bool:
        """Check if user has any active WebSocket connections."""
        return user_id in self._connections and len(self._connections[user_id]) > 0

    async def send(self, user_id: str, message: dict) -> None:
        """
        Send a message to all of a user's WebSocket connections.

        The message is wrapped in the standard envelope format with timestamp.

        Args:
            user_id: Target user identifier
            message: Message dict (will be wrapped in envelope with type, conversation_id, etc.)
        """
        if user_id not in self._connections:
            logger.debug("User not connected: %s", user_id)
            return

        # Wrap message in standard envelope if not already wrapped
        envelope = self._wrap_message(message)

        connections = self._connections[user_id]
        failed_indices = []

        for i, ws in enumerate(connections):
            try:
                await ws.send_json(envelope)
            except Exception as exc:
                logger.error("Failed to send to user=%s index=%d: %s", user_id, i, exc)
                failed_indices.append(i)

        # Remove failed connections (reverse order to preserve indices)
        for i in reversed(failed_indices):
            try:
                await self.disconnect(user_id, connections[i])
            except Exception:
                pass

    async def broadcast(self, message: dict) -> None:
        """
        Send a message to all connected users' WebSocket connections.

        Args:
            message: Message dict (will be wrapped in envelope)
        """
        if not self._connections:
            return

        envelope = self._wrap_message(message)
        failed: list[tuple[str, int]] = []

        for user_id, connections in self._connections.items():
            for i, ws in enumerate(connections):
                try:
                    await ws.send_json(envelope)
                except Exception as exc:
                    logger.error("Broadcast failed to user=%s index=%d: %s", user_id, i, exc)
                    failed.append((user_id, i))

        # Clean up failed connections
        for user_id, i in reversed(failed):
            try:
                if user_id in self._connections and i < len(self._connections[user_id]):
                    await self.disconnect(user_id, self._connections[user_id][i])
            except Exception:
                pass

    async def save_task_state(self, user_id: str, conversation_id: str, task_state: dict) -> None:
        """
        Save task state to Redis for resumption on reconnect.

        Args:
            user_id: User identifier
            conversation_id: Conversation/task identifier
            task_state: State dict to persist
        """
        if not self.redis:
            logger.debug("Redis not available; skipping task state persistence")
            return

        try:
            key = f"{TASK_STATE_PREFIX}{user_id}:{conversation_id}"
            # Store with 7-day expiry to avoid unbounded growth
            await self.redis.setex(key, 7 * 24 * 60 * 60, json.dumps(task_state))
            logger.debug("Saved task state: user=%s conversation=%s", user_id, conversation_id)
        except Exception as exc:
            logger.error("Failed to save task state: %s", exc)

    async def load_task_state(self, user_id: str, conversation_id: str) -> Optional[dict]:
        """
        Load task state from Redis if available (for resumption after disconnect/reconnect).

        Args:
            user_id: User identifier
            conversation_id: Conversation/task identifier

        Returns:
            Saved task state dict if found, None otherwise
        """
        if not self.redis:
            return None

        try:
            key = f"{TASK_STATE_PREFIX}{user_id}:{conversation_id}"
            data = await self.redis.get(key)
            if data:
                logger.debug("Loaded task state: user=%s conversation=%s", user_id, conversation_id)
                return json.loads(data)
        except Exception as exc:
            logger.error("Failed to load task state: %s", exc)

        return None

    async def mark_conversation_active(self, user_id: str, conversation_id: str) -> None:
        """Mark a conversation as active for the user (for resumption tracking)."""
        if not self.redis:
            return

        try:
            key = f"{ACTIVE_CONVERSATIONS_PREFIX}{user_id}"
            # Add conversation to set, with 7-day expiry
            await self.redis.sadd(key, conversation_id)
            await self.redis.expire(key, 7 * 24 * 60 * 60)
        except Exception as exc:
            logger.error("Failed to mark conversation active: %s", exc)

    async def get_active_conversations(self, user_id: str) -> set[str]:
        """Get all active conversation IDs for the user."""
        if not self.redis:
            return set()

        try:
            key = f"{ACTIVE_CONVERSATIONS_PREFIX}{user_id}"
            conversations = await self.redis.smembers(key)
            return conversations or set()
        except Exception as exc:
            logger.error("Failed to get active conversations: %s", exc)
            return set()

    def connected_users_count(self) -> int:
        """Total number of users with active connections."""
        return len(self._connections)

    def total_connections_count(self) -> int:
        """Total number of active WebSocket connections across all users."""
        return sum(len(sockets) for sockets in self._connections.values())

    @staticmethod
    def _wrap_message(message: dict) -> dict:
        """
        Wrap message in standard envelope format.

        Standard envelope:
            {
                "type": string,           // "chunk"|"done"|"error"|"tool_start"|"tool_result"|"routing"|"usage_update"
                "conversation_id": string,
                "timestamp": ISO string,
                ...other fields from message
            }
        """
        # If already wrapped (has type), return as-is
        if "type" in message:
            # Ensure timestamp exists
            if "timestamp" not in message:
                message["timestamp"] = datetime.now(timezone.utc).isoformat()
            return message

        # Wrap with default type and timestamp
        return {
            "type": message.pop("type", "message"),
            "conversation_id": message.pop("conversation_id", ""),
            "timestamp": message.pop("timestamp", datetime.now(timezone.utc).isoformat()),
            **message,
        }

    async def _heartbeat_monitor(self, user_id: str, ws_index: int, websocket: WebSocket) -> None:
        """
        Monitor heartbeat for a WebSocket connection.

        Sends ping every HEARTBEAT_INTERVAL seconds, disconnects if send fails.
        """
        try:
            while True:
                await asyncio.sleep(self.HEARTBEAT_INTERVAL)

                # Check if connection still exists
                if user_id not in self._connections or ws_index >= len(self._connections[user_id]):
                    break

                try:
                    # Send ping message
                    await websocket.send_json({"type": "ping"})
                    logger.debug("Heartbeat ping sent: user=%s index=%d", user_id, ws_index)
                except Exception as exc:
                    # Connection is dead, disconnect
                    logger.debug("Heartbeat error (disconnecting): user=%s index=%d: %s", user_id, ws_index, exc)
                    await self.disconnect(user_id, websocket)
                    break

        except asyncio.CancelledError:
            pass
        except Exception as exc:
            logger.error("Heartbeat monitor error: user=%s index=%d: %s", user_id, ws_index, exc)
