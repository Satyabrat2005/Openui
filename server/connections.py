"""
ConnectionManager — Robust WebSocket lifecycle management with heartbeat + state recovery.

Tracks all active WebSocket connections per user (multiple tabs/devices).
Implements heartbeat monitoring, connection recovery, and state persistence to Redis.

Usage:
    manager = ConnectionManager(redis_client)

    await manager.connect(user_id, websocket)
    await manager.send(user_id, {"type": "chunk", "delta": "..."})
    await manager.disconnect(user_id, websocket, save_task_state={...})
"""

import asyncio
import json
import time
from datetime import datetime
from typing import Any, Dict, List, Optional, Set
from enum import Enum

import redis.asyncio as redis


class MessageType(str, Enum):
    """Standardized message types for the WebSocket protocol."""
    CHUNK = "chunk"
    DONE = "done"
    ERROR = "error"
    TOOL_START = "tool_start"
    TOOL_RESULT = "tool_result"
    ROUTING = "routing"
    USAGE_UPDATE = "usage_update"
    PING = "ping"
    PONG = "pong"


class ConnectionManager:
    """
    Manages WebSocket lifecycle for multiple users with multiple connections per user.

    Features:
      - Track active connections: Dict[user_id, List[WebSocket]]
      - Heartbeat: ping every 30s, disconnect if no pong in 10s
      - Reconnect: save task state to Redis, recover on reconnect
      - Broadcast: send to all users or specific user's all sockets
      - Message envelope: standardized format with type, conversation_id, timestamp
    """

    HEARTBEAT_INTERVAL = 30  # seconds between pings
    HEARTBEAT_TIMEOUT = 10   # seconds to wait for pong

    REDIS_KEY_CONNECTIONS = "ws:connections:{user_id}"          # Set of connection IDs
    REDIS_KEY_TASK_STATE = "ws:task_state:{user_id}"            # Serialized task state
    REDIS_KEY_RECONNECT_WINDOW = "ws:reconnect:{user_id}"       # Temporary reconnect data
    REDIS_TTL_TASK_STATE = 3600  # 1 hour
    REDIS_TTL_RECONNECT = 300    # 5 minutes (user has 5m to reconnect)

    def __init__(self, redis_client: Optional[redis.Redis]) -> None:
        """
        Args:
            redis_client: redis.asyncio.Redis instance; if None, heartbeat + state recovery disabled.
        """
        self.redis = redis_client
        # In-memory tracking: user_id -> List[WebSocket]
        self.active_connections: Dict[str, List[Any]] = {}
        # In-memory heartbeat tasks: (user_id, ws_id) -> asyncio.Task
        self.heartbeat_tasks: Dict[tuple, asyncio.Task] = {}

    # ─────────────────────────────────────────────────────────────────────────────
    # Connection Lifecycle
    # ─────────────────────────────────────────────────────────────────────────────

    async def connect(self, user_id: str, websocket: Any) -> str:
        """
        Register a new WebSocket connection for a user.

        Args:
            user_id: The user's unique identifier.
            websocket: WebSocket connection object (must have send_json, receive_json).

        Returns:
            connection_id: Unique identifier for this connection.
        """
        user_id = user_id.strip()
        connection_id = f"{user_id}:{time.time_ns()}"

        # Add to in-memory tracking
        if user_id not in self.active_connections:
            self.active_connections[user_id] = []
        self.active_connections[user_id].append(websocket)

        # Log connection
        print(f"[ConnectionManager] User {user_id} connected (id={connection_id}); "
              f"total sockets for user: {len(self.active_connections[user_id])}")

        # Record in Redis if available
        if self.redis:
            try:
                key = self.REDIS_KEY_CONNECTIONS.format(user_id=user_id)
                await self.redis.sadd(key, connection_id)
                await self.redis.expire(key, self.REDIS_TTL_RECONNECT)
            except Exception as e:
                print(f"[ConnectionManager] Failed to record connection in Redis: {e}")

        # Start heartbeat task
        heartbeat_task = asyncio.create_task(
            self._heartbeat_loop(user_id, websocket, connection_id)
        )
        self.heartbeat_tasks[(user_id, connection_id)] = heartbeat_task

        return connection_id

    async def disconnect(
        self,
        user_id: str,
        websocket: Any,
        save_task_state: Optional[Dict[str, Any]] = None,
    ) -> None:
        """
        Unregister a WebSocket connection and optionally save task state for recovery.

        Args:
            user_id: The user's unique identifier.
            websocket: The WebSocket connection to remove.
            save_task_state: Task state dict to persist to Redis for reconnect recovery.
        """
        user_id = user_id.strip()

        # Remove from in-memory tracking
        if user_id in self.active_connections:
            try:
                self.active_connections[user_id].remove(websocket)
                if not self.active_connections[user_id]:
                    del self.active_connections[user_id]
            except ValueError:
                pass  # Already removed

        print(f"[ConnectionManager] User {user_id} disconnected; "
              f"remaining sockets: {len(self.active_connections.get(user_id, []))}")

        # Cancel heartbeat task
        for (uid, _), task in list(self.heartbeat_tasks.items()):
            if uid == user_id and task.get_coro() is not None:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
                del self.heartbeat_tasks[(uid, _)]

        # Save task state to Redis if provided
        if save_task_state and self.redis:
            try:
                key = self.REDIS_KEY_TASK_STATE.format(user_id=user_id)
                state_json = json.dumps(save_task_state, default=str)
                await self.redis.setex(key, self.REDIS_TTL_TASK_STATE, state_json)
                print(f"[ConnectionManager] Saved task state for user {user_id}")
            except Exception as e:
                print(f"[ConnectionManager] Failed to save task state: {e}")

    # ─────────────────────────────────────────────────────────────────────────────
    # Message Delivery
    # ─────────────────────────────────────────────────────────────────────────────

    async def send(
        self,
        user_id: str,
        message: Dict[str, Any],
        conversation_id: Optional[str] = None,
    ) -> None:
        """
        Send a message to all of a user's WebSocket connections.

        Wraps the message in the standard envelope (adds type, conversation_id, timestamp).

        Args:
            user_id: Target user.
            message: Message body (must include 'type' field).
            conversation_id: Optional conversation ID; if not in message, use this.
        """
        user_id = user_id.strip()

        # Ensure envelope fields
        if "type" not in message:
            message["type"] = MessageType.CHUNK.value

        if "timestamp" not in message:
            message["timestamp"] = datetime.utcnow().isoformat() + "Z"

        if "conversation_id" not in message and conversation_id:
            message["conversation_id"] = conversation_id

        sockets = self.active_connections.get(user_id, [])
        if not sockets:
            print(f"[ConnectionManager] No active connections for user {user_id}")
            return

        dead_sockets = []
        for ws in sockets:
            try:
                await ws.send_json(message)
            except Exception as e:
                print(f"[ConnectionManager] Failed to send to socket: {e}")
                dead_sockets.append(ws)

        # Clean up dead connections
        for ws in dead_sockets:
            await self.disconnect(user_id, ws)

    async def broadcast(self, message: Dict[str, Any]) -> None:
        """
        Send a message to all connected users.

        Args:
            message: Message body (must include 'type' field).
        """
        if "timestamp" not in message:
            message["timestamp"] = datetime.utcnow().isoformat() + "Z"

        for user_id in list(self.active_connections.keys()):
            await self.send(user_id, message.copy())

    # ─────────────────────────────────────────────────────────────────────────────
    # Query Methods
    # ─────────────────────────────────────────────────────────────────────────────

    def is_connected(self, user_id: str) -> bool:
        """Check if a user has any active WebSocket connections."""
        return user_id.strip() in self.active_connections

    def get_active_users(self) -> Set[str]:
        """Return all currently connected user IDs."""
        return set(self.active_connections.keys())

    def get_user_connection_count(self, user_id: str) -> int:
        """Return the number of active connections for a user."""
        return len(self.active_connections.get(user_id.strip(), []))

    # ─────────────────────────────────────────────────────────────────────────────
    # State Recovery
    # ─────────────────────────────────────────────────────────────────────────────

    async def recover_task_state(self, user_id: str) -> Optional[Dict[str, Any]]:
        """
        Retrieve saved task state from Redis (if available).

        Called when a user reconnects to resume interrupted work.

        Args:
            user_id: The user's unique identifier.

        Returns:
            Task state dict, or None if not found or Redis unavailable.
        """
        if not self.redis:
            return None

        user_id = user_id.strip()
        try:
            key = self.REDIS_KEY_TASK_STATE.format(user_id=user_id)
            state_json = await self.redis.get(key)
            if state_json:
                return json.loads(state_json)
        except Exception as e:
            print(f"[ConnectionManager] Failed to recover task state: {e}")

        return None

    async def clear_task_state(self, user_id: str) -> None:
        """
        Explicitly clear saved task state (call after successful reconnect).

        Args:
            user_id: The user's unique identifier.
        """
        if not self.redis:
            return

        user_id = user_id.strip()
        try:
            key = self.REDIS_KEY_TASK_STATE.format(user_id=user_id)
            await self.redis.delete(key)
        except Exception as e:
            print(f"[ConnectionManager] Failed to clear task state: {e}")

    # ─────────────────────────────────────────────────────────────────────────────
    # Heartbeat
    # ─────────────────────────────────────────────────────────────────────────────

    async def _heartbeat_loop(
        self,
        user_id: str,
        websocket: Any,
        connection_id: str,
    ) -> None:
        """
        Monitor a single WebSocket connection with ping/pong heartbeat.

        Sends PING every 30s, expects PONG within 10s.
        Disconnects if heartbeat fails.
        """
        try:
            while True:
                await asyncio.sleep(self.HEARTBEAT_INTERVAL)

                try:
                    # Send ping
                    ping_msg = {
                        "type": MessageType.PING.value,
                        "timestamp": datetime.utcnow().isoformat() + "Z",
                    }
                    await asyncio.wait_for(
                        websocket.send_json(ping_msg),
                        timeout=2.0
                    )

                    # Wait for pong (or receive any message)
                    pong_received = False
                    try:
                        response = await asyncio.wait_for(
                            websocket.receive_json(),
                            timeout=self.HEARTBEAT_TIMEOUT
                        )
                        if response.get("type") == MessageType.PONG.value:
                            pong_received = True
                    except asyncio.TimeoutError:
                        pass

                    if not pong_received:
                        print(f"[ConnectionManager] No pong from {connection_id}; disconnecting")
                        await self.disconnect(user_id, websocket)
                        break

                except Exception as e:
                    print(f"[ConnectionManager] Heartbeat failed for {connection_id}: {e}")
                    await self.disconnect(user_id, websocket)
                    break

        except asyncio.CancelledError:
            pass
        except Exception as e:
            print(f"[ConnectionManager] Heartbeat loop error: {e}")
            await self.disconnect(user_id, websocket)

    # ─────────────────────────────────────────────────────────────────────────────
    # Admin/Debug
    # ─────────────────────────────────────────────────────────────────────────────

    async def get_stats(self) -> Dict[str, Any]:
        """Return connection statistics."""
        total_users = len(self.active_connections)
        total_sockets = sum(len(sockets) for sockets in self.active_connections.values())

        return {
            "total_users": total_users,
            "total_sockets": total_sockets,
            "users": {
                uid: len(sockets) for uid, sockets in self.active_connections.items()
            }
        }

    async def disconnect_all(self) -> None:
        """Close all active connections and cleanup."""
        for user_id in list(self.active_connections.keys()):
            for ws in list(self.active_connections[user_id]):
                await self.disconnect(user_id, ws)

        # Cancel all heartbeat tasks
        for task in self.heartbeat_tasks.values():
            if not task.done():
                task.cancel()

        print("[ConnectionManager] All connections closed")
