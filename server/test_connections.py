"""
Tests for ConnectionManager.

Run with:
  pytest test_connections.py -v
  pytest test_connections.py -v -s  (show prints)
"""

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock, patch
from datetime import datetime

import pytest

from connections import ConnectionManager, MessageType


class MockWebSocket:
    """Mock WebSocket for testing."""

    def __init__(self, user_id: str = "user123"):
        self.user_id = user_id
        self.sent_messages = []
        self.receive_queue = asyncio.Queue()
        self.closed = False

    async def send_json(self, data: dict) -> None:
        """Record sent message."""
        if self.closed:
            raise RuntimeError("WebSocket closed")
        self.sent_messages.append(data)

    async def receive_json(self) -> dict:
        """Get next message from queue."""
        return await self.receive_queue.get()

    async def close(self) -> None:
        """Close connection."""
        self.closed = True

    async def queue_message(self, msg: dict) -> None:
        """Queue a message to be received."""
        await self.receive_queue.put(msg)


# ─────────────────────────────────────────────────────────────────────────────
# Tests
# ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
class TestConnectionManager:
    """Test ConnectionManager functionality."""

    @pytest.fixture
    def manager(self):
        """Create a ConnectionManager without Redis."""
        return ConnectionManager(redis_client=None)

    # Connection Lifecycle

    @pytest.mark.asyncio
    async def test_connect(self, manager):
        """Test connecting a WebSocket."""
        ws = MockWebSocket("user123")
        conn_id = await manager.connect("user123", ws)

        assert conn_id.startswith("user123:")
        assert manager.is_connected("user123")
        assert manager.get_user_connection_count("user123") == 1

    @pytest.mark.asyncio
    async def test_disconnect(self, manager):
        """Test disconnecting a WebSocket."""
        ws = MockWebSocket("user123")
        await manager.connect("user123", ws)
        assert manager.is_connected("user123")

        await manager.disconnect("user123", ws)
        assert not manager.is_connected("user123")

    @pytest.mark.asyncio
    async def test_multiple_connections_per_user(self, manager):
        """Test that a user can have multiple WebSocket connections."""
        ws1 = MockWebSocket("user123")
        ws2 = MockWebSocket("user123")

        await manager.connect("user123", ws1)
        await manager.connect("user123", ws2)

        assert manager.get_user_connection_count("user123") == 2
        assert manager.is_connected("user123")

        await manager.disconnect("user123", ws1)
        assert manager.get_user_connection_count("user123") == 1
        assert manager.is_connected("user123")

        await manager.disconnect("user123", ws2)
        assert not manager.is_connected("user123")

    @pytest.mark.asyncio
    async def test_multiple_users(self, manager):
        """Test managing multiple users."""
        ws1 = MockWebSocket("user1")
        ws2 = MockWebSocket("user2")

        await manager.connect("user1", ws1)
        await manager.connect("user2", ws2)

        assert manager.is_connected("user1")
        assert manager.is_connected("user2")

        active_users = manager.get_active_users()
        assert "user1" in active_users
        assert "user2" in active_users

    # Message Delivery

    @pytest.mark.asyncio
    async def test_send_to_user(self, manager):
        """Test sending a message to a user's connections."""
        ws = MockWebSocket("user123")
        await manager.connect("user123", ws)

        msg = {"type": "chunk", "delta": "hello"}
        await manager.send("user123", msg)

        # Should have sent the message with envelope fields added
        sent = ws.sent_messages[0]
        assert sent["type"] == "chunk"
        assert sent["delta"] == "hello"
        assert "timestamp" in sent
        assert "conversation_id" not in sent  # Not provided

    @pytest.mark.asyncio
    async def test_send_with_conversation_id(self, manager):
        """Test sending a message with conversation_id."""
        ws = MockWebSocket("user123")
        await manager.connect("user123", ws)

        msg = {"type": "chunk", "delta": "hello"}
        await manager.send("user123", msg, conversation_id="conv123")

        sent = ws.sent_messages[0]
        assert sent["conversation_id"] == "conv123"

    @pytest.mark.asyncio
    async def test_send_to_multiple_connections(self, manager):
        """Test that send() reaches all of a user's connections."""
        ws1 = MockWebSocket("user123")
        ws2 = MockWebSocket("user123")

        await manager.connect("user123", ws1)
        await manager.connect("user123", ws2)

        msg = {"type": "chunk", "delta": "test"}
        await manager.send("user123", msg)

        assert len(ws1.sent_messages) == 1
        assert len(ws2.sent_messages) == 1
        assert ws1.sent_messages[0]["delta"] == "test"
        assert ws2.sent_messages[0]["delta"] == "test"

    @pytest.mark.asyncio
    async def test_send_to_nonexistent_user(self, manager):
        """Test sending to a user with no connections (should not crash)."""
        msg = {"type": "chunk", "delta": "hello"}
        # Should not raise
        await manager.send("nonexistent", msg)

    @pytest.mark.asyncio
    async def test_broadcast(self, manager):
        """Test broadcasting to all users."""
        ws1 = MockWebSocket("user1")
        ws2 = MockWebSocket("user2")

        await manager.connect("user1", ws1)
        await manager.connect("user2", ws2)

        msg = {"type": "done", "model": "test"}
        await manager.broadcast(msg)

        assert len(ws1.sent_messages) == 1
        assert len(ws2.sent_messages) == 1
        assert ws1.sent_messages[0]["type"] == "done"
        assert ws2.sent_messages[0]["type"] == "done"

    # Message Envelope

    @pytest.mark.asyncio
    async def test_message_envelope_has_timestamp(self, manager):
        """Test that all sent messages include timestamp."""
        ws = MockWebSocket("user123")
        await manager.connect("user123", ws)

        await manager.send("user123", {"type": "chunk"})

        sent = ws.sent_messages[0]
        assert "timestamp" in sent
        # Verify ISO format
        assert "Z" in sent["timestamp"]
        datetime.fromisoformat(sent["timestamp"][:-1])  # Strip Z for parsing

    @pytest.mark.asyncio
    async def test_message_envelope_preserves_custom_fields(self, manager):
        """Test that custom message fields are preserved."""
        ws = MockWebSocket("user123")
        await manager.connect("user123", ws)

        await manager.send("user123", {
            "type": "chunk",
            "delta": "hello",
            "custom_field": "custom_value",
        })

        sent = ws.sent_messages[0]
        assert sent["delta"] == "hello"
        assert sent["custom_field"] == "custom_value"

    # Query Methods

    @pytest.mark.asyncio
    async def test_is_connected(self, manager):
        """Test is_connected query."""
        assert not manager.is_connected("user123")

        ws = MockWebSocket("user123")
        await manager.connect("user123", ws)

        assert manager.is_connected("user123")

        await manager.disconnect("user123", ws)
        assert not manager.is_connected("user123")

    @pytest.mark.asyncio
    async def test_get_active_users(self, manager):
        """Test getting list of active users."""
        assert len(manager.get_active_users()) == 0

        ws1 = MockWebSocket("user1")
        ws2 = MockWebSocket("user2")

        await manager.connect("user1", ws1)
        await manager.connect("user2", ws2)

        active = manager.get_active_users()
        assert "user1" in active
        assert "user2" in active
        assert len(active) == 2

    @pytest.mark.asyncio
    async def test_get_user_connection_count(self, manager):
        """Test getting connection count per user."""
        ws1 = MockWebSocket("user123")
        ws2 = MockWebSocket("user123")

        assert manager.get_user_connection_count("user123") == 0

        await manager.connect("user123", ws1)
        assert manager.get_user_connection_count("user123") == 1

        await manager.connect("user123", ws2)
        assert manager.get_user_connection_count("user123") == 2

        await manager.disconnect("user123", ws1)
        assert manager.get_user_connection_count("user123") == 1

    # Stats

    @pytest.mark.asyncio
    async def test_get_stats(self, manager):
        """Test getting connection statistics."""
        ws1 = MockWebSocket("user1")
        ws2 = MockWebSocket("user2")
        ws3 = MockWebSocket("user2")

        await manager.connect("user1", ws1)
        await manager.connect("user2", ws2)
        await manager.connect("user2", ws3)

        stats = await manager.get_stats()

        assert stats["total_users"] == 2
        assert stats["total_sockets"] == 3
        assert stats["users"]["user1"] == 1
        assert stats["users"]["user2"] == 2

    # Whitespace normalization

    @pytest.mark.asyncio
    async def test_connect_trims_whitespace(self, manager):
        """Test that user_id whitespace is trimmed."""
        ws = MockWebSocket("user123")
        await manager.connect("  user123  ", ws)

        assert manager.is_connected("user123")
        assert not manager.is_connected("  user123  ")

    @pytest.mark.asyncio
    async def test_send_trims_whitespace(self, manager):
        """Test that send() trims user_id whitespace."""
        ws = MockWebSocket("user123")
        await manager.connect("user123", ws)

        # Send with whitespace should still work
        await manager.send("  user123  ", {"type": "chunk"})

        assert len(ws.sent_messages) == 1


# ─────────────────────────────────────────────────────────────────────────────
# Heartbeat Tests (Basic)
# ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
class TestHeartbeat:
    """Test heartbeat functionality."""

    @pytest.fixture
    def manager(self):
        return ConnectionManager(redis_client=None)

    @pytest.mark.asyncio
    async def test_heartbeat_starts_on_connect(self, manager):
        """Test that heartbeat task is created on connect."""
        ws = MockWebSocket("user123")
        conn_id = await manager.connect("user123", ws)

        # Should have created a heartbeat task
        heartbeat_tasks = [
            task for (uid, _), task in manager.heartbeat_tasks.items()
            if uid == "user123"
        ]
        assert len(heartbeat_tasks) > 0
        assert not heartbeat_tasks[0].done()

    @pytest.mark.asyncio
    async def test_heartbeat_cancelled_on_disconnect(self, manager):
        """Test that heartbeat task is cancelled on disconnect."""
        ws = MockWebSocket("user123")
        await manager.connect("user123", ws)

        await manager.disconnect("user123", ws)

        # All heartbeat tasks for this user should be cancelled or done
        heartbeat_tasks = [
            task for (uid, _), task in manager.heartbeat_tasks.items()
            if uid == "user123"
        ]
        # After disconnect, the dict should be empty
        assert len(heartbeat_tasks) == 0


# ─────────────────────────────────────────────────────────────────────────────
# State Recovery Tests (Without Redis)
# ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
class TestStateRecovery:
    """Test task state recovery."""

    @pytest.fixture
    def manager(self):
        return ConnectionManager(redis_client=None)

    @pytest.mark.asyncio
    async def test_recover_task_state_without_redis(self, manager):
        """Test that recovery returns None when Redis is disabled."""
        ws = MockWebSocket("user123")
        await manager.connect("user123", ws)

        await manager.disconnect(
            "user123",
            ws,
            save_task_state={"task_id": "123", "status": "in_progress"},
        )

        # Without Redis, should return None
        state = await manager.recover_task_state("user123")
        assert state is None

    @pytest.mark.asyncio
    async def test_clear_task_state_without_redis(self, manager):
        """Test that clear_task_state is a no-op without Redis."""
        # Should not raise
        await manager.clear_task_state("user123")


# ─────────────────────────────────────────────────────────────────────────────
# Integration Tests
# ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
class TestIntegration:
    """Integration tests."""

    @pytest.fixture
    def manager(self):
        return ConnectionManager(redis_client=None)

    @pytest.mark.asyncio
    async def test_full_lifecycle(self, manager):
        """Test full connect -> send -> disconnect lifecycle."""
        ws = MockWebSocket("user123")

        # Connect
        conn_id = await manager.connect("user123", ws)
        assert manager.is_connected("user123")

        # Send
        await manager.send("user123", {
            "type": "chunk",
            "delta": "Hello",
        }, conversation_id="conv1")

        assert len(ws.sent_messages) == 1
        sent = ws.sent_messages[0]
        assert sent["type"] == "chunk"
        assert sent["delta"] == "Hello"
        assert sent["conversation_id"] == "conv1"
        assert "timestamp" in sent

        # Disconnect
        await manager.disconnect("user123", ws)
        assert not manager.is_connected("user123")

    @pytest.mark.asyncio
    async def test_multi_user_isolation(self, manager):
        """Test that users don't interfere with each other."""
        ws1 = MockWebSocket("user1")
        ws2 = MockWebSocket("user2")

        await manager.connect("user1", ws1)
        await manager.connect("user2", ws2)

        # Send to user1
        await manager.send("user1", {"type": "chunk", "delta": "msg1"})

        # Only user1's socket should have received
        assert len(ws1.sent_messages) == 1
        assert len(ws2.sent_messages) == 0

        # Send to user2
        await manager.send("user2", {"type": "chunk", "delta": "msg2"})

        assert len(ws1.sent_messages) == 1
        assert len(ws2.sent_messages) == 1


if __name__ == "__main__":
    pytest.main([__file__, "-v", "-s"])
